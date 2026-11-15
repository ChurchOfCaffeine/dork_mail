import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { MAIL_FOLDERS, type MailFolder, type StoredEmail } from "@dork-mail/shared";
import { countFolder, mailboxPk } from "./mail-store";

/**
 * Every write to a mailbox bumps one counter and appends one change log entry
 * in the same transaction, conditioned on the counter's previous value. The
 * log is read with strongly consistent queries, so JMAP /changes never skips
 * an entry that committed out of order.
 */

export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface ChangeEntry {
  created?: string[];
  updated?: string[];
  destroyed?: string[];
  /** Thread ids whose email list or members changed. */
  threads?: string[];
}

export interface Changes {
  created: string[];
  updated: string[];
  destroyed: string[];
  threads: string[];
  newState: number;
  hasMoreChanges: boolean;
}

const STATE_SK = "state";
const CHANGE_PREFIX = "chg#";
const CHANGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_COMMIT_ATTEMPTS = 20;

/** Items per transaction left after the counter and the log entry. */
export const MAX_ITEMS_PER_COMMIT = 98;

const changeSk = (modseq: number) => `${CHANGE_PREFIX}${String(modseq).padStart(12, "0")}`;

export class CommitConflict extends Error {
  /** Cancellation codes of the caller's items, without the counter and log entry. */
  constructor(readonly codes: (string | undefined)[]) {
    super("Transaction condition failed");
  }
}

export type FolderCounts = Record<MailFolder, { total: number; unread: number }>;

/** Signed changes to the per-folder email counts kept on the state item. */
export type CountDelta = Record<string, number>;

const totalAttr = (folder: MailFolder) => `n_${folder}`;
const unreadAttr = (folder: MailFolder) => `u_${folder}`;

export interface MailboxState {
  modseq: number;
  /** Null until `pnpm backfill` has counted the mailbox or it was created empty. */
  counts: FolderCounts | null;
}

export async function readMailboxState(ddb: DynamoDBDocumentClient, table: string, email: string): Promise<MailboxState> {
  const res = await ddb.send(new GetCommand({
    TableName: table,
    Key: { pk: mailboxPk(email), sk: STATE_SK },
    ConsistentRead: true,
  }));
  const item = res.Item ?? {};
  return {
    modseq: (item.modseq as number | undefined) ?? 0,
    counts: item.counted === true
      ? Object.fromEntries(MAIL_FOLDERS.map(f => [f, { total: item[totalAttr(f)] ?? 0, unread: item[unreadAttr(f)] ?? 0 }])) as FolderCounts
      : null,
  };
}

export async function readState(ddb: DynamoDBDocumentClient, table: string, email: string): Promise<number> {
  return (await readMailboxState(ddb, table, email)).modseq;
}

type Counted = Pick<StoredEmail, "folder" | "read">;

/** The count change of an email moving from `prev` to `next`; either side is absent for a create or destroy. */
export function countDelta(prev: Counted | undefined, next: Counted | undefined): CountDelta {
  const delta: CountDelta = {};
  const add = (e: Counted, sign: number) => {
    delta[totalAttr(e.folder)] = (delta[totalAttr(e.folder)] ?? 0) + sign;
    if (!e.read) delta[unreadAttr(e.folder)] = (delta[unreadAttr(e.folder)] ?? 0) + sign;
  };
  if (prev) add(prev, -1);
  if (next) add(next, 1);
  return delta;
}

