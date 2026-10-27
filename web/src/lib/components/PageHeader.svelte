<script lang="ts">
  import type { Snippet } from "svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import Icon from "./Icon.svelte";

  let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<header class="page-header">
  <button class="icon-btn menu" onclick={() => (ui.drawerOpen = true)} aria-label="Open menu">
    <Icon name="menu" size={22} />
  </button>
  <h1>{title}</h1>
  <div class="actions">{@render children?.()}</div>
</header>

<style>
  .page-header {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--header-h);
    padding: 0 12px 0 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  h1 { flex: 1; min-width: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; align-items: center; gap: 2px; }
  .menu { display: none; margin-left: -10px; }

  @media (max-width: 767px) {
    .page-header {
      height: calc(var(--header-h) + var(--safe-top));
      padding: var(--safe-top) 6px 0 8px;
    }
    .menu { display: inline-flex; margin-left: 0; }
    h1 { font-size: 20px; }
  }
</style>
