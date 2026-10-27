<script lang="ts">
  import { goto } from "$app/navigation";
  import type { StoredEmail, MailFolder, Attachment } from "@dork-mail/shared";
  import * as api from "#lib/api/client.ts";
  import { mail, folderActions, FOLDER_LABELS, type FolderAction } from "#lib/stores/mail.svelte.ts";
  import { prefs } from "#lib/stores/prefs.svelte.ts";
  import { toasts } from "#lib/stores/toast.svelte.ts";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import { fullDate, shortDate, displayName, formatAddress, fileSize, linkify, splitQuoted } from "#lib/util/format.ts";
  import Icon from "./Icon.svelte";
  import Avatar from "./Avatar.svelte";
  import EmailFrame, { hasRemoteContent } from "./EmailFrame.svelte";

  let { id, folder, mobile, onclose, onnavigate, onaction, hasPrev = false, hasNext = false }: {
    id: string;
    folder: MailFolder;
    mobile: boolean;
    onclose: () => void;
    onnavigate?: (dir: -1 | 1) => void;
    /** Called after the message leaves this folder, so the parent can show the next one. */
    onaction?: () => void;
    hasPrev?: boolean;
    hasNext?: boolean;
  } = $props();

  let email = $state<StoredEmail | null>(null);
  let error = $state("");
  let showDetails = $state(false);
  let showQuoted = $state(false);
  let loadRemote = $state(false);

  // List state carries the latest read/starred flags, including optimistic ones.
  let summary = $derived(mail.find(id));
  let starred = $derived(summary?.starred ?? email?.starred ?? false);
  let read = $derived(summary?.read ?? email?.read ?? true);
  let actions = $derived(folderActions(folder));

  let attachments = $derived((email?.attachments ?? []).filter(a => !a.url));
  let inlineOrigins = $derived([...new Set((email?.attachments ?? []).filter(a => a.url).map(a => new URL(a.url!).origin))]);
  let remote = $derived(!!email?.bodyHtml && hasRemoteContent(email.bodyHtml));
  let allowRemote = $derived(loadRemote || (!!email && prefs.isTrusted(email.from.address)));
  let text = $derived(email?.bodyHtml ? null : splitQuoted(email?.bodyText ?? ""));
  let canReplyAll = $derived(!!email && [...email.to, ...(email.cc ?? [])]
    .some(a => a.address !== auth.email && a.address !== email!.from.address));

  $effect(() => {
    const target = id;
    email = null;
    error = "";
    showDetails = false;
    showQuoted = false;
    loadRemote = false;
    mail.getMessage(target).then(
      e => {
        if (target !== id) return;
        email = e;
        if (!(mail.find(target)?.read ?? e.read)) void mail.setRead([target], true);
      },
      e => { if (target === id) error = (e as Error).message; },
    );
  });

  function recipientSummary(e: StoredEmail): string {
    const names = [...e.to, ...(e.cc ?? [])].map(a => a.address === auth.email ? "me" : displayName(a));
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  }

  async function run(action: FolderAction) {
    if (action.to === "delete") {
      if (!confirm("Delete this message forever?")) return;
      onaction?.();
      await mail.deleteForever([id]);
      return;
    }
    onaction?.();
    await mail.move([id], folder, action.to, { label: action.to === "spam" ? "Reported as spam" : undefined });
  }

  function compose(mode: "reply" | "replyAll" | "forward") {
    goto(`/mail/compose?mode=${mode}&id=${encodeURIComponent(id)}`);
  }

  function mailto(href: string) {
    const url = new URL(href);
    const qs = new URLSearchParams({ to: decodeURIComponent(url.pathname) });
    const subject = url.searchParams.get("subject");
    if (subject) qs.set("subject", subject);
    goto(`/mail/compose?${qs}`);
  }

  async function openAttachment(a: Attachment) {
    const inline = a.contentType.startsWith("image/") || a.contentType === "application/pdf" || a.contentType.startsWith("text/");
    // Open synchronously inside the tap, or popup blockers (iOS especially) eat it after the await.
    const win = window.open("", "_blank");
    try {
      const { url } = await api.getAttachmentUrl(id, a.s3Key, inline);
      if (win) win.location.href = url;
      else location.href = url;
    } catch (e) {
      win?.close();
      toasts.error((e as Error).message);
    }
  }

  function attachmentIcon(a: Attachment) {
    return a.contentType.startsWith("image/") ? "image" : "file";
  }
</script>

