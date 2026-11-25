// Playlist rules (D74), kept apart from the pages so they can be tested: adding songs, moving and removing them,
// a name for a new playlist, and the library's search (artists, albums, songs).

import { artistKey, artistOf, compareNames, sortKey, type LibrarySong } from "./library-format.ts";

export type Playlist = { id: string; name: string; paths: string[]; created_at: number; updated_at: number };

/** `paths` added at the end; songs already in the playlist are not added twice. */
export function withSongs(current: string[], paths: string[]): { paths: string[]; added: number } {
  const have = new Set(current);
  const next = [...current];
  for (const path of paths) {
    if (have.has(path)) continue;
    have.add(path);
    next.push(path);
  }
  return { paths: next, added: next.length - current.length };
}

/** The songs at `places` (positions in the list) taken out. */
export function withoutPlaces(paths: string[], places: number[]): string[] {
  const gone = new Set(places);
  return paths.filter((_, i) => !gone.has(i));
}

/**
 * The songs at `places` moved one step up (-1) or down (+1) as a block, or dropped before position `to`.
 * Returns the new list and where the moved songs now are.
 */
export function moved(paths: string[], places: number[], to: number | "up" | "down"): { paths: string[]; places: number[] } {
  const chosen = [...new Set(places)].filter((i) => i >= 0 && i < paths.length).sort((a, b) => a - b);
  if (!chosen.length) return { paths, places: [] };
  let target: number;
  if (to === "up") target = Math.max(0, chosen[0] - 1);
  else if (to === "down") target = Math.min(paths.length - chosen.length, chosen[0] + 1);
  else target = to - chosen.filter((i) => i < to).length; // the drop place, counted without the moved songs
  const block = chosen.map((i) => paths[i]);
  const rest = withoutPlaces(paths, chosen);
  target = Math.max(0, Math.min(rest.length, target));
  const next = [...rest.slice(0, target), ...block, ...rest.slice(target)];
  return { paths: next, places: block.map((_, n) => target + n) };
}

/** "New playlist", or "New playlist 2" and so on when that name is taken. */
export function newName(taken: string[], base = "New playlist"): string {
  const lower = new Set(taken.map((n) => n.toLocaleLowerCase()));
  if (!lower.has(base.toLocaleLowerCase())) return base;
  for (let n = 2; ; n += 1) if (!lower.has(`${base} ${n}`.toLocaleLowerCase())) return `${base} ${n}`;
}

export type AlbumMatch<T extends LibrarySong> = { name: string; artist: string; songs: T[] };
export type SearchResult<T extends LibrarySong> = { albums: AlbumMatch<T>[]; songs: T[] };

const plain = (text: string): string => sortKey(text, false);

/**
 * Albums whose name contains `query` and songs whose title contains it (capitals and accents do not matter),
 * for the library's search (owner, 2026-11-06: "car" finds the artist Yellowcard, and Adam Sandler's
 * "Ode to My Car"). Artists come from the wall's own filter. Albums are grouped by artist and name.
 */
export function searchLibrary<T extends LibrarySong>(songs: T[], query: string, ignoreArticles = true): SearchResult<T> {
  const wanted = plain(query);
  if (!wanted) return { albums: [], songs: [] };
  const albums = new Map<string, AlbumMatch<T>>();
  const titles: T[] = [];
  for (const song of songs) {
    const album = song.album?.trim();
    if (album && plain(album).includes(wanted)) {
      const artist = artistOf(song);
      const key = `${artistKey(artist)}\u0000${album.toLocaleLowerCase()}`;
      const found = albums.get(key);
      if (found) found.songs.push(song);
      else albums.set(key, { name: album, artist, songs: [song] });
    }
    if (plain(song.title).includes(wanted)) titles.push(song);
  }
  const byNumber = (a: T, b: T) => (a.disc_number ?? 1) - (b.disc_number ?? 1) || (a.track_number ?? 0) - (b.track_number ?? 0);
  return {
    albums: [...albums.values()]
      .map((a) => ({ ...a, songs: a.songs.sort(byNumber) }))
      .sort((a, b) => compareNames(a.name, b.name, ignoreArticles) || compareNames(a.artist, b.artist, ignoreArticles)),
    songs: titles.sort((a, b) => compareNames(a.title, b.title, ignoreArticles) || compareNames(artistOf(a), artistOf(b), ignoreArticles)),
  };
}
