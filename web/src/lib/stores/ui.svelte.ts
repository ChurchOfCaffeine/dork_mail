import { browser } from "$app/environment";

const mobileQuery = browser ? matchMedia("(max-width: 767px)") : null;

const state = $state({
  drawerOpen: false,
  mobile: mobileQuery?.matches ?? false,
  online: browser ? navigator.onLine : true,
  visible: browser ? document.visibilityState === "visible" : true,
});

if (browser) {
  mobileQuery!.addEventListener("change", e => { state.mobile = e.matches; });
  addEventListener("online", () => { state.online = true; });
  addEventListener("offline", () => { state.online = false; });
  document.addEventListener("visibilitychange", () => { state.visible = document.visibilityState === "visible"; });
}

export const ui = {
  get drawerOpen() { return state.drawerOpen; },
  set drawerOpen(v: boolean) { state.drawerOpen = v; },
  get mobile() { return state.mobile; },
  get online() { return state.online; },
  get visible() { return state.visible; },
};

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}
