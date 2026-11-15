import { createHash } from "node:crypto";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { StoredEmail, EmailSummary, MailFolder } from "@dork-mail/shared";

export const FOLDER_INDEX = "folder-index";
export const MESSAGE_INDEX = "message-index";
export const THREAD_INDEX = "thread-index";

// Must match non_key_attributes of folder-index in terraform/dynamo.tf.
export const SUMMARY_FIELDS: (keyof EmailSummary)[] = [
  "sk", "messageId", "threadId", "from", "to", "cc", "subject", "snippet", "searchText",
  "receivedAt", "read", "starred", "labels", "folder", "attachments",
];

// DynamoDB items cap at 400KB including every other attribute.
const MAX_INLINE_BODY_BYTES = 300_000;

export const mailboxPk = (email: string) => `mailbox#${email}`;
export const mailboxFolderKey = (email: string, folder: MailFolder) => `mailbox#${email}#${folder}`;
export const mailboxThreadKey = (email: string, threadId: string) => `mailbox#${email}#${threadId}`;
export const emailSk = (receivedAt: string, messageId: string) => `ts#${receivedAt.replace(/[:.]/g, "-")}#${messageId}`;

/**
 * Threads by the first References entry, which RFC 5322 says replies keep, so
 * every message in a conversation hashes the same root without a lookup.
 */
export function threadIdFor(e: Pick<StoredEmail, "messageId" | "inReplyTo" | "references">): string {
  const root = e.references?.[0] ?? e.inReplyTo ?? e.messageId;
  return "T" + createHash("sha256").update(root).digest("base64url").slice(0, 22);
}

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

export async function countFolder(
  ddb: DynamoDBDocumentClient,
  table: string,
  userEmail: string,
  folder: MailFolder,
  unreadOnly: boolean,
): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: FOLDER_INDEX,
      KeyConditionExpression: "mailboxFolder = :mf",
      FilterExpression: unreadOnly ? "#read = :false" : undefined,
      ExpressionAttributeNames: unreadOnly ? { "#read": "read" } : undefined,
      ExpressionAttributeValues: unreadOnly
        ? { ":mf": mailboxFolderKey(userEmail, folder), ":false": false }
        : { ":mf": mailboxFolderKey(userEmail, folder) },
      Select: "COUNT",
      ExclusiveStartKey: startKey,
    }));
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return count;
}
