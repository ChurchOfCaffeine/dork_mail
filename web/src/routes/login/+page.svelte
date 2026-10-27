<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/stores/auth.svelte";
  import * as api from "$lib/api/client";

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  $effect(() => {
    if (auth.isAuthenticated) goto("/mail", { replaceState: true });
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    loading = true;
    try {
      const res = await api.login(email.trim(), password);
      auth.login(res.token, res.email, res.displayName, res.isAdmin);
      goto("/mail", { replaceState: true });
    } catch (err) {
      error = (err as Error).message === "Invalid credentials" ? "That email and password don't match." : (err as Error).message;
      password = "";
    } finally {
      loading = false;
    }
  }
</script>

<div class="page">
  <div class="card">
    <img class="logo" src="/icon.svg" alt="" width="56" height="56" />
    <h1>Dork Mail</h1>
    <p class="subtitle">Sign in to your mailbox</p>

    <form onsubmit={submit}>
      <label>
        <span>Email</span>
        <input
          type="email"
          bind:value={email}
          autocomplete="username"
          autocapitalize="off"
          spellcheck="false"
          inputmode="email"
          enterkeyhint="next"
          required
        />
      </label>
      <label>
        <span>Password</span>
        <input type="password" bind:value={password} autocomplete="current-password" enterkeyhint="go" required />
      </label>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <button type="submit" class="btn btn-primary" disabled={loading}>
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </div>
</div>

<style>
  .page {
    height: 100dvh;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(24px + var(--safe-top)) 20px calc(24px + var(--safe-bottom));
    background:
      radial-gradient(1000px 500px at 50% -10%, var(--accent-dim), transparent 70%),
      var(--bg-base);
  }
  .card {
    width: 100%;
    max-width: 380px;
    padding: 36px 32px 32px;
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    text-align: center;
  }
  .logo { border-radius: 14px; margin-bottom: 16px; }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }
  .subtitle { color: var(--text-secondary); margin-bottom: 28px; }
  form { display: flex; flex-direction: column; gap: 16px; text-align: left; }
  label { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 13px; font-weight: 500; }
  input { width: 100%; height: 44px; padding: 0 14px; font-size: 16px; border-radius: var(--radius); background: var(--bg-base); }
  .error { color: var(--danger); font-size: 13px; }
  .btn-primary { width: 100%; height: 46px; font-size: 15px; border-radius: var(--radius); margin-top: 4px; }

  @media (max-width: 480px) {
    .card { border: none; box-shadow: none; background: transparent; padding: 24px 4px; }
  }
</style>
