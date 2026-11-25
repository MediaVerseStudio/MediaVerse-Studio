// Flagged "problem tracks" on the phone (D96). A flag is kept on the phone with the song's artist, title and album (not
// only its Android ID), so it can be matched to the same song on a server or the computer later. Flags made away from
// the computer carry no reason (owner decision): a playlist holds only songs.
//
// Sync with a server, in short: new flags go up as their own playlist "Problem Playlist 2026-11-14 19:40 (Phone)" (an
// "inbox": nothing to clash with when two devices sync at once); the computer folds inboxes into the master playlist
// "Problem tracks" and removes them; a flag the master no longer holds (and no inbox holds) was cleared, so the phone
// drops it too.

import { matchKey } from "../src/playlist-files.ts";

export const MASTER_NAME = "Problem tracks";
export const INBOX_PREFIX = "Problem Playlist ";

export type Flag = {
  /** The phone's own ID for the song (Android media index). */
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** When it was flagged (ms since 1970). */
  at: number;
  /** When it was uploaded to a server as an inbox playlist; null until then. */
  sent: number | null;
};

/** A song as a playlist or server names it (no IDs of ours). */
export type Named = { title?: string | null; artist?: string | null; album?: string | null };

/** What identifies a song across devices: artist and title, ignoring case, accents, "feat." and bracketed notes. */
export function songKey(song: Named): string {
  return `${matchKey(song.artist ?? "")}\u0000${matchKey(song.title ?? "")}`;
}

export function isFlagged(flags: Flag[], id: string): boolean {
  return flags.some((flag) => flag.id === id);
}

/** The list with the song flagged (once; flagging again keeps the first time). */
export function addFlag(flags: Flag[], song: { id: string; title: string; artist?: string | null; album?: string | null; durationMs?: number }, now: number): Flag[] {
  if (isFlagged(flags, song.id)) return flags;
  return [...flags, { id: song.id, title: song.title, artist: song.artist ?? "", album: song.album ?? "", durationMs: song.durationMs ?? 0, at: now, sent: null }];
}

export function removeFlag(flags: Flag[], id: string): Flag[] {
  return flags.filter((flag) => flag.id !== id);
}

/** Flags not yet uploaded. */
export function pendingFlags(flags: Flag[]): Flag[] {
  return flags.filter((flag) => flag.sent === null);
}

export function markSent(flags: Flag[], ids: string[], now: number): Flag[] {
  const set = new Set(ids);
  return flags.map((flag) => (set.has(flag.id) ? { ...flag, sent: now } : flag));
}

const two = (n: number): string => String(n).padStart(2, "0");

/** "Problem Playlist 2026-11-14 19:40 (Pixel)": year first so Jellyfin's lists sort by time; the device name tells inboxes apart. */
export function inboxName(when: Date, device: string): string {
  const stamp = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}:${two(when.getMinutes())}`;
  const who = device.trim();
  return `${INBOX_PREFIX}${stamp}${who ? ` (${who})` : ""}`;
}

export function isInbox(name: string): boolean {
  return name.startsWith(INBOX_PREFIX);
}

/** Flags that were uploaded but are in neither the master list nor any inbox on the server: cleared on the computer. */
export function clearedOnServer(flags: Flag[], master: Named[], inboxes: Named[]): Flag[] {
  const held = new Set([...master, ...inboxes].map(songKey));
  return flags.filter((flag) => flag.sent !== null && !held.has(songKey(flag)));
}

/** Library songs that a server's master list names (and that are not flagged here yet), found by artist and title. */
export function localMatches<T extends { id: string } & Named>(master: Named[], library: T[], flags: Flag[]): T[] {
  const wanted = new Set(master.map(songKey));
  const have = new Set(flags.map((flag) => flag.id));
  return library.filter((song) => !have.has(song.id) && wanted.has(songKey(song)));
}

/**
 * The server's song for a flag among search results: same artist and title, preferring the same album, then the
 * closest length. Null when the server has no such song.
 */
export function pickServerSong<T extends Named & { id: string; durationMs?: number }>(flag: Flag, candidates: T[]): T | null {
  const key = songKey(flag);
  const same = candidates.filter((c) => songKey(c) === key);
  if (!same.length) return null;
  const album = matchKey(flag.album);
  const sameAlbum = album ? same.filter((c) => matchKey(c.album ?? "") === album) : [];
  const pool = sameAlbum.length ? sameAlbum : same;
  if (!flag.durationMs) return pool[0];
  return [...pool].sort((a, b) => Math.abs((a.durationMs ?? 0) - flag.durationMs) - Math.abs((b.durationMs ?? 0) - flag.durationMs))[0];
}
