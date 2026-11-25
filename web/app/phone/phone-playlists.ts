// Playlists on the phone (D82): made and kept on the phone, for its own music. Each song is remembered by its ID and
// also by its title, artist, album and length, so a playlist survives Android numbering the music again (after a
// re-scan, or the files copied over once more): it finds the song by artist and title, as imported playlists do
// on the PC (src/playlist-files.ts). Pure apart from load/save, so the rules are tested.

import { matchKey } from "../src/playlist-files.ts";

export type PhoneEntry = { id: string; title: string; artist: string; album: string; ms: number };
export type PhonePlaylist = { id: string; name: string; entries: PhoneEntry[]; updated: number };
type Song = { id: string; title: string; artist: string | null; album_artist?: string | null; album: string | null; duration_ms?: number };

const KEY = "mediaverse.phone.playlists";

export function loadPlaylists(): PhonePlaylist[] {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((p): p is PhonePlaylist => !!p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.entries));
  } catch {
    return [];
  }
}

export function savePlaylists(lists: PhonePlaylist[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lists));
  } catch {
    // kept until the app closes
  }
}

export const entryOf = (song: Song): PhoneEntry => ({ id: song.id, title: song.title, artist: song.artist || song.album_artist || "", album: song.album ?? "", ms: song.duration_ms ?? 0 });

/** The songs of a playlist in this library, in order: by ID, else by artist and title (album and length break ties). */
export function resolvePlaylist<T extends Song>(playlist: PhonePlaylist, library: T[], byId: Map<string, T>): T[] {
  let byKey: Map<string, T[]> | null = null;
  const found: T[] = [];
  for (const entry of playlist.entries) {
    const same = byId.get(entry.id);
    if (same && matchKey(same.title) === matchKey(entry.title)) {
      found.push(same);
      continue;
    }
    if (!byKey) {
      byKey = new Map();
      for (const song of library) {
        for (const artist of new Set([song.artist, song.album_artist].filter((a): a is string => !!a))) {
          const key = `${matchKey(artist)}\u0000${matchKey(song.title)}`;
          const list = byKey.get(key);
          if (list) list.push(song);
          else byKey.set(key, [song]);
        }
      }
    }
    const candidates = byKey.get(`${matchKey(entry.artist)}\u0000${matchKey(entry.title)}`) ?? [];
    const sameAlbum = candidates.filter((s) => matchKey(s.album ?? "") === matchKey(entry.album));
    const pool = sameAlbum.length ? sameAlbum : candidates;
    const best = [...pool].sort((a, b) => Math.abs((a.duration_ms ?? 0) - entry.ms) - Math.abs((b.duration_ms ?? 0) - entry.ms))[0];
    if (best) found.push(best);
  }
  return found;
}

/** Adds songs at the end, skipping ones already in it; returns how many were added. */
export function addSongs(playlist: PhonePlaylist, songs: Song[], now = Date.now()): number {
  const have = new Set(playlist.entries.map((e) => e.id));
  let added = 0;
  for (const song of songs) {
    if (have.has(song.id)) continue;
    have.add(song.id);
    playlist.entries.push(entryOf(song));
    added += 1;
  }
  if (added) playlist.updated = now;
  return added;
}

/** Moves the song at `from` one place up or down (or takes it out with "remove"). */
export function changeAt(playlist: PhonePlaylist, from: number, change: "up" | "down" | "remove", now = Date.now()): void {
  const list = playlist.entries;
  if (from < 0 || from >= list.length) return;
  if (change === "remove") list.splice(from, 1);
  else {
    const to = change === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
  }
  playlist.updated = now;
}

/** A playlist name that is free: the one asked for, or with " 2", " 3"… added. */
export function freeName(name: string, lists: PhonePlaylist[], except?: string): string {
  const taken = new Set(lists.filter((p) => p.id !== except).map((p) => p.name.toLocaleLowerCase()));
  const base = name.trim() || "New playlist";
  if (!taken.has(base.toLocaleLowerCase())) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`.toLocaleLowerCase())) return `${base} ${n}`;
}
