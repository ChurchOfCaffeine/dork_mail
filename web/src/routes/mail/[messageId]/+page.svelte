<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import * as api from "$lib/api/client";
  import type { StoredEmail } from "@dork-mail/shared";

  let email = $state<StoredEmail | null>(null);
  let loading = $state(true);
  let error = $state("");
  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);

  let messageId = $derived(page.params.messageId!);
  let folder = $derived(page.url.searchParams.get("folder") ?? "inbox");

  $effect(async () => {
    loading = true;
    error = "";
    email = null;
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

  function injectIframeStyles(html: string): string {
    const style = `<style>
      html { overflow-x: hidden !important; }
      body { max-width: 100% !important; overflow-x: hidden !important; word-break: break-word; background: #f9f9f9 !important; }
      img, table, td, th, div, p, span { max-width: 100% !important; box-sizing: border-box !important; }
      img { height: auto !important; }
      pre { white-space: pre-wrap !important; }
    </style>`;
    if (html.includes('<head>')) return html.replace('<head>', `<head>${style}`);
    if (html.includes('<HEAD>')) return html.replace('<HEAD>', `<HEAD>${style}`);
    return style + html;
  }

  async function openAttachment(s3Key: string) {
    const res = await api.getAttachmentUrl(messageId, s3Key);
    window.open(res.url, "_blank");
  }
</script>

<div class="email-view">
  <header class="toolbar">
    <button class="btn btn-ghost back" onclick={() => goto(`/mail?folder=${folder}`)}>
      ← Back
    </button>
    {#if email}
      <div class="actions">
        <button class="btn btn-ghost" onclick={reply}>↩ Reply</button>
        <button class="btn btn-ghost" onclick={toggleStar}>
          {email.starred ? "★ Unstar" : "☆ Star"}
        </button>
        <button class="btn btn-ghost danger" onclick={moveToTrash}>⌫ Trash</button>
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

      <div class="divider"></div>

      <div class="body">
        {#if email.bodyHtml}
          <!-- Email HTML is sandboxed in an iframe to prevent script execution -->
          <div class="html-body-wrap">
            <iframe
              bind:this={iframeEl}
              class="html-body"
              title="Email body"
              srcdoc={injectIframeStyles(email.bodyHtml)}
              sandbox="allow-popups"
            ></iframe>
          </div>
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
                <button class="btn btn-ghost attachment-btn" onclick={() => openAttachment(att.s3Key)}>
                  📎 {att.filename}
                  <span class="size">({Math.ceil(att.size / 1024)} KB)</span>
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
  .email-view { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }

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
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 28px 32px;
    max-width: 860px;
    width: 100%;
  }

  @media (max-width: 599px) {
    .content { padding: 16px; }
    .subject { font-size: 17px; }
    .actions { gap: 2px; }
    .actions .btn { padding: 6px 8px; font-size: 13px; }
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

  .body { margin-top: 16px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .html-body-wrap {
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
    background: #f9f9f9;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .html-body {
    width: 100%;
    flex: 1;
    min-height: 0;
    border: none;
    background: transparent;
    display: block;
    overflow: auto;
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
