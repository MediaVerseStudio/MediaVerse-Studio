// Favorite songs (D44): marked with the heart in the player bar here or on a paired TV, played together from
// Home. The list is kept by the Rust core (`list_favorites`, `set_favorite`), by file path like flags.

import { invoke } from "./desktop-bridge";

export type FavoriteStore = {
  has: (path: string) => boolean;
  /** Paths, oldest favorite first. */
  all: () => string[];
  reload: () => Promise<void>;
  toggle: (path: string) => Promise<boolean>;
  onChange: (listener: () => void) => void;
};

type Reply = { favorites: Array<{ path: string; added_at?: number }> };

export function createFavoriteStore(): FavoriteStore {
  let paths: string[] = [];
  let set = new Set<string>();
  const listeners: (() => void)[] = [];
  const apply = (reply: Reply): void => {
    paths = reply.favorites.map((entry) => entry.path);
    set = new Set(paths);
    for (const listener of listeners) listener();
  };
  return {
    has: (path) => set.has(path),
    all: () => paths,
    reload: async () => apply(await invoke<Reply>("list_favorites")),
    async toggle(path) {
      const on = !set.has(path);
      apply(await invoke<Reply>("set_favorite", { path, favorite: on }));
      return on;
    },
    onChange: (listener) => listeners.push(listener),
  };
}
