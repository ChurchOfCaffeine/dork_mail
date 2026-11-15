import { randomUUID } from "node:crypto";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Attachment, EmailAddress, MailFolder, StoredEmail, User } from "@dork-mail/shared";
import {
  emailSk, mailboxFolderKey, mailboxPk, mailboxThreadKey, makeSearchText, makeSnippet, storeBodies, threadIdFor,
} from "../lib/mail-store";
import {
  MAX_ITEMS_PER_COMMIT, commitChange, countDelta, readState, sumDeltas, type CountDelta, type TransactItem,
} from "../lib/mail-state";
import { MethodError, idsArg, resolveId, setError, type Args, type Ctx, type SetError } from "./context";
import { estimateSize, getItems, keywordsOf } from "./email";
import { resolveBlob } from "./blobs";
import { emailIdFor, rawBlobId } from "./ids";
import { isMailboxId } from "./mailbox";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_SET = 100;

export interface Write {
  id: string;
  kind: "created" | "updated" | "destroyed";
  threadIds: string[];
  item: TransactItem;
  counts: CountDelta;
}

/** Commits writes in transactions of up to MAX_ITEMS_PER_COMMIT and returns the final state. */
export async function commitWrites(ctx: Ctx, writes: Write[]): Promise<number> {
  let state = await readState(ctx.ddb, ctx.table, ctx.email);
  for (let i = 0; i < writes.length; i += MAX_ITEMS_PER_COMMIT) {
    const chunk = writes.slice(i, i + MAX_ITEMS_PER_COMMIT);
    const ids = (kind: Write["kind"]) => chunk.filter(w => w.kind === kind).map(w => w.id);
    state = await commitChange(ctx.ddb, ctx.table, ctx.email, {
      created: ids("created"),
      updated: ids("updated"),
      destroyed: ids("destroyed"),
      threads: [...new Set(chunk.flatMap(w => w.threadIds))],
    }, () => chunk.map(w => w.item), sumDeltas(chunk.map(w => w.counts)));
  }
  return state;
}

type Counted = Pick<StoredEmail, "folder" | "read">;

/** Fails the transaction when the item's folder or read flag moved since it was read, which would skew the counts. */
function expectCounted(expect: Counted) {
  return {
    condition: `attribute_exists(pk) AND #xf = :xf AND ${expect.read ? "#xr = :xr" : "(attribute_not_exists(#xr) OR #xr = :xr)"}`,
    names: { "#xf": "folder", "#xr": "read" },
    values: { ":xf": expect.folder, ":xr": expect.read === true },
  };
}

export function updateItem(ctx: Ctx, sk: string, fields: Record<string, unknown>, expect: Counted): TransactItem {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const guard = expectCounted(expect);
  return {
    Update: {
      TableName: ctx.table,
      Key: { pk: mailboxPk(ctx.email), sk },
      UpdateExpression: "SET " + entries.map((_, i) => `#k${i} = :v${i}`).join(", "),
      ConditionExpression: guard.condition,
      ExpressionAttributeNames: { ...Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])), ...guard.names },
      ExpressionAttributeValues: { ...Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])), ...guard.values },
    },
  };
}

export function destroyItem(ctx: Ctx, item: StoredEmail): TransactItem {
  const guard = expectCounted(item);
  return {
    Delete: {
      TableName: ctx.table,
      Key: { pk: item.pk, sk: item.sk },
      ConditionExpression: guard.condition,
      ExpressionAttributeNames: guard.names,
      ExpressionAttributeValues: guard.values,
    },
  };
}

/** Bodies under the account's own prefix belong to exactly one email; inbound bodies can be shared by every recipient. */
export async function deleteOwnBodies(ctx: Ctx, items: Pick<StoredEmail, "bodyKey">[]): Promise<void> {
  const prefix = `bodies/${ctx.accountId}/`;
  await Promise.all(items
    .filter(i => i.bodyKey?.startsWith(prefix))
    .map(i => ctx.s3.send(new DeleteObjectCommand({ Bucket: ctx.bucket, Key: i.bodyKey })).catch(() => undefined)));
}

const unescapePointer = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

export type PatchResult = { folder: MailFolder; read: boolean; starred: boolean; labels: string[] };

