<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import * as api from "$lib/api/client";
  import type { StoredEmail } from "@dork-mail/shared";

  let email: StoredEmail | null = null;
  let loading = true;
  let error = "";
  let iframeEl: HTMLIFrameElement;

  $: messageId = $page.params.messageId;
  $: folder = $page.url.searchParams.get("folder") ?? "inbox";

  onMount(async () => {
    try {
      email = await api.getEmail(messageId);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  });

  async function toggleStar() {
    if (!email) return;
    email.starred = !email.starred;
    await api.updateEmail(messageId, { starred: email.starred });
  }

  async function moveToTrash() {
    await api.deleteEmail(messageId);
    goto(`/mail?folder=${folder}`);
  }

  async function reply() {
    const to = encodeURIComponent(email?.from.address ?? "");
    const subject = encodeURIComponent(`Re: ${email?.subject ?? ""}`);
    const replyTo = encodeURIComponent(messageId);
    goto(`/mail/compose?to=${to}&subject=${subject}&replyTo=${replyTo}`);
  }

  function formatFull(iso: string) {
    return new Date(iso).toLocaleString([], {
      weekday: "short", month: "short", day: "numeric",
      year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function onIframeLoad() {
    if (!iframeEl?.contentDocument) return;
    const h = iframeEl.contentDocument.documentElement.scrollHeight;
    iframeEl.style.height = `${h}px`;
  }

  async function openAttachment(s3Key: string) {
    const res = await api.getAttachmentUrl(messageId, s3Key);
    window.open(res.url, "_blank");
  }
</script>

<div class="email-view">
  <header class="toolbar">
    <button class="btn btn-ghost back" on:click={() => goto(`/mail?folder=${folder}`)}>
      ← Back
    </button>
    {#if email}
      <div class="actions">
        <button class="btn btn-ghost" on:click={reply}>↩ Reply</button>
        <button class="btn btn-ghost" on:click={toggleStar}>
          {email.starred ? "★ Unstar" : "☆ Star"}
        </button>
        <button class="btn btn-ghost danger" on:click={moveToTrash}>⌫ Trash</button>
      </div>
    {/if}
  </header>

  {#if loading}
    <div class="state-msg">Loading…</div>
  {:else if error}
    <div class="state-msg error">{error}</div>
  {:else if email}
    <div class="content">
      <h1 class="subject">{email.subject}</h1>

      <div class="meta">
        <div class="meta-row">
          <span class="label">From</span>
          <span>{email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}</span>
        </div>
        <div class="meta-row">
          <span class="label">To</span>
          <span>{email.to.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(", ")}</span>
        </div>
        {#if email.cc?.length}
          <div class="meta-row">
            <span class="label">CC</span>
            <span>{email.cc.map(a => a.address).join(", ")}</span>
          </div>
        {/if}
        <div class="meta-row">
          <span class="label">Date</span>
          <span>{formatFull(email.receivedAt)}</span>
        </div>
      </div>

      <div class="divider" />

      <div class="body">
        {#if email.bodyHtml}
          <!-- Email HTML is sandboxed in an iframe to prevent script execution -->
          <iframe
            bind:this={iframeEl}
            class="html-body"
            title="Email body"
            srcdoc={email.bodyHtml}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            on:load={onIframeLoad}
          />
        {:else}
          <pre class="text-body">{email.bodyText ?? "(no body)"}</pre>
        {/if}
      </div>

      {#if email.attachments?.length}
        <div class="attachments">
          <h3>Attachments</h3>
          <ul>
            {#each email.attachments as att}
              <li>
                <button class="btn btn-ghost attachment-btn" on:click={() => openAttachment(att.s3Key)}>
                  📎 {att.filename}
                  <span class="size">({Math.round(att.size / 1024)} KB)</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .email-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    gap: 8px;
  }
  .back { font-size: 14px; }
  .actions { display: flex; gap: 4px; }
  .actions .danger { color: var(--danger); }

  .state-msg {
    padding: 60px 20px;
    text-align: center;
    color: var(--text-secondary);
  }
  .state-msg.error { color: var(--danger); }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 28px 32px;
    max-width: 860px;
    width: 100%;
  }

  .subject {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 16px;
    line-height: 1.3;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }
  .meta-row { display: flex; gap: 12px; font-size: 13px; color: var(--text-secondary); }
  .label { color: var(--text-muted); width: 40px; flex-shrink: 0; }

  .body { margin-top: 16px; }
  .html-body {
    width: 100%;
    min-height: 200px;
    border: none;
    background: #fff;
    border-radius: var(--radius-sm);
    display: block;
  }
  .text-body {
    white-space: pre-wrap;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
    line-height: 1.6;
  }

  .attachments { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
  .attachments h3 { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
  .attachments ul { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }
  .attachment-btn { border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
  .size { color: var(--text-muted); font-size: 12px; }
</style>
