// Playlists (D74): the page's copy of the sidecar's playlists.json, the "Add to playlist ›" submenu used by every
// right-click menu, and the small dialog that asks for a name. All text is set with textContent.

import { invoke } from "./desktop-bridge";
import { el } from "./dom";
import type { MenuItem } from "./context-menu";
import { newName, withSongs, type Playlist } from "./playlist-format";

/** At most this many playlists are listed in the submenu (the most recently changed); the rest are on the page. */
const MENU_PLAYLISTS = 15;

export type PlaylistStore = {
  all: () => Playlist[];
  get: (id: string) => Playlist | undefined;
  load: () => Promise<void>;
  /** Saves a whole playlist (new when `id` is missing); returns it, or throws with a message to show. */
  save: (playlist: { id?: string; name: string; paths: string[] }) => Promise<Playlist>;
  remove: (id: string) => Promise<void>;
  onChange: (listener: () => void) => void;
  /** Adds songs to a playlist, skipping ones already there; returns how many were added. */
  add: (id: string, paths: string[]) => Promise<number>;
  /** Asks for a name, makes the playlist with these songs, and returns it (null if cancelled). */
  createWith: (paths: string[]) => Promise<Playlist | null>;
  /** The "Add to playlist ›" menu item for some songs. */
  menuItem: (paths: () => string[], note?: (text: string) => void) => MenuItem;
};

type Reply = { playlists: Playlist[] };

export function createPlaylistStore(): PlaylistStore {
  let lists: Playlist[] = [];
  const listeners: (() => void)[] = [];
  const changed = (next: Playlist[]): void => {
    lists = next;
    for (const listener of listeners) listener();
  };
  const message = (thrown: unknown): string => (thrown && typeof thrown === "object" && "message" in thrown ? String((thrown as { message: unknown }).message) : String(thrown));

  const store: PlaylistStore = {
    all: () => lists,
    get: (id) => lists.find((p) => p.id === id),
    async load() {
      try {
        changed((await invoke<Reply>("list_playlists")).playlists ?? []);
      } catch {
        // Keep what is known; the Playlists page says so if it stays empty.
      }
    },
    async save(playlist) {
      try {
        const reply = await invoke<Reply & { playlist: Playlist }>("save_playlist", playlist);
        changed(reply.playlists);
        return reply.playlist;
      } catch (thrown) {
        throw new Error(message(thrown));
      }
    },
    async remove(id) {
      changed((await invoke<Reply>("delete_playlist", { id })).playlists);
    },
    onChange: (listener) => void listeners.push(listener),
    async add(id, paths) {
      const playlist = store.get(id);
      if (!playlist) return 0;
      const next = withSongs(playlist.paths, paths);
      if (next.added) await store.save({ id, name: playlist.name, paths: next.paths });
      return next.added;
    },
    async createWith(paths) {
      const name = await askName("new playlist", newName(lists.map((p) => p.name)), (n) => (lists.some((p) => p.name.toLocaleLowerCase() === n.toLocaleLowerCase()) ? "There is already a playlist with that name." : null));
      if (name === null) return null;
      return store.save({ name, paths });
    },
    menuItem(paths, note = () => {}) {
      const recent = [...lists].sort((a, b) => b.updated_at - a.updated_at).slice(0, MENU_PLAYLISTS).sort((a, b) => a.name.localeCompare(b.name));
      const report = (promise: Promise<unknown>, text: (n: number) => string): void => {
        void promise.then((n) => note(text(typeof n === "number" ? n : 0))).catch((thrown) => note(message(thrown)));
      };
      return {
        label: "Add to playlist",
        submenu: [
          {
            label: "New playlist…",
            action: () => report(store.createWith(paths()).then((p) => (p ? p.paths.length : -1)), (n) => (n < 0 ? "" : `Made a playlist with ${n} song${n === 1 ? "" : "s"}.`)),
          },
          ...(recent.length ? (["separator"] as MenuItem[]) : []),
          ...recent.map((p): MenuItem => ({
            label: p.name,
            action: () => report(store.add(p.id, paths()), (n) => (n ? `Added ${n} song${n === 1 ? "" : "s"} to “${p.name}”.` : `Those songs are already in “${p.name}”.`)),
          })),
        ],
      };
    },
  };
  return store;
}

/** A small dialog asking for a playlist name; resolves to the name, or null when cancelled. */
export function askName(heading: string, initial: string, problem: (name: string) => string | null = () => null): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "lib-dialog name-dialog");
    const form = el("form");
    form.method = "dialog";
    const label = el("label", "lib-field", "Name");
    const input = el("input");
    input.value = initial;
    input.maxLength = 200;
    input.required = true;
    label.append(input);
    const warning = el("p", "field-hint name-warning");
    warning.setAttribute("role", "status");
    const ok = el("button", undefined, "OK");
    ok.type = "submit";
    const cancel = el("button", "secondary", "Cancel");
    cancel.type = "button";
    const actions = el("div", "dialog-actions");
    actions.append(cancel, ok);
    form.append(el("h2", undefined, heading), label, warning, actions);
    dialog.append(form);
    document.body.append(dialog);
    let result: string | null = null;
    const check = (): boolean => {
      const name = input.value.trim();
      const why = name ? problem(name) : "Give the playlist a name.";
      warning.textContent = why ?? "";
      ok.disabled = why !== null;
      return why === null;
    };
    input.addEventListener("input", check);
    form.addEventListener("submit", (event) => {
      if (!check()) {
        event.preventDefault();
        return;
      }
      result = input.value.trim();
    });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    check();
    input.select();
  });
}