/** Applies an Email/set update patch. Only keywords and mailboxIds are mutable. */
export function applyPatch(item: StoredEmail, patch: Args): PatchResult | SetError {
  const mailboxes = new Set<string>([item.folder]);
  let keywords: Record<string, boolean> = { ...keywordsOf(item) };
  for (const [path, value] of Object.entries(patch)) {
    if (path === "keywords") {
      if (!value || typeof value !== "object") return setError("invalidProperties", undefined, ["keywords"]);
      keywords = Object.fromEntries(Object.entries(value as Args).filter(([, v]) => v === true).map(([k]) => [k.toLowerCase(), true]));
    } else if (path.startsWith("keywords/")) {
      const keyword = unescapePointer(path.slice("keywords/".length)).toLowerCase();
      if (value === true) keywords[keyword] = true;
      else if (value === null || value === false) delete keywords[keyword];
      else return setError("invalidProperties", undefined, [path]);
    } else if (path === "mailboxIds") {
      if (!value || typeof value !== "object") return setError("invalidProperties", undefined, ["mailboxIds"]);
      mailboxes.clear();
      for (const [id, on] of Object.entries(value as Args)) if (on === true) mailboxes.add(id);
    } else if (path.startsWith("mailboxIds/")) {
      const id = unescapePointer(path.slice("mailboxIds/".length));
      if (value === true) mailboxes.add(id);
      else if (value === null || value === false) mailboxes.delete(id);
      else return setError("invalidProperties", undefined, [path]);
    } else {
      return setError("invalidProperties", `${path} cannot be changed`, [path]);
    }
  }
  if (mailboxes.size !== 1) return setError("invalidProperties", "An email must be in exactly one mailbox", ["mailboxIds"]);
  const [folder] = mailboxes;
  if (!isMailboxId(folder)) return setError("invalidProperties", `Unknown mailbox ${folder}`, ["mailboxIds"]);
  return {
    folder,
    read: keywords.$seen === true,
    starred: keywords.$flagged === true,
    labels: Object.keys(keywords).filter(k => k !== "$seen" && k !== "$flagged"),
  };
}

export function patchFields(ctx: Ctx, p: PatchResult): Record<string, unknown> {
  return { folder: p.folder, mailboxFolder: mailboxFolderKey(ctx.email, p.folder), read: p.read, starred: p.starred, labels: p.labels };
}

const fromJmap = (list: unknown): EmailAddress[] | undefined => Array.isArray(list) && list.length
  ? (list as Args[]).map(a => ({ address: String(a.email ?? "").toLowerCase().trim(), ...(a.name ? { name: String(a.name) } : {}) }))
  : undefined;

interface Leaf { partId?: string; blobId?: string; type?: string; name?: string; cid?: string; disposition?: string }

function leaves(part: Args | undefined): Leaf[] {
  if (!part) return [];
  if (Array.isArray(part.subParts)) return (part.subParts as Args[]).flatMap(leaves);
  return [part as Leaf];
}

async function displayName(ctx: Ctx): Promise<string | undefined> {
  const res = await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `user#${ctx.email}`, sk: "profile" } }));
  return (res.Item as User | undefined)?.displayName;
}

async function buildEmail(ctx: Ctx, obj: Args): Promise<StoredEmail | SetError> {
  const mailboxIds = Object.entries((obj.mailboxIds ?? {}) as Args).filter(([, v]) => v === true).map(([k]) => k);
  if (mailboxIds.length !== 1 || !isMailboxId(mailboxIds[0])) {
    return setError("invalidProperties", "An email must be in exactly one known mailbox", ["mailboxIds"]);
  }
  const folder = mailboxIds[0];
  const keywords = Object.entries((obj.keywords ?? {}) as Args).filter(([, v]) => v === true).map(([k]) => k.toLowerCase());

  const values = (obj.bodyValues ?? {}) as Record<string, { value?: string }>;
  const parts = obj.bodyStructure
    ? leaves(obj.bodyStructure as Args)
    : [...(obj.textBody as Leaf[] ?? []), ...(obj.htmlBody as Leaf[] ?? []), ...(obj.attachments as Leaf[] ?? [])];

  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  const attachments: Attachment[] = [];
  for (const part of parts) {
    if (part.partId && values[part.partId]) {
      const value = values[part.partId].value ?? "";
      if (part.type === "text/html") bodyHtml ??= value;
      else bodyText ??= value;
      continue;
    }
    if (!part.blobId) continue;
    const blob = await resolveBlob(ctx, part.blobId);
    if (!blob || blob.kind !== "s3") return { ...setError("blobNotFound"), notFound: [part.blobId] } as SetError;
    attachments.push({
      filename: part.name ?? blob.name ?? "attachment",
      contentType: part.type ?? blob.type,
      size: blob.size ?? 0,
      s3Key: blob.key,
      ...(part.cid ? { contentId: part.cid.replace(/^<|>$/g, "") } : {}),
    });
  }
  if (attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENT_BYTES) {
    return setError("tooLarge", "Attachments exceed 25 MB");
  }

  const from = fromJmap(obj.from)?.[0] ?? { address: ctx.email, name: await displayName(ctx) };
  const to = fromJmap(obj.to) ?? [];
  const cc = fromJmap(obj.cc);
  const subject = typeof obj.subject === "string" ? obj.subject.replace(/[\r\n]/g, "") : "";
  const receivedAt = typeof obj.receivedAt === "string" ? new Date(obj.receivedAt).toISOString() : new Date().toISOString();
  const sentAt = typeof obj.sentAt === "string" ? new Date(obj.sentAt).toISOString() : undefined;
  const messageId = (obj.messageId as string[] | undefined)?.[0] ?? `${randomUUID()}@${ctx.domain}`;
  const inReplyTo = (obj.inReplyTo as string[] | undefined)?.[0];
  const references = (obj.references as string[] | undefined)?.length ? obj.references as string[] : undefined;
  const snippet = makeSnippet(bodyText, bodyHtml);
  const threadId = threadIdFor({ messageId, inReplyTo, references });

  const email: StoredEmail = {
    pk: mailboxPk(ctx.email),
    sk: emailSk(receivedAt, messageId),
    mailboxFolder: mailboxFolderKey(ctx.email, folder),
    threadId,
    mailboxThread: mailboxThreadKey(ctx.email, threadId),
    messageId,
    from,
    to,
    cc,
    bcc: fromJmap(obj.bcc),
    replyTo: fromJmap(obj.replyTo),
    subject,
    snippet,
    searchText: makeSearchText({ from, to, cc, subject, snippet }),
    ...await storeBodies(ctx.s3, ctx.bucket, `bodies/${ctx.accountId}/${randomUUID()}.json`, bodyText, bodyHtml),
    inReplyTo,
    references,
    attachments: attachments.length ? attachments : undefined,
    rawKey: "",
    receivedAt,
    sentAt,
    read: keywords.includes("$seen"),
    starred: keywords.includes("$flagged"),
    labels: keywords.filter(k => k !== "$seen" && k !== "$flagged"),
    folder,
  };
  email.size = estimateSize({ ...email, bodyText, bodyHtml });
  return email;
}

