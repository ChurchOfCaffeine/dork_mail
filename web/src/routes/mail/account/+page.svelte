<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import { prefs, type ThemePref } from "#lib/stores/prefs.svelte.ts";
  import { toasts } from "#lib/stores/toast.svelte.ts";
  import * as api from "#lib/api/client.ts";
  import PageHeader from "#lib/components/PageHeader.svelte";

  let displayName = $state(auth.displayName ?? "");
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");

  let profileError = $state("");
  let profileSaving = $state(false);

  let pwError = $state("");
  let pwSaving = $state(false);

  type PushState = "loading" | "unsupported" | "needs-install" | "unconfigured" | "denied" | "off" | "on";
  let push = $state<PushState>("loading");
  let pushBusy = $state(false);
  let vapidKey = "";
  let registration: ServiceWorkerRegistration | undefined;

  const themes: { id: ThemePref; label: string }[] = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];

  onMount(async () => {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iOS && !standalone) { push = "needs-install"; return; }
    registration = supported ? await navigator.serviceWorker.getRegistration() : undefined;
    if (!registration) { push = "unsupported"; return; }
    try {
      vapidKey = (await api.getPushKey()).publicKey;
    } catch {
      push = "unconfigured";
      return;
    }
    const sub = await registration.pushManager.getSubscription();
    push = sub ? "on" : Notification.permission === "denied" ? "denied" : "off";
  });

  function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  async function enablePush() {
    pushBusy = true;
    try {
      // Must be the first await so it still counts as a user gesture on iOS.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { push = "denied"; return; }
      const sub = await registration!.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
      const json = sub.toJSON();
      await api.pushSubscribe({ endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth } });
      push = "on";
      toasts.show("Notifications on");
    } catch (e) {
      toasts.error((e as Error).message);
    } finally {
      pushBusy = false;
    }
  }

  async function disablePush() {
    pushBusy = true;
    try {
      const sub = await registration!.pushManager.getSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      push = "off";
    } catch (e) {
      toasts.error((e as Error).message);
    } finally {
      pushBusy = false;
    }
  }

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault();
    if (!displayName.trim()) { profileError = "Display name can't be empty."; return; }
    profileError = ""; profileSaving = true;
    try {
      await api.updateUser(auth.email!, { displayName: displayName.trim() });
      auth.updateDisplayName(displayName.trim());
      toasts.show("Display name saved");
    } catch (err) {
      profileError = (err as Error).message;
    } finally {
      profileSaving = false;
    }
  }

  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { pwError = "New passwords don't match."; return; }
    pwError = ""; pwSaving = true;
    try {
      await api.updateUser(auth.email!, { currentPassword, newPassword });
      toasts.show("Password changed");
      currentPassword = ""; newPassword = ""; confirmPassword = "";
    } catch (err) {
      pwError = (err as Error).message;
    } finally {
      pwSaving = false;
    }
  }

  function signOut() {
    auth.logout();
    goto("/login");
  }
</script>

<PageHeader title="Account" />

<div class="scroll">
  <div class="page">
    <form class="card" onsubmit={saveProfile}>
      <h2>Profile</h2>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" value={auth.email ?? ""} disabled />
      </div>
      <div class="field">
        <label for="displayName">Display name</label>
        <input id="displayName" type="text" bind:value={displayName} placeholder="Your name" autocomplete="name" />
        <p class="hint">Shown as the sender name on mail you send.</p>
      </div>
      {#if profileError}<p class="error">{profileError}</p>{/if}
      <button class="btn btn-primary" type="submit" disabled={profileSaving || displayName.trim() === auth.displayName}>
        {profileSaving ? "Saving…" : "Save"}
      </button>
    </form>

    <section class="card">
      <h2>Appearance</h2>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        {#each themes as t (t.id)}
          <button role="radio" aria-checked={prefs.theme === t.id} class:on={prefs.theme === t.id} onclick={() => prefs.setTheme(t.id)}>{t.label}</button>
        {/each}
      </div>
    </section>

    <section class="card">
      <h2>Notifications</h2>
      {#if push === "loading"}
        <p class="hint">Checking…</p>
      {:else if push === "needs-install"}
        <p class="hint">On iPhone and iPad, notifications work from the installed app. Tap Share, then Add to Home Screen, and open Dork Mail from there.</p>
      {:else if push === "unsupported"}
        <p class="hint">This browser doesn't support push notifications.</p>
      {:else if push === "unconfigured"}
        <p class="hint">Push isn't configured on this server. An admin needs to set the VAPID keys.</p>
      {:else if push === "denied"}
        <p class="hint">Notifications are blocked for this site. Allow them in your browser or system settings, then reload.</p>
      {:else}
        <div class="toggle-row">
          <div>
            <p>New mail alerts</p>
            <p class="hint">For this device only.</p>
          </div>
          <button
            class="switch"
            class:on={push === "on"}
            role="switch"
            aria-checked={push === "on"}
            aria-label="New mail alerts"
            disabled={pushBusy}
            onclick={() => (push === "on" ? disablePush() : enablePush())}
          ><span></span></button>
        </div>
      {/if}
    </section>

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
    max-width: 560px;
    margin: 0 auto;
    padding: 24px 20px calc(32px + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding: 20px;
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }
  h2 { font-size: 15px; font-weight: 600; }

  .field { width: 100%; display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
  input { width: 100%; height: 42px; padding: 0 12px; font-size: 15px; border-radius: var(--radius-sm); background: var(--bg-base); }
  input:disabled { opacity: 0.6; cursor: not-allowed; }
  .hint { font-size: 13px; color: var(--text-muted); }
  .error { color: var(--danger); font-size: 13px; }

  .segmented {
    display: flex;
    width: 100%;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--bg-raised);
  }
  .segmented button {
    flex: 1;
    height: 36px;
    border-radius: calc(var(--radius) - 3px);
    color: var(--text-secondary);
    font-weight: 500;
    transition: background 0.15s, color 0.15s;
  }
  .segmented button.on { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow); }

  .toggle-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .switch {
    position: relative;
    width: 50px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 99px;
    background: var(--border);
    transition: background 0.2s;
  }
  .switch span {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.2s;
  }
  .switch.on { background: var(--success); }
  .switch.on span { transform: translateX(20px); }

  .signout { align-self: center; color: var(--danger); }
</style>
