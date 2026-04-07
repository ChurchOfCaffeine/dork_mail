<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "$lib/stores/auth.svelte";

  const PUBLIC_ROUTES = ["/login"];

  let { children } = $props();

  $effect(() => {
    if (!auth.isAuthenticated && !PUBLIC_ROUTES.some(r => page.url.pathname.startsWith(r))) {
      goto("/login");
    }
  });
</script>

{@render children()}
