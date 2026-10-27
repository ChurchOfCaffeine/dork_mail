#!/usr/bin/env tsx
// One-time migration for mail indexed before the folder-index GSI existed. Safe to re-run.
//   - sets mailboxFolder, snippet and searchText on mail items that lack them
//   - writes attachments that were indexed but never stored in S3, by re-parsing the
//     raw .eml while it still exists (raw mail expires from S3 after 90 days)
// Run after terraform apply: pnpm backfill

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";
import type { StoredEmail } from "@dork-mail/shared";
import { mailboxFolderKey, makeSnippet, makeSearchText } from "../src/lib/mail-store";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(readFileSync(resolve(repoRoot, "deploy.json"), "utf8")) as {
  region: string;
  table: string;
  email_bucket: string;
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: config.region });

const stats = { scanned: 0, indexed: 0, attachmentsRestored: 0, rawExpired: 0 };

async function main() {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: config.table,
      FilterExpression: "begins_with(sk, :ts)",
      ExpressionAttributeValues: { ":ts": "ts#" },
      ExclusiveStartKey: startKey,
    }));
    const items = (page.Items ?? []) as StoredEmail[];
    stats.scanned += items.length;
    await Promise.all(items.map(async item => {
      await index(item);
      await restoreAttachments(item);
    }));
    startKey = page.LastEvaluatedKey;
    console.log(JSON.stringify(stats));
  } while (startKey);
  console.log("Backfill complete.");
}

async function index(item: StoredEmail) {
  if (item.mailboxFolder && item.searchText) return;
  const mailbox = item.pk.slice("mailbox#".length);
  const snippet = makeSnippet(item.bodyText, item.bodyHtml);
  await ddb.send(new UpdateCommand({
    TableName: config.table,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET mailboxFolder = :mf, searchText = :st" + (snippet ? ", snippet = :sn" : ""),
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: {
      ":mf": mailboxFolderKey(mailbox, item.folder),
      ":st": makeSearchText({ ...item, snippet }),
      ":sn": snippet,
    },
  }));
  stats.indexed++;
}

async function restoreAttachments(item: StoredEmail) {
  if (!item.attachments?.length || !item.rawKey) return;
  if (await exists(item.attachments[0].s3Key)) return;

  let raw: Buffer;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: config.email_bucket, Key: item.rawKey }));
    raw = Buffer.from(await obj.Body!.transformToByteArray());
  } catch {
    stats.rawExpired++;
    return;
  }

  // Same parse the original ingest did, so attachment order matches the stored keys.
  const parsed = await simpleParser(raw);
  await Promise.all(item.attachments.map((a, i) => {
    const part = parsed.attachments[i];
    if (!part) return;
    return s3.send(new PutObjectCommand({ Bucket: config.email_bucket, Key: a.s3Key, Body: part.content, ContentType: a.contentType }));
  }));
  stats.attachmentsRestored++;
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.email_bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
