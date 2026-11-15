<script lang="ts">
  import "../app.css";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import * as api from "#lib/api/client.ts";

  let { children } = $props();

  let ready = $state(false);

  // The cookie decides who is signed in, so a token left from another Bulwark account is replaced.
  $effect(() => {
    api.session()
      .then(s => {
        auth.login(s.token, s.email, s.displayName, s.isAdmin);
        ready = true;
      })
      .catch(() => api.redirectToSignIn());
  });
</script>

{#if ready}
  {@render children()}
{/if}
