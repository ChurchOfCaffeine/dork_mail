<script lang="ts">
  import { fade } from "svelte/transition";
  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import { ui } from "#lib/stores/ui.svelte.ts";
  import * as api from "#lib/api/client.ts";
  import Icon from "#lib/components/Icon.svelte";
  import Toasts from "#lib/components/Toasts.svelte";

  let { children } = $props();

  afterNavigate(() => { ui.drawerOpen = false; });

  async function signOut() {
    await api.logout().catch(() => {});
    api.redirectToSignIn();
  }
</script>

{#if ui.drawerOpen}
  <div class="backdrop" role="presentation" onclick={() => (ui.drawerOpen = false)} transition:fade={{ duration: 150 }}></div>
{/if}

<div class="shell">
  <aside class="sidebar" class:open={ui.drawerOpen} aria-label="Admin">
    <div class="brand">
      <img src="/icon.svg" alt="" width="28" height="28" />
      <span>Dork Mail</span>
    </div>

    <a href="/" class="btn btn-primary compose" data-sveltekit-reload>
      <Icon name="inbox" size={18} /> Open mail
    </a>

    <nav class="folders">
      <a href="/admin/account" class="folder" class:active={page.url.pathname === "/admin/account"}>
        <Icon name="user" size={19} />
        <span class="label account">
          <span>{auth.displayName || "Account"}</span>
          <span class="email">{auth.email}</span>
        </span>
      </a>
      {#if auth.isAdmin}
        <a href="/admin/users" class="folder" class:active={page.url.pathname === "/admin/users"}>
          <Icon name="users" size={19} /><span class="label">Users</span>
        </a>
        <a href="/admin/setup" class="folder" class:active={page.url.pathname === "/admin/setup"}><Icon name="globe" size={19} /><span class="label">Setup / DNS</span></a>
      {/if}
    </nav>

    <div class="footer">
      <button class="folder" onclick={signOut}><Icon name="log-out" size={19} /><span class="label">Sign out</span></button>
    </div>
  </aside>

  <main class="main">
    {#if !ui.online}
      <div class="offline" transition:fade={{ duration: 150 }}><Icon name="offline" size={14} /> Offline</div>
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
    background: var(--bg-base);
  }

  .sidebar {
    width: 256px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 8px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 12px;
    margin-bottom: 12px;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .brand img { border-radius: 6px; }

  .compose {
    justify-content: center;
    gap: 8px;
    margin: 0 4px 16px;
  }

  .folders { display: flex; flex-direction: column; gap: 2px; flex: 1; }

  .folder {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 36px;
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.875rem;
    text-align: left;
    transition: background 0.15s, color 0.15s;
  }
  .folder :global(svg) { color: var(--text-muted); }
  .folder:hover { background: var(--bg-raised); color: var(--text-primary); }
  .folder.active { background: var(--accent-dim); color: var(--accent-dim-text); font-weight: 500; }
  .folder.active :global(svg) { color: inherit; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .footer {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 8px;
    margin-top: 8px;
    border-top: 1px solid var(--border);
  }
  .footer .folder, .footer .folder :global(svg) { color: var(--danger); }
  .account { display: flex; flex-direction: column; line-height: 1.3; }
  .email { font-size: 0.75rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }

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
    font-size: 0.75rem;
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
    .folder { min-height: 46px; font-size: 0.9375rem; }
    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 199;
      background: var(--bg-overlay);
    }
  }
</style>
