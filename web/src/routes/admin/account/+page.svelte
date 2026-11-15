<script lang="ts">
  import { auth } from "#lib/stores/auth.svelte.ts";
  import * as api from "#lib/api/client.ts";
  import PageHeader from "#lib/components/PageHeader.svelte";

  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");

  let pwError = $state("");
  let pwSaving = $state(false);

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { pwError = "New passwords don't match."; return; }
    pwError = ""; pwSaving = true;
    try {
      await api.updateUser(auth.email!, { currentPassword, newPassword });
      // The change revokes every session of this account, this one included.
      api.redirectToSignIn();
    } catch (err) {
      pwError = (err as Error).message;
    } finally {
      pwSaving = false;
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    api.redirectToSignIn();
  }
</script>

<PageHeader title="Account" />

<div class="scroll">
  <div class="page">
    <p class="hint">Your display name and signature are in the mail app's identity settings.</p>

    <form class="card" onsubmit={changePassword}>
      <h2>Change password</h2>
      <input type="email" value={auth.email ?? ""} autocomplete="username" hidden readonly />
      <div class="field">
        <label for="currentPw">Current password</label>
        <input id="currentPw" type="password" bind:value={currentPassword} autocomplete="current-password" required />
      </div>
      <div class="field">
        <label for="newPw">New password</label>
        <input id="newPw" type="password" bind:value={newPassword} autocomplete="new-password" required minlength="12" />
        <p class="hint">At least 12 characters with an uppercase letter, a digit, and a symbol.</p>
      </div>
      <div class="field">
        <label for="confirmPw">Confirm new password</label>
        <input id="confirmPw" type="password" bind:value={confirmPassword} autocomplete="new-password" required />
      </div>
      {#if pwError}<p class="error">{pwError}</p>{/if}
      <button class="btn btn-primary" type="submit" disabled={pwSaving}>
        {pwSaving ? "Saving…" : "Change password"}
      </button>
    </form>

    <button class="btn btn-ghost signout" onclick={signOut}>Sign out</button>
  </div>
</div>

<style>
  .scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg-base); }
  .page {
    max-width: 768px;
    margin: 0 auto;
    padding: 24px 24px calc(32px + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    gap: 32px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  h2 { font-size: 1.125rem; font-weight: 500; }

  .field { width: 100%; display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  label { font-size: 0.875rem; font-weight: 500; color: var(--text-primary); }
  input { width: 100%; height: 40px; padding: 0 12px; font-size: 0.875rem; }
  .hint { font-size: 0.75rem; color: var(--text-muted); }
  .error { color: var(--danger); font-size: 0.875rem; }

  .signout { align-self: flex-start; color: var(--danger); }
</style>
