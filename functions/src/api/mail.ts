/**
 * Mail CRUD API.
 * GET    /mail                  — list emails (folder, cursor, q)
 * GET    /mail/counts           — unread counts for inbox and spam
 * GET    /mail/{messageId}      — get single email
 * POST   /mail/send             — send email via SES
 * POST   /mail/uploads          — presigned S3 PUT for an outgoing attachment
 * PATCH  /mail/{messageId}      — update (read, starred, labels, folder)
 * DELETE /mail/{messageId}      — move to trash or permanently delete
 * GET    /mail/{messageId}/attachment/{attachmentKey} — presigned S3 URL
 */
import { randomUUID } from "node:crypto";
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
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESv2Client, SendEmailCommand, type MessageHeader, type Attachment as SesAttachment } from "@aws-sdk/client-sesv2";
import { MAIL_FOLDERS } from "@dork-mail/shared";
import type {
  User,
  StoredEmail,
  Attachment,
  MailFolder,
  SendEmailRequest,
  UploadRequest,
  ListEmailsResponse,
  EmailSummary,
} from "@dork-mail/shared";
import isEmail from "validator/lib/isEmail";
import { json, parseBody, caller, withErrors } from "../lib/http";
import {
  FOLDER_INDEX,
  SUMMARY_FIELDS,
  mailboxPk,
  mailboxFolderKey,
  makeSnippet,
  makeSearchText,
  storeBodies,
  loadBodies,
  findEmail,
  countUnread,
} from "../lib/mail-store";

const logger = new Logger({ serviceName: "api-mail" });
const tracer = new Tracer({ serviceName: "api-mail" });
const metrics = new Metrics({ namespace: "DorkMail", serviceName: "api-mail" });

const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = tracer.captureAWSv3Client(new S3Client({}));
const sesv2 = tracer.captureAWSv3Client(new SESv2Client({}));

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.EMAIL_BUCKET!;
const SES_CONFIG_SET = process.env.SES_CONFIG_SET || undefined;
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SEARCH_MAX_PAGES = 5;

/** Strip CR/LF to prevent email header injection */
function noNewlines(s: string): string {
  return s.replace(/[\r\n]/g, "");
}

function formatAddress(a: { name?: string; address: string }): string {
  if (a.name) {
    const safeName = noNewlines(a.name).replace(/"/g, '\\"');
    return `"${safeName}" <${a.address}>`;
  }
  return a.address;
}

function isFolder(f: unknown): f is MailFolder {
  return (MAIL_FOLDERS as readonly unknown[]).includes(f);
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export const handler = withErrors(logger, async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { email: userEmail } = caller(event);
  const method = event.httpMethod;
  const path = event.path;

  if (method === "GET" && path.endsWith("/mail/counts")) return getCounts(userEmail);
  if (method === "POST" && path.endsWith("/mail/send")) return sendEmail(event, userEmail);
  if (method === "POST" && path.endsWith("/mail/uploads")) return createUpload(event, userEmail);

  const msgMatch = path.match(/\/mail\/([^/]+)$/);
  const attachMatch = path.match(/\/mail\/([^/]+)\/attachment\/(.+)$/);
  const messageId = msgMatch ? decodeURIComponent(msgMatch[1]) : null;

  if (method === "GET" && attachMatch) return getAttachment(event, decodeURIComponent(attachMatch[1]), attachMatch[2], userEmail);
  if (method === "GET" && !msgMatch) return listEmails(event, userEmail);
  if (method === "GET" && msgMatch) return getEmail(messageId!, userEmail);
  if (method === "PATCH" && msgMatch) return updateEmail(event, messageId!, userEmail);
  if (method === "DELETE" && msgMatch) return deleteEmail(messageId!, userEmail);

  return json(404, { ok: false, error: "Not found" });
});

async function listEmails(event: APIGatewayProxyEvent, userEmail: string): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters ?? {};
  const folder = qs.folder ?? "inbox";
  if (!isFolder(folder)) return json(400, { ok: false, error: "Invalid folder" });

  const limit = Math.min(Math.max(parseInt(qs.limit ?? "50", 10) || 50, 1), 100);
  const q = qs.q?.trim().toLowerCase();
  let startKey: Record<string, unknown> | undefined;
  if (qs.cursor) {
    try {
      startKey = JSON.parse(Buffer.from(qs.cursor, "base64").toString());
    } catch {
      return json(400, { ok: false, error: "Invalid cursor" });
    }
  }

  const names: Record<string, string> = Object.fromEntries(SUMMARY_FIELDS.map((f, i) => [`#f${i}`, f]));
  const values: Record<string, unknown> = { ":mf": mailboxFolderKey(userEmail, folder) };
  if (q) {
    names["#search"] = "searchText";
    values[":q"] = q;
  }

  const emails: EmailSummary[] = [];
  let pages = 0;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: FOLDER_INDEX,
      KeyConditionExpression: "mailboxFolder = :mf",
      FilterExpression: q ? "contains(#search, :q)" : undefined,
      ProjectionExpression: Object.keys(names).filter(n => n !== "#search").join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      // A Limit applies before the filter, so searches read whole pages instead.
      Limit: q ? undefined : limit,
      ScanIndexForward: false,
      ExclusiveStartKey: startKey,
    }));
    emails.push(...(res.Items ?? []) as EmailSummary[]);
    startKey = res.LastEvaluatedKey;
    pages++;
  } while (q && startKey && emails.length < limit && pages < SEARCH_MAX_PAGES);

  const response: ListEmailsResponse = {
    emails,
    nextCursor: startKey ? Buffer.from(JSON.stringify(startKey)).toString("base64") : undefined,
  };
  return json(200, { ok: true, data: response });
}

