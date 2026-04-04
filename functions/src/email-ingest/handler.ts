/**
 * Triggered by SES receipt rule via S3 put notification.
 * Reads the raw .eml from S3, parses it, and writes a structured
 * record to DynamoDB.
 */
import { S3Event } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { simpleParser } from "mailparser";
import type { StoredEmail, EmailAddress, Attachment } from "@dork-mail/shared";

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

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    await ingestOne(record.s3.bucket.name, decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")));
  }
};

async function ingestOne(bucket: string, key: string): Promise<void> {
  logger.info("Ingesting email", { bucket, key });

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await obj.Body!.transformToString("utf-8");

  const parsed = await simpleParser(raw);

  const messageId = (parsed.messageId ?? key).replace(/[<>]/g, "");
  const receivedAt = (parsed.date ?? new Date()).toISOString();
  const ts = receivedAt.replace(/[:.]/g, "-");

  // Determine recipient mailboxes from To/CC headers
  const toAddresses = toEmailAddresses(parsed.to);
  const ccAddresses = toEmailAddresses(parsed.cc);

  const attachments: Attachment[] = (parsed.attachments ?? []).map((a, i) => ({
    filename: a.filename ?? `attachment-${i}`,
    contentType: a.contentType,
    size: a.size,
    // Terraform will configure the actual attachment prefix
    s3Key: `attachments/${messageId}/${a.filename ?? i}`,
  }));

  // Write one record per recipient mailbox so each inbox query is simple
  for (const recipient of toAddresses) {
    const email: StoredEmail = {
      pk: `mailbox#${recipient.address.toLowerCase()}`,
      sk: `ts#${ts}#${messageId}`,
      messageId,
      from: toEmailAddresses(parsed.from)[0] ?? { address: "unknown" },
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      replyTo: toEmailAddresses(parsed.replyTo),
      subject: parsed.subject ?? "(no subject)",
      bodyText: parsed.text ?? undefined,
      bodyHtml: parsed.html || undefined,
      attachments: attachments.length ? attachments : undefined,
      rawKey: key,
      receivedAt,
      read: false,
      starred: false,
      labels: [],
      folder: "inbox",
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: email }));
    logger.info("Stored email", { mailbox: recipient.address, messageId });
  }

  metrics.addMetric("EmailsIngested", MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
}

function toEmailAddresses(input: unknown): EmailAddress[] {
  if (!input) return [];
  // mailparser gives AddressObject | AddressObject[]
  const objs = Array.isArray(input) ? input : [input];
  return objs.flatMap((obj: any) =>
    (obj?.value ?? []).map((v: any) => ({
      address: v.address ?? "",
      name: v.name || undefined,
    }))
  );
}
