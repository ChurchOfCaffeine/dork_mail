/**
 * The signed-in user's own aliases, loaded once and kept current by the
 * aliases page. Compose uses it for the From picker and replies.
 */
import type { AliasPublic } from "@dork-mail/shared";
import * as api from "#lib/api/client.ts";
import { auth } from "#lib/stores/auth.svelte.ts";

let list = $state<AliasPublic[]>([]);
let loadedFor: string | null = null;
let pending: Promise<void> | null = null;

export const aliases = {
  get list() { return list; },
  get enabled() { return list.filter(a => a.enabled); },

  /** Loads once per signed-in user; pass force to refetch. */
  load(force = false): Promise<void> {
    if (!auth.email) return Promise.resolve();
    if (!force && loadedFor === auth.email) return Promise.resolve();
    if (!force && pending) return pending;
    const email = auth.email;
    pending = api.listAliases().then(
      result => {
        if (auth.email !== email) return;
        list = result;
        loadedFor = email;
      },
    ).finally(() => { pending = null; });
    return pending;
  },

  /** Replaces or inserts an alias the caller owns after a create or update. */
  upsert(alias: AliasPublic) {
    if (alias.owner !== auth.email) return;
    const i = list.findIndex(a => a.address === alias.address);
    if (i === -1) list = [alias, ...list];
    else list[i] = alias;
  },

  remove(address: string) {
    list = list.filter(a => a.address !== address);
  },

  /** True for the user's own address or any of their aliases, enabled or not. */
  isMine(address: string) {
    return address === auth.email || list.some(a => a.address === address);
  },
};