async function getCounts(userEmail: string): Promise<APIGatewayProxyResult> {
  const [inbox, spam] = await Promise.all([
    countUnread(ddb, TABLE, userEmail, "inbox"),
    countUnread(ddb, TABLE, userEmail, "spam"),
  ]);
  return json(200, { ok: true, data: { inbox, spam } });
}

async function getEmail(messageId: string, userEmail: string): Promise<APIGatewayProxyResult> {
  const item = await findEmail(ddb, TABLE, userEmail, messageId);
  if (!item) return json(404, { ok: false, error: "Email not found" });

  await loadBodies(s3, BUCKET, item);

  const inline = (item.attachments ?? []).filter(a => a.contentId && item.bodyHtml?.includes(`cid:${a.contentId}`));
  await Promise.all(inline.map(async a => {
    a.url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: a.s3Key }), { expiresIn: 3600 });
    item.bodyHtml = item.bodyHtml!.replaceAll(`cid:${a.contentId}`, a.url);
  }));

  const { pk, sk, mailboxFolder, searchText, bodyKey, ...email } = item;
  return json(200, { ok: true, data: email });
}

async function sendEmail(event: APIGatewayProxyEvent, userEmail: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<SendEmailRequest>(event.body);
  if (!body?.to?.length) {
    return json(400, { ok: false, error: "At least one recipient is required" });
  }
  const subject = noNewlines(body.subject ?? "");
  if (subject.length > 998) {
    return json(400, { ok: false, error: "Subject is too long" });
  }

  const allRecipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])];
  if (!allRecipients.every(a => isEmail(a.address))) {
    return json(400, { ok: false, error: "Invalid email address in to, cc, or bcc" });
  }

  const [userRecord, original, forwarded] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `user#${userEmail}`, sk: "profile" } })),
    body.inReplyTo ? findEmail(ddb, TABLE, userEmail, body.inReplyTo) : undefined,
    body.forwardOf ? findEmail(ddb, TABLE, userEmail, body.forwardOf) : undefined,
  ]);
  if (body.inReplyTo && !original) return json(400, { ok: false, error: "Replied-to message not found" });
  if (body.forwardOf && !forwarded) return json(400, { ok: false, error: "Forwarded message not found" });

  const displayName = (userRecord.Item as User | undefined)?.displayName;
  const fromAddress = formatAddress({ name: displayName, address: userEmail });

  const headers: MessageHeader[] = [];
  let references: string[] | undefined;
  if (original) {
    references = [...(original.references ?? []), original.messageId];
    headers.push(
      { Name: "In-Reply-To", Value: `<${original.messageId}>` },
      { Name: "References", Value: references.map(r => `<${r}>`).join(" ") },
    );
  }

  const uploadPrefix = `uploads/${userEmail}/`;
  const forwardable = new Set((forwarded?.attachments ?? []).map(a => a.s3Key));
  const outgoing = body.attachments ?? [];
  if (!outgoing.every(a => a.s3Key.startsWith(uploadPrefix) || forwardable.has(a.s3Key))) {
    return json(403, { ok: false, error: "Attachment not allowed" });
  }
  const files = await Promise.all(outgoing.map(async a => {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: a.s3Key }));
    return { ...a, content: await obj.Body!.transformToByteArray() };
  }));
  if (files.reduce((n, f) => n + f.content.byteLength, 0) > MAX_UPLOAD_BYTES) {
    return json(400, { ok: false, error: "Attachments exceed 25 MB" });
  }

  const res = await sesv2.send(new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: {
      ToAddresses: body.to.map(formatAddress),
      CcAddresses: body.cc?.length ? body.cc.map(formatAddress) : undefined,
      BccAddresses: body.bcc?.length ? body.bcc.map(formatAddress) : undefined,
    },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: body.bodyText ?? "", Charset: "UTF-8" },
          Html: body.bodyHtml ? { Data: body.bodyHtml, Charset: "UTF-8" } : undefined,
        },
        Headers: headers.length ? headers : undefined,
        Attachments: files.length
          ? files.map((f): SesAttachment => ({
              RawContent: f.content,
              FileName: f.filename,
              ContentType: f.contentType,
              ContentDisposition: "ATTACHMENT",
              ContentTransferEncoding: "BASE64",
            }))
          : undefined,
      },
    },
    ConfigurationSetName: SES_CONFIG_SET,
  }));

  const sesMessageId = res.MessageId!;
  // SES builds the Message-ID header from its own ID; storing the full form lets replies thread.
  const messageId = `${sesMessageId}@${AWS_REGION === "us-east-1" ? "email" : AWS_REGION}.amazonses.com`;
  const now = new Date().toISOString();

  const attachments: Attachment[] = await Promise.all(files.map(async (f, i) => {
    const s3Key = `attachments/${messageId}/${i}-${safeFilename(f.filename)}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: f.content, ContentType: f.contentType }));
    return { filename: f.filename, contentType: f.contentType, size: f.content.byteLength, s3Key };
  }));

  const from = { address: userEmail, name: displayName };
  const snippet = makeSnippet(body.bodyText, body.bodyHtml);
  const stored: StoredEmail = {
    pk: mailboxPk(userEmail),
    sk: `ts#${now.replace(/[:.]/g, "-")}#${messageId}`,
    mailboxFolder: mailboxFolderKey(userEmail, "sent"),
    messageId,
    from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject,
    snippet,
    searchText: makeSearchText({ from, to: body.to, cc: body.cc, subject, snippet }),
    ...await storeBodies(s3, BUCKET, `bodies/${messageId}.json`, body.bodyText, body.bodyHtml),
    inReplyTo: original?.messageId,
    references,
    attachments: attachments.length ? attachments : undefined,
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
  logger.info("Email sent", { from: userEmail, recipients: allRecipients.length, attachments: files.length });

  return json(200, { ok: true, data: { messageId } });
}

async function createUpload(event: APIGatewayProxyEvent, userEmail: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<UploadRequest>(event.body);
  if (!body?.filename || !body.contentType || typeof body.size !== "number") {
    return json(400, { ok: false, error: "filename, contentType and size required" });
  }
  if (body.size > MAX_UPLOAD_BYTES) return json(400, { ok: false, error: "Attachments are limited to 25 MB" });

  const s3Key = `uploads/${userEmail}/${randomUUID()}/${safeFilename(body.filename)}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: body.contentType }),
    { expiresIn: 900 },
  );
  return json(200, { ok: true, data: { s3Key, uploadUrl } });
}

async function updateEmail(
  event: APIGatewayProxyEvent,
  messageId: string,
  userEmail: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<Pick<StoredEmail, "read" | "starred" | "labels" | "folder">>>(event.body);
  if (!body) return json(400, { ok: false, error: "Body required" });

  const item = await findEmail(ddb, TABLE, userEmail, messageId);
  if (!item) return json(404, { ok: false, error: "Not found" });

  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (body.read !== undefined) { sets.push("#read = :read"); names["#read"] = "read"; values[":read"] = body.read; }
  if (body.starred !== undefined) { sets.push("starred = :starred"); values[":starred"] = body.starred; }
  if (body.labels !== undefined) { sets.push("labels = :labels"); values[":labels"] = body.labels; }
  if (body.folder !== undefined) {
    if (!isFolder(body.folder)) {
      return json(400, { ok: false, error: "Invalid folder" });
    }
    sets.push("folder = :folder", "mailboxFolder = :mf");
    values[":folder"] = body.folder;
    values[":mf"] = mailboxFolderKey(userEmail, body.folder);
  }

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
  const item = await findEmail(ddb, TABLE, userEmail, messageId);
  if (!item) return json(404, { ok: false, error: "Not found" });

  if (item.folder === "trash") {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: item.pk, sk: item.sk } }));
    return json(200, { ok: true, data: { deleted: true } });
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET folder = :trash, mailboxFolder = :mf",
    ExpressionAttributeValues: { ":trash": "trash", ":mf": mailboxFolderKey(userEmail, "trash") },
  }));

  return json(200, { ok: true, data: { deleted: false, folder: "trash" } });
}

async function getAttachment(
  event: APIGatewayProxyEvent,
  messageId: string,
  attachmentKey: string,
  userEmail: string,
): Promise<APIGatewayProxyResult> {
  const emailItem = await findEmail(ddb, TABLE, userEmail, messageId);
  if (!emailItem) return json(404, { ok: false, error: "Not found" });

  const decodedKey = decodeURIComponent(attachmentKey);
  const attachment = (emailItem.attachments ?? []).find(a => a.s3Key === decodedKey);
  if (!attachment) return json(403, { ok: false, error: "Forbidden" });

  const disposition = event.queryStringParameters?.inline === "1" ? "inline" : "attachment";
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: decodedKey,
      ResponseContentType: attachment.contentType,
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    }),
    { expiresIn: 300 }
  );

  return json(200, { ok: true, data: { url } });
}
