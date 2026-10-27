import type { EmailAddress } from "@dork-mail/shared";

interface Contact extends EmailAddress { count: number; lastSeen: number }

const KEY = "dm:contacts";
const MAX = 500;

let cache: Record<string, Contact> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function all(): Record<string, Contact> {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { cache = {}; }
  return cache!;
}

export function rememberContacts(addresses: (EmailAddress | undefined)[], weight = 1) {
  const book = all();
  const now = Date.now();
  for (const a of addresses) {
    if (!a?.address || a.address === "unknown") continue;
    const key = a.address.toLowerCase();
    const prev = book[key];
    book[key] = { address: key, name: a.name || prev?.name, count: (prev?.count ?? 0) + weight, lastSeen: now };
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const top = Object.values(book).sort((x, y) => y.count - x.count).slice(0, MAX);
    cache = Object.fromEntries(top.map(c => [c.address, c]));
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full */ }
  }, 1000);
}

export function searchContacts(query: string, exclude: string[] = [], limit = 6): EmailAddress[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set(exclude.map(e => e.toLowerCase()));
  return Object.values(all())
    .filter(c => !skip.has(c.address) && (c.address.includes(q) || c.name?.toLowerCase().includes(q)))
    .sort((x, y) => {
      const xs = Number(x.address.startsWith(q) || !!x.name?.toLowerCase().startsWith(q));
      const ys = Number(y.address.startsWith(q) || !!y.name?.toLowerCase().startsWith(q));
      return ys - xs || y.count - x.count || y.lastSeen - x.lastSeen;
    })
    .slice(0, limit)
    .map(({ address, name }) => ({ address, name }));
}
