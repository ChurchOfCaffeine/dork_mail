import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Attachment, EmailAddress, StoredEmail } from "@dork-mail/shared";
import { THREAD_INDEX, loadBodies, mailboxPk, mailboxThreadKey, threadIdFor } from "../lib/mail-store";
import { readChanges, readState } from "../lib/mail-state";
import { MethodError, idsArg, toUtcDate, type Args, type Ctx } from "./context";
import { attachmentBlobId, emailIdFor, htmlBlobId, rawBlobId, skFor, textBlobId } from "./ids";

const DEFAULT_PROPERTIES = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo",
  "references", "sender", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt", "hasAttachment",
  "preview", "bodyValues", "textBody", "htmlBody", "attachments",
];
const DEFAULT_BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "language", "location"];
const BODY_PROPERTIES = ["bodyStructure", "textBody", "htmlBody", "bodyValues", "attachments"];
const NON_BODY_ATTRIBUTES = [
  "pk", "sk", "messageId", "threadId", "from", "to", "cc", "bcc", "replyTo", "subject", "snippet", "inReplyTo",
  "references", "attachments", "rawKey", "size", "receivedAt", "sentAt", "read", "starred", "labels", "folder", "bodyKey",
];
const MAX_GET = 500;

export function keywordsOf(e: Pick<StoredEmail, "read" | "starred" | "labels">): Record<string, true> {
  const keywords: Record<string, true> = {};
  if (e.read) keywords.$seen = true;
  if (e.starred) keywords.$flagged = true;
  for (const label of e.labels ?? []) keywords[label.toLowerCase()] = true;
  return keywords;
}

/** Without the HTML body to check, any attachment with a Content-ID counts as inline. */
export function isInline(a: Attachment, html?: string): boolean {
  if (!a.contentId) return false;
  return html === undefined || html.includes(`cid:${a.contentId}`);
}

export const hasAttachment = (attachments: Attachment[] | undefined, html?: string) =>
  (attachments ?? []).some(a => !isInline(a, html));

export function toJmapAddresses(list: EmailAddress[] | undefined): Args[] | null {
  return list?.length ? list.map(a => ({ name: a.name ?? null, email: a.address })) : null;
}

export function estimateSize(e: Pick<StoredEmail, "size" | "bodyText" | "bodyHtml" | "attachments" | "snippet">): number {
  if (e.size) return e.size;
  const attachments = (e.attachments ?? []).reduce((n, a) => n + Math.ceil(a.size * 4 / 3), 0);
  return attachments + Buffer.byteLength(e.bodyText ?? e.snippet ?? "") + Buffer.byteLength(e.bodyHtml ?? "");
}

