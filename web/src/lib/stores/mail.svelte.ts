import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import * as api from "$lib/api/client";
import { MAIL_FOLDERS } from "@dork-mail/shared";
import type { EmailSummary, StoredEmail, MailFolder, UnreadCounts, SendEmailRequest } from "@dork-mail/shared";
import { toasts } from "./toast.svelte";
import { rememberContacts } from "./contacts";

interface FolderState {
  emails: EmailSummary[];
  cursor?: string;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  fetchedAt: number;
}

const PAGE = 50;
const CACHE_LIMIT = 100;
// How long an optimistic change wins over list data from a refresh that raced it.
const OVERRIDE_MS = 15_000;
const MESSAGE_TTL_MS = 45 * 60_000;
const UNDO_SEND_MS = 5000;

export const FOLDER_LABELS: Record<MailFolder, string> = {
  inbox: "Inbox", archive: "Archive", sent: "Sent", trash: "Trash", spam: "Spam",
};

export interface FolderAction { to: MailFolder | "delete"; icon: "archive" | "inbox" | "trash" | "spam"; label: string }

/** Primary (swipe right) and destructive (swipe left) actions for messages in a folder. */
export function folderActions(folder: MailFolder): { primary?: FolderAction; remove: FolderAction; spam?: FolderAction } {
  const toTrash: FolderAction = { to: "trash", icon: "trash", label: "Trash" };
  const toInbox: FolderAction = { to: "inbox", icon: "inbox", label: "Move to Inbox" };
  switch (folder) {
    case "inbox": return { primary: { to: "archive", icon: "archive", label: "Archive" }, remove: toTrash, spam: { to: "spam", icon: "spam", label: "Report spam" } };
    case "archive": return { primary: toInbox, remove: toTrash };
    case "sent": return { remove: toTrash };
    case "trash": return { primary: { ...toInbox, label: "Restore" }, remove: { to: "delete", icon: "trash", label: "Delete forever" } };
    case "spam": return { primary: { ...toInbox, label: "Not spam" }, remove: toTrash };
  }
}

function readCache(folder: string): { emails: EmailSummary[]; cursor?: string } | null {
  if (!browser) return null;
  try { return JSON.parse(localStorage.getItem(`dm:list:${folder}`) ?? "null"); } catch { return null; }
}

const folders = $state<Record<string, FolderState>>(
  Object.fromEntries(MAIL_FOLDERS.map(f => {
    const cached = readCache(f);
    return [f, {
      emails: cached?.emails ?? [],
      cursor: cached?.cursor,
      loaded: !!cached,
      loading: false,
      loadingMore: false,
      error: "",
      fetchedAt: 0,
    }];
  })),
);

const counts = $state<UnreadCounts>({ inbox: 0, spam: 0 });

const messages = new Map<string, { email: StoredEmail; at: number }>();
const overrides = new Map<string, { patch: Partial<EmailSummary>; until: number }>();
const movedAway = new Map<string, { from: string; until: number }>();

function persist(folder: string) {
  const s = folders[folder];
  try {
    localStorage.setItem(`dm:list:${folder}`, JSON.stringify({
      emails: s.emails.slice(0, CACHE_LIMIT),
      cursor: s.emails.length > CACHE_LIMIT ? undefined : s.cursor,
    }));
  } catch { /* storage full, cache is only an optimization */ }
}

function applyOverrides(folder: string, list: EmailSummary[]): EmailSummary[] {
  const now = Date.now();
  return list
    .filter(e => { const m = movedAway.get(e.messageId); return !(m && m.from === folder && m.until > now); })
    .map(e => { const o = overrides.get(e.messageId); return o && o.until > now ? { ...e, ...o.patch } : e; });
}

function insertSorted(list: EmailSummary[], email: EmailSummary): EmailSummary[] {
  const i = list.findIndex(e => e.receivedAt < email.receivedAt);
  return i < 0 ? [...list, email] : [...list.slice(0, i), email, ...list.slice(i)];
}

function syncBadge() {
  if (!browser || !("setAppBadge" in navigator)) return;
  (counts.inbox > 0 ? navigator.setAppBadge(counts.inbox) : navigator.clearAppBadge()).catch(() => {});
}

function adjustUnread(folder: MailFolder, delta: number) {
  if (folder === "inbox" || folder === "spam") {
    counts[folder] = Math.max(0, counts[folder] + delta);
    if (folder === "inbox") syncBadge();
  }
}

