<script lang="ts">
  import { auth } from "$lib/stores/auth.svelte";
  import * as api from "$lib/api/client";

  let displayName = $state(auth.displayName ?? "");
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");

  let profileMsg = $state("");
  let profileError = $state("");
  let profileSaving = $state(false);

  let pwMsg = $state("");
  let pwError = $state("");
  let pwSaving = $state(false);

  async function saveProfile() {
    if (!displayName.trim()) { profileError = "Display name cannot be empty."; return; }
    profileError = ""; profileMsg = ""; profileSaving = true;
    try {
      await api.updateUser(auth.email!, { displayName: displayName.trim() });
      auth.updateDisplayName(displayName.trim());
      profileMsg = "Display name updated.";
    } catch (e) {
      profileError = (e as Error).message;
    } finally {
      profileSaving = false;
    }
  }

  async function changePassword() {
    if (!currentPassword) { pwError = "Current password is required."; return; }
    if (!newPassword)     { pwError = "New password is required."; return; }
    if (newPassword !== confirmPassword) { pwError = "Passwords do not match."; return; }
    pwError = ""; pwMsg = ""; pwSaving = true;
    try {
      await api.updateUser(auth.email!, { currentPassword, newPassword });
      pwMsg = "Password changed.";
      currentPassword = ""; newPassword = ""; confirmPassword = "";
    } catch (e) {
      pwError = (e as Error).message;
    } finally {
      pwSaving = false;
    }
  }
</script>

<div class="page">
  <h1 class="page-title">Account Settings</h1>

  <section class="card">
    <h2>Profile</h2>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" value={auth.email ?? ""} disabled />
    </div>
    <div class="field">
      <label for="displayName">Display name</label>
      <input id="displayName" type="text" bind:value={displayName} placeholder="Your name" />
      <p class="hint">This appears as the sender name on emails you send.</p>
    </div>
    {#if profileMsg}<p class="success">{profileMsg}</p>{/if}
    {#if profileError}<p class="error">{profileError}</p>{/if}
    <button class="btn btn-primary" onclick={saveProfile} disabled={profileSaving}>
      {profileSaving ? "Saving…" : "Save"}
    </button>
  </section>

  <section class="card">
    <h2>Change Password</h2>
    <div class="field">
      <label for="currentPw">Current password</label>
      <input id="currentPw" type="password" bind:value={currentPassword} autocomplete="current-password" />
    </div>
    <div class="field">
      <label for="newPw">New password</label>
      <input id="newPw" type="password" bind:value={newPassword} autocomplete="new-password" />
    </div>
    <div class="field">
      <label for="confirmPw">Confirm new password</label>
      <input id="confirmPw" type="password" bind:value={confirmPassword} autocomplete="new-password" />
    </div>
    {#if pwMsg}<p class="success">{pwMsg}</p>{/if}
    {#if pwError}<p class="error">{pwError}</p>{/if}
    <button class="btn btn-primary" onclick={changePassword} disabled={pwSaving}>
      {pwSaving ? "Saving…" : "Change password"}
    </button>
  </section>
</div>

<style>
  .page {
    padding: 32px;
    max-width: 480px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
  }

  .page-title {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 24px;
  }

  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 20px;
  }

  h2 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 16px;
  }

  .field {
    margin-bottom: 14px;
  }

  label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    box-sizing: border-box;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  input:disabled { opacity: 0.5; cursor: not-allowed; }

  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 4px 0 0;
  }

  .success { color: var(--accent); font-size: 13px; margin: 0 0 12px; }
  .error   { color: #e55; font-size: 13px; margin: 0 0 12px; }
</style>