export async function getItems(ctx: Ctx, ids: string[], withBodies: boolean): Promise<Map<string, StoredEmail>> {
  const keys = new Map<string, string>();
  for (const id of ids) {
    const sk = skFor(id);
    if (sk) keys.set(sk, id);
  }
  const found = new Map<string, StoredEmail>();
  const pending = [...keys.keys()];
  const names = Object.fromEntries(NON_BODY_ATTRIBUTES.map((a, i) => [`#a${i}`, a]));
  for (let i = 0; i < pending.length; i += 100) {
    let batch: Record<string, unknown>[] = pending.slice(i, i + 100).map(sk => ({ pk: mailboxPk(ctx.email), sk }));
    while (batch.length) {
      const res = await ctx.ddb.send(new BatchGetCommand({
        RequestItems: {
          [ctx.table]: {
            Keys: batch,
            ConsistentRead: true,
            ...(withBodies ? {} : { ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names }),
          },
        },
      }));
      for (const item of (res.Responses?.[ctx.table] ?? []) as StoredEmail[]) found.set(keys.get(item.sk)!, item);
      batch = (res.UnprocessedKeys?.[ctx.table]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  if (withBodies) await Promise.all([...found.values()].map(item => loadBodies(ctx.s3, ctx.bucket, item)));
  return found;
}

interface BodyOptions {
  bodyProperties: string[];
  fetchText: boolean;
  fetchHtml: boolean;
  maxBodyValueBytes: number;
}

function truncate(value: string, maxBytes: number): { value: string; isTruncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, isTruncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/, ""), isTruncated: true };
}

function bodyParts(ctx: Ctx, id: string, item: StoredEmail, opts: BodyOptions) {
  const pick = (part: Args) => {
    const out = Object.fromEntries(Object.entries(part).filter(([k]) => opts.bodyProperties.includes(k)));
    if (part.subParts) out.subParts = part.subParts;
    return out;
  };
  const leaf = (partId: string, blobId: string, type: string, size: number, extra: Args = {}): Args => ({
    partId, blobId, size, headers: [], name: null, type, charset: type.startsWith("text/") ? "utf-8" : null,
    disposition: null, cid: null, language: null, location: null, ...extra,
  });

  const hasText = item.bodyText !== undefined || item.bodyHtml === undefined;
  const text = hasText ? leaf("1", textBlobId(id), "text/plain", Buffer.byteLength(item.bodyText ?? "")) : null;
  const html = item.bodyHtml !== undefined ? leaf("2", htmlBlobId(id), "text/html", Buffer.byteLength(item.bodyHtml)) : null;
  const attachments = (item.attachments ?? []).map((a, i) => leaf(`a${i}`, attachmentBlobId(id, i), a.contentType, a.size, {
    name: a.filename,
    charset: null,
    cid: a.contentId ?? null,
    disposition: isInline(a, item.bodyHtml ?? "") ? "inline" : "attachment",
  }));

  const multipart = (type: string, subParts: Args[]): Args => ({
    partId: null, blobId: null, size: 0, headers: [], name: null, type, charset: null,
    disposition: null, cid: null, language: null, location: null, subParts,
  });
  const body = text && html ? multipart("multipart/alternative", [pick(text), pick(html)]) : pick((text ?? html)!);
  const bodyStructure = attachments.length ? multipart("multipart/mixed", [body, ...attachments.map(pick)]) : body;

  const values: Record<string, Args> = {};
  const addValue = (partId: string, value: string | undefined) => {
    const limit = Math.max(0, Math.min(opts.maxBodyValueBytes || Infinity, ctx.bodyBudget));
    const result = truncate(value ?? "", limit);
    ctx.bodyBudget -= Buffer.byteLength(result.value);
    values[partId] = { value: result.value, isEncodingProblem: false, isTruncated: result.isTruncated };
  };
  const textBody = text ? [text] : [html!];
  const htmlBody = html ? [html] : [text!];
  if (opts.fetchText) for (const p of textBody) addValue(p.partId as string, p === html ? item.bodyHtml : item.bodyText);
  if (opts.fetchHtml) for (const p of htmlBody) if (!values[p.partId as string]) addValue(p.partId as string, p === html ? item.bodyHtml : item.bodyText);

  return {
    bodyStructure: pick(bodyStructure),
    textBody: textBody.map(pick),
    htmlBody: htmlBody.map(pick),
    attachments: attachments.map(pick),
    bodyValues: values,
  };
}

export function toJmapEmail(ctx: Ctx, item: StoredEmail, properties: string[], opts: BodyOptions): Args {
  const id = emailIdFor(item.sk);
  const out: Args = {};
  const bodies = properties.some(p => BODY_PROPERTIES.includes(p)) ? bodyParts(ctx, id, item, opts) : undefined;
  for (const p of properties) {
    switch (p) {
      case "id": out.id = id; break;
      case "blobId": out.blobId = rawBlobId(id); break;
      case "threadId": out.threadId = item.threadId ?? threadIdFor(item); break;
      case "mailboxIds": out.mailboxIds = { [item.folder]: true }; break;
      case "keywords": out.keywords = keywordsOf(item); break;
      case "size": out.size = estimateSize(item); break;
      case "receivedAt": out.receivedAt = toUtcDate(item.receivedAt); break;
      case "sentAt": out.sentAt = toUtcDate(item.sentAt ?? item.receivedAt); break;
      case "messageId": out.messageId = [item.messageId]; break;
      case "inReplyTo": out.inReplyTo = item.inReplyTo ? [item.inReplyTo] : null; break;
      case "references": out.references = item.references?.length ? item.references : null; break;
      case "sender": out.sender = null; break;
      case "from": out.from = toJmapAddresses([item.from]); break;
      case "to": out.to = toJmapAddresses(item.to); break;
      case "cc": out.cc = toJmapAddresses(item.cc); break;
      case "bcc": out.bcc = toJmapAddresses(item.bcc); break;
      case "replyTo": out.replyTo = toJmapAddresses(item.replyTo); break;
      case "subject": out.subject = item.subject; break;
      case "hasAttachment": out.hasAttachment = hasAttachment(item.attachments, item.bodyHtml); break;
      case "preview": out.preview = item.snippet ?? ""; break;
      case "headers": out.headers = []; break;
      case "bodyStructure": case "textBody": case "htmlBody": case "attachments": case "bodyValues":
        out[p] = bodies![p];
        break;
      default:
        if (p.startsWith("header:")) out[p] = p.endsWith(":all") ? [] : null;
        else throw new MethodError("invalidArguments", `Unknown property ${p}`);
    }
  }
  return out;
}

export async function emailGet(ctx: Ctx, args: Args): Promise<Args> {
  const ids = idsArg(args, "ids", MAX_GET);
  if (ids === null) throw new MethodError("requestTooLarge", "ids is required");
  const properties = (args.properties as string[] | null | undefined) ?? DEFAULT_PROPERTIES;
  const fetchAll = args.fetchAllBodyValues === true;
  const opts: BodyOptions = {
    bodyProperties: (args.bodyProperties as string[] | null | undefined) ?? DEFAULT_BODY_PROPERTIES,
    fetchText: fetchAll || args.fetchTextBodyValues === true,
    fetchHtml: fetchAll || args.fetchHTMLBodyValues === true,
    maxBodyValueBytes: Number(args.maxBodyValueBytes ?? 0),
  };
  const withBodies = properties.some(p => BODY_PROPERTIES.includes(p));

  const [state, items] = await Promise.all([
    readState(ctx.ddb, ctx.table, ctx.email),
    ids.length ? getItems(ctx, ids, withBodies) : new Map<string, StoredEmail>(),
  ]);
  const withId = properties.includes("id") ? properties : ["id", ...properties];
  return {
    accountId: ctx.accountId,
    state: String(state),
    list: ids.filter(id => items.has(id)).map(id => toJmapEmail(ctx, items.get(id)!, withId, opts)),
    notFound: ids.filter(id => !items.has(id)),
  };
}

export async function emailChanges(ctx: Ctx, args: Args): Promise<Args> {
  const since = Number(args.sinceState);
  const maxChanges = Number(args.maxChanges ?? 500) || 500;
  const current = await readState(ctx.ddb, ctx.table, ctx.email);
  if (!Number.isInteger(since) || since < 0 || since > current) throw new MethodError("cannotCalculateChanges");
  const changes = await readChanges(ctx.ddb, ctx.table, ctx.email, since, current, maxChanges);
  if (!changes) throw new MethodError("cannotCalculateChanges");
  return {
    accountId: ctx.accountId,
    oldState: String(since),
    newState: String(changes.newState),
    hasMoreChanges: changes.hasMoreChanges,
    created: changes.created,
    updated: changes.updated,
    destroyed: changes.destroyed,
  };
}

export async function threadGet(ctx: Ctx, args: Args): Promise<Args> {
  const ids = idsArg(args, "ids", MAX_GET) ?? [];
  const [state, threads] = await Promise.all([
    readState(ctx.ddb, ctx.table, ctx.email),
    Promise.all([...new Set(ids)].map(async id => {
      const emailIds: string[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const res = await ctx.ddb.send(new QueryCommand({
          TableName: ctx.table,
          IndexName: THREAD_INDEX,
          KeyConditionExpression: "mailboxThread = :t",
          ExpressionAttributeValues: { ":t": mailboxThreadKey(ctx.email, id) },
          ProjectionExpression: "sk",
          ExclusiveStartKey: startKey,
        }));
        emailIds.push(...(res.Items ?? []).map(i => emailIdFor(i.sk as string)));
        startKey = res.LastEvaluatedKey;
      } while (startKey);
      return { id, emailIds };
    })),
  ]);
  return {
    accountId: ctx.accountId,
    state: String(state),
    list: threads.filter(t => t.emailIds.length),
    notFound: threads.filter(t => !t.emailIds.length).map(t => t.id),
  };
}

/** Touched threads come back as updated; one whose emails are all gone answers notFound on Thread/get. */
export async function threadChanges(ctx: Ctx, args: Args): Promise<Args> {
  const since = Number(args.sinceState);
  const current = await readState(ctx.ddb, ctx.table, ctx.email);
  if (!Number.isInteger(since) || since < 0 || since > current) throw new MethodError("cannotCalculateChanges");
  const changes = await readChanges(ctx.ddb, ctx.table, ctx.email, since, current, Infinity);
  if (!changes) throw new MethodError("cannotCalculateChanges");
  return {
    accountId: ctx.accountId,
    oldState: String(since),
    newState: String(changes.newState),
    hasMoreChanges: false,
    created: [],
    updated: changes.threads,
    destroyed: [],
  };
}

export async function searchSnippetGet(ctx: Ctx, args: Args): Promise<Args> {
  const emailIds = idsArg(args, "emailIds", MAX_GET) ?? [];
  return {
    accountId: ctx.accountId,
    list: emailIds.map(emailId => ({ emailId, subject: null, preview: null })),
    notFound: [],
  };
}
