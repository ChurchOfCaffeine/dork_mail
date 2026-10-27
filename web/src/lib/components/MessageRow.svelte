<script lang="ts">
  import type { EmailSummary } from "@dork-mail/shared";
  import Icon, { type IconName } from "./Icon.svelte";
  import Avatar from "./Avatar.svelte";
  import { shortDate, displayName } from "$lib/util/format";

  export interface SwipeAction { icon: IconName; label: string; color: string }

  let {
    email,
    showRecipients = false,
    active = false,
    checked = false,
    selecting = false,
    swipeRight,
    swipeLeft,
    onopen,
    oncheck,
    onswipe,
    onstar,
    onread,
  }: {
    email: EmailSummary;
    showRecipients?: boolean;
    active?: boolean;
    checked?: boolean;
    selecting?: boolean;
    swipeRight?: SwipeAction;
    swipeLeft?: SwipeAction;
    onopen: () => void;
    oncheck: () => void;
    onswipe: (dir: "left" | "right") => void;
    onstar: () => void;
    onread: () => void;
  } = $props();

  let row = $state<HTMLElement>();
  let dx = $state(0);
  let animating = $state(false);

  let startX = 0;
  let startY = 0;
  let axis: "h" | "v" | null = null;
  let tracking = false;
  let suppressClick = false;
  let leaving: "left" | "right" | null = null;

  function settled() {
    animating = false;
    if (leaving) {
      const dir = leaving;
      leaving = null;
      onswipe(dir);
    }
  }
  let longPress: ReturnType<typeof setTimeout> | undefined;

  let who = $derived(showRecipients
    ? `To: ${email.to.map(displayName).join(", ") || "(no recipients)"}`
    : displayName(email.from));
  let hasAttachments = $derived((email.attachments ?? []).some(a => !a.contentId));
  let threshold = $derived(Math.min(110, (row?.clientWidth ?? 320) * 0.28));
  let action = $derived(dx > 0 ? swipeRight : dx < 0 ? swipeLeft : undefined);
  let armed = $derived(Math.abs(dx) >= threshold);

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse" || e.button !== 0) return;
    tracking = true;
    axis = null;
    startX = e.clientX;
    startY = e.clientY;
    suppressClick = false;
    longPress = setTimeout(() => {
      suppressClick = true;
      tracking = false;
      navigator.vibrate?.(10);
      oncheck();
    }, 450);
  }

  function move(e: PointerEvent) {
    if (!tracking) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!axis && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      clearTimeout(longPress);
      axis = Math.abs(mx) > Math.abs(my) && !selecting ? "h" : "v";
      if (axis === "h") row?.setPointerCapture(e.pointerId);
      else tracking = false;
    }
    if (axis === "h") {
      const allowed = (mx > 0 && swipeRight) || (mx < 0 && swipeLeft);
      dx = allowed ? mx : mx / 6;
    }
  }

  function up() {
    clearTimeout(longPress);
    if (!tracking) return;
    tracking = false;
    if (axis !== "h") return;
    suppressClick = true;
    animating = true;
    if (armed && action) {
      leaving = dx > 0 ? "right" : "left";
      navigator.vibrate?.(8);
      dx = (dx > 0 ? 1 : -1) * (row?.clientWidth ?? 400);
    } else {
      dx = 0;
    }
  }

  function cancel() {
    clearTimeout(longPress);
    tracking = false;
    animating = true;
    dx = 0;
  }

  function click(e: MouseEvent) {
    if (suppressClick) { suppressClick = false; return; }
    if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) { oncheck(); return; }
    onopen();
  }
</script>

<div
  class="row"
  class:unread={!email.read}
  class:active
  class:checked
  bind:this={row}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  role="listitem"
