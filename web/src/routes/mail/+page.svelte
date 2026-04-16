<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import * as api from "$lib/api/client";
  import type { StoredEmail } from "@dork-mail/shared";

  let emails = $state<StoredEmail[]>([]);
  let loading = $state(true);
  let error = $state("");
  let nextCursor = $state<string | undefined>(undefined);
  let loadingMore = $state(false);
  let emptyingTrash = $state(false);
  let refreshing = $state(false);

  // Split-pane state
  let selectedId = $state<string | null>(null);
  let selectedEmail = $state<StoredEmail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state("");
  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);

  let folder = $derived(page.url.searchParams.get("folder") ?? "inbox");

  // Close panel when folder changes
  let prevFolder = $state(folder);
  $effect(() => {
    if (folder !== prevFolder) {
      prevFolder = folder;
      selectedId = null;
      selectedEmail = null;
    }
  });

  const FOLDER_EMPTY: Record<string, { icon: string; title: string; desc: string; showCompose?: boolean }> = {
    inbox:  { icon: "📬", title: "Your inbox is empty",  desc: "New emails will appear here when they arrive.", showCompose: true },
    sent:   { icon: "📤", title: "No sent emails",       desc: "Emails you send will show up here.", showCompose: true },
    drafts: { icon: "📝", title: "No drafts",            desc: "Emails you're still working on will be saved here.", showCompose: true },
    trash:  { icon: "🗑",  title: "Trash is empty",       desc: "Deleted emails will appear here." },
    spam:   { icon: "🚫", title: "No spam",              desc: "Spam messages will be caught here." },
  };

  // ── sessionStorage cache for instant loads ──
  const CACHE_PREFIX = "dork_mail_list_";
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function cacheKey(f: string) { return `${CACHE_PREFIX}${f}`; }

  function getCached(f: string): { emails: StoredEmail[]; nextCursor?: string } | null {
    try {
      const raw = sessionStorage.getItem(cacheKey(f));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts > CACHE_TTL) {
        sessionStorage.removeItem(cacheKey(f));
        return null;
      }
      return { emails: cached.emails, nextCursor: cached.nextCursor };
    } catch {
      return null;
    }
  }

  function setCache(f: string, data: { emails: StoredEmail[]; nextCursor?: string }) {
    try {
      sessionStorage.setItem(cacheKey(f), JSON.stringify({ ...data, ts: Date.now() }));
    } catch {
      // storage full — not critical
    }
  }

  function syncCache() {
    setCache(folder, { emails, nextCursor });
  }

  $effect(() => { load(); });

  async function load() {
    error = "";
    nextCursor = undefined;

    // Try to show cached data instantly
    const cached = getCached(folder);
    if (cached) {
      emails = cached.emails;
      nextCursor = cached.nextCursor;
      loading = false;
      // Refresh in background
      refreshing = true;
      try {
        const res = await api.listEmails(folder);
        emails = res.emails;
        nextCursor = res.nextCursor;
        setCache(folder, res);
      } catch (e) {
        // Keep showing cached data, don't overwrite
      } finally {
        refreshing = false;
      }
      return;
    }

    // No cache — show skeleton
    loading = true;
    emails = [];
    try {
      const res = await api.listEmails(folder);
      emails = res.emails;
      nextCursor = res.nextCursor;
      setCache(folder, res);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    refreshing = true;
    try {
      const res = await api.listEmails(folder);
      emails = res.emails;
      nextCursor = res.nextCursor;
      setCache(folder, res);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      refreshing = false;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const res = await api.listEmails(folder, nextCursor);
      emails = [...emails, ...res.emails];
      nextCursor = res.nextCursor;
    } finally {
      loadingMore = false;
    }
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function formatFull(iso: string) {
    return new Date(iso).toLocaleString([], {
      weekday: "short", month: "short", day: "numeric",
      year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  async function emptyTrash() {
    if (!confirm("Permanently delete all messages in Trash?")) return;
    emptyingTrash = true;
    try {
      let cursor: string | undefined;
      do {
        const res = await api.listEmails("trash", cursor, 100);
        await Promise.all(res.emails.map(e => api.deleteEmail(e.messageId)));
        cursor = res.nextCursor;
      } while (cursor);
      await load();
    } finally {
      emptyingTrash = false;
    }
  }

  function isMobile() {
    return typeof window !== "undefined" && window.innerWidth < 768;
  }

  async function openEmail(messageId: string) {
    if (isMobile()) {
      goto(`/mail/${encodeURIComponent(messageId)}?folder=${folder}`);
      return;
    }
    selectedId = messageId;
    detailLoading = true;
    detailError = "";
    try {
      selectedEmail = await api.getEmail(messageId);
      // Mark as read if unread
      if (selectedEmail && !selectedEmail.read) {
        await api.updateEmail(messageId, { read: true });
        selectedEmail.read = true;
        const idx = emails.findIndex(e => e.messageId === messageId);
        if (idx >= 0) emails[idx] = { ...emails[idx], read: true };
      }
    } catch (e) {
      detailError = (e as Error).message;
    } finally {
      detailLoading = false;
    }
  }

  function closePanel() {
    selectedId = null;
    selectedEmail = null;
  }

  async function toggleStar(e: MouseEvent, email: StoredEmail) {
    e.stopPropagation();
    const prev = email.starred;
    const idx = emails.findIndex(em => em.messageId === email.messageId);
    if (idx >= 0) emails[idx] = { ...emails[idx], starred: !prev };
    if (selectedEmail?.messageId === email.messageId) selectedEmail = { ...selectedEmail, starred: !prev };
    try {
      await api.updateEmail(email.messageId, { starred: !prev });
    } catch {
      if (idx >= 0) emails[idx] = { ...emails[idx], starred: prev };
      if (selectedEmail?.messageId === email.messageId) selectedEmail = { ...selectedEmail, starred: prev };
    }
  }

  async function toggleRead(e: MouseEvent, email: StoredEmail) {
    e.stopPropagation();
    const prev = email.read;
    const idx = emails.findIndex(em => em.messageId === email.messageId);
    if (idx >= 0) emails[idx] = { ...emails[idx], read: !prev };
    syncCache();
    try {
      await api.updateEmail(email.messageId, { read: !prev });
    } catch {
      if (idx >= 0) emails[idx] = { ...emails[idx], read: prev };
      syncCache();
    }
  }

  async function trashEmail(e: MouseEvent, email: StoredEmail) {
    e.stopPropagation();
    try {
      await api.deleteEmail(email.messageId);
      emails = emails.filter(em => em.messageId !== email.messageId);
      syncCache();
      if (selectedId === email.messageId) closePanel();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function detailToggleStar() {
    if (!selectedEmail) return;
    const prev = selectedEmail.starred;
    selectedEmail = { ...selectedEmail, starred: !prev };
    const idx = emails.findIndex(e => e.messageId === selectedEmail!.messageId);
    if (idx >= 0) emails[idx] = { ...emails[idx], starred: !prev };
    try {
      await api.updateEmail(selectedEmail.messageId, { starred: !prev });
    } catch {
      selectedEmail = { ...selectedEmail, starred: prev };
      if (idx >= 0) emails[idx] = { ...emails[idx], starred: prev };
    }
  }

  async function detailMoveToTrash() {
    if (!selectedEmail) return;
    try {
      await api.deleteEmail(selectedEmail.messageId);
      emails = emails.filter(e => e.messageId !== selectedEmail!.messageId);
      closePanel();
    } catch (e) {
      detailError = (e as Error).message;
    }
  }

  function detailReply() {
    if (!selectedEmail) return;
    const to = encodeURIComponent(selectedEmail.from.address);
    const subject = encodeURIComponent(`Re: ${selectedEmail.subject}`);
    const replyTo = encodeURIComponent(selectedEmail.messageId);
    goto(`/mail/compose?to=${to}&subject=${subject}&replyTo=${replyTo}`);
  }

  function injectIframeStyles(html: string): string {
    const style = `<style>
      html { overflow-x: hidden !important; }
      body {
        max-width: 100% !important;
        overflow-x: hidden !important;
        word-break: break-word;
        background: #1a1d27 !important;
        color: #e2e4f0 !important;
        font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif !important;
        font-size: 14px !important;
        line-height: 1.65 !important;
        padding: 20px !important;
        margin: 0 !important;
      }
      a { color: #7b8af0 !important; }
      img, table, td, th, div, p, span { max-width: 100% !important; box-sizing: border-box !important; }
      img { height: auto !important; }
      pre { white-space: pre-wrap !important; color: #e2e4f0 !important; }
      blockquote {
        border-left: 3px solid #3a3f5c !important;
        margin: 12px 0 !important;
        padding: 4px 16px !important;
        color: #8b90a8 !important;
      }
      hr { border: none !important; border-top: 1px solid #2e3347 !important; margin: 16px 0 !important; }
      table { border-collapse: collapse !important; }
      td, th { border: 1px solid #2e3347 !important; padding: 6px 10px !important; }
    </style>`;
    const headRegex = /<head>/i;
    if (headRegex.test(html)) return html.replace(headRegex, (match) => `${match}${style}`);
    return style + html;
  }

  async function openAttachment(s3Key: string) {
    if (!selectedEmail) return;
    const res = await api.getAttachmentUrl(selectedEmail.messageId, s3Key);
    window.open(res.url, "_blank");
  }

  function senderInitial(email: StoredEmail): string {
    return (email.from.name ?? email.from.address).charAt(0).toUpperCase();
  }

  function senderColor(email: StoredEmail): string {
    const name = email.from.name ?? email.from.address;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const colors = ["#5b6ad0", "#d05b6a", "#5bd08a", "#d0aa5b", "#8b5bd0", "#5bc4d0", "#d07b5b"];
    return colors[Math.abs(hash) % colors.length];
  }

  // Silent background refresh
  async function silentRefresh() {
    try {
      const res = await api.listEmails(folder);
      const existingIds = new Set(emails.map(e => e.messageId));
      const fresh = res.emails.filter(e => !existingIds.has(e.messageId));
      if (fresh.length) {
        emails = [...fresh, ...emails];
        syncCache();
      }
    } catch {
      // ignore
    }
  }

  $effect(() => {
    void folder;
    const id = setInterval(silentRefresh, 60_000);
    return () => clearInterval(id);
  });
</script>

<div class="inbox" class:has-panel={selectedId !== null}>
  <!-- Email list column -->
  <div class="list-col" class:hidden-mobile={selectedId !== null}>
    <header class="toolbar">
      <h2 class="folder-title">{folder.charAt(0).toUpperCase() + folder.slice(1)}</h2>
      <div class="toolbar-actions">
        <button class="btn btn-ghost icon-btn" onclick={refresh} disabled={loading || refreshing} title="Refresh">
          <span class="refresh-icon" class:spinning={refreshing}>&#x21BA;</span>
        </button>
        {#if folder === "trash" && emails.length > 0}
          <button class="btn btn-ghost danger" onclick={emptyTrash} disabled={emptyingTrash}>
            {emptyingTrash ? "Deleting..." : "Empty Trash"}
          </button>
        {/if}
      </div>
    </header>

    {#if loading}
      <!-- Skeleton loading -->
      <div class="skeleton-list">
        {#each Array(8) as _}
          <div class="skeleton-row">
            <div class="skel skel-dot"></div>
            <div class="skel-content">
              <div class="skel-top">
                <div class="skel skel-from"></div>
                <div class="skel skel-date"></div>
              </div>
              <div class="skel skel-subject"></div>
              <div class="skel skel-preview"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if error}
      <div class="state-msg error">{error}</div>
    {:else if emails.length === 0}
      {@const empty = FOLDER_EMPTY[folder] ?? { icon: "📭", title: "No messages", desc: "This folder is empty." }}
      <div class="empty-state">
        <span class="empty-icon">{empty.icon}</span>
        <h3 class="empty-title">{empty.title}</h3>
        <p class="empty-desc">{empty.desc}</p>
        {#if empty.showCompose}
          <a href="/mail/compose" class="btn btn-primary">Compose</a>
        {/if}
      </div>
    {:else}
      <div class="email-list">
        {#each emails as email (email.messageId)}
          <div
            class="email-row"
            class:unread={!email.read}
            class:selected={selectedId === email.messageId}
            onclick={() => openEmail(email.messageId)}
            onkeydown={(e) => e.key === "Enter" && openEmail(email.messageId)}
            tabindex="0"
            role="button"
          >
            <!-- Unread dot -->
            <div class="dot-col">
              {#if !email.read}
                <span class="unread-dot"></span>
              {/if}
            </div>

            <div class="row-main">
              <div class="row-top">
                <span class="from">
                  {email.from.name ?? email.from.address}
                </span>
                {#if email.starred}<span class="star" title="Starred">&#9733;</span>{/if}
                {#if email.attachments?.length}<span class="attach-badge" title="Has attachments">&#128206;</span>{/if}
                <span class="date">{formatDate(email.receivedAt)}</span>
              </div>
              <div class="row-bottom">
                <span class="subject">{email.subject}</span>
                {#if email.bodyText}
                  <span class="preview"> &mdash; {email.bodyText.slice(0, 80)}</span>
                {/if}
              </div>
            </div>

            <!-- Hover actions -->
            <div class="hover-actions">
              <button
                class="action-btn"
                onclick={(e) => toggleRead(e, email)}
                title={email.read ? "Mark unread" : "Mark read"}
              >
                {email.read ? "&#9711;" : "&#9679;"}
              </button>
              <button
                class="action-btn"
                onclick={(e) => toggleStar(e, email)}
                title={email.starred ? "Unstar" : "Star"}
              >
                {email.starred ? "&#9733;" : "&#9734;"}
              </button>
              <button
                class="action-btn danger"
                onclick={(e) => trashEmail(e, email)}
                title="Delete"
              >
                &#9003;
              </button>
            </div>
          </div>
        {/each}
      </div>

      {#if nextCursor}
        <div class="load-more">
          <button class="btn btn-ghost" onclick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Detail panel (desktop split-pane) -->
  {#if selectedId !== null}
    <div class="detail-panel">
      {#if detailLoading}
        <div class="detail-skeleton">
          <div class="detail-skel-toolbar">
            <div class="skel skel-btn"></div>
            <div class="skel skel-btn"></div>
            <div class="skel skel-btn"></div>
          </div>
          <div class="detail-skel-body">
            <div class="skel skel-title"></div>
            <div class="skel-sender-row">
              <div class="skel skel-avatar"></div>
              <div class="skel-sender-lines">
                <div class="skel skel-line-md"></div>
                <div class="skel skel-line-sm"></div>
              </div>
            </div>
            <div class="skel-body-lines">
              <div class="skel skel-line-full"></div>
              <div class="skel skel-line-lg"></div>
              <div class="skel skel-line-md"></div>
              <div class="skel skel-line-lg"></div>
            </div>
          </div>
        </div>
      {:else if detailError}
        <div class="state-msg error">{detailError}</div>
      {:else if selectedEmail}
        <!-- Toolbar -->
        <header class="detail-toolbar">
          <div class="detail-toolbar-left">
            <button class="btn btn-ghost icon-btn" onclick={detailReply} title="Reply">&#8617;</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-ghost icon-btn" onclick={detailToggleStar} title={selectedEmail.starred ? "Unstar" : "Star"}>
              <span class:starred={selectedEmail.starred}>{selectedEmail.starred ? "★" : "☆"}</span>
            </button>
            <button class="btn btn-ghost icon-btn danger" onclick={detailMoveToTrash} title="Move to trash">&#9003;</button>
          </div>
          <button class="btn btn-ghost icon-btn" onclick={closePanel} title="Close">&#10005;</button>
        </header>

        <!-- Email content -->
        <div class="detail-content">
          <h1 class="detail-subject">{selectedEmail.subject}</h1>

          <div class="sender-block">
            <div class="avatar" style="background: {senderColor(selectedEmail)}">
              {senderInitial(selectedEmail)}
            </div>
            <div class="sender-info">
              <div class="sender-name">
                {selectedEmail.from.name ? `${selectedEmail.from.name}` : selectedEmail.from.address}
              </div>
              <div class="sender-meta">
                To: {selectedEmail.to.map(a => a.name ?? a.address).join(", ")}
                {#if selectedEmail.cc?.length}
                  <span class="cc-label">CC: {selectedEmail.cc.map(a => a.address).join(", ")}</span>
                {/if}
              </div>
            </div>
            <span class="detail-date">{formatFull(selectedEmail.receivedAt)}</span>
          </div>

          <div class="detail-body">
            {#if selectedEmail.bodyHtml}
              <div class="html-body-wrap">
                <iframe
                  bind:this={iframeEl}
                  class="html-body"
                  title="Email body"
                  srcdoc={injectIframeStyles(selectedEmail.bodyHtml)}
                  sandbox="allow-popups"
                ></iframe>
              </div>
            {:else}
              <pre class="text-body">{selectedEmail.bodyText ?? "(no body)"}</pre>
            {/if}
          </div>

          {#if selectedEmail.attachments?.length}
            <div class="attachments">
              <h3>Attachments</h3>
              <div class="attachment-grid">
                {#each selectedEmail.attachments as att}
                  <button class="attachment-chip" onclick={() => openAttachment(att.s3Key)}>
                    <span class="att-icon">&#128206;</span>
                    <span class="att-name">{att.filename}</span>
                    <span class="att-size">{Math.ceil(att.size / 1024)} KB</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Layout ─────────────────────────────────────────────────────── */
  .inbox {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .list-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    transition: flex 0.2s ease;
  }

  .inbox.has-panel .list-col {
    flex: 0 0 380px;
    border-right: 1px solid var(--border);
  }

  .detail-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    background: var(--bg-base);
  }

  /* ── Toolbar ────────────────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .toolbar-actions { display: flex; align-items: center; gap: 4px; }
  .toolbar .danger { color: var(--danger); }
  .folder-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .icon-btn {
    padding: 6px 10px;
    font-size: 16px;
    line-height: 1;
    border-radius: var(--radius-sm);
  }

  .refresh-icon {
    display: inline-block;
    transition: transform 0.3s ease;
  }
  .refresh-icon.spinning {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Skeleton loading ───────────────────────────────────────────── */
  .skeleton-list {
    padding: 4px 0;
  }
  .skeleton-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 20px;
  }
  .skel {
    background: var(--bg-raised);
    border-radius: 4px;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.8; }
  }
  .skel-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
  .skel-content { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .skel-top { display: flex; align-items: center; justify-content: space-between; }
  .skel-from { width: 120px; height: 14px; }
  .skel-date { width: 50px; height: 12px; }
  .skel-subject { width: 80%; height: 14px; }
  .skel-preview { width: 60%; height: 12px; }

  /* ── Empty states ───────────────────────────────────���───────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 24px;
    text-align: center;
    flex: 1;
  }
  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.7;
  }
  .empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 6px;
  }
  .empty-desc {
    font-size: 14px;
    color: var(--text-muted);
    max-width: 280px;
    margin-bottom: 20px;
    line-height: 1.5;
  }

  /* ── State messages ─────────────────────────────────────────────── */
  .state-msg {
    padding: 60px 20px;
    text-align: center;
    color: var(--text-secondary);
  }
  .state-msg.error { color: var(--danger); }

  /* ── Email list ─────────────────────────────────────────────────── */
  .email-list {
    overflow-y: auto;
    flex: 1;
  }

  .email-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.1s;
    color: var(--text-secondary);
    position: relative;
  }
  .email-row:hover { background: var(--bg-hover); }
  .email-row.unread {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .email-row.selected {
    background: var(--accent-dim);
  }

  /* Unread dot */
  .dot-col {
    width: 10px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
  }
  .unread-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* Row content */
  .row-main { flex: 1; min-width: 0; }
  .row-top {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .from {
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .email-row.unread .from { font-weight: 600; color: var(--text-primary); }
  .star { color: var(--warning); font-size: 13px; flex-shrink: 0; }
  .attach-badge { font-size: 12px; flex-shrink: 0; opacity: 0.7; }
  .date {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .row-bottom {
    margin-top: 2px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .subject { font-size: 13px; }
  .email-row.unread .subject { font-weight: 500; color: var(--text-primary); }
  .preview { color: var(--text-muted); font-size: 13px; }

  /* Hover actions */
  .hover-actions {
    display: none;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--bg-hover);
    border-radius: var(--radius-sm);
    padding: 2px;
    box-shadow: var(--shadow);
  }
  .email-row:hover .hover-actions { display: flex; }

  .action-btn {
    padding: 4px 8px;
    font-size: 14px;
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    line-height: 1;
  }
  .action-btn:hover { background: var(--bg-raised); color: var(--text-primary); }
  .action-btn.danger:hover { color: var(--danger); }

  .load-more { padding: 16px; text-align: center; }

  /* ── Detail panel ───────────────────────────────────────────────── */
  .detail-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .detail-toolbar-left { display: flex; align-items: center; gap: 4px; }
  .toolbar-divider {
    width: 1px;
    height: 20px;
    background: var(--border);
    margin: 0 4px;
  }
  .starred { color: var(--warning); }
  .detail-toolbar .danger { color: var(--danger); }

  /* Detail skeleton */
  .detail-skeleton { padding: 0; }
  .detail-skel-toolbar {
    display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-surface);
  }
  .skel-btn { width: 32px; height: 32px; border-radius: var(--radius-sm); }
  .detail-skel-body { padding: 24px 28px; }
  .skel-title { width: 60%; height: 22px; margin-bottom: 20px; }
  .skel-sender-row { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .skel-avatar { width: 40px; height: 40px; border-radius: 50%; }
  .skel-sender-lines { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .skel-line-sm { width: 100px; height: 12px; }
  .skel-line-md { width: 180px; height: 14px; }
  .skel-line-lg { width: 85%; height: 12px; }
  .skel-line-full { width: 100%; height: 12px; }
  .skel-body-lines { display: flex; flex-direction: column; gap: 10px; }

  /* Detail content */
  .detail-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 24px 28px;
  }

  .detail-subject {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 20px;
    line-height: 1.3;
  }

  /* Sender block with avatar */
  .sender-block {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  .sender-info {
    flex: 1;
    min-width: 0;
  }
  .sender-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .sender-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .cc-label { margin-left: 8px; }
  .detail-date {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 2px;
  }

  /* Email body */
  .detail-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .html-body-wrap {
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
    flex: 1;
    min-height: 200px;
    display: flex;
    flex-direction: column;
  }
  .html-body {
    width: 100%;
    flex: 1;
    min-height: 200px;
    border: none;
    background: var(--bg-surface);
    display: block;
  }
  .text-body {
    white-space: pre-wrap;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
    line-height: 1.7;
    padding: 4px 0;
  }

  /* Attachments */
  .attachments {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .attachments h3 {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .attachment-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .attachment-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 13px;
    transition: background 0.15s, border-color 0.15s;
  }
  .attachment-chip:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .att-icon { font-size: 14px; }
  .att-name { font-weight: 500; }
  .att-size { color: var(--text-muted); font-size: 12px; }

  /* ── Mobile ─────────────────────────────────────────────────────── */
  @media (max-width: 767px) {
    .inbox.has-panel .list-col {
      flex: 1;
      border-right: none;
    }
    .hidden-mobile { display: none; }
    .detail-panel { display: none; }
    .hover-actions { display: none !important; }
    .email-row { padding: 10px 14px; }
    .preview { display: none; }
  }

  /* Compact rows when panel is open */
  .inbox.has-panel .email-row { padding: 8px 14px; }
  .inbox.has-panel .from { font-size: 13px; }
  .inbox.has-panel .subject { font-size: 12px; }
  .inbox.has-panel .preview { display: none; }
</style>
