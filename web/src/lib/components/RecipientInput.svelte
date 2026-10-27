<script lang="ts" module>
  import type { EmailAddress } from "@dork-mail/shared";

  const VALID = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

  export function isValidAddress(a: string): boolean {
    return VALID.test(a);
  }

  /** Parses "Name <a@b.c>, d@e.f; ..." into addresses. */
  export function parseAddresses(raw: string): EmailAddress[] {
    const out: EmailAddress[] = [];
    for (const m of raw.matchAll(/(?:"?([^"<,;]*?)"?\s*<([^>]+)>|([^\s,;<>]+))/g)) {
      const address = (m[2] ?? m[3] ?? "").trim().toLowerCase();
      if (!address) continue;
      const name = m[1]?.trim() || undefined;
      out.push({ address, name });
    }
    return out;
  }
</script>

<script lang="ts">
  import { searchContacts } from "$lib/stores/contacts";
  import { displayName } from "$lib/util/format";

  let { label, value = $bindable([]) }: { label: string; value: EmailAddress[] } = $props();

  let text = $state("");
  let focused = $state(false);
  let highlighted = $state(0);
  let input = $state<HTMLInputElement>();

  let suggestions = $derived(focused ? searchContacts(text, value.map(v => v.address)) : []);

  export function flush() {
    commit(text);
  }

  function commit(raw: string) {
    const parsed = parseAddresses(raw);
    if (!parsed.length) { text = ""; return; }
    const existing = new Set(value.map(v => v.address));
    value = [...value, ...parsed.filter(p => !existing.has(p.address))];
    text = "";
    highlighted = 0;
  }

  function pick(a: EmailAddress) {
    if (!value.some(v => v.address === a.address)) value = [...value, a];
    text = "";
    highlighted = 0;
    input?.focus();
  }

  function remove(i: number) {
    value = value.filter((_, j) => j !== i);
    input?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && suggestions.length && text) {
      e.preventDefault();
      pick(suggestions[highlighted]);
      return;
    }
    if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === " " && text.includes("@"))) {
      if (text.trim()) { e.preventDefault(); commit(text); }
      return;
    }
    if (e.key === "Backspace" && !text && value.length) {
      e.preventDefault();
      const last = value[value.length - 1];
      value = value.slice(0, -1);
      text = last.address;
    }
  }

  function onpaste(e: ClipboardEvent) {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (/[,;\n]/.test(pasted) || parseAddresses(pasted).length > 1) {
      e.preventDefault();
      commit(text + pasted);
    }
  }
</script>

<div class="field" class:focused>
  <label for="rcpt-{label}">{label}</label>
  <div class="chips">
    {#each value as a, i (a.address)}
      <button
        type="button"
        class="chip"
        class:invalid={!isValidAddress(a.address)}
        title={a.address}
        onclick={() => remove(i)}
        aria-label="Remove {a.address}"
      >
        <span>{displayName(a)}</span>
        <span class="x" aria-hidden="true">×</span>
      </button>
    {/each}
    <input
      id="rcpt-{label}"
      bind:this={input}
      bind:value={text}
      type="text"
      inputmode="email"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      enterkeyhint="next"
      {onkeydown}
      {onpaste}
      onfocus={() => (focused = true)}
      onblur={() => { focused = false; commit(text); }}
    />
  </div>
  {#if suggestions.length}
    <ul class="suggestions" role="listbox">
      {#each suggestions as s, i (s.address)}
        <li role="option" aria-selected={i === highlighted}>
          <button type="button" class:hl={i === highlighted} onmousedown={(e) => { e.preventDefault(); pick(s); }}>
            <span class="s-name">{s.name ?? s.address}</span>
            {#if s.name}<span class="s-addr">{s.address}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .field {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  label {
    width: 44px;
    flex-shrink: 0;
    padding-top: 7px;
    color: var(--text-muted);
    font-size: 14px;
  }
  .chips {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    height: 28px;
    padding: 0 6px 0 10px;
    border-radius: 99px;
    background: var(--accent-dim);
    color: var(--text-primary);
    font-size: 14px;
  }
  .chip span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.invalid { background: var(--danger-dim); color: var(--danger); }
  .x { color: var(--text-muted); font-size: 16px; line-height: 1; }
  input {
    flex: 1;
    min-width: 120px;
    height: 32px;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 15px;
  }
  input:focus-visible { outline: none; }
  .suggestions {
    position: absolute;
    left: 44px;
    right: 0;
    top: 100%;
    z-index: 30;
    list-style: none;
    margin-top: 4px;
    padding: 4px;
    border-radius: var(--radius);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }
  .suggestions button {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .suggestions button.hl, .suggestions button:hover { background: var(--bg-hover); }
  .s-name { font-size: 14px; color: var(--text-primary); }
  .s-addr { font-size: 12px; color: var(--text-muted); }
</style>
