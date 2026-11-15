import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { MAIL_FOLDERS, type EmailSummary, type MailFolder } from "@dork-mail/shared";
import { FOLDER_INDEX, SUMMARY_FIELDS, emailSk, mailboxFolderKey } from "../lib/mail-store";
import { readState, stateWithCounts } from "../lib/mail-state";
import { MethodError, type Args, type Ctx } from "./context";
import { hasAttachment, keywordsOf } from "./email";
import { emailIdFor } from "./ids";
import { isMailboxId } from "./mailbox";

type Filter = Args;

const CONDITIONS = new Set([
  "inMailbox", "inMailboxOtherThan", "before", "after", "hasKeyword", "notKeyword",
  "hasAttachment", "text", "from", "to", "cc", "bcc", "subject", "body",
]);
const MAX_LIMIT = 1000;
const PAGE_SIZE = 500;

function validate(filter: Filter | null | undefined): void {
  if (!filter) return;
  if ("operator" in filter) {
    if (!["AND", "OR", "NOT"].includes(filter.operator as string) || !Array.isArray(filter.conditions)) {
      throw new MethodError("invalidArguments", "Malformed filter operator");
    }
    for (const c of filter.conditions as Filter[]) validate(c);
    return;
  }
  for (const key of Object.keys(filter)) {
    if (!CONDITIONS.has(key)) throw new MethodError("unsupportedFilter", `Filter ${key} is not supported`);
  }
}

const terms = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
const containsAll = (haystack: string, needle: string) => terms(needle).every(t => haystack.includes(t));
const addressText = (list: EmailSummary["to"] | undefined) =>
  (list ?? []).flatMap(a => [a.name, a.address]).filter(Boolean).join(" ").toLowerCase();

function matches(filter: Filter | null | undefined, e: EmailSummary): boolean {
  if (!filter) return true;
  if ("operator" in filter) {
    const results = (filter.conditions as Filter[]).map(c => matches(c, e));
    if (filter.operator === "AND") return results.every(Boolean);
    if (filter.operator === "OR") return results.some(Boolean);
    return !results.some(Boolean);
  }
  const keywords = keywordsOf(e);
  for (const [key, value] of Object.entries(filter)) {
    const ok = (() => {
      switch (key) {
        case "inMailbox": return e.folder === value;
        case "inMailboxOtherThan": return !(value as string[]).includes(e.folder);
        case "before": return Date.parse(e.receivedAt) < Date.parse(value as string);
        case "after": return Date.parse(e.receivedAt) >= Date.parse(value as string);
        case "hasKeyword": return keywords[(value as string).toLowerCase()] === true;
        case "notKeyword": return keywords[(value as string).toLowerCase()] !== true;
        case "hasAttachment": return hasAttachment(e.attachments) === value;
        case "text": case "body": return containsAll(e.searchText ?? "", value as string);
        case "from": return containsAll(addressText([e.from]), value as string);
        case "to": return containsAll(addressText(e.to), value as string);
        case "cc": return containsAll(addressText(e.cc), value as string);
        case "bcc": return false;
        case "subject": return containsAll(e.subject.toLowerCase(), value as string);
        default: return false;
      }
    })();
    if (!ok) return false;
  }
  return true;
}

/** Folders and the time window a top-level AND pins down, so only those partitions and ranges are read. */
function scope(filter: Filter | null | undefined): { folders: MailFolder[]; after?: string; before?: string } {
  let folders: MailFolder[] = [...MAIL_FOLDERS];
  let after: string | undefined;
  let before: string | undefined;
  const conditions = !filter ? [] : "operator" in filter ? (filter.operator === "AND" ? filter.conditions as Filter[] : []) : [filter];
  for (const c of conditions) {
    if ("operator" in c) continue;
    if (typeof c.inMailbox === "string") folders = folders.filter(f => f === c.inMailbox);
    if (Array.isArray(c.inMailboxOtherThan)) folders = folders.filter(f => !(c.inMailboxOtherThan as string[]).includes(f));
    if (typeof c.after === "string" && (!after || c.after > after)) after = c.after;
    if (typeof c.before === "string" && (!before || c.before < before)) before = c.before;
  }
  return { folders, after, before };
}

async function* folderStream(ctx: Ctx, folder: MailFolder, ascending: boolean, after?: string, before?: string) {
  const names: Record<string, string> = Object.fromEntries(SUMMARY_FIELDS.map((f, i) => [`#f${i}`, f]));
  const values: Record<string, unknown> = { ":mf": mailboxFolderKey(ctx.email, folder) };
  let range = "";
  if (after || before) {
    names["#sk"] = "sk";
    values[":lo"] = after ? emailSk(new Date(after).toISOString(), "") : "ts#";
    values[":hi"] = before ? emailSk(new Date(before).toISOString(), "") : "ts$";
    range = " AND #sk BETWEEN :lo AND :hi";
  }
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.ddb.send(new QueryCommand({
      TableName: ctx.table,
      IndexName: FOLDER_INDEX,
      KeyConditionExpression: `mailboxFolder = :mf${range}`,
      ProjectionExpression: SUMMARY_FIELDS.map((_, i) => `#f${i}`).join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: ascending,
      Limit: PAGE_SIZE,
      ExclusiveStartKey: startKey,
    }));
    for (const item of res.Items ?? []) yield item as EmailSummary;
    startKey = res.LastEvaluatedKey;
  } while (startKey);
}