function patchLocal(ids: string[], patch: Partial<EmailSummary>) {
  const set = new Set(ids);
  const until = Date.now() + OVERRIDE_MS;
  for (const id of ids) overrides.set(id, { patch: { ...overrides.get(id)?.patch, ...patch }, until });
  for (const f of MAIL_FOLDERS) {
    const s = folders[f];
    if (!s.emails.some(e => set.has(e.messageId))) continue;
    s.emails = s.emails.map(e => set.has(e.messageId) ? { ...e, ...patch } : e);
    persist(f);
  }
  for (const id of ids) {
    const m = messages.get(id);
    if (m) Object.assign(m.email, patch);
  }
}

function findSummary(id: string): EmailSummary | undefined {
  for (const f of MAIL_FOLDERS) {
    const e = folders[f].emails.find(x => x.messageId === id);
    if (e) return e;
  }
  return messages.get(id)?.email;
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ─── Outbox (undo send) ───────────────────────────────────────────────────────

let pendingSend: { payload: SendEmailRequest; draftKey: string; composeUrl: string; timer: ReturnType<typeof setTimeout> } | null = null;

async function flushSend(leavingPage = false) {
  const p = pendingSend;
  if (!p) return;
  pendingSend = null;
  clearTimeout(p.timer);
  // keepalive lets the request finish if the app is closed, but caps the body at 64KB.
  const keepalive = leavingPage && JSON.stringify(p.payload).length < 60_000;
  try {
    await api.sendEmail(p.payload, keepalive);
    try { localStorage.removeItem(p.draftKey); } catch { /* ignore */ }
    rememberContacts([...p.payload.to, ...(p.payload.cc ?? []), ...(p.payload.bcc ?? [])], 3);
    if (!leavingPage) toasts.show("Message sent");
    if (folders.sent.loaded) void mail.refresh("sent");
  } catch (e) {
    toasts.show(`Couldn't send: ${errorMessage(e)}`, {
      kind: "error",
      action: { label: "Edit", run: () => goto(p.composeUrl) },
    });
  }
}

if (browser) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushSend(true);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const mail = {
  folder(folder: MailFolder): FolderState {
    return folders[folder];
  },

  get counts() { return counts; },

  async refresh(folder: MailFolder) {
    const s = folders[folder];
    if (s.loading) return;
    s.loading = true;
    s.error = "";
    try {
      const res = await api.listEmails(folder, undefined, PAGE);
      const fresh = applyOverrides(folder, res.emails);
      const ids = new Set(fresh.map(e => e.messageId));
      const oldest = fresh.at(-1)?.receivedAt;
      // Keep pages loaded past the first one, so a refresh doesn't collapse a scrolled list.
      const tail = oldest && res.nextCursor
        ? s.emails.filter(e => !ids.has(e.messageId) && e.receivedAt < oldest)
        : [];
      s.emails = [...fresh, ...tail];
      s.cursor = tail.length ? s.cursor : res.nextCursor;
      s.loaded = true;
      s.fetchedAt = Date.now();
      persist(folder);
      rememberContacts(res.emails.flatMap(e => folder === "sent" ? e.to : [e.from]));
    } catch (e) {
      s.error = errorMessage(e);
    } finally {
      s.loading = false;
    }
  },

  async loadMore(folder: MailFolder) {
    const s = folders[folder];
    if (!s.cursor || s.loadingMore) return;
    s.loadingMore = true;
    try {
      const res = await api.listEmails(folder, s.cursor, PAGE);
      const ids = new Set(s.emails.map(e => e.messageId));
      s.emails = [...s.emails, ...applyOverrides(folder, res.emails).filter(e => !ids.has(e.messageId))];
      s.cursor = res.nextCursor;
    } catch (e) {
      toasts.error(errorMessage(e));
    } finally {
      s.loadingMore = false;
    }
  },

  search(folder: MailFolder, q: string, cursor?: string) {
    return api.listEmails(folder, cursor, PAGE, q);
  },

  async refreshCounts() {
    try {
      Object.assign(counts, await api.getUnreadCounts());
      syncBadge();
    } catch { /* counts are cosmetic */ }
  },

  find: findSummary,

  async getMessage(id: string): Promise<StoredEmail> {
    const hit = messages.get(id);
    if (hit && Date.now() - hit.at < MESSAGE_TTL_MS) return hit.email;
    const email = await api.getEmail(id);
    const o = overrides.get(id);
    if (o && o.until > Date.now()) Object.assign(email, o.patch);
    messages.set(id, { email, at: Date.now() });
    rememberContacts([email.from, ...email.to, ...(email.cc ?? [])]);
    return email;
  },

  async setRead(ids: string[], read: boolean) {
    const changed = ids.map(findSummary).filter((e): e is EmailSummary => !!e && e.read !== read);
    if (!changed.length) return;
    patchLocal(changed.map(e => e.messageId), { read });
    changed.forEach(e => adjustUnread(e.folder, read ? -1 : 1));
    const results = await Promise.allSettled(changed.map(e => api.updateEmail(e.messageId, { read })));
    const failed = changed.filter((_, i) => results[i].status === "rejected");
    if (failed.length) {
      patchLocal(failed.map(e => e.messageId), { read: !read });
      failed.forEach(e => adjustUnread(e.folder, read ? 1 : -1));
      toasts.error("Couldn't update message");
    }
  },

  async setStarred(id: string, starred: boolean) {
    patchLocal([id], { starred });
    try {
      await api.updateEmail(id, { starred });
    } catch {
      patchLocal([id], { starred: !starred });
      toasts.error("Couldn't update message");
    }
  },

  /** Optimistically moves messages, with an Undo toast. */
  async move(ids: string[], from: MailFolder, to: MailFolder, opts: { undo?: boolean; label?: string; known?: EmailSummary[] } = {}) {
    const src = folders[from];
    const moving = src.emails.filter(e => ids.includes(e.messageId));
    // Undo passes the summaries along: the source folder's list may never have been loaded.
    const extra = ids
      .filter(id => !moving.some(e => e.messageId === id))
      .map(id => opts.known?.find(e => e.messageId === id) ?? findSummary(id))
      .filter((e): e is EmailSummary => !!e);
    const all = [...moving, ...extra];
    if (!all.length) return;

    const until = Date.now() + OVERRIDE_MS;
    all.forEach(e => movedAway.set(e.messageId, { from, until }));
    src.emails = src.emails.filter(e => !ids.includes(e.messageId));
    persist(from);
    const dest = folders[to];
    if (dest.loaded) {
      for (const e of all) dest.emails = insertSorted(dest.emails.filter(x => x.messageId !== e.messageId), { ...e, folder: to });
      persist(to);
    }
    patchLocal(all.map(e => e.messageId), { folder: to });
    all.filter(e => !e.read).forEach(() => { adjustUnread(from, -1); adjustUnread(to, 1); });

    const results = await Promise.allSettled(all.map(e => api.updateEmail(e.messageId, { folder: to })));
    const failed = all.filter((_, i) => results[i].status === "rejected");
    if (failed.length) {
      failed.forEach(e => movedAway.delete(e.messageId));
      toasts.error(`Couldn't move ${failed.length === 1 ? "message" : `${failed.length} messages`}`);
      void this.refresh(from);
      if (dest.loaded) void this.refresh(to);
      return;
    }

    if (opts.undo !== false) {
      const n = all.length;
      const label = opts.label ?? `Moved to ${FOLDER_LABELS[to]}`;
      toasts.show(n === 1 ? label : `${n} messages: ${label.toLowerCase()}`, {
        action: {
          label: "Undo",
          run: () => this.move(all.map(e => e.messageId), to, from, { undo: false, known: all.map(e => ({ ...e, folder: to })) }),
        },
      });
    }
  },

  async deleteForever(ids: string[]) {
    const s = folders.trash;
    s.emails = s.emails.filter(e => !ids.includes(e.messageId));
    persist("trash");
    const results = await Promise.allSettled(ids.map(id => api.deleteEmail(id)));
    const failed = results.filter(r => r.status === "rejected").length;
    if (failed) {
      toasts.error(`Couldn't delete ${failed} message${failed === 1 ? "" : "s"}`);
      void this.refresh("trash");
    } else {
      toasts.show(ids.length === 1 ? "Deleted forever" : `${ids.length} messages deleted forever`);
    }
  },

  async emptyFolder(folder: "trash" | "spam") {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await api.listEmails(folder, cursor, 100);
      ids.push(...res.emails.map(e => e.messageId));
      cursor = res.nextCursor;
    } while (cursor);
    if (folder === "spam") {
      await Promise.allSettled(ids.map(id => api.updateEmail(id, { folder: "trash" })));
    }
    await this.deleteForever(ids);
    folders[folder].emails = [];
    folders[folder].cursor = undefined;
    persist(folder);
    if (folder === "spam") adjustUnread("spam", -counts.spam);
  },

  queueSend(payload: SendEmailRequest, draftKey: string, composeUrl: string) {
    if (pendingSend) void flushSend();
    pendingSend = { payload, draftKey, composeUrl, timer: setTimeout(() => void flushSend(), UNDO_SEND_MS) };
    toasts.show("Sending…", {
      duration: UNDO_SEND_MS,
      action: {
        label: "Undo",
        run: () => {
          if (!pendingSend) return;
          clearTimeout(pendingSend.timer);
          pendingSend = null;
          goto(composeUrl);
        },
      },
    });
  },
};
