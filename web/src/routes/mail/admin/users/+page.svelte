<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import * as api from "#lib/api/client.ts";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import type { UserPublic } from "@dork-mail/shared";

  // Redirect non-admins
  if (!auth.isAdmin) goto("/mail");

  let users = $state<UserPublic[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  let newEmail = $state("");
  let newDisplayName = $state("");
  let newPassword = $state("");
  let newIsAdmin = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let createMsg = $state("");

  let actionError = $state<Record<string, string>>({});
  let toggling = $state<Record<string, boolean>>({});
  let deleting = $state<Record<string, boolean>>({});

  $effect(() => { load(); });

  async function load() {
    loading = true; loadError = "";
    try { users = await api.listUsers(); }
    catch (e) { loadError = (e as Error).message; }
    finally { loading = false; }
  }

  async function createUser() {
    if (!newEmail || !newDisplayName || !newPassword) {
      createError = "All fields are required."; return;
    }
    createError = ""; createMsg = ""; creating = true;
    try {
      await api.createUser(newEmail, newPassword, newDisplayName, newIsAdmin);
      createMsg = `User ${newEmail} created.`;
      newEmail = ""; newDisplayName = ""; newPassword = ""; newIsAdmin = false;
      await load();
    } catch (e) {
      createError = (e as Error).message;
    } finally {
      creating = false;
    }
  }

  async function toggleAdmin(user: UserPublic) {
    toggling[user.email] = true;
    actionError[user.email] = "";
    try {
      await api.updateUser(user.email, { isAdmin: !user.isAdmin });
      await load();
    } catch (e) {
      actionError[user.email] = (e as Error).message;
    } finally {
      toggling[user.email] = false;
    }
  }

  async function deleteUser(user: UserPublic) {
    if (!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    deleting[user.email] = true;
    actionError[user.email] = "";
    try {
      await api.deleteUser(user.email);
      await load();
    } catch (e) {
      actionError[user.email] = (e as Error).message;
    } finally {
      deleting[user.email] = false;
    }
  }
</script>

<PageHeader title="Users" />
<div class="scroll">
<div class="page">

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if loadError}
    <p class="error">{loadError}</p>
  {:else}
    <section class="card">
      <h2>Users <span class="count">{users.length}</span></h2>
      {#if users.length === 0}
        <p class="muted">No users found.</p>
      {:else}
        <div class="user-list">
          {#each users as user}
            <div class="user-row">
              <div class="user-info">
                <span class="user-name">{user.displayName}</span>
                <span class="user-email">{user.email}</span>
                {#if user.email === auth.email}
                  <span class="badge badge-self">you</span>
                {/if}
                {#if user.isAdmin}
                  <span class="badge badge-admin">admin</span>
                {/if}
              </div>
              {#if user.email !== auth.email}
                <div class="user-actions">
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => toggleAdmin(user)}
                    disabled={toggling[user.email]}
                    title={user.isAdmin ? "Remove admin" : "Make admin"}
                  >
                    {toggling[user.email] ? "…" : user.isAdmin ? "Remove admin" : "Make admin"}
                  </button>
                  <button
                    class="btn btn-ghost btn-sm btn-danger"
                    onclick={() => deleteUser(user)}
                    disabled={deleting[user.email]}
                  >
                    {deleting[user.email] ? "…" : "Delete"}
                  </button>
                </div>
              {/if}
              {#if actionError[user.email]}
                <p class="error row-error">{actionError[user.email]}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h2>Create User</h2>
    <div class="form-grid">
      <div class="field">
        <label for="newEmail">Email</label>
        <input id="newEmail" type="email" bind:value={newEmail} placeholder="user@domain.com" />
      </div>
      <div class="field">
        <label for="newDisplayName">Display name</label>
        <input id="newDisplayName" type="text" bind:value={newDisplayName} placeholder="Full name" />
      </div>
      <div class="field">
        <label for="newPassword">Password</label>
        <input id="newPassword" type="password" bind:value={newPassword} autocomplete="new-password" />
      </div>
    </div>
    <label class="checkbox-label">
      <input type="checkbox" bind:checked={newIsAdmin} />
      <span>Grant admin access</span>
    </label>
    {#if createMsg}<p class="success">{createMsg}</p>{/if}
    {#if createError}<p class="error">{createError}</p>{/if}
    <button class="btn btn-primary" onclick={createUser} disabled={creating}>
      {creating ? "Creating…" : "Create user"}
    </button>
  </section>
</div>
</div>

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg-base);
  }

  .page {
    padding: 24px 24px calc(24px + var(--safe-bottom));
    max-width: 640px;
    margin: 0 auto;
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
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .count {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-muted);
    background: var(--bg-hover);
    border-radius: 10px;
    padding: 1px 7px;
  }

  .user-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 8px;
    border-radius: var(--radius-sm);
    flex-wrap: wrap;
  }
  .user-row:hover { background: var(--bg-hover); }

  .user-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .user-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .user-email {
    font-size: 13px;
    color: var(--text-muted);
  }

  .badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 8px;
    font-weight: 500;
  }
  .badge-admin { background: var(--accent-dim); color: var(--accent); }
  .badge-self  { background: var(--bg-hover); color: var(--text-muted); }

  .user-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .btn-sm { font-size: 12px; padding: 4px 10px; }
  .btn-danger { color: var(--danger); background: transparent; }
  .btn-danger:hover { background: var(--danger-dim); }

  .row-error {
    width: 100%;
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--danger);
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }

  .form-grid .field:last-child {
    grid-column: span 2;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    font-size: 14px;
    color: var(--text-secondary);
    cursor: pointer;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
  }

  input[type="text"],
  input[type="email"],
  input[type="password"] {
    padding: 8px 10px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  .muted   { color: var(--text-muted); font-size: 14px; }
  .success { color: var(--accent); font-size: 13px; margin: 0 0 12px; }
  .error   { color: var(--danger); font-size: 13px; margin: 0 0 12px; }
</style>
