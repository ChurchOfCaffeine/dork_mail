<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import * as api from "$lib/api/client";
  import type { EmailAddress } from "@dork-mail/shared";

  // Pre-fill from query params (used by reply)
  $: toParam = $page.url.searchParams.get("to") ?? "";
  $: subjectParam = $page.url.searchParams.get("subject") ?? "";
  $: replyToParam = $page.url.searchParams.get("replyTo") ?? undefined;

  let to = toParam;
  let cc = "";
  let subject = subjectParam;
  let body = "";
  let sending = false;
  let error = "";

  function parseAddresses(raw: string): EmailAddress[] {
    return raw.split(",").map(s => s.trim()).filter(Boolean).map(address => ({ address }));
  }

  async function send() {
    if (!to || !subject) { error = "To and Subject are required."; return; }
    error = "";
    sending = true;
    try {
      await api.sendEmail({
        to: parseAddresses(to),
        cc: cc ? parseAddresses(cc) : undefined,
        subject,
        bodyText: body,
        replyToMessageId: replyToParam,
      });
      goto("/mail?folder=sent");
    } catch (e) {
      error = (e as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<div class="compose-page">
  <header class="toolbar">
    <button class="btn btn-ghost" on:click={() => history.back()}>← Discard</button>
    <h2>New Message</h2>
    <button class="btn btn-primary" on:click={send} disabled={sending}>
      {sending ? "Sending…" : "Send →"}
    </button>
  </header>

  <div class="form">
    <div class="field">
      <label for="to">To</label>
      <input id="to" type="text" bind:value={to} placeholder="recipient@example.com, …" />
    </div>
    <div class="field">
      <label for="cc">CC</label>
      <input id="cc" type="text" bind:value={cc} placeholder="optional" />
    </div>
    <div class="field">
      <label for="subject">Subject</label>
      <input id="subject" type="text" bind:value={subject} />
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <textarea
      id="body"
      bind:value={body}
      placeholder="Write your message…"
      rows="20"
    />
  </div>
</div>

<style>
  .compose-page { display: flex; flex-direction: column; height: 100%; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .toolbar h2 { font-size: 15px; font-weight: 600; }

  .form {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 20px 32px;
    gap: 12px;
    max-width: 860px;
    width: 100%;
    overflow-y: auto;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 10px;
  }
  label {
    width: 64px;
    color: var(--text-muted);
    font-size: 13px;
    flex-shrink: 0;
  }
  input {
    flex: 1;
    background: transparent;
    border: none;
    padding: 4px 0;
    font-size: 14px;
  }

  .error { color: var(--danger); font-size: 13px; }

  textarea {
    flex: 1;
    background: transparent;
    border: none;
    resize: none;
    font-size: 14px;
    line-height: 1.7;
    padding: 8px 0;
    color: var(--text-primary);
    font-family: var(--font-sans);
  }
  textarea:focus { outline: none; }

  button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
