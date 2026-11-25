// Artist photos from a Jellyfin server (D97): which of the library's artists the server has a photo for. The photo is
// then written into the artist's songs as their "Artist" picture (ID3 picture type 8) and shown on top of the
// artist's stack in the library. Pure logic, tested without a server.

import type { ServerArtist } from "../phone/jellyfin-phone.ts";
import { looseKey } from "./artist-names.ts";
import { artistKey, artistOf, type LibrarySong } from "./library-format.ts";

/** An artist as the library wall lists them: the name, and every song filed under it. */
export type LibraryArtist = { name: string; paths: string[] };
export type PhotoMatch = { artist: LibraryArtist; source: ServerArtist };
export type PhotoPlan = {
  /** Artists the server has a photo for. */
  matches: PhotoMatch[];
  /** Artists the server knows but has no photo for. */
  noPhoto: LibraryArtist[];
  /** Artists the server does not list at all. */
  notOnServer: LibraryArtist[];
};

/** Not people or bands: no photo is looked for. */
const SKIPPED = new Set(["unknown artist", "various artists", "various", "soundtrack", "original soundtrack"]);

/** The wall's artists (album artist, else artist), with their songs. Several spellings that the wall merges stay one. */
export function libraryArtists(songs: LibrarySong[]): LibraryArtist[] {
  const byKey = new Map<string, { names: Map<string, number>; paths: string[] }>();
  for (const song of songs) {
    const name = artistOf(song);
    const key = artistKey(name);
    let entry = byKey.get(key);
    if (!entry) byKey.set(key, (entry = { names: new Map(), paths: [] }));
    entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
    entry.paths.push(song.source_uri);
  }
  return [...byKey.values()]
    .map((entry) => ({ name: [...entry.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], paths: entry.paths }))
    .filter((artist) => !SKIPPED.has(artist.name.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pairs each library artist with the server's artist of the same name (punctuation, spacing and capitals aside:
 * "A.F.I." finds "AFI"). When the server lists a name twice, the exact spelling wins, then the one with a photo.
 */
export function planPhotos(artists: LibraryArtist[], server: ServerArtist[]): PhotoPlan {
  const byKey = new Map<string, ServerArtist[]>();
  for (const candidate of server) {
    const key = looseKey(candidate.name);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }
  const plan: PhotoPlan = { matches: [], noPhoto: [], notOnServer: [] };
  for (const artist of artists) {
    const candidates = byKey.get(looseKey(artist.name)) ?? [];
    if (!candidates.length) {
      plan.notOnServer.push(artist);
      continue;
    }
    const best = [...candidates].sort(
      (a, b) => Number(b.name === artist.name) - Number(a.name === artist.name) || Number(!!b.imageTag) - Number(!!a.imageTag) || a.name.localeCompare(b.name),
    )[0];
    if (best.imageTag) plan.matches.push({ artist, source: best });
    else plan.noPhoto.push(artist);
  }
  return plan;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What the person is told about a plan. */
export function describePlan(plan: PhotoPlan, alreadyHave: number): string {
  const artists = (n: number): string => `${n} artist${n === 1 ? "" : "s"}`;
  const parts = [`Jellyfin has photos for ${artists(plan.matches.length)}`];
  if (alreadyHave) parts.push(`${alreadyHave} already have one in their songs`);
  if (plan.noPhoto.length) parts.push(`${artists(plan.noPhoto.length)} on the server have no photo`);
  if (plan.notOnServer.length) parts.push(`${artists(plan.notOnServer.length)} are not on the server`);
  return `${parts.join("; ")}.`;
}
