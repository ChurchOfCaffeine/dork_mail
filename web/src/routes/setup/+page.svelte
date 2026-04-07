<script lang="ts">
  import { goto } from "$app/navigation";
  import * as api from "$lib/api/client";
  import { auth } from "$lib/stores/auth.svelte";
  import type { DnsCheckResult } from "@dork-mail/shared";

  // ─── State ──────────────────────────────────────────────────────────────────

  let dns = $state<DnsCheckResult | null>(null);
  let sesStatus = $state<{ verificationStatus: string; dkim: any; inSandbox: boolean; quota: { max24Hour: number; maxSendRate: number; sentLast24Hours: number }; productionReview?: { status: string; caseId?: string } | null } | null>(null);
  let verifiedEmails = $state<{ email: string; status: string }[]>([]);

  let loading = $state(true);
  let error = $state("");
  let applying = $state(false);
  let applyMsg = $state("");
  let verifying = $state(false);

  let newEmail = $state("");
  let addingEmail = $state(false);
  let addEmailMsg = $state("");
  let addEmailError = $state("");

  let verifyingSelf = $state(false);
  let selfVerifyMsg = $state("");

  let prodWebsiteUrl = $state("");
  let prodUseCase = $state("");
  let requestingProd = $state(false);
  let prodMsg = $state("");
  let prodError = $state("");

  let selfIdentity = $derived(verifiedEmails.find(e => e.email === auth.email));

  $effect(() => {
    if (!auth.isAdmin) goto("/mail");
  });

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = "";
    try {
      [dns, sesStatus, verifiedEmails] = await Promise.all([
        api.checkDns(),
        api.getSesStatus(),
        api.listVerifiedEmails(),
      ]);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function applyAll() {
    if (!dns?.issues.length) return;
    applying = true; applyMsg = "";
    try {
      const res = await api.applyDns(dns.issues as any);
      applyMsg = `Applied ${res.applied} record(s). DNS may take a few minutes to propagate.`;
      await load();
    } catch (e) { applyMsg = (e as Error).message; }
    finally { applying = false; }
  }

  async function triggerVerify() {
    verifying = true;
    try { await api.triggerSesVerify(); await load(); }
    catch (e) { error = (e as Error).message; }
    finally { verifying = false; }
  }

  async function addEmail() {
    if (!newEmail) return;
    addingEmail = true; addEmailMsg = ""; addEmailError = "";
    try {
      const res = await api.addVerifiedEmail(newEmail);
      addEmailMsg = res.message;
      newEmail = "";
      await load();
    } catch (e) {
      addEmailError = (e as Error).message;
    } finally {
      addingEmail = false;
    }
  }

  async function verifySelf() {
    if (!auth.email) return;
    verifyingSelf = true; selfVerifyMsg = "";
    try {
      await api.addVerifiedEmail(auth.email);
      selfVerifyMsg = "Verification email sent — check your inbox and click the link.";
      await load();
    } catch (e) {
      selfVerifyMsg = (e as Error).message;
    } finally {
      verifyingSelf = false;
    }
  }

  async function requestProductionAccess() {
    if (!prodWebsiteUrl || !prodUseCase) return;
    requestingProd = true; prodMsg = ""; prodError = "";
    try {
      const res = await api.requestProductionAccess(prodWebsiteUrl, prodUseCase);
      prodMsg = res.message;
      await load();
    } catch (e) {
      prodError = (e as Error).message;
    } finally {
      requestingProd = false;
    }
  }

  async function removeEmail(email: string) {
    await api.removeVerifiedEmail(email);
    verifiedEmails = verifiedEmails.filter(e => e.email !== email);
  }

  function statusColor(s: string) {
    if (s === "Success" || s === "success") return "var(--success)";
    if (s === "Pending" || s === "pending") return "var(--warning)";
    return "var(--danger)";
  }
</script>

<div class="setup-page">
  <header class="page-header">
    <h1>Setup & DNS Wizard</h1>
    <button class="btn btn-ghost" onclick={load} disabled={loading}>↺ Refresh</button>
  </header>

  {#if loading}
    <div class="state-msg">Checking status…</div>
  {:else if error}
    <div class="state-msg error">{error}</div>
  {:else}

    <!-- ─── SES Sandbox Status ─────────────────────────────────────────── -->
    {#if sesStatus?.inSandbox}
      <section class="card sandbox-card">
        <div class="sandbox-header">
          <span class="sandbox-icon">⚠</span>
          <div>
            <h2>SES Sandbox Mode Active</h2>
            <p class="hint">You can only send to verified email addresses. Request production access to send to anyone.</p>
          </div>
        </div>

        <div class="quota-row">
          <div class="quota-item">
            <span class="quota-val">{sesStatus.quota.sentLast24Hours}</span>
            <span class="quota-label">sent (24h)</span>
          </div>
          <div class="quota-item">
            <span class="quota-val">{sesStatus.quota.max24Hour}</span>
            <span class="quota-label">daily limit</span>
          </div>
          <div class="quota-item">
            <span class="quota-val">{sesStatus.quota.maxSendRate}/s</span>
            <span class="quota-label">send rate</span>
          </div>
        </div>

        {#if sesStatus.productionReview?.status === "PENDING"}
          <div class="review-pending">
            <span class="review-icon">⏳</span>
            <div>
              <strong>Production access review in progress</strong>
              <p class="hint">AWS is reviewing your request. Approval typically takes 24–48 hours.</p>
              {#if sesStatus.productionReview.caseId}
                <p class="hint mono">Case ID: {sesStatus.productionReview.caseId}</p>
              {/if}
            </div>
          </div>
        {:else if sesStatus.productionReview?.status === "FAILED"}
          <div class="review-failed">
            <span>✗ Production access request was denied.</span>
            <p class="hint">You can submit a new request below.</p>
          </div>
        {/if}

        {#if !sesStatus.productionReview || sesStatus.productionReview.status === "FAILED"}
          <div class="sandbox-steps">
            <h3>Request production access</h3>
            <p class="hint">AWS reviews requests within 24–48 hours.</p>
            <input
              type="url"
              bind:value={prodWebsiteUrl}
              placeholder="https://mail.yourdomain.com"
              class="prod-input"
            />
            <textarea
              bind:value={prodUseCase}
              placeholder="Describe your use case — e.g. self-hosted transactional mail server for caffeine.church. Sending password resets, notifications, and personal email for domain users."
              rows="4"
              class="prod-input"
            ></textarea>
            {#if prodMsg}<p class="success">{prodMsg}</p>{/if}
            {#if prodError}<p class="err">{prodError}</p>{/if}
            <button
              class="btn btn-primary"
              onclick={requestProductionAccess}
              disabled={requestingProd || !prodWebsiteUrl || !prodUseCase}
            >
              {requestingProd ? "Submitting…" : "Request production access"}
            </button>
          </div>
        {/if}
      </section>
    {:else if sesStatus}
      <section class="card ok-card">
        <span class="ok-icon">✓</span>
        <div>
          <h2>Production Access Enabled</h2>
          <p>{sesStatus.quota.max24Hour.toLocaleString()} emails/day · {sesStatus.quota.maxSendRate}/sec send rate</p>
        </div>
      </section>
    {/if}

    <!-- ─── Your Email Identity ──────────────────────────────────────── -->
    <section class="card" class:identity-verified={selfIdentity?.status === "Success"} class:identity-pending={selfIdentity && selfIdentity.status !== "Success"} class:identity-missing={!selfIdentity}>
      <div class="identity-header">
        <div class="identity-info">
          <h2>Your Email Identity</h2>
          <p class="hint">Your account email must be verified in SES before you can send or receive test emails in sandbox mode.</p>
        </div>
        {#if selfIdentity?.status === "Success"}
          <span class="identity-badge ok">Verified</span>
        {:else if selfIdentity}
          <span class="identity-badge pending">Pending</span>
        {:else}
          <span class="identity-badge missing">Not verified</span>
        {/if}
      </div>

      <div class="identity-email">{auth.email}</div>

      {#if selfIdentity?.status === "Success"}
        <p class="identity-ok-msg">Your email is verified. You can send and receive emails in sandbox mode.</p>
      {:else if selfIdentity}
        <p class="hint">A verification email was sent to your inbox. Click the link inside to complete verification, then refresh this page.</p>
        <button class="btn btn-ghost sm" onclick={verifySelf} disabled={verifyingSelf}>
          {verifyingSelf ? "Sending…" : "Resend verification email"}
        </button>
      {:else}
        <button class="btn btn-primary" onclick={verifySelf} disabled={verifyingSelf}>
          {verifyingSelf ? "Sending…" : "Send verification email to my inbox"}
        </button>
      {/if}
      {#if selfVerifyMsg}<p class="success">{selfVerifyMsg}</p>{/if}
    </section>

    <!-- ─── Verified Emails (sandbox testing) ─────────────────────────── -->
    {#if sesStatus?.inSandbox}
      <section class="card">
        <h2>Verified Email Addresses</h2>
        <p class="hint">While in sandbox mode, you can only send to these verified addresses. Add any email you want to test with — the recipient will get a verification link.</p>

        <div class="add-email-row">
          <input
            type="email"
            bind:value={newEmail}
            placeholder="recipient@example.com"
            onkeydown={(e) => e.key === "Enter" && addEmail()}
          />
          <button class="btn btn-primary" onclick={addEmail} disabled={addingEmail || !newEmail}>
            {addingEmail ? "Sending…" : "Send verification"}
          </button>
        </div>
        {#if addEmailMsg}<p class="success">{addEmailMsg}</p>{/if}
        {#if addEmailError}<p class="err">{addEmailError}</p>{/if}

        {#if verifiedEmails.length}
          <ul class="email-list">
            {#each verifiedEmails as e}
              <li class="email-row">
                <span class="email-addr">{e.email}</span>
                <span class="email-status" style="color: {statusColor(e.status)}">{e.status}</span>
                <button class="btn btn-ghost remove-btn" onclick={() => removeEmail(e.email)}>✕</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="none-msg">No verified email addresses yet.</p>
        {/if}
      </section>
    {/if}

    <!-- ─── SES Domain Verification ───────────────────────────────────── -->
    <section class="card">
      <h2>SES Domain Verification</h2>
      <div class="status-row">
        <span class="label">Domain</span>
        <span class="badge" style="background: {sesStatus?.verificationStatus === 'Success' ? 'rgba(91,208,138,.15)' : 'rgba(208,91,106,.15)'}; color: {statusColor(sesStatus?.verificationStatus ?? '')}">
          {sesStatus?.verificationStatus ?? "Unknown"}
        </span>
        {#if sesStatus?.verificationStatus !== "Success"}
          <button class="btn btn-ghost sm" onclick={triggerVerify} disabled={verifying}>
            {verifying ? "…" : "Re-trigger"}
          </button>
        {/if}
      </div>
      <div class="status-row">
        <span class="label">DKIM</span>
        <span class="badge" style="background: {sesStatus?.dkim?.DkimVerificationStatus === 'Success' ? 'rgba(91,208,138,.15)' : 'rgba(208,91,106,.15)'}; color: {statusColor(sesStatus?.dkim?.DkimVerificationStatus ?? '')}">
          {sesStatus?.dkim?.DkimVerificationStatus ?? "Unknown"}
        </span>
      </div>
    </section>

    <!-- ─── DNS Issues ────────────────────────────────────────────────── -->
    {#if dns?.issues.length}
      <section class="card">
        <h2>DNS Issues ({dns.issues.length})</h2>
        <ul class="issues">
          {#each dns.issues as issue}
            <li class="issue">
              <div class="issue-header">
                <span class="record-type">{issue.type}</span>
                <span class="issue-name">{issue.name}</span>
              </div>
              <code class="fix-record">{issue.value}</code>
            </li>
          {/each}
        </ul>
        {#if applyMsg}<p class="success">{applyMsg}</p>{/if}
        <button class="btn btn-primary" onclick={applyAll} disabled={applying}>
          {applying ? "Applying…" : `Apply ${dns.issues.length} fix(es) to Route 53`}
        </button>
      </section>
    {:else if dns}
      <section class="card ok-card">
        <span class="ok-icon">✓</span>
        <div><h2>DNS looks good</h2><p>MX, SPF, DKIM, and DMARC are all correct.</p></div>
      </section>
    {/if}

    <!-- ─── DNS Record Details ─────────────────────────────────────────── -->
    {#if dns}
      <section class="card">
        <h2>DNS Record Details</h2>
        <table class="records-table">
          <thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody>
            {#each dns.mx as r}
              <tr><td>MX</td><td>{r.name}</td><td class="mono">{r.value}</td><td class:ok={r.correct} class:bad={!r.correct}>{r.correct ? "✓" : "✗"}</td></tr>
            {/each}
            {#if dns.spf}
              <tr><td>SPF</td><td>{dns.spf.name}</td><td class="mono">{dns.spf.value}</td><td class:ok={dns.spf.correct} class:bad={!dns.spf.correct}>{dns.spf.correct ? "✓" : "✗"}</td></tr>
            {:else}
              <tr><td>SPF</td><td colspan="2" class="missing">Missing</td><td class="bad">✗</td></tr>
            {/if}
            {#each dns.dkim as r}
              <tr><td>DKIM</td><td class="mono small">{r.name}</td><td class="mono small">{r.value}</td><td class:ok={r.correct} class:bad={!r.correct}>{r.correct ? "✓" : "✗"}</td></tr>
            {/each}
            {#if dns.dmarc}
              <tr><td>DMARC</td><td>{dns.dmarc.name}</td><td class="mono">{dns.dmarc.value}</td><td class:ok={dns.dmarc.correct} class:bad={!dns.dmarc.correct}>{dns.dmarc.correct ? "✓" : "✗"}</td></tr>
            {:else}
              <tr><td>DMARC</td><td colspan="2" class="missing">Missing</td><td class="bad">✗</td></tr>
            {/if}
          </tbody>
        </table>
      </section>
    {/if}

  {/if}
</div>

<style>
  .setup-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 28px 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    overflow-y: auto;
    height: 100%;
  }
  .page-header { display: flex; align-items: center; justify-content: space-between; }
  .page-header h1 { font-size: 20px; font-weight: 700; }

  .state-msg { padding: 60px; text-align: center; color: var(--text-secondary); }
  .state-msg.error { color: var(--danger); }

  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ok-card { flex-direction: row; align-items: flex-start; gap: 16px; }
  .ok-icon { font-size: 22px; color: var(--success); }
  h2 { font-size: 15px; font-weight: 600; }
  .hint { font-size: 13px; color: var(--text-secondary); }

  /* Sandbox card */
  .sandbox-card { border-color: rgba(208, 170, 91, 0.4); background: rgba(208, 170, 91, 0.05); }
  .sandbox-header { display: flex; gap: 14px; align-items: flex-start; }
  .sandbox-icon { font-size: 22px; color: var(--warning); }
  .quota-row { display: flex; gap: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .quota-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 8px;
    border-right: 1px solid var(--border);
    gap: 2px;
  }
  .quota-item:last-child { border-right: none; }
  .quota-val { font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .quota-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .sandbox-steps { display: flex; flex-direction: column; gap: 10px; }
  .sandbox-steps h3 { font-size: 13px; font-weight: 600; }
  .prod-input { width: 100%; padding: 8px 12px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-raised); color: var(--text-primary); font-family: inherit; resize: vertical; }

  .review-pending {
    display: flex; gap: 12px; align-items: flex-start;
    background: rgba(91,138,208,.08); border: 1px solid rgba(91,138,208,.25);
    border-radius: var(--radius-sm); padding: 12px 14px;
  }
  .review-icon { font-size: 18px; }
  .review-failed { color: var(--danger); font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
  .mono { font-family: var(--font-mono); font-size: 12px; }

  /* Your Email Identity */
  .identity-verified { border-color: rgba(91,208,138,.35); background: rgba(91,208,138,.04); }
  .identity-pending  { border-color: rgba(208,170,91,.35); background: rgba(208,170,91,.04); }
  .identity-missing  { border-color: rgba(208,91,106,.25); }
  .identity-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .identity-info { display: flex; flex-direction: column; gap: 4px; }
  .identity-badge {
    padding: 2px 12px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .identity-badge.ok      { background: rgba(91,208,138,.15); color: var(--success); }
  .identity-badge.pending { background: rgba(208,170,91,.15); color: var(--warning); }
  .identity-badge.missing { background: rgba(208,91,106,.12); color: var(--danger); }
  .identity-email { font-family: var(--font-mono); font-size: 14px; color: var(--text-primary); background: var(--bg-raised); padding: 8px 12px; border-radius: var(--radius-sm); }
  .identity-ok-msg { font-size: 13px; color: var(--success); }

  /* Verified emails */
  .add-email-row { display: flex; gap: 8px; }
  .add-email-row input { flex: 1; padding: 8px 12px; }
  .success { color: var(--success); font-size: 13px; }
  .err { color: var(--danger); font-size: 13px; }
  .email-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .email-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-raised);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .email-addr { flex: 1; }
  .email-status { font-size: 12px; font-weight: 600; }
  .remove-btn { font-size: 12px; color: var(--text-muted); padding: 2px 6px; }
  .none-msg { font-size: 13px; color: var(--text-muted); }

  /* SES status */
  .status-row { display: flex; align-items: center; gap: 10px; }
  .label { color: var(--text-muted); font-size: 13px; width: 60px; }
  .badge { padding: 2px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .sm { font-size: 12px; padding: 4px 10px; }

  /* DNS issues */
  .issues { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .issue {
    background: var(--bg-raised);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .issue-header { display: flex; align-items: center; gap: 10px; }
  .record-type { font-size: 11px; font-weight: 700; background: var(--accent-dim); color: var(--accent); padding: 1px 7px; border-radius: 99px; }
  .issue-name { font-size: 13px; color: var(--text-muted); }
  .fix-record { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); background: var(--bg-base); padding: 4px 8px; border-radius: var(--radius-sm); }

  /* DNS table */
  .records-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .records-table th { text-align: left; color: var(--text-muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .records-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .mono { font-family: var(--font-mono); word-break: break-all; }
  .small { font-size: 11px; }
  .missing { color: var(--text-muted); font-style: italic; }
  .ok { color: var(--success); }
  .bad { color: var(--danger); }

  button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