export function sumDeltas(deltas: CountDelta[]): CountDelta {
  const sum: CountDelta = {};
  for (const d of deltas) for (const [k, v] of Object.entries(d)) sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

/** The mailbox state with counts for `folders`, read from the folder index when the mailbox has none kept yet. */
export async function stateWithCounts(
  ddb: DynamoDBDocumentClient,
  table: string,
  email: string,
  folders: readonly MailFolder[],
): Promise<{ modseq: number; counts: Partial<FolderCounts> }> {
  const state = await readMailboxState(ddb, table, email);
  if (state.counts) return { modseq: state.modseq, counts: state.counts };
  const counted = await Promise.all(folders.map(async f => {
    const [total, unread] = await Promise.all([
      countFolder(ddb, table, email, f, false),
      countFolder(ddb, table, email, f, true),
    ]);
    return [f, { total, unread }] as const;
  }));
  return { modseq: state.modseq, counts: Object.fromEntries(counted) };
}

/** Stores exact counts, unless the mailbox changed since `modseq` was read. Returns whether they were stored. */
export async function storeCounts(
  ddb: DynamoDBDocumentClient,
  table: string,
  email: string,
  modseq: number,
  counts: FolderCounts,
): Promise<boolean> {
  const values: Record<string, unknown> = { ":true": true, ":m": modseq };
  const names: Record<string, string> = {};
  const sets = MAIL_FOLDERS.flatMap((f, i) => {
    names[`#n${i}`] = totalAttr(f);
    names[`#u${i}`] = unreadAttr(f);
    values[`:n${i}`] = counts[f].total;
    values[`:u${i}`] = counts[f].unread;
    return [`#n${i} = :n${i}`, `#u${i} = :u${i}`];
  });
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { pk: mailboxPk(email), sk: STATE_SK },
      UpdateExpression: `SET counted = :true, modseq = :m, ${sets.join(", ")}`,
      ConditionExpression: modseq === 0 ? "attribute_not_exists(modseq) OR modseq = :m" : "modseq = :m",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Commits the caller's items with the next modseq and returns it. */
export async function commitChange(
  ddb: DynamoDBDocumentClient,
  table: string,
  email: string,
  change: ChangeEntry,
  items: (modseq: number) => TransactItem[],
  counts: CountDelta = {},
): Promise<number> {
  const pk = mailboxPk(email);
  const deltas = Object.entries(counts).filter(([, v]) => v !== 0);
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
    const current = await readState(ddb, table, email);
    const next = current + 1;
    const own = items(next);
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table,
              Key: { pk, sk: STATE_SK },
              UpdateExpression: "SET modseq = :next" + (deltas.length ? " ADD " + deltas.map((_, i) => `#c${i} :c${i}`).join(", ") : ""),
              ConditionExpression: current === 0 ? "attribute_not_exists(modseq) OR modseq = :cur" : "modseq = :cur",
              ...(deltas.length ? { ExpressionAttributeNames: Object.fromEntries(deltas.map(([k], i) => [`#c${i}`, k])) } : {}),
              ExpressionAttributeValues: {
                ":cur": current,
                ":next": next,
                ...Object.fromEntries(deltas.map(([, v], i) => [`:c${i}`, v])),
              },
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                pk,
                sk: changeSk(next),
                ...change,
                ttl: Math.floor(Date.now() / 1000) + CHANGE_TTL_SECONDS,
              },
            },
          },
          ...own,
        ],
      }));
      return next;
    } catch (err) {
      if ((err as Error).name !== "TransactionCanceledException") throw err;
      const codes = ((err as TransactionCanceledException).CancellationReasons ?? []).map(r => r.Code);
      if (codes[0] === "ConditionalCheckFailed") continue;
      if (codes.slice(2).includes("ConditionalCheckFailed")) throw new CommitConflict(codes.slice(2));
      throw err;
    }
  }
  throw new Error("Too much write contention on mailbox state");
}

/**
 * Merges log entries after `since`. Returns null when the log no longer
 * reaches back that far, which JMAP reports as cannotCalculateChanges.
 */
export async function readChanges(
  ddb: DynamoDBDocumentClient,
  table: string,
  email: string,
  since: number,
  current: number,
  maxChanges: number,
): Promise<Changes | null> {
  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  const threads = new Set<string>();
  const result = (newState: number, hasMoreChanges: boolean): Changes => ({
    created: [...created], updated: [...updated], destroyed: [...destroyed], threads: [...threads], newState, hasMoreChanges,
  });
  if (since === current) return result(current, false);

  let expected = since + 1;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
      ExpressionAttributeValues: { ":pk": mailboxPk(email), ":lo": changeSk(since + 1), ":hi": changeSk(current) },
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    for (const entry of (res.Items ?? []) as (ChangeEntry & { sk: string })[]) {
      if (entry.sk !== changeSk(expected)) return null;
      if (expected > since + 1 && created.size + updated.size + destroyed.size >= maxChanges) return result(expected - 1, true);
      for (const id of entry.threads ?? []) threads.add(id);
      for (const id of entry.created ?? []) created.add(id);
      for (const id of entry.updated ?? []) if (!created.has(id)) updated.add(id);
      for (const id of entry.destroyed ?? []) {
        updated.delete(id);
        if (!created.delete(id)) destroyed.add(id);
      }
      expected++;
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  if (expected !== current + 1) return null;
  return result(current, false);
}
