<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/stores/auth.svelte";
  import * as api from "$lib/api/client";

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    loading = true;
    try {
      const res = await api.login(email, password);
      auth.login(res.token, res.email, res.displayName, res.isAdmin);
      goto("/mail");
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="page">
  <div class="card">
    <h1>Dork Mail</h1>
    <p class="subtitle">Sign in to your mailbox</p>

    <form onsubmit={submit}>
      <label>
        <span>Email</span>
        <input type="email" bind:value={email} autocomplete="email" required />
      </label>
      <label>
        <span>Password</span>
        <input type="password" bind:value={password} autocomplete="current-password" required />
      </label>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="submit" class="btn btn-primary" disabled={loading}>
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </div>
</div>

<style>
  .page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 40px;
    width: 100%;
    max-width: 380px;
    box-shadow: var(--shadow);
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 4px;
    color: var(--text-primary);
  }
  .subtitle {
    color: var(--text-secondary);
    margin-bottom: 28px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  input {
    padding: 9px 12px;
    width: 100%;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
  }
  .btn-primary {
    width: 100%;
    justify-content: center;
    padding: 10px;
    font-size: 15px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