export async function emailSet(ctx: Ctx, args: Args): Promise<Args> {
  const oldState = await readState(ctx.ddb, ctx.table, ctx.email);
  if (args.ifInState !== undefined && args.ifInState !== null && String(args.ifInState) !== String(oldState)) {
    throw new MethodError("stateMismatch");
  }
  const create = (args.create ?? {}) as Record<string, Args>;
  const update = (args.update ?? {}) as Record<string, Args>;
  const destroy = (idsArg(args, "destroy", MAX_SET) ?? []).map(id => resolveId(ctx, id));
  if (Object.keys(create).length + Object.keys(update).length + destroy.length > MAX_SET) {
    throw new MethodError("requestTooLarge", `At most ${MAX_SET} objects per call`);
  }

  const writes: Write[] = [];
  const created: Record<string, Args> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  // Emails created by this call, which its updates and destroys apply to before anything is written.
  const pending = new Map<string, { write: Write; email: StoredEmail }>();
  for (const [cid, obj] of Object.entries(create)) {
    const email = await buildEmail(ctx, obj);
    if ("type" in email) { notCreated[cid] = email; continue; }
    const id = emailIdFor(email.sk);
    const write: Write = {
      id, kind: "created", threadIds: [email.threadId],
      item: { Put: { TableName: ctx.table, Item: email, ConditionExpression: "attribute_not_exists(pk)" } },
      counts: countDelta(undefined, email),
    };
    writes.push(write);
    pending.set(id, { write, email });
    created[cid] = { id, blobId: rawBlobId(id), threadId: email.threadId, size: email.size };
    ctx.createdIds.set(cid, id);
  }

  const updateIds = Object.keys(update).map(id => resolveId(ctx, id));
  const existing = await getItems(ctx, [...updateIds, ...destroy].filter(id => !pending.has(id)), false);

  for (const [rawId, patch] of Object.entries(update)) {
    const id = resolveId(ctx, rawId);
    const fresh = pending.get(id);
    const item = fresh?.email ?? existing.get(id);
    if (!item) { notUpdated[rawId] = setError("notFound"); continue; }
    const result = applyPatch(item, patch);
    if ("type" in result) { notUpdated[rawId] = result; continue; }
    if (fresh) {
      Object.assign(fresh.email, patchFields(ctx, result));
      fresh.write.counts = countDelta(undefined, fresh.email);
    } else {
      writes.push({
        id, kind: "updated", threadIds: [item.threadId ?? threadIdFor(item)],
        item: updateItem(ctx, item.sk, patchFields(ctx, result), item),
        counts: countDelta(item, result),
      });
    }
    updated[rawId] = null;
  }

  const gone: StoredEmail[] = [];
  for (const id of destroy) {
    const fresh = pending.get(id);
    if (fresh) {
      writes.splice(writes.indexOf(fresh.write), 1);
      pending.delete(id);
      gone.push(fresh.email);
      destroyed.push(id);
      continue;
    }
    const item = existing.get(id);
    if (!item) { notDestroyed[id] = setError("notFound"); continue; }
    writes.push({ id, kind: "destroyed", threadIds: [item.threadId ?? threadIdFor(item)], item: destroyItem(ctx, item), counts: countDelta(item, undefined) });
    gone.push(item);
    destroyed.push(id);
  }

  const newState = writes.length ? await commitWrites(ctx, writes) : oldState;
  await deleteOwnBodies(ctx, gone);
  return {
    accountId: ctx.accountId,
    oldState: String(oldState),
    newState: String(newState),
    created: Object.keys(created).length ? created : null,
    updated: Object.keys(updated).length ? updated : null,
    destroyed: destroyed.length ? destroyed : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}
