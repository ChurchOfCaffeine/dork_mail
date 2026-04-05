<script lang="ts">
  import { auth } from "$lib/stores/auth";
  import { goto, afterNavigate } from "$app/navigation";
  import { page } from "$app/stores";

  const folders = [
    { id: "inbox",  label: "Inbox",  icon: "⊡" },
    { id: "sent",   label: "Sent",   icon: "↗" },
    { id: "drafts", label: "Drafts", icon: "✎" },
    { id: "trash",  label: "Trash",  icon: "⌫" },
    { id: "spam",   label: "Spam",   icon: "⚑" },
  ];

  let sidebarOpen = false;
  let collapsed = false;

  // Close mobile overlay on navigation
  afterNavigate(() => { sidebarOpen = false; });

  function signOut() {
    auth.logout();
    goto("/login");
  }

  $: activeFolder = $page.url.searchParams.get("folder") ?? "inbox";
</script>

<!-- Mobile top bar (hidden on desktop) -->
<header class="mobile-topbar">
  <button
    class="hamburger"
    on:click={() => (sidebarOpen = !sidebarOpen)}
    aria-label="Toggle navigation"
    aria-expanded={sidebarOpen}
  >
    <span></span>
    <span></span>
    <span></span>
  </button>
  <span class="mobile-brand">Dork Mail</span>
  <a href="/mail/compose" class="btn btn-primary mobile-compose" aria-label="Compose">✎</a>
</header>

<!-- Mobile backdrop -->
{#if sidebarOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="backdrop" on:click={() => (sidebarOpen = false)}></div>
{/if}

<div class="shell">
  <aside class="sidebar" class:open={sidebarOpen} class:collapsed>
    <div class="sidebar-head">
      {#if !collapsed}
        <span class="brand">Dork Mail</span>
      {/if}
      <button
        class="collapse-btn btn btn-ghost"
        on:click={() => (collapsed = !collapsed)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </div>

    <a
      href="/mail/compose"
      class="btn btn-primary compose-btn"
      title={collapsed ? "Compose" : undefined}
    >
      <span class="compose-icon">✎</span>
      {#if !collapsed}<span>Compose</span>{/if}
    </a>

    <nav class="folders">
      {#each folders as f}
        <a
          href="/mail?folder={f.id}"
          class="folder-link"
          class:active={activeFolder === f.id}
          title={collapsed ? f.label : undefined}
        >
          <span class="icon">{f.icon}</span>
          {#if !collapsed}<span>{f.label}</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="sidebar-footer">
      {#if $auth.isAdmin}
        <a
          href="/setup"
          class="btn btn-ghost setup-btn"
          title={collapsed ? "Setup / DNS" : undefined}
        >
          <span>⚙</span>
          {#if !collapsed}<span>Setup / DNS</span>{/if}
        </a>
      {/if}
      <div class="user-area">
        {#if !collapsed}
          <span class="user-email">{$auth.email}</span>
          <button class="btn btn-ghost signout-btn" on:click={signOut}>Sign out</button>
        {:else}
          <button class="btn btn-ghost signout-icon" on:click={signOut} title="Sign out">⏻</button>
        {/if}
      </div>
    </div>
  </aside>

  <main class="main">
    <slot />
  </main>
</div>

<style>
  /* ── Shell ──────────────────────────────────────────────────────── */
  .shell {
    display: flex;
    height: 100dvh;
    overflow: hidden;
  }

  /* ── Sidebar ────────────────────────────────────────────────────── */
  .sidebar {
    width: 220px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 12px 0;
    flex-shrink: 0;
    overflow: hidden;
    transition: width 0.2s ease;
  }

  .sidebar.collapsed { width: 52px; }

  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 12px;
    min-height: 36px;
  }

  .sidebar.collapsed .sidebar-head {
    justify-content: center;
    padding: 0 0 12px;
  }

  .brand {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.3px;
    white-space: nowrap;
  }

  .collapse-btn {
    padding: 3px 7px;
    font-size: 16px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .collapse-btn:hover { color: var(--text-primary); }

  /* ── Compose ────────────────────────────────────────────────────── */
  .compose-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0 8px 16px;
    padding: 8px 12px;
    white-space: nowrap;
    overflow: hidden;
  }

  .sidebar.collapsed .compose-btn {
    width: 36px;
    padding: 8px;
    margin: 0 auto 16px;
  }

  /* ── Folder nav ─────────────────────────────────────────────────── */
  .folders {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .folder-link {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 16px;
    color: var(--text-secondary);
    font-size: 14px;
    text-decoration: none;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
  }
  .folder-link:hover { background: var(--bg-hover); color: var(--text-primary); }
  .folder-link.active {
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .sidebar.collapsed .folder-link {
    justify-content: center;
    padding: 9px 0;
  }

  .icon { font-style: normal; width: 18px; text-align: center; flex-shrink: 0; }

  /* ── Footer ─────────────────────────────────────────────────────── */
  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }

  .setup-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
  }

  .sidebar.collapsed .setup-btn {
    justify-content: center;
    padding: 8px 0;
  }

  .user-area {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 4px 4px 0;
  }

  .sidebar.collapsed .user-area { justify-content: center; }

  .user-email {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .signout-btn { font-size: 12px; flex-shrink: 0; }
  .signout-icon { padding: 4px 8px; }

  /* ── Main ───────────────────────────────────────────────────────── */
  .main {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* ── Mobile top bar (hidden on desktop) ─────────────────────────── */
  .mobile-topbar { display: none; }
  .backdrop { display: none; }

  /* ── Mobile ─────────────────────────────────────────────────────── */
  @media (max-width: 767px) {
    .mobile-topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 52px;
      padding: 0 12px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 50;
    }

    .mobile-brand {
      flex: 1;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.3px;
    }

    .mobile-compose {
      padding: 6px 12px;
      font-size: 15px;
    }

    .shell {
      padding-top: 52px;
      height: 100dvh;
    }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      height: 100dvh;
      width: 270px;
      z-index: 100;
      transform: translateX(-100%);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      /* Reset collapsed width on mobile */
      min-width: 270px;
    }

    .sidebar.open {
      transform: translateX(0);
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
    }

    .sidebar.collapsed { width: 270px; }

    .sidebar .sidebar-head {
      padding: 20px 16px 12px;
      justify-content: flex-start;
    }

    .sidebar .brand { display: block !important; }
    .collapse-btn { display: none; }

    /* Restore full sidebar appearance on mobile regardless of collapsed state */
    .sidebar.collapsed .sidebar-head { justify-content: flex-start; padding: 20px 16px 12px; }
    .sidebar.collapsed .compose-btn { width: auto; padding: 8px 12px; margin: 0 8px 16px; }
    .sidebar.collapsed .folder-link { justify-content: flex-start; padding: 9px 16px; }
    .sidebar.collapsed .setup-btn { justify-content: flex-start; }
    .sidebar.collapsed .user-area { justify-content: space-between; }

    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      z-index: 99;
    }
  }

  /* ── Hamburger ──────────────────────────────────────────────────── */
  .hamburger {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 36px;
    height: 36px;
    padding: 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    flex-shrink: 0;
  }
  .hamburger:hover { background: var(--bg-hover); }
  .hamburger span {
    display: block;
    height: 2px;
    background: var(--text-primary);
    border-radius: 2px;
  }
</style>
