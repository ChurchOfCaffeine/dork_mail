// Alias address rules and name generation, shared by the API and the web app.

export const ALIAS_LOCAL_PART_MAX = 64;

/** Local parts that must keep reaching a real person or are used by mail infrastructure. */
export const RESERVED_LOCAL_PARTS = new Set([
  "abuse", "admin", "administrator", "bounces", "hostmaster", "mailer-daemon",
  "no-reply", "noreply", "postmaster", "root", "security", "webmaster",
]);

/**
 * Lowercase letters, digits, dot, dash and underscore; starts and ends with a
 * letter or digit; no consecutive dots. "+" is excluded because it is the
 * plus-addressing separator.
 */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Returns an error message, or null when the local part is usable. */
export function aliasLocalPartError(localPart: string): string | null {
  if (!localPart) return "Name is required";
  if (localPart.length > ALIAS_LOCAL_PART_MAX) return `Name must be ${ALIAS_LOCAL_PART_MAX} characters or fewer`;
  if (!LOCAL_PART_RE.test(localPart) || localPart.includes("..")) {
    return "Use lowercase letters, digits, dots, dashes or underscores, starting and ending with a letter or digit";
  }
  if (RESERVED_LOCAL_PARTS.has(localPart)) return `"${localPart}" is reserved`;
  return null;
}

const ADJECTIVES = [
  "amber", "brave", "brisk", "calm", "clever", "cosmic", "crisp", "dapper", "eager", "fancy",
  "fuzzy", "gentle", "glossy", "golden", "happy", "hidden", "humble", "jolly", "keen", "lively",
  "lucky", "mellow", "misty", "nimble", "noble", "plucky", "polite", "quiet", "rapid", "rustic",
  "shiny", "silent", "silver", "sleepy", "smooth", "snowy", "sunny", "swift", "tidy", "velvet",
  "vivid", "witty", "zesty",
];

const NOUNS = [
  "acorn", "badger", "beacon", "bison", "breeze", "canyon", "cedar", "comet", "coral", "falcon",
  "fern", "finch", "fox", "glacier", "harbor", "heron", "lantern", "maple", "meadow", "moose",
  "nebula", "orchid", "otter", "panda", "pebble", "pine", "puffin", "quartz", "raven", "river",
  "robin", "sparrow", "spruce", "summit", "thistle", "tiger", "tulip", "walrus", "willow", "wombat",
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** A readable random local part, e.g. "quiet-otter-4821". Not secret, just hard to guess. */
export function generateAliasLocalPart(): string {
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}
