<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";

  // Messages open inside the mailbox view; this keeps old /mail/<id> links working.
  $effect(() => {
    const qs = new URLSearchParams({
      folder: page.url.searchParams.get("folder") ?? "inbox",
      m: page.params.messageId!,
    });
    goto(`/mail?${qs}`, { replace: true });
  });
</script>
