<script lang="ts">
  import type { EmailAddress } from "@dork-mail/shared";
  import { initials, avatarHue } from "$lib/util/format";

  let { address, size = 40 }: { address: EmailAddress; size?: number } = $props();
</script>

<span
  class="avatar"
  style:--hue={avatarHue(address)}
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.38)}px"
  aria-hidden="true"
>{initials(address)}</span>

<style>
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 50%;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: hsl(var(--hue) 55% 30%);
    background: hsl(var(--hue) 70% 88%);
    user-select: none;
  }
  :global([data-theme="dark"]) .avatar {
    color: hsl(var(--hue) 70% 85%);
    background: hsl(var(--hue) 35% 28%);
  }
</style>
