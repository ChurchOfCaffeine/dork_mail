import { MAIL_FOLDERS, type MailFolder } from "@dork-mail/shared";
import { readState, stateWithCounts } from "../lib/mail-state";
import { MethodError, idsArg, setError, type Args, type Ctx } from "./context";

const MAILBOXES: Record<MailFolder, { name: string; role: string; sortOrder: number }> = {
  inbox: { name: "Inbox", role: "inbox", sortOrder: 1 },
  drafts: { name: "Drafts", role: "drafts", sortOrder: 2 },
  sent: { name: "Sent", role: "sent", sortOrder: 3 },
  archive: { name: "Archive", role: "archive", sortOrder: 4 },
  spam: { name: "Spam", role: "junk", sortOrder: 5 },
  trash: { name: "Trash", role: "trash", sortOrder: 6 },
};

const COUNT_PROPERTIES = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];

export const isMailboxId = (id: string): id is MailFolder => (MAIL_FOLDERS as readonly string[]).includes(id);

export async function mailboxGet(ctx: Ctx, args: Args): Promise<Args> {
  const ids = idsArg(args, "ids", 100);
  const properties = args.properties as string[] | null | undefined;
  const wanted = ids ?? [...MAIL_FOLDERS];
  const found = wanted.filter(isMailboxId);
  const notFound = wanted.filter(id => !isMailboxId(id));
  const withCounts = !properties || properties.some(p => COUNT_PROPERTIES.includes(p));

  const { modseq: state, counts: kept } = withCounts
    ? await stateWithCounts(ctx.ddb, ctx.table, ctx.email, found)
    : { modseq: await readState(ctx.ddb, ctx.table, ctx.email), counts: undefined };
  const counts = kept && found.map(f => kept[f]!);

  const list = found.map((id, i) => {
    const box: Args = {
      id,
      ...MAILBOXES[id],
      parentId: null,
      isSubscribed: true,
      myRights: {
        mayReadItems: true,
        mayAddItems: true,
        mayRemoveItems: true,
        maySetSeen: true,
        maySetKeywords: true,
        mayCreateChild: false,
        mayRename: false,
        mayDelete: false,
        maySubmit: true,
      },
    };
    if (counts) {
      // Thread counts would need a scan of every thread in the folder; email counts stand in.
      Object.assign(box, {
        totalEmails: counts[i].total,
        unreadEmails: counts[i].unread,
        totalThreads: counts[i].total,
        unreadThreads: counts[i].unread,
      });
    }
    return properties ? Object.fromEntries(Object.entries(box).filter(([k]) => k === "id" || properties.includes(k))) : box;
  });

  return { accountId: ctx.accountId, state: String(state), list, notFound };
}

export async function mailboxQuery(ctx: Ctx, args: Args): Promise<Args> {
  const filter = (args.filter ?? {}) as Args;
  const ids = [...MAIL_FOLDERS]
    .filter(id => filter.role === undefined || MAILBOXES[id].role === filter.role)
    .filter(() => filter.parentId === undefined || filter.parentId === null)
    .filter(() => filter.hasAnyRole === undefined || filter.hasAnyRole === true)
    .sort((a, b) => MAILBOXES[a].sortOrder - MAILBOXES[b].sortOrder);
  const state = await readState(ctx.ddb, ctx.table, ctx.email);
  return { accountId: ctx.accountId, queryState: String(state), canCalculateChanges: false, position: 0, ids, total: ids.length };
}

/** Any email write can move unread counts, so every mailbox is reported as updated. */
export async function mailboxChanges(ctx: Ctx, args: Args): Promise<Args> {
  const since = Number(args.sinceState);
  const current = await readState(ctx.ddb, ctx.table, ctx.email);
  if (!Number.isInteger(since) || since < 0 || since > current) throw new MethodError("cannotCalculateChanges");
  const changed = since !== current;
  return {
    accountId: ctx.accountId,
    oldState: String(since),
    newState: String(current),
    hasMoreChanges: false,
    created: [],
    updated: changed ? [...MAIL_FOLDERS] : [],
    destroyed: [],
    updatedProperties: changed ? COUNT_PROPERTIES : null,
  };
}

export async function mailboxSet(ctx: Ctx, args: Args): Promise<Args> {
  const state = String(await readState(ctx.ddb, ctx.table, ctx.email));
  const forbidden = () => setError("forbidden", "Mailboxes are fixed on this server");
  const notCreated = Object.fromEntries(Object.keys((args.create ?? {}) as Args).map(k => [k, forbidden()]));
  const notUpdated = Object.fromEntries(Object.keys((args.update ?? {}) as Args).map(k => [k, forbidden()]));
  const notDestroyed = Object.fromEntries(((args.destroy ?? []) as string[]).map(k => [k, forbidden()]));
  return {
    accountId: ctx.accountId,
    oldState: state,
    newState: state,
    created: null,
    updated: null,
    destroyed: null,
    notCreated,
    notUpdated,
    notDestroyed,
  };
}