/** Merges the per-folder streams by sort key. */
async function* merged(ctx: Ctx, folders: MailFolder[], ascending: boolean, after?: string, before?: string) {
  const streams = folders.map(f => folderStream(ctx, f, ascending, after, before));
  const heads = await Promise.all(streams.map(s => s.next()));
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (head.done) continue;
      const bestHead = best >= 0 ? heads[best] : undefined;
      if (!bestHead || bestHead.done || (ascending ? head.value.sk < bestHead.value.sk : head.value.sk > bestHead.value.sk)) best = i;
    }
    if (best < 0) return;
    const head = heads[best];
    if (head.done) return;
    yield head.value;
    heads[best] = await streams[best].next();
  }
}

function sortDirection(sort: unknown): boolean {
  if (sort === undefined || sort === null) return false;
  if (!Array.isArray(sort)) throw new MethodError("invalidArguments", "sort must be a list");
  const [first, ...rest] = sort as Args[];
  if (!first) return false;
  const byDate = (c: Args) => c.property === "receivedAt" || c.property === "sentAt";
  if (!byDate(first) || rest.some(c => !byDate(c))) throw new MethodError("unsupportedSort", "Only receivedAt and sentAt sorts are supported");
  return first.isAscending === true;
}

export async function emailQuery(ctx: Ctx, args: Args): Promise<Args> {
  const filter = args.filter as Filter | null | undefined;
  validate(filter);
  const ascending = sortDirection(args.sort);
  const collapse = args.collapseThreads === true;
  const limit = Math.min(Math.max(Number(args.limit ?? MAX_LIMIT) || 0, 0), MAX_LIMIT);
  let position = Number(args.position ?? 0) || 0;
  const anchor = args.anchor as string | undefined;
  const anchorOffset = Number(args.anchorOffset ?? 0) || 0;
  const needTotal = args.calculateTotal === true || position < 0 || anchor !== undefined;

  const { folders, after, before } = scope(filter);
  const validFolders = folders.filter(isMailboxId);
  const countOnly = args.calculateTotal === true && position >= 0 && anchor === undefined && !collapse && folderOnly(filter);
  const { modseq: state, counts } = countOnly
    ? await stateWithCounts(ctx.ddb, ctx.table, ctx.email, validFolders)
    : { modseq: await readState(ctx.ddb, ctx.table, ctx.email), counts: undefined };
  const counted = counts && validFolders.reduce((n, f) => n + counts[f]!.total, 0);
  if (counted !== undefined) {
    const ids: string[] = [];
    let seen = 0;
    for await (const e of merged(ctx, validFolders, ascending)) {
      if (ids.length >= limit) break;
      if (seen++ >= position) ids.push(emailIdFor(e.sk));
    }
    return { accountId: ctx.accountId, queryState: String(state), canCalculateChanges: false, position, ids, total: counted };
  }

  const ids: string[] = [];
  const seenThreads = new Set<string>();
  let total = 0;
  let anchorIndex = -1;
  const all: string[] | null = position < 0 || anchor !== undefined ? [] : null;

  for await (const e of merged(ctx, validFolders, ascending, after, before)) {
    if (!matches(filter, e)) continue;
    if (collapse) {
      if (seenThreads.has(e.threadId)) continue;
      seenThreads.add(e.threadId);
    }
    const id = emailIdFor(e.sk);
    if (all) {
      all.push(id);
      if (id === anchor) anchorIndex = total;
    } else if (total >= position && ids.length < limit) {
      ids.push(id);
    }
    total++;
    if (!needTotal && ids.length >= limit) break;
  }

  if (all) {
    if (anchor !== undefined) {
      if (anchorIndex < 0) throw new MethodError("anchorNotFound");
      position = Math.max(0, anchorIndex + anchorOffset);
    } else {
      position = Math.max(0, total + position);
    }
    ids.push(...all.slice(position, position + limit));
  }

  return {
    accountId: ctx.accountId,
    queryState: String(state),
    canCalculateChanges: false,
    position,
    ids,
    ...(args.calculateTotal === true ? { total } : {}),
    ...(Number(args.limit) > MAX_LIMIT ? { limit } : {}),
  };
}

function folderOnly(filter: Filter | null | undefined): boolean {
  if (!filter) return true;
  const conditions = "operator" in filter ? (filter.operator === "AND" ? filter.conditions as Filter[] : null) : [filter];
  return !!conditions && conditions.every(c => !("operator" in c) && Object.keys(c).every(k => k === "inMailbox" || k === "inMailboxOtherThan"));
}

export async function emailQueryChanges(): Promise<Args> {
  throw new MethodError("cannotCalculateChanges");
}