<article class="view" class:mobile>
  <header class="toolbar">
    <button class="icon-btn" onclick={onclose} aria-label={mobile ? "Back" : "Close"} title={mobile ? "Back" : "Close (Esc)"}>
      <Icon name={mobile ? "chevron-left" : "x"} size={mobile ? 26 : 20} />
    </button>
    {#if mobile}<span class="toolbar-title">{FOLDER_LABELS[folder]}</span>{/if}
    <div class="spacer"></div>
    {#if actions.primary}
      <button class="icon-btn" onclick={() => run(actions.primary!)} title="{actions.primary.label}{folder === 'inbox' ? ' (E)' : ''}" aria-label={actions.primary.label}>
        <Icon name={actions.primary.icon} />
      </button>
    {/if}
    <button class="icon-btn danger" onclick={() => run(actions.remove)} title="{actions.remove.label} (#)" aria-label={actions.remove.label}>
      <Icon name="trash" />
    </button>
    {#if actions.spam}
      <button class="icon-btn" onclick={() => run(actions.spam!)} title={actions.spam.label} aria-label={actions.spam.label}>
        <Icon name="spam" />
      </button>
    {/if}
    <button class="icon-btn" onclick={() => { void mail.setRead([id], false); onclose(); }} title="Mark unread (U)" aria-label="Mark unread">
      <Icon name="mail" />
    </button>
    {#if !mobile}
      <button class="icon-btn" class:starred onclick={() => mail.setStarred(id, !starred)} title="{starred ? 'Unstar' : 'Star'} (S)" aria-label={starred ? "Unstar" : "Star"}>
        <Icon name="star" filled={starred} />
      </button>
      {#if onnavigate}
        <span class="sep"></span>
        <button class="icon-btn" onclick={() => onnavigate(-1)} disabled={!hasPrev} title="Newer (K)" aria-label="Newer message"><Icon name="chevron-up" /></button>
        <button class="icon-btn" onclick={() => onnavigate(1)} disabled={!hasNext} title="Older (J)" aria-label="Older message"><Icon name="chevron-down" /></button>
      {/if}
    {/if}
  </header>

  <div class="scroller">
    {#if error}
      <div class="state error">
        <p>{error}</p>
        <button class="btn btn-ghost" onclick={() => { const t = id; error = ""; mail.getMessage(t).then(e => (email = e), e => (error = e.message)); }}>Try again</button>
      </div>
    {:else if !email}
      <div class="content">
        <div class="skel" style="width: 70%; height: 24px; margin-bottom: 24px"></div>
        <div class="sender">
          <div class="skel" style="width: 40px; height: 40px; border-radius: 50%"></div>
          <div style="flex: 1; display: flex; flex-direction: column; gap: 6px">
            <div class="skel" style="width: 160px; height: 14px"></div>
            <div class="skel" style="width: 110px; height: 12px"></div>
          </div>
        </div>
        {#each [100, 92, 96, 60] as w}<div class="skel" style="width: {w}%; height: 12px; margin-top: 12px"></div>{/each}
      </div>
    {:else}
      <div class="content">
        <h1 class="subject">{email.subject || "(no subject)"}</h1>

        <div class="sender">
          <Avatar address={email.from} size={40} />
          <button class="sender-info" onclick={() => (showDetails = !showDetails)} aria-expanded={showDetails}>
            <span class="sender-top">
              <span class="sender-name">{displayName(email.from)}</span>
              <span class="sender-date" title={fullDate(email.receivedAt)}>{shortDate(email.receivedAt)}</span>
            </span>
            <span class="sender-to">to {recipientSummary(email)} <Icon name={showDetails ? "chevron-up" : "chevron-down"} size={14} /></span>
          </button>
        </div>

        {#if showDetails}
          <dl class="details">
            <dt>From</dt><dd>{formatAddress(email.from)}</dd>
            {#if email.replyTo?.length && email.replyTo[0].address !== email.from.address}
              <dt>Reply-To</dt><dd>{email.replyTo.map(formatAddress).join(", ")}</dd>
            {/if}
            <dt>To</dt><dd>{email.to.map(formatAddress).join(", ") || "(none)"}</dd>
            {#if email.cc?.length}<dt>Cc</dt><dd>{email.cc.map(formatAddress).join(", ")}</dd>{/if}
            {#if email.bcc?.length}<dt>Bcc</dt><dd>{email.bcc.map(formatAddress).join(", ")}</dd>{/if}
            <dt>Date</dt><dd>{fullDate(email.receivedAt)}</dd>
          </dl>
        {/if}

        {#if remote && !allowRemote}
          <div class="remote-banner">
            <Icon name="eye" size={18} />
            <span>Remote images are hidden.</span>
            <button class="link" onclick={() => (loadRemote = true)}>Load</button>
            <button class="link" onclick={() => prefs.trust(email!.from.address)}>Always from sender</button>
          </div>
        {/if}

        <div class="body">
          {#if email.bodyHtml}
            <EmailFrame html={email.bodyHtml} {inlineOrigins} {allowRemote} dark={prefs.dark} onmailto={mailto} />
          {:else if text}
            <div class="text-body">{#each linkify(text.body || "(no content)") as part}{#if part.href}<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>{:else}{part.text}{/if}{/each}</div>
            {#if text.quoted}
              <button class="quoted-toggle" onclick={() => (showQuoted = !showQuoted)} aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}>•••</button>
              {#if showQuoted}<div class="text-body quoted">{text.quoted}</div>{/if}
            {/if}
          {/if}
        </div>

        {#if attachments.length}
          <div class="attachments">
            {#each attachments as a (a.s3Key)}
              <button class="attachment" onclick={() => openAttachment(a)}>
                <span class="att-icon"><Icon name={attachmentIcon(a)} size={20} /></span>
                <span class="att-text">
                  <span class="att-name">{a.filename}</span>
                  <span class="att-size">{fileSize(a.size)}</span>
                </span>
                <Icon name="download" size={16} />
              </button>
            {/each}
          </div>
        {/if}

        {#if !mobile}
          <div class="reply-row">
            <button class="btn btn-ghost outline" onclick={() => compose("reply")}><Icon name="reply" size={16} />Reply</button>
            {#if canReplyAll}<button class="btn btn-ghost outline" onclick={() => compose("replyAll")}><Icon name="reply-all" size={16} />Reply all</button>{/if}
            <button class="btn btn-ghost outline" onclick={() => compose("forward")}><Icon name="forward" size={16} />Forward</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if mobile}
    <footer class="bottombar">
      <button class="icon-btn" class:starred onclick={() => mail.setStarred(id, !starred)} aria-label={starred ? "Unstar" : "Star"}>
        <Icon name="star" size={22} filled={starred} />
      </button>
      <button class="icon-btn" onclick={() => compose("reply")} aria-label="Reply" disabled={!email}><Icon name="reply" size={22} /></button>
      {#if canReplyAll}
        <button class="icon-btn" onclick={() => compose("replyAll")} aria-label="Reply all" disabled={!email}><Icon name="reply-all" size={22} /></button>
      {/if}
      <button class="icon-btn" onclick={() => compose("forward")} aria-label="Forward" disabled={!email}><Icon name="forward" size={22} /></button>
    </footer>
  {/if}
</article>

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg-surface);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--header-h);
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .mobile .toolbar {
    height: calc(var(--header-h) + var(--safe-top));
    padding-top: var(--safe-top);
    padding-left: 2px;
  }
  .toolbar-title { font-size: 16px; color: var(--accent); margin-left: -6px; }
  .mobile .toolbar > .icon-btn:first-child { color: var(--accent); }
  .spacer { flex: 1; }
  .sep { width: 1px; height: 20px; background: var(--border); margin: 0 6px; }
  .starred, .starred:hover { color: var(--warning) !important; }

  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .content {
    max-width: 880px;
    margin: 0 auto;
    padding: 24px 28px 40px;
  }
  .mobile .content { padding: 16px 16px 24px; }

  .subject {
    font-size: 22px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin-bottom: 20px;
    word-break: break-word;
  }
  .mobile .subject { font-size: 20px; margin-bottom: 16px; }

  .sender {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }
  .sender-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: left;
    padding: 0;
  }
  .sender-top { display: flex; align-items: baseline; gap: 8px; }
  .sender-name {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sender-date { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
  .sender-to {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    white-space: nowrap;
  }

  .details {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    padding: 12px 14px;
    margin: -4px 0 16px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    font-size: 13px;
  }
  .details dt { color: var(--text-muted); }
  .details dd { color: var(--text-secondary); word-break: break-word; }

  .remote-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 10px 14px;
    margin-bottom: 12px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: 13px;
  }
  .link { color: var(--accent); font-weight: 600; padding: 2px 0; }

  .text-body {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 15px;
    line-height: 1.6;
    color: var(--text-primary);
  }
  .text-body.quoted { color: var(--text-muted); border-left: 3px solid var(--border); padding-left: 12px; margin-top: 8px; }
  .quoted-toggle {
    margin-top: 12px;
    padding: 0 10px;
    height: 20px;
    border-radius: 99px;
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 1px;
  }

  .attachments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
    margin-top: 20px;
  }
  .attachment {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-muted);
    text-align: left;
    min-width: 0;
    transition: border-color 0.15s, background 0.15s;
  }
  .attachment:hover { border-color: var(--accent); background: var(--bg-hover); }
  .att-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    color: var(--accent);
    flex-shrink: 0;
  }
  .att-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .att-name { color: var(--text-primary); font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att-size { font-size: 12px; }

  .reply-row { display: flex; gap: 8px; margin-top: 28px; flex-wrap: wrap; }
  .outline { border: 1px solid var(--border); border-radius: 99px; padding: 8px 18px; }

  .bottombar {
    display: flex;
    justify-content: space-around;
    align-items: center;
    padding: 4px 8px calc(4px + var(--safe-bottom));
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .bottombar .icon-btn { width: 48px; height: 48px; color: var(--accent); }

  .state { padding: 60px 20px; text-align: center; color: var(--text-secondary); }
  .state.error p { color: var(--danger); margin-bottom: 12px; }
</style>
