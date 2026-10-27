<script lang="ts">
  import { untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { SvelteSet } from "svelte/reactivity";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { MAIL_FOLDERS, type EmailSummary, type MailFolder } from "@dork-mail/shared";
  import { mail, folderActions, FOLDER_LABELS, type FolderAction } from "#lib/stores/mail.svelte.ts";
  import { ui, isTyping } from "#lib/stores/ui.svelte.ts";
  import { toasts } from "#lib/stores/toast.svelte.ts";
  import { dateGroup } from "#lib/util/format.ts";
  import Icon from "#lib/components/Icon.svelte";
  import MessageRow from "#lib/components/MessageRow.svelte";
  import MessageView from "#lib/components/MessageView.svelte";

  const EMPTY: Record<MailFolder, { title: string; desc: string }> = {
    inbox: { title: "You're all caught up", desc: "New mail will show up here." },
    archive: { title: "Nothing archived", desc: "Swipe right or press E on a message to archive it." },
    sent: { title: "Nothing sent yet", desc: "Messages you send show up here." },
    trash: { title: "Trash is empty", desc: "Deleted messages show up here." },
    spam: { title: "No spam", desc: "Messages SES flags as spam land here." },
  };

  let folder = $derived.by(() => {
    const f = page.url.searchParams.get("folder") ?? "inbox";
    return ((MAIL_FOLDERS as readonly string[]).includes(f) ? f : "inbox") as MailFolder;
  });
  let openId = $derived(page.url.searchParams.get("m"));
  let box = $derived(mail.folder(folder));
  let actions = $derived(folderActions(folder));

  // ─── Search ──────────────────────────────────────────────────────────────
  let query = $state("");
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement>();
  let search = $state<{ q: string; emails: EmailSummary[]; cursor?: string; loading: boolean; loadingMore: boolean } | null>(null);

  $effect(() => {
    const q = query.trim();
    const f = folder;
    if (q.length < 2) { search = null; return; }
    const timer = setTimeout(async () => {
      search = { q, emails: search?.q === q ? search.emails : [], loading: true, loadingMore: false };
      try {
        const res = await mail.search(f, q);
        if (untrack(() => query.trim()) === q) search = { q, emails: res.emails, cursor: res.nextCursor, loading: false, loadingMore: false };
      } catch (e) {
        toasts.error((e as Error).message);
        if (search) search.loading = false;
      }
    }, 250);
    return () => clearTimeout(timer);
  });

  async function searchMore() {
    if (!search?.cursor || search.loadingMore) return;
    search.loadingMore = true;
    const s = search;
    try {
      const res = await mail.search(folder, s.q, s.cursor);
      if (search === s) { s.emails = [...s.emails, ...res.emails]; s.cursor = res.nextCursor; }
    } finally {
      s.loadingMore = false;
    }
  }

  function closeSearch() {
    query = "";
    searchOpen = false;
    search = null;
  }

  // ─── List ────────────────────────────────────────────────────────────────
  let emails = $derived(search ? search.emails : box.emails);
  let groups = $derived.by(() => {
    const out: { label: string; items: EmailSummary[] }[] = [];
    for (const e of emails) {
      const label = dateGroup(e.receivedAt);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  });
  let openIndex = $derived(openId ? emails.findIndex(e => e.messageId === openId) : -1);

  const selection = new SvelteSet<string>();
  let selecting = $derived(selection.size > 0);

  // Folder switches reset transient state and fetch fresh data.
  let shownFolder: MailFolder | null = null;
  $effect(() => {
    const f = folder;
    untrack(() => {
      if (Date.now() - mail.folder(f).fetchedAt > 5000) void mail.refresh(f);
      if (shownFolder && shownFolder !== f) {
        selection.clear();
        closeSearch();
        listEl?.scrollTo({ top: 0 });
      }
      shownFolder = f;
    });
  });

  // ─── Navigation ──────────────────────────────────────────────────────────
  let pushedOpen = false;

  function urlFor(id: string | null) {
    const qs = new URLSearchParams({ folder });
    if (id) qs.set("m", id);
    return `/mail?${qs}`;
  }

  function open(id: string) {
    const replace = !!openId;
    if (!replace) pushedOpen = true;
    goto(urlFor(id), { reset: false, replace });
  }

  function close() {
    if (pushedOpen) {
      pushedOpen = false;
      history.back();
    } else {
      goto(urlFor(null), { reset: false, replace: true });
    }
  }

  function step(dir: -1 | 1) {
    const next = emails[(openIndex < 0 ? -1 : openIndex) + dir];
    if (next) open(next.messageId);
  }

  /** The open message is leaving this folder: show its neighbor on desktop, go back on mobile. */
  function afterOpenRemoved() {
    if (ui.mobile) { close(); return; }
    const next = emails[openIndex + 1] ?? emails[openIndex - 1];
    if (next && next.messageId !== openId) goto(urlFor(next.messageId), { reset: false, replace: true });
    else close();
  }

  // ─── Actions ─────────────────────────────────────────────────────────────
  async function apply(action: FolderAction, ids: string[]) {
    if (!ids.length) return;
    if (openId && ids.includes(openId)) afterOpenRemoved();
    if (search) search.emails = search.emails.filter(e => !ids.includes(e.messageId));
    if (action.to === "delete") {
      if (!confirm(ids.length === 1 ? "Delete this message forever?" : `Delete ${ids.length} messages forever?`)) return;
      await mail.deleteForever(ids);
    } else {
      await mail.move(ids, folder, action.to, { label: action.to === "spam" ? "Reported as spam" : undefined });
    }
  }

  function swipe(email: EmailSummary, dir: "left" | "right") {
    const action = dir === "right" ? actions.primary : actions.remove;
    if (action) void apply(action, [email.messageId]);
  }

  function toggleCheck(id: string) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
  }

  function bulk(action: FolderAction) {
    const ids = [...selection];
    selection.clear();
    void apply(action, ids);
  }

  function bulkRead(read: boolean) {
    void mail.setRead([...selection], read);
    selection.clear();
  }

  async function emptyFolder() {
    if (folder !== "trash" && folder !== "spam") return;
    if (!confirm(`Permanently delete everything in ${FOLDER_LABELS[folder]}?`)) return;
    emptying = true;
    try { await mail.emptyFolder(folder); }
    catch (e) { toasts.error((e as Error).message); }
    finally { emptying = false; }
  }
  let emptying = $state(false);

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────
  function onkeydown(e: KeyboardEvent) {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "Escape" && e.target === searchInput) { closeSearch(); searchInput?.blur(); }
      return;
    }
    const target = openId ? [openId] : [...selection];
    switch (e.key) {
      case "j": case "ArrowDown": step(1); break;
      case "k": case "ArrowUp": step(-1); break;
      case "e": if (actions.primary) void apply(actions.primary, target); selection.clear(); break;
      case "#": case "Delete": void apply(actions.remove, target); selection.clear(); break;
      case "!": if (actions.spam) void apply(actions.spam, target); break;
      case "s": if (openId) { const m = mail.find(openId); if (m) void mail.setStarred(openId, !m.starred); } break;
      case "u": if (openId) { void mail.setRead([openId], false); close(); } else bulkRead(false); break;
      case "r": if (openId) goto(`/mail/compose?mode=reply&id=${encodeURIComponent(openId)}`); break;
      case "a": if (openId) goto(`/mail/compose?mode=replyAll&id=${encodeURIComponent(openId)}`); break;
      case "f": if (openId) goto(`/mail/compose?mode=forward&id=${encodeURIComponent(openId)}`); break;
      case "x": if (openId) toggleCheck(openId); break;
      case "c": goto("/mail/compose"); break;
      case "/": searchOpen = true; queueMicrotask(() => searchInput?.focus()); break;
      case "Escape":
        if (selecting) selection.clear();
        else if (openId) close();
        else if (search) closeSearch();
        break;
      default: return;
    }
    e.preventDefault();
  }

  // ─── Infinite scroll & pull to refresh ───────────────────────────────────
  let listEl = $state<HTMLElement>();

  export const snapshot = {
    capture: () => listEl?.scrollTop ?? 0,
    restore: (top: number) => { if (listEl) listEl.scrollTop = top; },
  };
  let sentinel = $state<HTMLElement>();

  $effect(() => {
    if (!sentinel || !listEl) return;
    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      if (search) void searchMore();
      else void mail.loadMore(folder);
    }, { root: listEl, rootMargin: "600px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  const PULL_TRIGGER = 72;
  let pull = $state(0);
  let pullArmed = false;
  let pulling = false;
  let pullStartY = 0;
  let lastY = 0;

  function touchstart(e: TouchEvent) {
    pullArmed = !search;
    pulling = false;
    lastY = e.touches[0].clientY;
  }
  function touchmove(e: TouchEvent) {
    const y = e.touches[0].clientY;
    // The pull starts once a downward drag reaches the top, so a scroll that
    // lands at the top can continue straight into a refresh.
    if (!pulling) {
      if (pullArmed && listEl && listEl.scrollTop <= 0 && y > lastY) {
        pulling = true;
        pullStartY = y;
      }
      lastY = y;
      return;
    }
    const dy = y - pullStartY;
    if (dy <= 0 || listEl!.scrollTop > 0) { pull = 0; return; }
    pull = Math.min(110, dy * 0.5);
  }
  function touchend() {
    if (!pulling) return;
    pulling = false;
    if (pull >= PULL_TRIGGER) {
      navigator.vibrate?.(8);
      void Promise.all([mail.refresh(folder), mail.refreshCounts()]);
    }
    pull = 0;
  }

  // Standalone iOS PWAs have no browser back gesture, so the reading view provides one.
  let backDx = $state(0);
  let backTracking = false;
  let backStartX = 0;
  let backStartY = 0;
  let backSettling = $state(false);

  function backStart(e: TouchEvent) {
    const t = e.touches[0];
    backTracking = ui.mobile && t.clientX < 28;
    backStartX = t.clientX;
    backStartY = t.clientY;
  }
  function backMove(e: TouchEvent) {
    if (!backTracking) return;
    const t = e.touches[0];
    const dx = t.clientX - backStartX;
    if (backDx === 0 && Math.abs(t.clientY - backStartY) > Math.abs(dx)) { backTracking = false; return; }
    backDx = Math.max(0, dx);
  }
  function backEnd() {
    if (!backTracking) return;
    backTracking = false;
    backSettling = true;
    if (backDx > innerWidth * 0.33) {
      backDx = innerWidth;
      closeAfterSettle = true;
    } else {
      backDx = 0;
    }
  }
  let closeAfterSettle = false;
  function backSettled(e: TransitionEvent) {
    if (e.target !== e.currentTarget) return;
    backSettling = false;
    if (closeAfterSettle) {
      closeAfterSettle = false;
      close();
      backDx = 0;
    }
  }

  let refreshing = $derived(box.loading && box.loaded);
  let showSkeleton = $derived(!search && !box.loaded && box.loading);
</script>

<svelte:window {onkeydown} />

<div class="mailbox" class:has-open={!!openId}>
  <section class="list-pane" aria-label="{FOLDER_LABELS[folder]} messages">
    <header class="list-header">
      {#if selecting}
        <button class="icon-btn" onclick={() => selection.clear()} aria-label="Clear selection"><Icon name="x" /></button>
        <span class="title selection-count">{selection.size}</span>
        <div class="spacer"></div>
        {#if actions.primary}
          <button class="icon-btn" onclick={() => bulk(actions.primary!)} title={actions.primary.label} aria-label={actions.primary.label}><Icon name={actions.primary.icon} /></button>
        {/if}
        <button class="icon-btn" onclick={() => bulk(actions.remove)} title={actions.remove.label} aria-label={actions.remove.label}><Icon name="trash" /></button>
        <button class="icon-btn" onclick={() => bulkRead(true)} title="Mark read" aria-label="Mark read"><Icon name="mail-open" /></button>
        <button class="icon-btn" onclick={() => bulkRead(false)} title="Mark unread" aria-label="Mark unread"><Icon name="mail" /></button>
      {:else if searchOpen || !ui.mobile}
        {#if ui.mobile}
          <button class="icon-btn" onclick={closeSearch} aria-label="Close search"><Icon name="chevron-left" size={24} /></button>
        {:else}
          <h1 class="title">{FOLDER_LABELS[folder]}</h1>
        {/if}
        <label class="search">
          <Icon name="search" size={17} />
          <input
            bind:this={searchInput}
            bind:value={query}
            type="search"
            placeholder="Search {FOLDER_LABELS[folder]}"
            autocomplete="off"
            enterkeyhint="search"
          />
          {#if query}<button class="clear" onclick={() => { query = ""; searchInput?.focus(); }} aria-label="Clear search"><Icon name="x" size={16} /></button>{/if}
        </label>
        {#if !ui.mobile}
          <button class="icon-btn" onclick={() => { void mail.refresh(folder); void mail.refreshCounts(); }} title="Refresh" aria-label="Refresh" disabled={box.loading}>
            <span class:spinning={box.loading}><Icon name="refresh" size={18} /></span>
          </button>
        {/if}
      {:else}
        <button class="icon-btn" onclick={() => (ui.drawerOpen = true)} aria-label="Open menu"><Icon name="menu" size={22} /></button>
        <h1 class="title">{FOLDER_LABELS[folder]}</h1>
        {#if refreshing}<span class="spinning header-spinner"><Icon name="refresh" size={16} /></span>{/if}
        <div class="spacer"></div>
        <button class="icon-btn" onclick={() => { searchOpen = true; queueMicrotask(() => searchInput?.focus()); }} aria-label="Search"><Icon name="search" size={22} /></button>
      {/if}
    </header>

    {#if (folder === "trash" || folder === "spam") && box.emails.length && !search && !selecting}
      <div class="folder-note">
        <span>{folder === "trash" ? "Messages in Trash stay until you delete them." : "Spam stays until you delete it."}</span>
        <button class="link" onclick={emptyFolder} disabled={emptying}>{emptying ? "Deleting…" : `Empty ${FOLDER_LABELS[folder]}`}</button>
      </div>
    {/if}

    <div
      class="list"
      class:compact={!ui.mobile}
      bind:this={listEl}
      ontouchstart={touchstart}
      ontouchmove={touchmove}
      ontouchend={touchend}
      role="list"
    >
      <div class="ptr" style:height="{pull}px" class:armed={pull >= PULL_TRIGGER} aria-hidden="true">
        <span style:transform="rotate({pull * 3}deg)"><Icon name="refresh" size={20} /></span>
      </div>

      {#if showSkeleton}
        {#each Array(8) as _, i (i)}
          <div class="skel-row">
            <div class="skel" style="width: 40px; height: 40px; border-radius: 50%"></div>
            <div style="flex: 1; display: flex; flex-direction: column; gap: 8px">
              <div class="skel" style="width: 40%; height: 14px"></div>
              <div class="skel" style="width: 75%; height: 12px"></div>
              <div class="skel" style="width: 90%; height: 12px"></div>
            </div>
          </div>
        {/each}
      {:else if box.error && !emails.length && !search}
        <div class="empty">
          <p class="empty-title">Couldn't load {FOLDER_LABELS[folder]}</p>
          <p class="empty-desc">{box.error}</p>
          <button class="btn btn-ghost" onclick={() => mail.refresh(folder)}>Try again</button>
        </div>
      {:else if search && !emails.length}
        <div class="empty">
          {#if search.loading}<span class="spinning"><Icon name="refresh" size={22} /></span>
          {:else}<p class="empty-title">No results for "{search.q}"</p><p class="empty-desc">Search covers sender, recipients, subject and preview text in {FOLDER_LABELS[folder]}.</p>{/if}
        </div>
      {:else if !emails.length}
        <div class="empty">
          <span class="empty-icon"><Icon name={folder === "sent" ? "send" : folder === "inbox" ? "check" : folder} size={30} /></span>
          <p class="empty-title">{EMPTY[folder].title}</p>
          <p class="empty-desc">{EMPTY[folder].desc}</p>
        </div>
      {:else}
        {#each groups as group (group.label)}
          <div class="group-label">{group.label}</div>
          {#each group.items as email (email.messageId)}
            <MessageRow
              {email}
              showRecipients={folder === "sent"}
              active={email.messageId === openId}
              checked={selection.has(email.messageId)}
              {selecting}
              swipeRight={actions.primary ? { icon: actions.primary.icon, label: actions.primary.label, color: "var(--swipe-archive)" } : undefined}
              swipeLeft={{ icon: "trash", label: actions.remove.label, color: "var(--swipe-trash)" }}
              onopen={() => open(email.messageId)}
              oncheck={() => toggleCheck(email.messageId)}
              onswipe={dir => swipe(email, dir)}
              onstar={() => mail.setStarred(email.messageId, !email.starred)}
              onread={() => mail.setRead([email.messageId], !email.read)}
            />
          {/each}
        {/each}
        {#if (search ? search.cursor : box.cursor)}
          <div class="more"><span class="spinning"><Icon name="refresh" size={18} /></span></div>
        {/if}
      {/if}
      <div bind:this={sentinel} class="sentinel"></div>
    </div>

    {#if ui.mobile && !selecting}
      <a href="/mail/compose" class="fab" aria-label="Compose"><Icon name="compose" size={22} /></a>
    {/if}
  </section>

  {#if openId}
    {#key ui.mobile}
      <section
        class="read-pane"
        aria-label="Message"
        class:settling={backSettling}
        style:transform={backDx ? `translateX(${backDx}px)` : undefined}
        in:fly={{ x: ui.mobile ? innerWidth : 0, duration: ui.mobile ? 260 : 0, opacity: 1, easing: cubicOut }}
        ontouchstart={backStart}
        ontouchmove={backMove}
        ontouchend={backEnd}
        ontransitionend={backSettled}
      >
        <MessageView
          id={openId}
          {folder}
          mobile={ui.mobile}
          onclose={close}
          onnavigate={step}
          onaction={afterOpenRemoved}
          hasPrev={openIndex > 0}
          hasNext={openIndex >= 0 && openIndex < emails.length - 1}
        />
      </section>
    {/key}
  {:else if !ui.mobile}
    <section class="read-pane placeholder">
      <Icon name="mail" size={40} strokeWidth={1.5} />
      <p>Select a message to read</p>
      <p class="hint">J and K move between messages, E archives, R replies</p>
    </section>
  {/if}
</div>

<style>
  .mailbox {
    position: relative;
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .list-pane {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 400px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-surface);
    min-height: 0;
  }
  @media (max-width: 1100px) { .list-pane { width: 340px; } }

  .read-pane { flex: 1; min-width: 0; height: 100%; }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-muted);
    background: var(--bg-base);
  }
  .placeholder p { font-size: 15px; }
  .placeholder .hint { font-size: 12px; }

  .list-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--header-h);
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .title {
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .selection-count { font-size: 17px; padding-left: 4px; }
  .spacer { flex: 1; }
  .header-spinner { color: var(--text-muted); margin-left: 4px; }

  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 6px 0 12px;
    border-radius: 99px;
    background: var(--bg-raised);
    color: var(--text-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 14px;
  }
  .search input::-webkit-search-cancel-button { display: none; }
  .search input:focus-visible { outline: none; }
  .search:focus-within { box-shadow: inset 0 0 0 2px var(--border-focus); }
  .clear { display: flex; padding: 4px; color: var(--text-muted); }

  .folder-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: 12px;
    flex-shrink: 0;
  }
  .link { color: var(--accent); font-weight: 600; white-space: nowrap; }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior-y: none;
    -webkit-overflow-scrolling: touch;
  }

  .ptr {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: var(--text-muted);
    transition: height 0.2s ease-out;
  }
  .ptr.armed { color: var(--accent); }

  .group-label {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }

  .skel-row { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    padding: 72px 32px;
    color: var(--text-muted);
  }
  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    margin-bottom: 8px;
    border-radius: 50%;
    background: var(--bg-raised);
    color: var(--text-secondary);
  }
  .empty-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }
  .empty-desc { font-size: 14px; max-width: 280px; }

  .more { display: flex; justify-content: center; padding: 20px; color: var(--text-muted); }
  .sentinel { height: 1px; }

  .fab {
    position: absolute;
    right: 18px;
    bottom: calc(18px + var(--safe-bottom));
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 58px;
    height: 58px;
    border-radius: 18px;
    background: var(--accent);
    color: var(--text-on-accent);
    box-shadow: var(--shadow-lg);
    transition: transform 0.15s;
  }
  .fab:active { transform: scale(0.94); }
  .fab:hover { color: var(--text-on-accent); }

  @media (max-width: 767px) {
    .list-pane { width: 100%; border-right: none; }
    .list-header {
      height: calc(var(--header-h) + var(--safe-top));
      padding: var(--safe-top) 6px 0 4px;
    }
    .title { font-size: 21px; }
    .list { padding-bottom: calc(88px + var(--safe-bottom)); }
    .read-pane {
      position: absolute;
      inset: 0;
      z-index: 20;
      box-shadow: var(--shadow-lg);
    }
    .read-pane.settling { transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1); }
  }
</style>
