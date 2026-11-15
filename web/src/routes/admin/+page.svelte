<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "#lib/stores/auth.svelte.ts";

  $effect(() => { void goto(auth.isAdmin ? "/admin/users" : "/admin/account", { replace: true }); });
</script>
