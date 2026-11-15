import { browser } from "$app/env";

const state = $state({
  drawerOpen: false,
  online: browser ? navigator.onLine : true,
});

if (browser) {
  addEventListener("online", () => { state.online = true; });
  addEventListener("offline", () => { state.online = false; });
}

export const ui = {
  get drawerOpen() { return state.drawerOpen; },
  set drawerOpen(v: boolean) { state.drawerOpen = v; },
  get online() { return state.online; },
};
