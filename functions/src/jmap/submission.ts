import { createHash, randomUUID } from "node:crypto";
import { CopyObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import isEmail from "validator/lib/isEmail";
import type { Attachment, StoredEmail, User } from "@dork-mail/shared";
import { mailboxThreadKey, threadIdFor } from "../lib/mail-store";
import { countDelta, readState } from "../lib/mail-state";
import { MethodError, idsArg, resolveId, setError, type Args, type Ctx, type MethodResponse, type SetError } from "./context";
import { getItems } from "./email";
import { readBlob } from "./blobs";
import { buildMime, type MimeAttachment } from "./mime";
import { emailIdFor } from "./ids";
import { applyPatch, commitWrites, deleteOwnBodies, destroyItem, patchFields, updateItem, type Write } from "./set";

const IDENTITY_ID = "default";
const SUBMISSION_STATE = "0";
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

const safeFilename = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

interface Sent {
  submissionId: string;
  item: StoredEmail;
  fields: Record<string, unknown>;
}

/** Copies upload-backed attachments under attachments/, since uploads/ expires, and loads every attachment's bytes. */
async function settleAttachments(ctx: Ctx, item: StoredEmail): Promise<{ stored: Attachment[]; mime: MimeAttachment[] }> {
  const stored: Attachment[] = [];
  const mime: MimeAttachment[] = [];
  const prefix = `attachments/${ctx.accountId}/${randomUUID()}`;
  for (const [i, a] of (item.attachments ?? []).entries()) {
    let s3Key = a.s3Key;
    if (s3Key.startsWith("uploads/")) {
      s3Key = `${prefix}/${i}-${safeFilename(a.filename)}`;
      await ctx.s3.send(new CopyObjectCommand({
        Bucket: ctx.bucket,
        Key: s3Key,
        CopySource: `${ctx.bucket}/${encodeURIComponent(a.s3Key).replace(/%2F/g, "/")}`,
        ContentType: a.contentType,
        MetadataDirective: "REPLACE",
      }));
    }
    stored.push({ ...a, s3Key });
    mime.push({
      filename: a.filename,
      contentType: a.contentType,
      content: await readBlob(ctx, { kind: "s3", key: s3Key, type: a.contentType }),
      cid: a.contentId,
    });
  }
  return { stored, mime };
}

async function send(ctx: Ctx, sub: Args): Promise<Sent | SetError> {
  if (sub.identityId !== undefined && sub.identityId !== IDENTITY_ID) return setError("invalidProperties", "Unknown identity", ["identityId"]);
  const emailId = resolveId(ctx, String(sub.emailId ?? ""));
  const item = (await getItems(ctx, [emailId], true)).get(emailId);
  if (!item) return setError("invalidProperties", "Email not found", ["emailId"]);
  if (item.from.address.toLowerCase() !== ctx.email) return setError("forbiddenFrom", `Mail can only be sent from ${ctx.email}`);

  const envelope = sub.envelope as { rcptTo?: { email: string }[] } | null | undefined;
  const recipients = envelope?.rcptTo?.map(r => r.email)
    ?? [...item.to, ...(item.cc ?? []), ...(item.bcc ?? [])].map(a => a.address);
  if (!recipients.length) return setError("noRecipients");
  const invalid = recipients.filter(r => !isEmail(r));
  if (invalid.length) return { ...setError("invalidRecipients"), invalidRecipients: invalid } as SetError;

  const { stored, mime } = await settleAttachments(ctx, item);
  const raw = await buildMime(item, mime);
  if (raw.byteLength > MAX_MESSAGE_BYTES) return setError("tooLarge", "Message exceeds 40 MB");

  const res = await ctx.ses.send(new SendEmailCommand({
    FromEmailAddress: ctx.email,
    Destination: { ToAddresses: recipients },
    Content: { Raw: { Data: raw } },
    ConfigurationSetName: ctx.sesConfigSet,
  }));
  const sesMessageId = res.MessageId!;
  // SES replaces Message-ID with its own, and replies reference that one.
  const messageId = `${sesMessageId}@${ctx.sesMessageIdDomain}`;
  const sentRaw = await buildMime({ ...item, messageId }, mime);
  const rawKey = `raw/${ctx.accountId}/${sesMessageId}.eml`;
  await ctx.s3.send(new PutObjectCommand({ Bucket: ctx.bucket, Key: rawKey, Body: sentRaw, ContentType: "message/rfc822" }));

  const isRoot = !item.references?.length && !item.inReplyTo;
  const threadId = isRoot ? threadIdFor({ messageId }) : item.threadId ?? threadIdFor(item);
  return {
    submissionId: `S${sesMessageId}`,
    item,
    fields: {
      messageId,
      sesMessageId,
      rawKey,
      size: sentRaw.byteLength,
      attachments: stored.length ? stored : undefined,
      threadId,
      mailboxThread: mailboxThreadKey(ctx.email, threadId),
    },
  };
}

export async function submissionSet(ctx: Ctx, args: Args, callId: string): Promise<MethodResponse[]> {
  const create = (args.create ?? {}) as Record<string, Args>;
  const destroy = idsArg(args, "destroy", 100) ?? [];
  const created: Record<string, Args> = {};
  const notCreated: Record<string, SetError> = {};
  const sent = new Map<string, Sent>();

  for (const [cid, sub] of Object.entries(create)) {
    const result = await send(ctx, sub);
    if ("type" in result) { notCreated[cid] = result; continue; }
    sent.set(cid, result);
    ctx.createdIds.set(cid, result.submissionId);
    created[cid] = { id: result.submissionId, undoStatus: "final", sendAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  }

  const emailFor = (ref: string): string | undefined => {
    if (ref.startsWith("#")) {
      const s = sent.get(ref.slice(1));
      return s ? emailIdFor(s.item.sk) : undefined;
    }
    return ref;
  };
  const patches = new Map<string, Args>();
  for (const [ref, patch] of Object.entries((args.onSuccessUpdateEmail ?? {}) as Record<string, Args>)) {
    const id = emailFor(ref);
    if (id) patches.set(id, patch);
  }
  const destroys = ((args.onSuccessDestroyEmail ?? []) as string[]).map(emailFor).filter((id): id is string => !!id);

  const oldState = await readState(ctx.ddb, ctx.table, ctx.email);
  const others = await getItems(ctx, [...patches.keys(), ...destroys].filter(id => ![...sent.values()].some(s => emailIdFor(s.item.sk) === id)), false);
  const writes: Write[] = [];
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};

  const destroyed: string[] = [];
  const gone: StoredEmail[] = [];
  for (const id of destroys) {
    const item = others.get(id) ?? [...sent.values()].find(s => emailIdFor(s.item.sk) === id)?.item;
    if (!item) continue;
    writes.push({ id, kind: "destroyed", threadIds: [item.threadId ?? threadIdFor(item)], item: destroyItem(ctx, item), counts: countDelta(item, undefined) });
    gone.push(item);
    destroyed.push(id);
  }
  for (const s of sent.values()) {
    const id = emailIdFor(s.item.sk);
    if (destroyed.includes(id)) continue;
    const patch = patches.get(id);
    let fields = s.fields;
    let counts = {};
    if (patch) {
      patches.delete(id);
      const result = applyPatch(s.item, patch);
      if ("type" in result) notUpdated[id] = result;
      else {
        fields = { ...fields, ...patchFields(ctx, result) };
        counts = countDelta(s.item, result);
        updated[id] = null;
      }
    }
    writes.push({
      id, kind: "updated",
      threadIds: [...new Set([s.item.threadId ?? threadIdFor(s.item), s.fields.threadId as string])],
      item: updateItem(ctx, s.item.sk, fields, s.item),
      counts,
    });
  }
  for (const [id, patch] of patches) {
    if (destroyed.includes(id)) continue;
    const item = others.get(id);
    if (!item) { notUpdated[id] = setError("notFound"); continue; }
    const result = applyPatch(item, patch);
    if ("type" in result) { notUpdated[id] = result; continue; }
    writes.push({
      id, kind: "updated", threadIds: [item.threadId ?? threadIdFor(item)],
      item: updateItem(ctx, item.sk, patchFields(ctx, result), item),
      counts: countDelta(item, result),
    });
    updated[id] = null;
  }
  const newState = writes.length ? await commitWrites(ctx, writes) : oldState;
  await deleteOwnBodies(ctx, gone);

  const responses: MethodResponse[] = [[
    "EmailSubmission/set",
    {
      accountId: ctx.accountId,
      oldState: SUBMISSION_STATE,
      newState: SUBMISSION_STATE,
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      updated: null,
      // Submissions are final the moment SES accepts them and nothing keeps them, so destroying one is a no-op.
      destroyed: destroy.length ? destroy : null,
    },
    callId,
  ]];
  if (args.onSuccessUpdateEmail || args.onSuccessDestroyEmail) {
    responses.push(["Email/set", {
      accountId: ctx.accountId,
      oldState: String(oldState),
      newState: String(newState),
      updated: Object.keys(updated).length ? updated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      destroyed: destroyed.length ? destroyed : null,
    }, callId]);
  }
  return responses;
}

export async function submissionGet(ctx: Ctx, args: Args): Promise<Args> {
  return { accountId: ctx.accountId, state: SUBMISSION_STATE, list: [], notFound: idsArg(args, "ids", 500) ?? [] };
}

export async function submissionQuery(ctx: Ctx): Promise<Args> {
  return { accountId: ctx.accountId, queryState: SUBMISSION_STATE, canCalculateChanges: false, position: 0, ids: [], total: 0 };
}

export async function submissionChanges(ctx: Ctx, args: Args): Promise<Args> {
  return { accountId: ctx.accountId, oldState: String(args.sinceState), newState: SUBMISSION_STATE, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
}

// ─── Identity ───────────────────────────────────────────────────────────────

async function profile(ctx: Ctx): Promise<User> {
  const res = await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `user#${ctx.email}`, sk: "profile" } }));
  if (!res.Item) throw new MethodError("accountNotFound");
  return res.Item as User;
}

