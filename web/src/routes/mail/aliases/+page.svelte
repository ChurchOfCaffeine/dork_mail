<script lang="ts">
  import { page } from "$app/state";
  import { aliasLocalPartError, generateAliasLocalPart, type AliasPublic } from "@dork-mail/shared";
  import * as api from "#lib/api/client.ts";
  import { auth } from "#lib/stores/auth.svelte.ts";
  import { aliases as ownAliases } from "#lib/stores/aliases.svelte.ts";
  import { toasts } from "#lib/stores/toast.svelte.ts";
  import { shortDate } from "#lib/util/format.ts";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import Icon from "#lib/components/Icon.svelte";

  const domain = (auth.email ?? "").split("@")[1] ?? "";

  // Admins can manage another user's aliases with ?owner=<email>.
  let owner = $derived((auth.isAdmin && page.url.searchParams.get("owner")?.toLowerCase()) || auth.email || "");
  let managingOther = $derived(owner !== auth.email);

  let otherAliases = $state<AliasPublic[]>([]);
  let list = $derived(managingOther ? otherAliases : ownAliases.list);
  let loading = $state(true);
  let loadError = $state("");

  let localPart = $state("");
  let label = $state("");
  let creating = $state(false);
  let createError = $state("");

  let busy = $state<Record<string, boolean>>({});

  let nameError = $derived(localPart.trim() ? aliasLocalPartError(localPart.trim().toLowerCase()) : null);

  $effect(() => {
    const target = owner;
    void load(target);
  });

  async function load(target: string) {
    loading = true; loadError = "";
    try {
      if (target === auth.email) await ownAliases.load(true);
      else otherAliases = await api.listAliases({ owner: target });
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function track(alias: AliasPublic) {
    if (managingOther) {
      const i = otherAliases.findIndex(a => a.address === alias.address);
      if (i === -1) otherAliases = [alias, ...otherAliases];
      else otherAliases[i] = alias;
    } else {
      ownAliases.upsert(alias);
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (nameError) { createError = nameError; return; }
    createError = ""; creating = true;
    try {
      const alias = await api.createAlias({
        localPart: localPart.trim().toLowerCase() || undefined,
        label: label.trim() || undefined,
        owner: managingOther ? owner : undefined,
      });
      track(alias);
      localPart = ""; label = "";
      const copied = await writeClipboard(alias.address);
      toasts.show(copied ? `Created ${alias.address}, copied to clipboard` : `Created ${alias.address}`);
    } catch (err) {
      createError = (err as Error).message;
    } finally {
      creating = false;
    }
  }

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function copy(address: string) {
    if (await writeClipboard(address)) toasts.show("Copied");
    else toasts.error("Couldn't copy to the clipboard");
  }

  async function update(alias: AliasPublic, patch: { enabled?: boolean; label?: string }) {
    busy[alias.address] = true;
    try {
      track(await api.updateAlias(alias.address, patch));
    } catch (e) {
      toasts.error((e as Error).message);
    } finally {
      busy[alias.address] = false;
    }
  }

  function editLabel(alias: AliasPublic) {
    const next = prompt(`Note for ${alias.address}`, alias.label ?? "");
    if (next === null || next.trim() === (alias.label ?? "")) return;
    void update(alias, { label: next.trim() });
  }

  async function remove(alias: AliasPublic) {
    if (!confirm(`Delete ${alias.address}? Mail sent to it will stop arriving, and the name is released. This can't be undone.`)) return;
    busy[alias.address] = true;
    try {
      await api.deleteAlias(alias.address);
      if (managingOther) otherAliases = otherAliases.filter(a => a.address !== alias.address);
      else ownAliases.remove(alias.address);
      toasts.show(`Deleted ${alias.address}`);
    } catch (e) {
      toasts.error((e as Error).message);
    } finally {
      busy[alias.address] = false;
    }
  }
</script>

<PageHeader title={managingOther ? `Aliases for ${owner}` : "Aliases"} />

<div class="scroll">
  <div class="page">
    <form class="card" onsubmit={create}>
      <h2>New alias</h2>
      <p class="hint">
        Mail sent to an alias arrives in {managingOther ? `${owner}'s` : "your"} inbox. Give a different one to each
        site, then disable or delete it if it starts getting spam.
      </p>
      <div class="field">
        <label for="localPart">Name</label>
        <div class="address-input" class:invalid={nameError}>
          <input
            id="localPart"
            type="text"
            bind:value={localPart}
            placeholder="Leave blank to generate one"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
          />
          <span class="domain">@{domain}</span>
          <button type="button" class="icon-btn" onclick={() => (localPart = generateAliasLocalPart())} title="Suggest a name" aria-label="Suggest a name">
            <Icon name="shuffle" size={18} />
          </button>
        </div>
        {#if nameError}<p class="error">{nameError}</p>{/if}
      </div>
      <div class="field">
        <label for="label">Note <span class="optional">(optional)</span></label>
        <input id="label" type="text" bind:value={label} placeholder="Where you're using it, e.g. Acme newsletter" maxlength="200" />
      </div>
      {#if createError}<p class="error">{createError}</p>{/if}
      <button class="btn btn-primary" type="submit" disabled={creating || !!nameError}>
        <Icon name="plus" size={16} /> {creating ? "Creating…" : "Create alias"}
      </button>
    </form>

    <section class="card">
      <h2>{managingOther ? "Their aliases" : "Your aliases"} {#if !loading}<span class="count">{list.length}</span>{/if}</h2>
      {#if loading && !list.length}
        <p class="hint">Loading…</p>
      {:else if loadError}
        <p class="error">{loadError}</p>
      {:else if !list.length}
        <p class="hint">No aliases yet.</p>
      {:else}
        <ul class="alias-list">
          {#each list as alias (alias.address)}
            <li class="alias-row" class:disabled={!alias.enabled}>
              <div class="alias-info">
                <span class="address">{alias.address}</span>
                <span class="meta">
                  {#if !alias.enabled}<span class="badge">disabled</span>{/if}
                  <button class="note" onclick={() => editLabel(alias)} title="Edit note">
                    {alias.label ?? "Add a note"}
                  </button>
                  <span>· {shortDate(alias.createdAt)}</span>
                </span>
              </div>
              <div class="alias-actions">
                <button class="icon-btn" onclick={() => copy(alias.address)} title="Copy address" aria-label="Copy {alias.address}">
                  <Icon name="copy" size={18} />
                </button>
                <button
                  class="switch"
                  class:on={alias.enabled}
                  role="switch"
                  aria-checked={alias.enabled}
                  aria-label="{alias.enabled ? 'Disable' : 'Enable'} {alias.address}"
                  title={alias.enabled ? "Receiving mail. Click to disable." : "Disabled: mail is dropped. Click to enable."}
                  disabled={busy[alias.address]}
                  onclick={() => update(alias, { enabled: !alias.enabled })}
                ><span></span></button>
                <button class="icon-btn danger" onclick={() => remove(alias)} disabled={busy[alias.address]} title="Delete" aria-label="Delete {alias.address}">
                  <Icon name="trash" size={18} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg-base); }
  .page {
    max-width: 640px;
    margin: 0 auto;
    padding: 24px 20px calc(32px + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding: 20px;
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }
  h2 { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 12px; font-weight: 400; color: var(--text-muted); background: var(--bg-hover); border-radius: 10px; padding: 1px 7px; }

  .field { width: 100%; display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
  .optional { font-weight: 400; color: var(--text-muted); }
  input { width: 100%; height: 42px; padding: 0 12px; font-size: 15px; border-radius: var(--radius-sm); background: var(--bg-base); }
  .hint { font-size: 13px; color: var(--text-muted); }
  .error { color: var(--danger); font-size: 13px; }

  .address-input {
    display: flex;
    align-items: center;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    padding-right: 4px;
  }
  .address-input:focus-within { outline: 2px solid var(--border-focus); outline-offset: -1px; }
  .address-input.invalid { border-color: var(--danger); }
  .address-input input { flex: 1; min-width: 0; border: none; background: transparent; padding-right: 4px; font-family: var(--font-mono); font-size: 14px; }
  .address-input input:focus-visible { outline: none; }
  .domain { color: var(--text-muted); font-family: var(--font-mono); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }

  .alias-list { list-style: none; width: 100%; display: flex; flex-direction: column; }
  .alias-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }
  .alias-row:first-child { border-top: none; }
  .alias-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .address { font-family: var(--font-mono); font-size: 14px; overflow-wrap: anywhere; }
  .alias-row.disabled .address { color: var(--text-muted); text-decoration: line-through; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .note { font-size: 12px; color: var(--text-secondary); text-align: left; }
  .note:hover { color: var(--accent); text-decoration: underline; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--bg-hover); color: var(--text-muted); font-weight: 500; }

  .alias-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

  .switch {
    position: relative;
    width: 44px;
    height: 26px;
    margin: 0 4px;
    flex-shrink: 0;
    border-radius: 99px;
    background: var(--border);
    transition: background 0.2s;
  }
  .switch span {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.2s;
  }
  .switch.on { background: var(--success); }
  .switch.on span { transform: translateX(18px); }
  .switch:disabled { opacity: 0.6; }
</style>
