import { browser } from "$app/env";

export type ThemePref = "system" | "light" | "dark";

function read<T>(key: string, fallback: T): T {
  if (!browser) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
}

const media = browser ? matchMedia("(prefers-color-scheme: dark)") : null;

const state = $state({
  // Stored raw (not JSON) because app.html reads it before any script loads.
  theme: (browser ? (localStorage.getItem("dm:theme") as ThemePref | null) : null) ?? "system",
  systemDark: media?.matches ?? false,
  trustedSenders: read<string[]>("dm:trusted-senders", []),
});

media?.addEventListener("change", e => {
  state.systemDark = e.matches;
  apply();
});

function apply() {
  if (!browser) return;
  const dark = prefs.dark;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#161922" : "#ffffff");
}

export const prefs = {
  get theme() { return state.theme; },
  get dark() { return state.theme === "dark" || (state.theme === "system" && state.systemDark); },

  setTheme(theme: ThemePref) {
    state.theme = theme;
    try { localStorage.setItem("dm:theme", theme); } catch { /* ignore */ }
    apply();
  },

  isTrusted(address: string) {
    return state.trustedSenders.includes(address.toLowerCase());
  },

  trust(address: string) {
    const a = address.toLowerCase();
    if (state.trustedSenders.includes(a)) return;
    state.trustedSenders = [...state.trustedSenders, a];
    write("dm:trusted-senders", state.trustedSenders);
  },
};
