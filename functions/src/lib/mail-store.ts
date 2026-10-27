import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { StoredEmail, EmailSummary, MailFolder } from "@dork-mail/shared";

export const FOLDER_INDEX = "folder-index";
export const MESSAGE_INDEX = "message-index";

export const SUMMARY_FIELDS: (keyof EmailSummary)[] = [
  "messageId", "from", "to", "cc", "subject", "snippet", "receivedAt", "read", "starred", "labels", "folder", "attachments",
];

// DynamoDB items cap at 400KB including every other attribute.
const MAX_INLINE_BODY_BYTES = 300_000;

export const mailboxPk = (email: string) => `mailbox#${email}`;
export const mailboxFolderKey = (email: string, folder: MailFolder) => `mailbox#${email}#${folder}`;

export function makeSnippet(text?: string, html?: string): string | undefined {
  const source = text || (html ? htmlToText(html) : "");
  const unquoted = source.split("\n").filter(line => !line.trimStart().startsWith(">")).join(" ");
  return unquoted.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", zwj: "" };

function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(\w+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[͏​-‍⁠﻿­]/g, "");
}

export function makeSearchText(e: Pick<StoredEmail, "from" | "to" | "cc" | "subject" | "snippet">): string {
  const addrs = [e.from, ...e.to, ...(e.cc ?? [])].flatMap(a => [a.name, a.address]);
  return [...addrs, e.subject, e.snippet].filter(Boolean).join(" ").toLowerCase();
}

/** Inline bodies when they fit in the item, otherwise write them to S3 and return the key. */
export async function storeBodies(
  s3: S3Client,
  bucket: string,
  key: string,
  bodyText: string | undefined,
  bodyHtml: string | undefined,
): Promise<Pick<StoredEmail, "bodyText" | "bodyHtml" | "bodyKey">> {
  const size = Buffer.byteLength(bodyText ?? "") + Buffer.byteLength(bodyHtml ?? "");
  if (size <= MAX_INLINE_BODY_BYTES) return { bodyText, bodyHtml };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify({ bodyText, bodyHtml }),
    ContentType: "application/json",
  }));
  return { bodyKey: key };
}

export async function loadBodies(s3: S3Client, bucket: string, item: StoredEmail): Promise<void> {
  if (!item.bodyKey) return;
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: item.bodyKey }));
  const bodies = JSON.parse(await obj.Body!.transformToString("utf-8"));
  item.bodyText = bodies.bodyText;
  item.bodyHtml = bodies.bodyHtml;
}

export async function findEmail(
  ddb: DynamoDBDocumentClient,
  table: string,
  userEmail: string,
  messageId: string,
): Promise<StoredEmail | undefined> {
  const keys = await ddb.send(new QueryCommand({
    TableName: table,
    IndexName: MESSAGE_INDEX,
    KeyConditionExpression: "pk = :pk AND messageId = :mid",
    ExpressionAttributeValues: { ":pk": mailboxPk(userEmail), ":mid": messageId },
    Limit: 1,
  }));
  const key = keys.Items?.[0];
  if (!key) return undefined;
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }));
  return res.Item as StoredEmail | undefined;
}

export async function countUnread(
  ddb: DynamoDBDocumentClient,
  table: string,
  userEmail: string,
  folder: MailFolder,
): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: FOLDER_INDEX,
      KeyConditionExpression: "mailboxFolder = :mf",
      FilterExpression: "#read = :false",
      ExpressionAttributeNames: { "#read": "read" },
      ExpressionAttributeValues: { ":mf": mailboxFolderKey(userEmail, folder), ":false": false },
      Select: "COUNT",
      ExclusiveStartKey: startKey,
    }));
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return count;
}
