// The smart playlists this computer keeps (smart-playlists.ts has the rules), and the page's picture of what the rules need to know: hearts and play counts.

import { invoke } from "./desktop-bridge";
import { cleanSmart, type Facts, type Smart } from "./smart-playlists";

const KEY = "mediaverse.smart-playlists.v1";

export type SmartStore = {
  all: () => Smart[];
  get: (id: string) => Smart | undefined;
  save: (smart: Smart) => void;
  remove: (id: string) => void;
  /** A new, empty playlist (not saved until it is given rules or a name). */
  blank: () => Smart;
};

export function createSmartStore(): SmartStore {
  let lists: Smart[] = [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as unknown;
    lists = (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const s = cleanSmart(r);
      return s ? [s] : [];
    });
  } catch {
    lists = [];
  }
  const write = (): void => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(lists));
    } catch {
      // kept until the window closes
    }
  };
  return {
    all: () => lists,
    get: (id) => lists.find((s) => s.id === id),
    save(smart) {
      const clean = cleanSmart(smart);
      if (!clean) return;
      const at = lists.findIndex((s) => s.id === clean.id);
      if (at >= 0) lists[at] = clean;
      else lists.push(clean);
      write();
    },
    remove(id) {
      lists = lists.filter((s) => s.id !== id);
      write();
    },
    blank: () => ({ id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name: "New smart playlist", match: "all", rules: [], sort: "random", limit: 50 }),
  };
}

/** Hearts and play counts, asked of the program when a smart playlist is opened (an answer that fails counts as none). */
export async function readFacts(): Promise<Facts> {
  const hearts = new Set<string>();
  const plays = new Map<string, { count: number; last: number }>();
  try {
    const fav = await invoke<{ favorites: Array<{ path: string }> }>("list_favorites");
    for (const f of fav.favorites) hearts.add(f.path);
  } catch {
    // no hearts known
  }
  try {
    const history = await invoke<{ entries: Array<{ path: string; last_played: number; count: number }> }>("list_history");
    for (const e of history.entries) plays.set(e.path, { count: e.count, last: e.last_played });
  } catch {
    // no history known
  }
  return { hearts, plays, now: Math.floor(Date.now() / 1000) };
}
