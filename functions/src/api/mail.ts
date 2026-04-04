/**
 * Mail CRUD API.
 * GET    /mail                  — list emails (folder, cursor)
 * GET    /mail/{messageId}      — get single email, mark read
 * POST   /mail/send             — send email via SES
 * PATCH  /mail/{messageId}      — update (read, starred, labels, folder)
 * DELETE /mail/{messageId}      — move to trash or permanently delete
 * GET    /mail/{messageId}/attachment/{attachmentKey} — presigned S3 URL
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { StoredEmail, SendEmailRequest, ListEmailsResponse, ApiResponse } from "@dork-mail/shared";

const logger = new Logger({ serviceName: "api-mail" });
const tracer = new Tracer({ serviceName: "api-mail" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-mail" });

const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo);
const s3 = tracer.captureAWSv3Client(new S3Client({}));
const ses = tracer.captureAWSv3Client(new SESClient({}));

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.EMAIL_BUCKET!;
const FROM_DOMAIN = process.env.FROM_DOMAIN!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userEmail = event.requestContext.authorizer?.userEmail as string;
  const method = event.httpMethod;
  const path = event.path;

  const msgMatch = path.match(/\/mail\/([^/]+)$/);
  const attachMatch = path.match(/\/mail\/([^/]+)\/attachment\/(.+)$/);
  const messageId = msgMatch ? decodeURIComponent(msgMatch[1]) : null;

  if (method === "GET" && !msgMatch) return listEmails(event, userEmail);
  if (method === "GET" && attachMatch) return getAttachment(decodeURIComponent(attachMatch[1]), attachMatch[2], userEmail);
  if (method === "GET" && msgMatch) return getEmail(messageId!, userEmail);
  if (method === "POST" && path.endsWith("/send")) return sendEmail(event, userEmail);
  if (method === "PATCH" && msgMatch) return updateEmail(event, messageId!, userEmail);
  if (method === "DELETE" && msgMatch) return deleteEmail(messageId!, userEmail);

  return json(404, { ok: false, error: "Not found" });
};

async function listEmails(event: APIGatewayProxyEvent, userEmail: string): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters ?? {};
  const folder = qs.folder ?? "inbox";
  const limit = Math.min(parseInt(qs.limit ?? "50", 10), 100);
  const cursor = qs.cursor ? JSON.parse(Buffer.from(qs.cursor, "base64").toString()) : undefined;

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    FilterExpression: "folder = :folder",
    ExpressionAttributeValues: {
      ":pk": `mailbox#${userEmail}`,
      ":prefix": "ts#",
      ":folder": folder,
    },
    Limit: limit,
    ScanIndexForward: false, // newest first
    ExclusiveStartKey: cursor,
  }));

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
    : undefined;

  const response: ListEmailsResponse = {
    emails: (result.Items ?? []) as StoredEmail[],
    nextCursor,
  };

  return json(200, { ok: true, data: response });
}

async function getEmail(messageId: string, userEmail: string): Promise<APIGatewayProxyResult> {
  // We need to find the SK for this messageId — query by pk and filter
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "messageId = :mid",
    ExpressionAttributeValues: {
      ":pk": `mailbox#${userEmail}`,
      ":mid": messageId,
    },
  }));

  const item = result.Items?.[0] as StoredEmail | undefined;
  if (!item) return json(404, { ok: false, error: "Email not found" });

  // Mark as read
  if (!item.read) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET #read = :true",
      ExpressionAttributeNames: { "#read": "read" },
      ExpressionAttributeValues: { ":true": true },
    }));
    item.read = true;
  }

  return json(200, { ok: true, data: item });
}

async function sendEmail(event: APIGatewayProxyEvent, userEmail: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<SendEmailRequest>(event.body);
  if (!body?.to?.length || !body.subject) {
    return json(400, { ok: false, error: "to and subject required" });
  }

  const toAddresses = body.to.map(a => a.address);
  const ccAddresses = (body.cc ?? []).map(a => a.address);

  const res = await ses.send(new SendEmailCommand({
    Source: userEmail,
    Destination: {
      ToAddresses: toAddresses,
      CcAddresses: ccAddresses.length ? ccAddresses : undefined,
    },
    Message: {
      Subject: { Data: body.subject, Charset: "UTF-8" },
      Body: {
        Text: body.bodyText ? { Data: body.bodyText, Charset: "UTF-8" } : undefined,
        Html: body.bodyHtml ? { Data: body.bodyHtml, Charset: "UTF-8" } : undefined,
      },
    },
    ReplyToAddresses: body.replyToMessageId ? [`<${body.replyToMessageId}>`] : undefined,
  }));

  // Store in sent folder
  const now = new Date().toISOString();
  const ts = now.replace(/[:.]/g, "-");
  const sesMessageId = res.MessageId!;
  const stored: StoredEmail = {
    pk: `mailbox#${userEmail}`,
    sk: `ts#${ts}#${sesMessageId}`,
    messageId: sesMessageId,
    from: { address: userEmail },
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    rawKey: "",
    receivedAt: now,
    read: true,
    starred: false,
    labels: [],
    folder: "sent",
    sesMessageId,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: stored }));

  metrics.addMetric("EmailsSent", MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  logger.info("Email sent", { from: userEmail, to: toAddresses });

  return json(200, { ok: true, data: { messageId: sesMessageId } });
}

async function updateEmail(
  event: APIGatewayProxyEvent,
  messageId: string,
  userEmail: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<Pick<StoredEmail, "read" | "starred" | "labels" | "folder">>>(event.body);
  if (!body) return json(400, { ok: false, error: "Body required" });

  const lookup = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "messageId = :mid",
    ExpressionAttributeValues: { ":pk": `mailbox#${userEmail}`, ":mid": messageId },
  }));

  const item = lookup.Items?.[0];
  if (!item) return json(404, { ok: false, error: "Not found" });

  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (body.read !== undefined) { sets.push("#read = :read"); names["#read"] = "read"; values[":read"] = body.read; }
  if (body.starred !== undefined) { sets.push("starred = :starred"); values[":starred"] = body.starred; }
  if (body.labels !== undefined) { sets.push("labels = :labels"); values[":labels"] = body.labels; }
  if (body.folder !== undefined) { sets.push("folder = :folder"); values[":folder"] = body.folder; }

  if (!sets.length) return json(400, { ok: false, error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
  }));

  return json(200, { ok: true });
}

async function deleteEmail(messageId: string, userEmail: string): Promise<APIGatewayProxyResult> {
  const lookup = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "messageId = :mid",
    ExpressionAttributeValues: { ":pk": `mailbox#${userEmail}`, ":mid": messageId },
  }));

  const item = lookup.Items?.[0];
  if (!item) return json(404, { ok: false, error: "Not found" });

  if (item.folder === "trash") {
    // Already in trash — hard delete
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: item.pk, sk: item.sk } }));
    return json(200, { ok: true, data: { deleted: true } });
  }

  // Move to trash
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET folder = :trash",
    ExpressionAttributeValues: { ":trash": "trash" },
  }));

  return json(200, { ok: true, data: { deleted: false, folder: "trash" } });
}

async function getAttachment(messageId: string, attachmentKey: string, userEmail: string): Promise<APIGatewayProxyResult> {
  // Verify the email belongs to this user before issuing presigned URL
  const lookup = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "messageId = :mid",
    ExpressionAttributeValues: { ":pk": `mailbox#${userEmail}`, ":mid": messageId },
  }));

  if (!lookup.Items?.[0]) return json(404, { ok: false, error: "Not found" });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: decodeURIComponent(attachmentKey) }),
    { expiresIn: 300 }
  );

  return json(200, { ok: true, data: { url } });
}

function parseBody<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function json(status: number, body: ApiResponse): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