>
  {#if action}
    <div class="swipe-bg" class:right={dx > 0} class:armed style:--swipe-color={action.color}>
      <span class="swipe-label"><Icon name={action.icon} size={22} />{action.label}</span>
    </div>
  {/if}

  <div
    class="content"
    class:animating
    style:transform={dx ? `translateX(${dx}px)` : undefined}
    ontransitionend={settled}
  >
    <button class="hit" onclick={click} aria-label="{who}: {email.subject}{email.read ? '' : ', unread'}"></button>

    <button
      class="avatar-btn"
      onclick={oncheck}
      aria-label={checked ? "Deselect" : "Select"}
      aria-pressed={checked}
    >
      <span class="avatar-face"><Avatar address={showRecipients ? (email.to[0] ?? email.from) : email.from} size={40} /></span>
      <span class="check"><Icon name="check" size={20} strokeWidth={3} /></span>
    </button>

    <div class="text">
      <div class="line top">
        <span class="from">{who}</span>
        {#if hasAttachments}<span class="meta-icon"><Icon name="paperclip" size={14} /></span>{/if}
        <span class="date">{shortDate(email.receivedAt)}</span>
      </div>
      <div class="line">
        <span class="subject">{email.subject || "(no subject)"}</span>
        {#if email.starred}<span class="star"><Icon name="star" size={14} filled /></span>{/if}
      </div>
      {#if email.snippet}<div class="snippet">{email.snippet}</div>{/if}
    </div>

    <div class="hover-actions">
      <button class="icon-btn" onclick={() => onswipe("right")} title={swipeRight?.label} aria-label={swipeRight?.label}>
        <Icon name={swipeRight?.icon ?? "archive"} size={18} />
      </button>
      <button class="icon-btn danger" onclick={() => onswipe("left")} title={swipeLeft?.label} aria-label={swipeLeft?.label}>
        <Icon name="trash" size={18} />
      </button>
      <button class="icon-btn" onclick={onread} title={email.read ? "Mark unread" : "Mark read"} aria-label={email.read ? "Mark unread" : "Mark read"}>
        <Icon name={email.read ? "mail" : "mail-open"} size={18} />
      </button>
      <button class="icon-btn" class:active={email.starred} onclick={onstar} title={email.starred ? "Unstar" : "Star"} aria-label={email.starred ? "Unstar" : "Star"}>
        <Icon name="star" size={18} filled={email.starred} />
      </button>
    </div>
  </div>
</div>

<style>
  .row {
    position: relative;
    overflow: hidden;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  .swipe-bg {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 24px;
    background: var(--bg-raised);
    color: var(--text-secondary);
    transition: background 0.15s, color 0.15s;
  }
  .swipe-bg.right { justify-content: flex-start; }
  .swipe-bg.armed { background: var(--swipe-color); color: #fff; }
  .swipe-label { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }

  .content {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
  }
  .content.animating { transition: transform 0.18s ease-out; }

  .hit {
    position: absolute;
    inset: 0;
    width: 100%;
    cursor: pointer;
    background: transparent;
  }
  .hit:focus-visible { outline-offset: -2px; }

  @media (hover: hover) {
    .row:hover .content { background: var(--bg-hover); }
  }
  .row:active .content { background: var(--bg-hover); }
  .row.active .content { background: var(--accent-dim); }
  .row.checked .content { background: var(--accent-dim); }

  .avatar-btn {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    flex-shrink: 0;
    z-index: 1;
  }
  .avatar-face, .check {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: opacity 0.12s, transform 0.12s;
  }
  .check {
    background: var(--accent);
    color: var(--text-on-accent);
    opacity: 0;
    transform: scale(0.6);
  }
  .row.checked .check { opacity: 1; transform: scale(1); }
  .row.checked .avatar-face { opacity: 0; }
  @media (hover: hover) {
    .avatar-btn:hover .avatar-face { opacity: 0; }
    .avatar-btn:hover .check { opacity: 1; transform: scale(1); background: var(--bg-raised); color: var(--text-muted); box-shadow: inset 0 0 0 2px var(--border); }
    .row.checked .avatar-btn:hover .check { background: var(--accent); color: var(--text-on-accent); box-shadow: none; }
  }

  .text {
    flex: 1;
    min-width: 0;
    pointer-events: none;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .from, .subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .from { font-size: 15px; color: var(--text-primary); }
  .date { font-size: 12px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; }
  .subject { font-size: 14px; color: var(--text-secondary); margin-top: 1px; }
  .snippet {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .meta-icon { color: var(--text-muted); }
  .star { color: var(--warning); }

  .unread .from { font-weight: 700; }
  .unread .subject { font-weight: 600; color: var(--text-primary); }
  .unread .date { color: var(--accent); font-weight: 600; }
  .unread .content::before {
    content: "";
    position: absolute;
    left: 5px;
    top: 50%;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    background: var(--accent);
  }

  .hover-actions {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    gap: 2px;
    padding: 2px;
    border-radius: 99px;
    background: var(--bg-surface);
    box-shadow: var(--shadow);
    z-index: 1;
  }
  .hover-actions .icon-btn { width: 34px; height: 34px; }
  .hover-actions .icon-btn.active { color: var(--warning); }
  @media (hover: hover) and (pointer: fine) {
    .row:hover .hover-actions { display: flex; }
  }

  :global(.compact) .snippet { -webkit-line-clamp: 1; line-clamp: 1; }
</style>
