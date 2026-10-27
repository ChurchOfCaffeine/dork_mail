<script lang="ts">
  import { fly } from "svelte/transition";
  import { toasts } from "#lib/stores/toast.svelte.ts";
</script>

<div class="toasts" aria-live="polite">
  {#each toasts.list as t (t.id)}
    <div class="toast" class:error={t.kind === "error"} role="status" transition:fly={{ y: 24, duration: 180 }}>
      <span class="msg">{t.message}</span>
      {#if t.action}
        <button class="action" onclick={() => { t.action!.run(); toasts.dismiss(t.id); }}>{t.action.label}</button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(24px + var(--safe-bottom));
    transform: translateX(-50%);
    z-index: 300;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: max-content;
    max-width: calc(100vw - 32px);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 10px 10px 16px;
    min-height: 44px;
    border-radius: var(--radius);
    background: #23262f;
    color: #f1f2f6;
    box-shadow: var(--shadow-lg);
    font-size: 14px;
    pointer-events: auto;
  }
  :global([data-theme="dark"]) .toast { background: #e9ebf3; color: #171a24; }
  .toast.error { background: var(--danger); color: #fff; }
  .msg { padding-right: 6px; }
  .action {
    font-weight: 600;
    color: #a9b4ff;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
  }
  :global([data-theme="dark"]) .action { color: #4351b5; }
  .toast.error .action { color: #fff; text-decoration: underline; }

  @media (max-width: 767px) {
    .toasts { bottom: calc(88px + var(--safe-bottom)); }
  }
</style>
