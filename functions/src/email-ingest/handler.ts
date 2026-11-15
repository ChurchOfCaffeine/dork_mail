/**
 * Invoked by the SES receipt rule after its S3 action has stored the raw .eml.
 * Parses the message, stores attachments in S3, and writes one record per
 * local recipient mailbox to DynamoDB. Also accepts S3 put events, for
 * reprocessing raw objects by hand.
 */
import type { S3Event, SESEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { simpleParser, type AddressObject } from "mailparser";
import type { StoredEmail, EmailAddress, Attachment, MailFolder } from "@dork-mail/shared";
import isEmail from "validator/lib/isEmail";
import {
  emailSk, mailboxPk, mailboxFolderKey, mailboxThreadKey, makeSnippet, makeSearchText, storeBodies, threadIdFor,
} from "../lib/mail-store";
import { CommitConflict, commitChange, countDelta } from "../lib/mail-state";
import { emailIdFor } from "../jmap/ids";

const logger = new Logger({ serviceName: "email-ingest" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "email-ingest" });

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
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
  virus: boolean;
}

export const handler = async (event: S3Event | SESEvent): Promise<void> => {
  for (const record of event.Records) {
    if ("ses" in record) {
      const { mail, receipt } = record.ses;
      // Only when the sender's domain asks receivers to act on failures, so mailing lists that break alignment still arrive.
      const dmarcFail = receipt.dmarcVerdict?.status === "FAIL" && ["quarantine", "reject"].includes(receipt.dmarcPolicy?.toLowerCase() ?? "");
      const virus = receipt.virusVerdict.status === "FAIL";
      await ingestOne(BUCKET, `${INCOMING_PREFIX}${mail.messageId}`, {
        recipients: receipt.recipients,
        spam: receipt.spamVerdict.status === "FAIL" || virus || dmarcFail,
        virus,
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

  // SES names the raw object, so unlike the Message-ID a sender can't pick it and collide with other mail's parts.
  const objectId = key.split("/").pop()!;
  const messageId = stripBrackets(parsed.messageId ?? objectId);
  // When SES stored the message, so the same object gets the same sort key on reprocessing.
  const receivedAt = (obj.LastModified ?? new Date()).toISOString();
  const sentAt = parsed.date?.toISOString();

  const toAddresses = toEmailAddresses(parsed.to);
  const ccAddresses = toEmailAddresses(parsed.cc);

  // Header verdicts are only a fallback for S3 reprocessing: a sender can forge them.
  const headerFail = (name: string) => String(parsed.headers.get(name) ?? "").toUpperCase() === "FAIL";
  const virus = envelope?.virus ?? headerFail("x-ses-virus-verdict");
  const spam = envelope?.spam ?? (virus || headerFail("x-ses-spam-verdict"));
  const folder: MailFolder = spam ? "spam" : "inbox";

  const mailboxes = await localMailboxes(envelope?.recipients ?? [...toAddresses, ...ccAddresses].map(a => a.address));
  if (!mailboxes.length) {
    logger.warn("No local mailbox for recipients", { key, recipients: envelope?.recipients });
    return;
  }

  const attachments = virus ? [] : await storeAttachments(bucket, objectId, parsed.attachments ?? []);
  const bodyText = parsed.text || undefined;
  const bodyHtml = parsed.html || undefined;
  const snippet = makeSnippet(bodyText, bodyHtml);
  const bodies = await storeBodies(s3, bucket, `bodies/${objectId}.json`, bodyText, bodyHtml);

  const refs = parsed.references ? [parsed.references].flat().map(stripBrackets) : undefined;
  const inReplyTo = parsed.inReplyTo ? stripBrackets(parsed.inReplyTo) : undefined;
  const from = toEmailAddresses(parsed.from)[0] ?? { address: "unknown" };
  const subject = parsed.subject ?? "(no subject)";
  const threadId = threadIdFor({ messageId, inReplyTo, references: refs });

  for (const mailbox of mailboxes) {
    const email: StoredEmail = {
      pk: mailboxPk(mailbox),
      sk: emailSk(receivedAt, messageId),
      mailboxFolder: mailboxFolderKey(mailbox, folder),
      threadId,
      mailboxThread: mailboxThreadKey(mailbox, threadId),
      messageId,
      from,
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      replyTo: toEmailAddresses(parsed.replyTo),
      subject,
      snippet,
      searchText: makeSearchText({ from, to: toAddresses, cc: ccAddresses, subject, snippet }),
      ...bodies,
      inReplyTo,
      references: refs,
      attachments: attachments.length ? attachments : undefined,
      rawKey: key,
      size: raw.byteLength,
      receivedAt,
      sentAt,
      read: false,
      starred: false,
      labels: [],
      folder,
    };

    try {
      await commitChange(ddb, TABLE, mailbox, { created: [emailIdFor(email.sk)], threads: [threadId] }, () => [
        { Put: { TableName: TABLE, Item: email, ConditionExpression: "attribute_not_exists(pk)" } },
      ], countDelta(undefined, email));
    } catch (err) {
      if (err instanceof CommitConflict) {
        logger.info("Already ingested", { mailbox, messageId });
        continue;
      }
      throw err;
    }
    logger.info("Stored email", { mailbox, messageId, folder });
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
  objectId: string,
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
        s3Key: `attachments/${objectId}/${safeName}`,
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
