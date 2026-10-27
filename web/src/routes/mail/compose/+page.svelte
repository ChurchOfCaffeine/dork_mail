<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { goto, afterNavigate } from "$app/navigation";
  import type { EmailAddress, OutgoingAttachment, StoredEmail } from "@dork-mail/shared";
  import * as api from "#lib/api/client.ts";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import { mail } from "#lib/stores/mail.svelte.ts";
  import { toasts } from "#lib/stores/toast.svelte.ts";
  import { fullDate, formatAddress, fileSize, htmlToText } from "#lib/util/format.ts";
  import Icon from "#lib/components/Icon.svelte";
  import RecipientInput, { isValidAddress } from "#lib/components/RecipientInput.svelte";

  type Mode = "new" | "reply" | "replyAll" | "forward";

  interface Item extends OutgoingAttachment {
    id: number;
    size: number;
    progress: number;
    error?: string;
  }

  interface Draft {
    to: EmailAddress[];
    cc: EmailAddress[];
    bcc: EmailAddress[];
    subject: string;
    body: string;
    attachments: Item[];
  }

  const MAX_TOTAL = 25 * 1024 * 1024;

  // URL params are read once: they describe how this draft started.
  const params = page.url.searchParams;
  const mode = (["reply", "replyAll", "forward"].includes(params.get("mode") ?? "") ? params.get("mode") : "new") as Mode;
  const sourceId = params.get("id") ?? undefined;
  const draftKey = `dm:draft:${mode}:${sourceId ?? ""}`;
  const composeUrl = page.url.pathname + page.url.search;

  let to = $state<EmailAddress[]>([]);
  let cc = $state<EmailAddress[]>([]);
  let bcc = $state<EmailAddress[]>([]);
  let subject = $state("");
  let body = $state("");
  let items = $state<Item[]>([]);
  let showCcBcc = $state(false);
  let ready = $state(false);
  let loadError = $state("");
  let dragging = $state(false);

  let textarea = $state<HTMLTextAreaElement>();
  let fileInput = $state<HTMLInputElement>();
  let toField = $state<RecipientInput>();
  let ccField = $state<RecipientInput>();
  let bccField = $state<RecipientInput>();

  let nextItemId = 1;
  let uploading = $derived(items.some(i => !i.s3Key && !i.error));
  let total = $derived(items.reduce((n, i) => n + i.size, 0));
  let title = $derived({ new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" }[mode]);
  let hasContent = $derived(!!(to.length || cc.length || bcc.length || subject.trim() || body.trim() || items.length));

  function prefixed(prefix: string, s: string) {
    return new RegExp(`^${prefix}:`, "i").test(s.trim()) ? s : `${prefix}: ${s}`;
  }

  function originalText(e: StoredEmail) {
    return e.bodyText ?? (e.bodyHtml ? htmlToText(e.bodyHtml) : "");
  }

  function build(e: StoredEmail) {
    const me = auth.email;
    const fromMe = e.from.address === me;
    if (mode === "forward") {
      subject = prefixed("Fwd", e.subject);
      body = [
        "", "",
        "---------- Forwarded message ----------",
        `From: ${formatAddress(e.from)}`,
        `Date: ${fullDate(e.receivedAt)}`,
        `Subject: ${e.subject}`,
        `To: ${e.to.map(formatAddress).join(", ")}`,
        ...(e.cc?.length ? [`Cc: ${e.cc.map(formatAddress).join(", ")}`] : []),
        "",
        originalText(e),
      ].join("\n");
      items = (e.attachments ?? []).filter(a => !a.url).map(a => ({
        id: nextItemId++, s3Key: a.s3Key, filename: a.filename, contentType: a.contentType, size: a.size, progress: 1,
      }));
      return;
    }

    const replyTarget = fromMe ? e.to : (e.replyTo?.length ? e.replyTo : [e.from]);
    to = replyTarget;
    if (mode === "replyAll") {
      const seen = new Set([me, ...to.map(a => a.address)]);
      const others = [...(fromMe ? [] : e.to), ...(e.cc ?? [])].filter(a => !seen.has(a.address) && seen.add(a.address));
      cc = others;
    }
    subject = prefixed("Re", e.subject);
    const quoted = originalText(e).split("\n").map(l => `> ${l}`).join("\n");
    body = `\n\nOn ${fullDate(e.receivedAt)}, ${formatAddress(e.from)} wrote:\n${quoted}`;
  }

  onMount(async () => {
    let draft: Draft | null = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey) ?? "null"); } catch { /* corrupt draft */ }

    if (draft) {
      ({ to, cc, bcc, subject, body } = draft);
      items = draft.attachments.filter(a => a.s3Key);
      nextItemId = Math.max(0, ...items.map(i => i.id)) + 1;
    } else if (mode !== "new" && sourceId) {
      try {
        build(await mail.getMessage(sourceId));
      } catch (e) {
        loadError = (e as Error).message;
      }
    } else {
      const presetTo = params.get("to");
      if (presetTo) to = presetTo.split(",").map(a => ({ address: a.trim().toLowerCase() })).filter(a => a.address);
      subject = params.get("subject") ?? "";
    }
    showCcBcc = cc.length > 0 || bcc.length > 0;
    ready = true;

    queueMicrotask(() => {
      autosize();
      if (mode === "reply" || mode === "replyAll") {
        textarea?.focus();
        textarea?.setSelectionRange(0, 0);
        textarea?.scrollIntoView({ block: "nearest" });
      } else if (!to.length) {
        document.getElementById("rcpt-To")?.focus();
      } else {
        textarea?.focus();
      }
    });
  });

  function saveDraft() {
    try {
      if (hasContent) localStorage.setItem(draftKey, JSON.stringify({ to, cc, bcc, subject, body, attachments: items.filter(i => i.s3Key) } satisfies Draft));
      else localStorage.removeItem(draftKey);
    } catch { /* storage full */ }
  }

  $effect(() => {
    if (!ready) return;
    void [to, cc, bcc, subject, body, items.map(i => i.s3Key)];
    const timer = setTimeout(() => untrack(saveDraft), 400);
    return () => clearTimeout(timer);
  });

  function autosize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  let cameFromApp = false;
  afterNavigate(({ from }) => { cameFromApp = !!from; });

  function leave() {
    if (cameFromApp) history.back();
    else goto("/mail", { replace: true });
  }

  function closeKeepDraft() {
    saveDraft();
    if (hasContent) toasts.show("Draft saved");
    leave();
  }

  function discard() {
    if (hasContent && !confirm("Discard this draft?")) return;
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    leave();
  }

  function send() {
    toField?.flush();
    ccField?.flush();
    bccField?.flush();

    const all = [...to, ...cc, ...bcc];
    if (!all.length) { toasts.error("Add at least one recipient"); return; }
    const bad = all.find(a => !isValidAddress(a.address));
    if (bad) { toasts.error(`"${bad.address}" isn't a valid address`); return; }
    if (uploading) { toasts.error("Wait for attachments to finish uploading"); return; }
    if (items.some(i => i.error)) { toasts.error("Remove the attachments that failed to upload"); return; }
    if (!subject.trim() && !confirm("Send without a subject?")) return;

    saveDraft();
    mail.queueSend({
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject: subject.trim(),
      bodyText: body,
      inReplyTo: mode === "reply" || mode === "replyAll" ? sourceId : undefined,
      forwardOf: mode === "forward" ? sourceId : undefined,
      attachments: items.length ? items.map(({ s3Key, filename, contentType }) => ({ s3Key, filename, contentType })) : undefined,
    }, draftKey, composeUrl);
    leave();
  }

  function upload(url: string, file: File, contentType: string, onprogress: (p: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onprogress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
  }

  async function addFiles(files: FileList | File[]) {
    let running = total;
    for (const file of files) {
      if (running + file.size > MAX_TOTAL) {
        toasts.error(`${file.name} would put attachments over 25 MB`);
        continue;
      }
      running += file.size;
      const id = nextItemId++;
      const contentType = file.type || "application/octet-stream";
      items.push({ id, s3Key: "", filename: file.name, contentType, size: file.size, progress: 0 });
      const item = () => items.find(i => i.id === id);
      try {
        const { s3Key, uploadUrl } = await api.createUpload({ filename: file.name, contentType, size: file.size });
        await upload(uploadUrl, file, contentType, p => { const it = item(); if (it) it.progress = p; });
        const it = item();
        if (it) { it.s3Key = s3Key; it.progress = 1; }
      } catch (e) {
        const it = item();
        if (it) it.error = (e as Error).message;
      }
    }
  }

  function removeItem(id: number) {
    items = items.filter(i => i.id !== id);
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.key === "Escape" && !(e.target as HTMLElement).closest(".field")) { e.preventDefault(); closeKeepDraft(); }
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
  }
