/**
 * Invoked by the SES receipt rule after its S3 action has stored the raw .eml.
 * Parses the message, stores attachments in S3, and writes one record per
 * local recipient mailbox to DynamoDB. Also accepts S3 put events, for
 * reprocessing raw objects by hand.
 */
import type { S3Event, SESEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { simpleParser, type AddressObject } from "mailparser";
import type { StoredEmail, EmailAddress, Attachment, MailFolder } from "@dork-mail/shared";
import isEmail from "validator/lib/isEmail";
import { mailboxPk, mailboxFolderKey, makeSnippet, makeSearchText, storeBodies } from "../lib/mail-store";
import { notifyNewMail } from "../lib/push";

const logger = new Logger({ serviceName: "email-ingest" });
const tracer = new Tracer({ serviceName: "email-ingest" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "email-ingest" });

const s3 = tracer.captureAWSv3Client(new S3Client({}));
const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.EMAIL_BUCKET!;
const DOMAIN = process.env.MAIL_DOMAIN!.toLowerCase();
// Must match object_key_prefix on the receipt rule's s3_action in terraform/ses.tf.
const INCOMING_PREFIX = "incoming/";

interface Envelope {
  recipients: string[];
  spam: boolean;
}

export const handler = async (event: S3Event | SESEvent): Promise<void> => {
  for (const record of event.Records) {
    if ("ses" in record) {
      const { mail, receipt } = record.ses;
      await ingestOne(BUCKET, `${INCOMING_PREFIX}${mail.messageId}`, {
        recipients: receipt.recipients,
        spam: receipt.spamVerdict.status === "FAIL" || receipt.virusVerdict.status === "FAIL",
      });
    } else {
      await ingestOne(record.s3.bucket.name, decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")));
    }
  }
};

async function ingestOne(bucket: string, key: string, envelope?: Envelope): Promise<void> {
  logger.info("Ingesting email", { bucket, key });

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = Buffer.from(await obj.Body!.transformToByteArray());
  const parsed = await simpleParser(raw, { keepCidLinks: true });

  const messageId = stripBrackets(parsed.messageId ?? key.split("/").pop()!);
  const receivedAt = (parsed.date ?? new Date()).toISOString();
  const ts = receivedAt.replace(/[:.]/g, "-");

  const toAddresses = toEmailAddresses(parsed.to);
  const ccAddresses = toEmailAddresses(parsed.cc);

  // Header verdicts are only a fallback for S3 reprocessing: a sender can forge them.
  const spam = envelope?.spam ?? [parsed.headers.get("x-ses-spam-verdict"), parsed.headers.get("x-ses-virus-verdict")]
    .some(v => String(v ?? "").toUpperCase() === "FAIL");
  const folder: MailFolder = spam ? "spam" : "inbox";

  const mailboxes = await localMailboxes(envelope?.recipients ?? [...toAddresses, ...ccAddresses].map(a => a.address));
  if (!mailboxes.length) {
    logger.warn("No local mailbox for recipients", { key, recipients: envelope?.recipients });
    return;
  }

  const attachments = await storeAttachments(bucket, messageId, parsed.attachments ?? []);
  const bodyText = parsed.text || undefined;
  const bodyHtml = parsed.html || undefined;
  const snippet = makeSnippet(bodyText, bodyHtml);
  const bodies = await storeBodies(s3, bucket, `bodies/${messageId}.json`, bodyText, bodyHtml);

  const refs = parsed.references ? [parsed.references].flat().map(stripBrackets) : undefined;
  const from = toEmailAddresses(parsed.from)[0] ?? { address: "unknown" };
  const subject = parsed.subject ?? "(no subject)";

  for (const mailbox of mailboxes) {
    const email: StoredEmail = {
      pk: mailboxPk(mailbox),
      sk: `ts#${ts}#${messageId}`,
      mailboxFolder: mailboxFolderKey(mailbox, folder),
      messageId,
      from,
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      replyTo: toEmailAddresses(parsed.replyTo),
      subject,
      snippet,
      searchText: makeSearchText({ from, to: toAddresses, cc: ccAddresses, subject, snippet }),
      ...bodies,
      inReplyTo: parsed.inReplyTo ? stripBrackets(parsed.inReplyTo) : undefined,
      references: refs,
      attachments: attachments.length ? attachments : undefined,
      rawKey: key,
      receivedAt,
      read: false,
      starred: false,
      labels: [],
      folder,
    };

    try {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: email, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") {
        logger.info("Already ingested", { mailbox, messageId });
        continue;
      }
      throw err;
    }
    logger.info("Stored email", { mailbox, messageId, folder });
    if (folder === "inbox") await notifyNewMail(ddb, TABLE, logger, mailbox, email);
  }

  metrics.addMetric(spam ? "SpamIngested" : "EmailsIngested", MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
}

/**
 * Maps recipient addresses to existing users on this domain. Plus-addressed
 * mail (user+tag@domain) is delivered to the base mailbox.
 */
async function localMailboxes(recipients: string[]): Promise<string[]> {
  const candidates = [...new Set(
    recipients
      .map(r => r.toLowerCase().trim())
      .filter(r => r.endsWith(`@${DOMAIN}`))
      .map(r => r.replace(/\+[^@]*@/, "@")),
  )];
  if (!candidates.length) return [];

  const res = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE]: {
        Keys: candidates.slice(0, 100).map(email => ({ pk: `user#${email}`, sk: "profile" })),
        ProjectionExpression: "email",
      },
    },
  }));
  return (res.Responses?.[TABLE] ?? []).map(u => u.email as string);
}

async function storeAttachments(
  bucket: string,
  messageId: string,
  parts: Awaited<ReturnType<typeof simpleParser>>["attachments"],
): Promise<Attachment[]> {
  const used = new Set<string>();
  const attachments = parts.map((part, i) => {
    const filename = part.filename ?? `attachment-${i}`;
    let safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (used.has(safeName)) safeName = `${i}-${safeName}`;
    used.add(safeName);
    return {
      part,
      meta: {
        filename,
        contentType: part.contentType,
        size: part.size,
        s3Key: `attachments/${messageId}/${safeName}`,
        contentId: part.contentId ? stripBrackets(part.contentId) : undefined,
      } satisfies Attachment,
    };
  });

  await Promise.all(attachments.map(({ part, meta }) =>
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: meta.s3Key, Body: part.content, ContentType: meta.contentType })),
  ));
  return attachments.map(a => a.meta);
}

function stripBrackets(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

function toEmailAddresses(input: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!input) return [];
  return [input].flat().flatMap(obj =>
    obj.value
      .map(v => ({ address: (v.address ?? "").toLowerCase().trim(), name: v.name || undefined }))
      .filter(a => isEmail(a.address)),
  );
}
