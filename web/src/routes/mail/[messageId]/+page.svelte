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
      if (email && !email.read) {
        await api.updateEmail(messageId, { read: true });
        email.read = true;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  });

  async function toggleStar() {
    if (!email) return;
    const previousStarred = email.starred;
    email.starred = !email.starred;
    try {
      await api.updateEmail(messageId, { starred: email.starred });
    } catch (e) {
      email.starred = previousStarred;
      error = (e as Error).message || "Failed to update starred state.";
    }
  }

  async function moveToTrash() {
    try {
      await api.deleteEmail(messageId);
      goto(`/mail?folder=${folder}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to move email to trash.";
    }
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
    const res = await api.getAttachmentUrl(messageId, s3Key);
    window.open(res.url, "_blank");
  }

  function senderInitial(): string {
    if (!email) return "?";
    return (email.from.name ?? email.from.address).charAt(0).toUpperCase();
  }

  function senderColor(): string {
    if (!email) return "#5b6ad0";
    const name = email.from.name ?? email.from.address;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const colors = ["#5b6ad0", "#d05b6a", "#5bd08a", "#d0aa5b", "#8b5bd0", "#5bc4d0", "#d07b5b"];
    return colors[Math.abs(hash) % colors.length];
  }
</script>

<div class="email-view">
  <header class="toolbar">
    <button class="btn btn-ghost icon-btn" onclick={() => goto(`/mail?folder=${folder}`)}>
      &#8592; Back
    </button>
    {#if email}
      <div class="actions">
        <button class="btn btn-ghost icon-btn" onclick={reply} title="Reply">&#8617; Reply</button>
        <button class="btn btn-ghost icon-btn" onclick={toggleStar} title={email.starred ? "Unstar" : "Star"}>
          <span class:starred={email.starred}>{email.starred ? "★" : "☆"}</span>
          {email.starred ? "Unstar" : "Star"}
        </button>
        <button class="btn btn-ghost icon-btn danger" onclick={moveToTrash} title="Trash">&#9003; Trash</button>
      </div>
    {/if}
  </header>

  {#if loading}
    <div class="detail-skeleton">
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
  {:else if error}
    <div class="state-msg error">{error}</div>
  {:else if email}
    <div class="content">
      <h1 class="subject">{email.subject}</h1>

      <div class="sender-block">
        <div class="avatar" style="background: {senderColor()}">
          {senderInitial()}
        </div>
        <div class="sender-info">
          <div class="sender-name">
            {email.from.name ? `${email.from.name}` : email.from.address}
          </div>
          <div class="sender-meta">
            <span class="sender-email">{email.from.address}</span>
          </div>
        </div>
        <span class="detail-date">{formatFull(email.receivedAt)}</span>
      </div>

      <div class="meta-details">
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
      </div>

      <div class="body">
        {#if email.bodyHtml}
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
          <div class="attachment-grid">
            {#each email.attachments as att}
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

<style>
  .email-view { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .icon-btn { padding: 6px 10px; font-size: 14px; line-height: 1; }
  .actions { display: flex; gap: 4px; }
  .danger { color: var(--danger); }
  .starred { color: var(--warning); }

  .state-msg { padding: 60px 20px; text-align: center; color: var(--text-secondary); }
  .state-msg.error { color: var(--danger); }

  /* Skeleton */
  .detail-skeleton { padding: 28px 32px; }
  .skel {
    background: var(--bg-raised);
    border-radius: 4px;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
  .skel-title { width: 60%; height: 22px; margin-bottom: 24px; }
  .skel-sender-row { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
  .skel-avatar { width: 40px; height: 40px; border-radius: 50%; }
  .skel-sender-lines { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .skel-line-sm { width: 100px; height: 12px; }
  .skel-line-md { width: 180px; height: 14px; }
  .skel-line-lg { width: 85%; height: 12px; }
  .skel-line-full { width: 100%; height: 12px; }
  .skel-body-lines { display: flex; flex-direction: column; gap: 10px; }

  /* Content */
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 28px 32px;
    max-width: 860px;
    width: 100%;
  }

  @media (max-width: 599px) {
    .content { padding: 16px; }
    .detail-skeleton { padding: 16px; }
    .subject { font-size: 17px !important; }
    .actions { gap: 2px; }
    .actions .icon-btn { padding: 6px 8px; font-size: 13px; }
  }

  .subject {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 20px;
    line-height: 1.3;
  }

  /* Sender block */
  .sender-block {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
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
  .sender-info { flex: 1; min-width: 0; }
  .sender-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .sender-email { font-size: 12px; color: var(--text-muted); }
  .sender-meta { margin-top: 2px; }
  .detail-date { font-size: 12px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; margin-top: 2px; }

  /* To/CC details */
  .meta-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .meta-row { display: flex; gap: 12px; font-size: 12px; color: var(--text-secondary); }
  .label { color: var(--text-muted); width: 28px; flex-shrink: 0; }

  /* Body */
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
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
</style>
