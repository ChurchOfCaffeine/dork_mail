<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { goto, afterNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import type { MailFolder } from "@dork-mail/shared";
  import { auth } from "$lib/stores/auth.svelte";
  import { mail, FOLDER_LABELS } from "$lib/stores/mail.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import Icon, { type IconName } from "$lib/components/Icon.svelte";
  import Toasts from "$lib/components/Toasts.svelte";

  const POLL_MS = 30_000;

  const folders: { id: MailFolder; icon: IconName }[] = [
    { id: "inbox", icon: "inbox" },
    { id: "archive", icon: "archive" },
    { id: "sent", icon: "send" },
    { id: "spam", icon: "spam" },
    { id: "trash", icon: "trash" },
  ];

  let { children } = $props();

  let activeFolder = $derived(page.url.pathname === "/mail" ? (page.url.searchParams.get("folder") ?? "inbox") as MailFolder : null);

  afterNavigate(() => { ui.drawerOpen = false; });

  function refreshNow() {
    void mail.refreshCounts();
    const f = untrack(() => activeFolder);
    if (f) void mail.refresh(f);
  }

  // Refresh whenever the app comes back to the foreground, then poll while it stays there.
  $effect(() => {
    if (!ui.visible || !ui.online) return;
    untrack(refreshNow);
    const timer = setInterval(refreshNow, POLL_MS);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "new-mail") refreshNow();
      if (e.data?.type === "open" && typeof e.data.url === "string") goto(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  });

  function signOut() {
    auth.logout();
    goto("/login");
  }
</script>

{#if ui.drawerOpen}
  <div class="backdrop" role="presentation" onclick={() => (ui.drawerOpen = false)} transition:fade={{ duration: 150 }}></div>
{/if}

<div class="shell">
  <aside class="sidebar" class:open={ui.drawerOpen} aria-label="Mailboxes">
    <div class="brand">
      <img src="/icon.svg" alt="" width="28" height="28" />
      <span>Dork Mail</span>
    </div>

    <a href="/mail/compose" class="btn btn-primary compose">
      <Icon name="compose" size={18} /> Compose
    </a>

    <nav class="folders">
      {#each folders as f (f.id)}
        {@const unread = f.id === "inbox" || f.id === "spam" ? mail.counts[f.id] : 0}
        <a href="/mail?folder={f.id}" class="folder" class:active={activeFolder === f.id} aria-current={activeFolder === f.id ? "page" : undefined}>
          <Icon name={f.icon} size={19} />
          <span class="label">{FOLDER_LABELS[f.id]}</span>
          {#if unread}<span class="count" class:muted={f.id === "spam"}>{unread > 999 ? "999+" : unread}</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="footer">
      {#if auth.isAdmin}
        <a href="/mail/admin/users" class="folder" class:active={page.url.pathname.startsWith("/mail/admin")}>
          <Icon name="users" size={19} /><span class="label">Users</span>
        </a>
        <a href="/setup" class="folder"><Icon name="globe" size={19} /><span class="label">Setup / DNS</span></a>
      {/if}
      <a href="/mail/account" class="folder" class:active={page.url.pathname === "/mail/account"}>
        <Icon name="user" size={19} />
        <span class="label account">
          <span>{auth.displayName || "Account"}</span>
          <span class="email">{auth.email}</span>
        </span>
      </a>
      <button class="folder" onclick={signOut}><Icon name="log-out" size={19} /><span class="label">Sign out</span></button>
    </div>
  </aside>

  <main class="main">
    {#if !ui.online}
      <div class="offline" transition:fade={{ duration: 150 }}><Icon name="offline" size={14} /> Offline, showing saved mail</div>
    {/if}
    {@render children()}
  </main>
</div>

<Toasts />

<style>
  .shell {
    display: flex;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg-surface);
  }

  .sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 10px;
    background: var(--bg-base);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px 16px;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .brand img { border-radius: 7px; }

  .compose {
    justify-content: flex-start;
    gap: 10px;
    margin: 0 0 16px;
    padding: 12px 18px;
    border-radius: var(--radius-lg);
    font-size: 15px;
    box-shadow: var(--shadow);
  }

  .folders { display: flex; flex-direction: column; gap: 1px; flex: 1; }

  .folder {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 99px;
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
    transition: background 0.12s, color 0.12s;
  }
  .folder:hover { background: var(--bg-hover); color: var(--text-primary); }
  .folder.active { background: var(--accent-dim); color: var(--accent); font-weight: 600; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { font-size: 12px; font-weight: 700; color: var(--text-primary); }
  .folder.active .count { color: var(--accent); }
  .count.muted { color: var(--text-muted); font-weight: 600; }

  .footer {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-top: 10px;
    margin-top: 10px;
    border-top: 1px solid var(--border);
  }
  .account { display: flex; flex-direction: column; line-height: 1.3; }
  .email { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }

  .main {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .offline {
    position: absolute;
    top: calc(var(--safe-top) + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 99px;
    background: var(--text-primary);
    color: var(--bg-surface);
    font-size: 12px;
    font-weight: 500;
    pointer-events: none;
  }

  .backdrop { display: none; }

  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 200;
      width: min(300px, 84vw);
      padding-top: calc(var(--safe-top) + 12px);
      padding-bottom: calc(var(--safe-bottom) + 12px);
      background: var(--bg-surface);
      border-right: none;
      transform: translateX(-100%);
      transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s 0.24s;
      visibility: hidden;
    }
    .sidebar.open {
      transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
      transform: none;
      visibility: visible;
      box-shadow: var(--shadow-lg);
    }
    .folder { min-height: 46px; font-size: 15px; }
    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 199;
      background: var(--bg-overlay);
    }
  }
</style>
