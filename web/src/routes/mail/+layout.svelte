<script lang="ts">
  import { auth } from "$lib/stores/auth";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  const folders = [
    { id: "inbox",  label: "Inbox",  icon: "⊡" },
    { id: "sent",   label: "Sent",   icon: "↗" },
    { id: "drafts", label: "Drafts", icon: "✎" },
    { id: "trash",  label: "Trash",  icon: "⌫" },
    { id: "spam",   label: "Spam",   icon: "⚑" },
  ];

  function signOut() {
    auth.logout();
    goto("/login");
  }

  $: activeFolder = $page.url.searchParams.get("folder") ?? "inbox";
</script>

<div class="shell">
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="brand">Dork Mail</div>

    <a href="/mail/compose" class="btn btn-primary compose-btn">Compose</a>

    <nav class="folders">
      {#each folders as f}
        <a
          href="/mail?folder={f.id}"
          class="folder-link"
          class:active={activeFolder === f.id}
        >
          <span class="icon">{f.icon}</span>
          {f.label}
        </a>
      {/each}
    </nav>

    <div class="sidebar-footer">
      {#if $auth.isAdmin}
        <a href="/setup" class="btn btn-ghost setup-btn">⚙ Setup / DNS</a>
      {/if}
      <div class="user-row">
        <span class="user-email">{$auth.email}</span>
        <button class="btn btn-ghost" on:click={signOut}>Sign out</button>
      </div>
    </div>
  </aside>

  <!-- Main content area -->
  <main class="main">
    <slot />
  </main>
</div>

<style>
  .shell {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  .sidebar {
    width: 220px;
    min-width: 220px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 16px 0;
    gap: 0;
  }
  .brand {
    font-size: 16px;
    font-weight: 700;
    padding: 0 20px 16px;
    color: var(--text-primary);
    letter-spacing: -0.3px;
  }
  .compose-btn {
    margin: 0 12px 20px;
    justify-content: center;
  }
  .folders {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .folder-link {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 20px;
    color: var(--text-secondary);
    font-size: 14px;
    border-radius: 0;
    transition: background 0.1s, color 0.1s;
    text-decoration: none;
  }
  .folder-link:hover { background: var(--bg-hover); color: var(--text-primary); }
  .folder-link.active {
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }
  .icon { font-style: normal; width: 18px; text-align: center; }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border-top: 1px solid var(--border);
  }
  .setup-btn { font-size: 13px; }
  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 4px 8px;
  }
  .user-email {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
