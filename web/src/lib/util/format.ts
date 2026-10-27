import type { EmailAddress } from "@dork-mail/shared";

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** List timestamp: time today, weekday this week, date otherwise. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = (startOfDay(now) - startOfDay(d)) / DAY;
  if (days <= 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** Section header for grouping a newest-first list. */
export function dateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = (startOfDay(now) - startOfDay(d)) / DAY;
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "This month";
  return d.toLocaleDateString([], { month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function displayName(a: EmailAddress): string {
  return a.name || a.address;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function initials(a: EmailAddress): string {
  const name = (a.name || a.address).replace(/["']/g, "").trim();
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2 && a.name) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

const AVATAR_HUES = [231, 350, 152, 38, 268, 190, 15, 205, 300, 95];

export function avatarHue(a: EmailAddress): number {
  let hash = 0;
  for (const ch of a.address) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, head").forEach(el => el.remove());
  doc.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, blockquote").forEach(el => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** Splits plain text into text and link parts so links render without {@html}. */
export function linkify(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], href: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Separates a trailing quoted reply ("On ... wrote:" and > lines) from the new text. */
export function splitQuoted(text: string): { body: string; quoted: string } {
  const lines = text.split("\n");
  let i = lines.length;
  while (i > 0 && (lines[i - 1].startsWith(">") || lines[i - 1].trim() === "")) i--;
  if (i === lines.length) return { body: text, quoted: "" };
  if (i > 0 && /wrote:\s*$/.test(lines[i - 1])) i--;
  const body = lines.slice(0, i).join("\n").trimEnd();
  if (!body) return { body: text, quoted: "" };
  return { body, quoted: lines.slice(i).join("\n").trim() };
}
