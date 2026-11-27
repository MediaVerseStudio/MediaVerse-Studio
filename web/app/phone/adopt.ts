// Recognising music the phone already has (owner, 2026-11-23, D178): when the phone starts keeping music in step with a home Jellyfin server, songs that were copied onto it
// long ago (by USB cable, or from the same library) should be recognised and marked as kept, not deleted and fetched again. A song on the server is matched to a song on the phone
// by what both know: the title and artist, the album, the length, the file's name and, strongest of all, its size in bytes. A pair whose size is the same is "exact" (and can be
// confirmed by comparing a fingerprint of the file's head and tail, which the app does); a pair that agrees on everything but the size is the same song in another version
// ("differs": a different tag, bitrate or rip), which is marked as kept but left alone until the person chooses the server's version. Pure, so it is unit tested.

import { matchKey } from "../src/playlist-files.ts";
import type { SyncSong } from "./jellyfin-phone.ts";

/** A song on the phone as the page knows it (the app's media index). */
export type LocalSong = {
  id: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  /** The song's folder on the phone ("Music/Band/Album/"), and its file name. */
  folder: string;
  file: string;
  size: number;
  durationMs: number;
  /** Whether the program created this file (it fetched it before): such a song is its own to replace or take off. */
  own?: boolean;
};

export type Adoption = { song: SyncSong; local: LocalSong; level: "exact" | "differs"; score: number };


/** The least score that makes two songs the same: the same title and artist (20) plus enough else (the length and album, or the size). */
export const THRESHOLD = 55;

const key = (text: string): string => matchKey(text ?? "");
const lastPart = (folder: string): string => folder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

/** How well a phone song fits a server song, 0 when it cannot be the same (another title or artist). */
export function score(song: SyncSong, local: LocalSong): number {
  if (!song.title || key(song.title) !== key(local.title)) return 0;
  const theirs = new Set([song.artist, song.albumArtist].map(key).filter(Boolean));
  const mine = [local.artist, local.albumArtist].map(key).filter(Boolean);
  if (theirs.size > 0 && mine.length > 0 && !mine.some((a) => theirs.has(a))) return 0;
  let total = 20;
  if (song.size > 0 && local.size > 0 && song.size === local.size) total += 50;
  const gap = song.durationMs > 0 && local.durationMs > 0 ? Math.abs(song.durationMs - local.durationMs) : Number.POSITIVE_INFINITY;
  if (gap <= 1500) total += 25;
  else if (gap <= 5000) total += 10;
  else if (gap > 20_000 && Number.isFinite(gap)) return 0; // a different recording
  if (song.album && key(song.album) === key(local.album)) total += 15;
  else if (song.album && key(song.album) === key(lastPart(local.folder))) total += 10;
  const name = key(local.file.replace(/\.[^.]+$/, ""));
  if (name && key(song.title) && name.includes(key(song.title))) total += 5;
  return total;
}

/**
 * The songs on the phone that are the same as songs on the server, one to one. `taken` holds phone songs that are already kept (they are not matched again). The best pairs
 * are matched first, so a song with two possible partners gets the closer one.
 */
export function findAdoptions(wanted: SyncSong[], locals: LocalSong[], taken: Set<string>): Adoption[] {
  const byTitle = new Map<string, LocalSong[]>();
  for (const local of locals) {
    if (taken.has(local.id)) continue;
    const k = key(local.title);
    if (k) byTitle.set(k, [...(byTitle.get(k) ?? []), local]);
  }
  const pairs: Adoption[] = [];
  for (const song of wanted) {
    for (const local of byTitle.get(key(song.title)) ?? []) {
      const s = score(song, local);
      if (s >= THRESHOLD) pairs.push({ song, local, level: song.size > 0 && song.size === local.size ? "exact" : "differs", score: s });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.local.folder.localeCompare(b.local.folder) || a.local.file.localeCompare(b.local.file));
  const songsDone = new Set<string>();
  const localsDone = new Set<string>();
  const out: Adoption[] = [];
  for (const pair of pairs) {
    if (songsDone.has(pair.song.id) || localsDone.has(pair.local.id)) continue;
    songsDone.add(pair.song.id);
    localsDone.add(pair.local.id);
    out.push(pair);
  }
  return out;
}
