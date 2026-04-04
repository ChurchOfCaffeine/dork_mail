<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { isAuthenticated } from "$lib/stores/auth";

  const PUBLIC_ROUTES = ["/login", "/setup"];

  $: if (typeof window !== "undefined" && !$isAuthenticated && !PUBLIC_ROUTES.some(r => $page.url.pathname.startsWith(r))) {
    goto("/login");
  }
</script>

<slot />
