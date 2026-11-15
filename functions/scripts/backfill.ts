#!/usr/bin/env tsx
// Migration for mail indexed by older versions. Safe to re-run.
//   - sets mailboxFolder, snippet and searchText on mail items that lack them
//   - sets threadId and mailboxThread, which Email/get and Thread/get need
//   - writes attachments that were indexed but never stored in S3, by re-parsing the
//     raw .eml while it still exists (raw mail expires from S3 after 90 days)
//   - puts users in the user-index GSI, which the admin user list reads
//   - stores each mailbox's per-folder email counts, which Mailbox/get reads
// Run after terraform apply: pnpm backfill

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";
import { MAIL_FOLDERS, type StoredEmail, type User } from "@dork-mail/shared";
import { mailboxFolderKey, mailboxPk, mailboxThreadKey, makeSnippet, makeSearchText, threadIdFor } from "../src/lib/mail-store";
import { readMailboxState, storeCounts, type FolderCounts } from "../src/lib/mail-state";

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

const stats = { scanned: 0, indexed: 0, threaded: 0, attachmentsRestored: 0, rawExpired: 0, usersIndexed: 0, mailboxesCounted: 0 };

async function main() {
  const users: User[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: config.table,
      FilterExpression: "begins_with(sk, :ts) OR sk = :profile",
      ExpressionAttributeValues: { ":ts": "ts#", ":profile": "profile" },
      ExclusiveStartKey: startKey,
    }));
    const items = page.Items ?? [];
    users.push(...items.filter(i => i.sk === "profile") as User[]);
    const emails = items.filter(i => i.sk !== "profile") as StoredEmail[];
    stats.scanned += emails.length;
    await Promise.all(emails.map(async item => {
      await index(item);
      await thread(item);
      await restoreAttachments(item);
    }));
    startKey = page.LastEvaluatedKey;
    console.log(JSON.stringify(stats));
  } while (startKey);

  for (const user of users) {
    await indexUser(user);
    await countMailbox(user.email);
  }
  console.log(JSON.stringify(stats));
  console.log("Backfill complete.");
}

async function indexUser(user: User) {
  if (user.entity === "user") return;
  await ddb.send(new UpdateCommand({
    TableName: config.table,
    Key: { pk: user.pk, sk: user.sk },
    UpdateExpression: "SET entity = :user",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":user": "user" },
  }));
  stats.usersIndexed++;
}

/** Counts with consistent reads of the mailbox itself, retrying until no write lands mid-count. */
async function countMailbox(email: string) {
  for (;;) {
    const state = await readMailboxState(ddb, config.table, email);
    if (state.counts) return;
    const counts = Object.fromEntries(MAIL_FOLDERS.map(f => [f, { total: 0, unread: 0 }])) as FolderCounts;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new QueryCommand({
        TableName: config.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :ts)",
        ExpressionAttributeNames: { "#read": "read" },
        ExpressionAttributeValues: { ":pk": mailboxPk(email), ":ts": "ts#" },
        ProjectionExpression: "folder, #read",
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }));
      for (const item of (page.Items ?? []) as Pick<StoredEmail, "folder" | "read">[]) {
        const c = counts[item.folder];
        if (!c) continue;
        c.total++;
        if (item.read !== true) c.unread++;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    if (await storeCounts(ddb, config.table, email, state.modseq, counts)) {
      stats.mailboxesCounted++;
      return;
    }
  }
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

async function thread(item: StoredEmail) {
  if (item.threadId && item.mailboxThread) return;
  const threadId = threadIdFor(item);
  await ddb.send(new UpdateCommand({
    TableName: config.table,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET threadId = :t, mailboxThread = :mt",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":t": threadId, ":mt": mailboxThreadKey(item.pk.slice("mailbox#".length), threadId) },
  }));
  stats.threaded++;
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