</script>

<svelte:window {onkeydown} />

<div
  class="compose"
  class:dragging
  role="region"
  aria-label={title}
  ondragover={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging = true; } }}
  ondragleave={(e) => { if (e.currentTarget === e.target) dragging = false; }}
  {ondrop}
>
  <header class="toolbar">
    <button class="icon-btn" onclick={closeKeepDraft} aria-label="Close and keep draft" title="Close (Esc)"><Icon name="x" size={22} /></button>
    <h1>{title}</h1>
    <button class="icon-btn" onclick={discard} aria-label="Discard draft" title="Discard"><Icon name="trash" /></button>
    <button class="icon-btn" onclick={() => fileInput?.click()} aria-label="Attach files" title="Attach"><Icon name="paperclip" /></button>
    <button class="btn btn-primary send" onclick={send} disabled={!ready} title="Send (⌘/Ctrl+Enter)">
      <Icon name="send" size={16} /><span class="send-label">Send</span>
    </button>
    <input bind:this={fileInput} type="file" multiple hidden onchange={(e) => { const f = e.currentTarget.files; if (f) void addFiles([...f]); e.currentTarget.value = ""; }} />
  </header>

  <div class="scroller">
    <div class="form">
      {#if loadError}<p class="load-error">Couldn't load the original message: {loadError}</p>{/if}

      <div class="to-row">
        <div class="grow"><RecipientInput bind:this={toField} label="To" bind:value={to} /></div>
        {#if !showCcBcc}
          <button class="ccbcc" onclick={() => (showCcBcc = true)}>Cc/Bcc</button>
        {/if}
      </div>
      {#if showCcBcc}
        <RecipientInput bind:this={ccField} label="Cc" bind:value={cc} />
        <RecipientInput bind:this={bccField} label="Bcc" bind:value={bcc} />
      {/if}

      <div class="subject-row">
        <input
          class="subject"
          type="text"
          placeholder="Subject"
          bind:value={subject}
          enterkeyhint="next"
          onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); textarea?.focus(); } }}
        />
      </div>

      {#if items.length}
        <ul class="attachments">
          {#each items as item (item.id)}
            <li class="attachment" class:failed={item.error}>
              <Icon name={item.contentType.startsWith("image/") ? "image" : "file"} size={18} />
              <span class="att-text">
                <span class="att-name">{item.filename}</span>
                <span class="att-meta">{item.error ?? (item.s3Key ? fileSize(item.size) : `Uploading ${Math.round(item.progress * 100)}%`)}</span>
              </span>
              <button class="att-remove" onclick={() => removeItem(item.id)} aria-label="Remove {item.filename}"><Icon name="x" size={16} /></button>
              {#if !item.s3Key && !item.error}<span class="progress" style:width="{item.progress * 100}%"></span>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      <textarea
        bind:this={textarea}
        bind:value={body}
        oninput={autosize}
        placeholder="Message"
        rows="10"
        autocapitalize="sentences"
      ></textarea>
    </div>
  </div>

  {#if dragging}
    <div class="drop"><Icon name="paperclip" size={28} /><span>Drop files to attach</span></div>
  {/if}
</div>

<style>
  .compose {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-surface);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--header-h);
    padding: 0 12px 0 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h1 { flex: 1; font-size: 17px; font-weight: 600; padding-left: 4px; }
  .send { margin-left: 6px; border-radius: 99px; padding: 8px 18px; }

  .scroller { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }

  .form {
    max-width: 860px;
    margin: 0 auto;
    padding: 4px 24px 40px;
    display: flex;
    flex-direction: column;
  }

  .load-error { color: var(--danger); font-size: 13px; padding: 10px 0; }

  .to-row { display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid var(--border); }
  .to-row :global(.field) { border-bottom: none; }
  .subject:focus-visible, textarea:focus-visible { outline: none; }
  .grow { flex: 1; min-width: 0; }
  .ccbcc { color: var(--text-muted); font-size: 14px; padding: 13px 0 0; }
  .ccbcc:hover { color: var(--accent); }

  .subject-row { border-bottom: 1px solid var(--border); }
  .subject {
    width: 100%;
    height: 46px;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 16px;
    font-weight: 500;
  }

  .attachments {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 0 0;
  }
  .attachment {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    color: var(--text-muted);
  }
  .attachment.failed { border-color: var(--danger); color: var(--danger); }
  .att-text { display: flex; flex-direction: column; min-width: 0; }
  .att-name { font-size: 13px; color: var(--text-primary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att-meta { font-size: 11px; }
  .att-remove { display: flex; padding: 6px; border-radius: 50%; color: var(--text-muted); }
  .att-remove:hover { background: var(--bg-hover); color: var(--text-primary); }
  .progress { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--accent); transition: width 0.2s; }

  textarea {
    width: 100%;
    min-height: 240px;
    margin-top: 12px;
    border: none;
    background: transparent;
    resize: none;
    padding: 0;
    font-size: 15px;
    line-height: 1.6;
    overflow: hidden;
  }

  .drop {
    position: absolute;
    inset: 12px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 2px dashed var(--accent);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
    color: var(--accent);
    font-weight: 600;
    pointer-events: none;
  }

  @media (max-width: 767px) {
    .toolbar {
      height: calc(var(--header-h) + var(--safe-top));
      padding: var(--safe-top) 8px 0 4px;
    }
    .send { padding: 8px 14px; }
    .send-label { display: none; }
    .form { padding: 0 16px calc(24px + var(--safe-bottom)); }
  }
</style>
