<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import * as api from "$lib/api/client";
  import type { StoredEmail } from "@dork-mail/shared";

  let emails: StoredEmail[] = [];
  let loading = true;
  let error = "";
  let nextCursor: string | undefined;
  let loadingMore = false;
  let emptyingTrash = false;

  $: folder = $page.url.searchParams.get("folder") ?? "inbox";
  $: folder, load();

  async function load() {
    loading = true;
    error = "";
    emails = [];
    nextCursor = undefined;
    try {
      const res = await api.listEmails(folder);
      emails = res.emails;
      nextCursor = res.nextCursor;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
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

  function openEmail(messageId: string) {
    goto(`/mail/${encodeURIComponent(messageId)}?folder=${folder}`);
  }
</script>

<div class="inbox">
  <header class="toolbar">
    <h2 class="folder-title">{folder.charAt(0).toUpperCase() + folder.slice(1)}</h2>
    <div class="toolbar-actions">
      <button class="btn btn-ghost" on:click={load} disabled={loading} title="Refresh">↺</button>
      {#if folder === "trash" && emails.length > 0}
        <button class="btn btn-ghost danger" on:click={emptyTrash} disabled={emptyingTrash}>
          {emptyingTrash ? "Deleting…" : "Empty Trash"}
        </button>
      {/if}
    </div>
  </header>

  {#if loading}
    <div class="state-msg">Loading…</div>
  {:else if error}
    <div class="state-msg error">{error}</div>
  {:else if emails.length === 0}
    <div class="state-msg muted">No messages here.</div>
  {:else}
    <ul class="email-list">
      {#each emails as email (email.messageId)}
        <li
          class="email-row"
          class:unread={!email.read}
          on:click={() => openEmail(email.messageId)}
          on:keydown={(e) => e.key === "Enter" && openEmail(email.messageId)}
          role="button"
          tabindex="0"
        >
          <div class="row-left">
            <span class="from">{email.from.name ?? email.from.address}</span>
            {#if email.starred}<span class="star">★</span>{/if}
          </div>
          <div class="row-center">
            <span class="subject">{email.subject}</span>
            {#if email.bodyText}
              <span class="preview"> — {email.bodyText.slice(0, 80)}</span>
            {/if}
          </div>
          <div class="row-right">
            <span class="date">{formatDate(email.receivedAt)}</span>
            {#if email.attachments?.length}
              <span class="attach-icon">📎</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if nextCursor}
      <div class="load-more">
        <button class="btn btn-ghost" on:click={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .inbox { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .toolbar-actions { display: flex; align-items: center; gap: 4px; }
  .toolbar .danger { color: var(--danger); }
  .folder-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .state-msg {
    padding: 60px 20px;
    text-align: center;
    color: var(--text-secondary);
  }
  .state-msg.error { color: var(--danger); }
  .state-msg.muted { color: var(--text-muted); }

  .email-list {
    list-style: none;
    overflow-y: auto;
    flex: 1;
  }

  .email-row {
    display: grid;
    grid-template-columns: 180px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.1s;
    color: var(--text-secondary);
  }
  .email-row:hover { background: var(--bg-hover); }
  .email-row.unread {
    background: var(--bg-raised);
    color: var(--text-primary);
  }
  .email-row.unread .from,
  .email-row.unread .subject { font-weight: 600; color: var(--text-primary); }

  .row-left { display: flex; align-items: center; gap: 6px; overflow: hidden; }
  .from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .star { color: var(--warning); font-size: 12px; }

  .row-center { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .subject { font-size: 14px; }
  .preview { color: var(--text-muted); font-size: 13px; }

  .row-right {
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-muted);
  }

  .load-more { padding: 16px; text-align: center; }
</style>