function identityState(user: User): string {
  return createHash("sha256").update(JSON.stringify([user.displayName, user.textSignature, user.htmlSignature])).digest("base64url").slice(0, 16);
}

export async function identityGet(ctx: Ctx, args: Args): Promise<Args> {
  const user = await profile(ctx);
  const ids = idsArg(args, "ids", 10);
  const identity = {
    id: IDENTITY_ID,
    name: user.displayName ?? "",
    email: user.email,
    replyTo: null,
    bcc: null,
    textSignature: user.textSignature ?? "",
    htmlSignature: user.htmlSignature ?? "",
    mayDelete: false,
  };
  const found = !ids || ids.includes(IDENTITY_ID);
  return {
    accountId: ctx.accountId,
    state: identityState(user),
    list: found ? [identity] : [],
    notFound: (ids ?? []).filter(id => id !== IDENTITY_ID),
  };
}

export async function identityChanges(ctx: Ctx, args: Args): Promise<Args> {
  const state = identityState(await profile(ctx));
  const changed = args.sinceState !== state;
  return { accountId: ctx.accountId, oldState: args.sinceState, newState: state, hasMoreChanges: false, created: [], updated: changed ? [IDENTITY_ID] : [], destroyed: [] };
}

export async function identitySet(ctx: Ctx, args: Args): Promise<Args> {
  const oldState = identityState(await profile(ctx));
  const forbidden = () => setError("forbidden", "This server has one identity per account");
  const notCreated = Object.fromEntries(Object.keys((args.create ?? {}) as Args).map(k => [k, forbidden()]));
  const notDestroyed = Object.fromEntries(((args.destroy ?? []) as string[]).map(k => [k, forbidden()]));
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};

  for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Args>)) {
    if (id !== IDENTITY_ID) { notUpdated[id] = setError("notFound"); continue; }
    const fields: Record<string, string> = {};
    if (typeof patch.name === "string") fields.displayName = patch.name.trim();
    if (typeof patch.textSignature === "string") fields.textSignature = patch.textSignature;
    if (typeof patch.htmlSignature === "string") fields.htmlSignature = patch.htmlSignature;
    const unknown = Object.keys(patch).filter(k => !["name", "textSignature", "htmlSignature", "replyTo", "bcc"].includes(k));
    if (unknown.length) { notUpdated[id] = setError("invalidProperties", undefined, unknown); continue; }
    if (Object.keys(fields).length) {
      const entries = Object.entries(fields);
      await ctx.ddb.send(new UpdateCommand({
        TableName: ctx.table,
        Key: { pk: `user#${ctx.email}`, sk: "profile" },
        UpdateExpression: "SET " + entries.map((_, i) => `#k${i} = :v${i}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      }));
    }
    updated[id] = null;
  }

  return {
    accountId: ctx.accountId,
    oldState,
    newState: identityState(await profile(ctx)),
    created: null,
    updated: Object.keys(updated).length ? updated : null,
    destroyed: null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}
