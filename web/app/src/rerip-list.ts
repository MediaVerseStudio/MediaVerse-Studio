// The re-rip list (owner, 2026-11-23, D175): songs whose scan found no sound at all (an empty rip) go into a playlist, "Needs re-ripping", and their discs are flagged
// for a re-rip (the list under Review > Missing & copies). A playlist, because it is the one list every part of the program already has: it is on the TVs and the phone
// through the Jellyfin sync, a person can play it to hear what is wrong, and a song leaves it with one click when its disc has been ripped again. Pure, so it is unit tested.

import { folderOf } from "./cover-util.ts";


export const RERIP_PLAYLIST = "Needs re-ripping";

export type ScannedSong = { path: string; report: { counts: Record<string, number | undefined> } };

/** The songs among the scan results that have no sound at all. */
export function silentSongs<T extends ScannedSong>(results: T[]): T[] {
  return results.filter((r) => (r.report.counts.silent ?? 0) > 0);
}

/** One entry per disc (album folder) holding silent songs, with the titles that are silent, for flagging the discs. */
export function discsOf(songs: Array<{ path: string; title: string; album: string | null; artist: string | null }>): Array<{ folder: string; album: string; artist: string; titles: string[] }> {
  const byFolder = new Map<string, { folder: string; album: string; artist: string; titles: string[] }>();
  for (const song of songs) {
    const folder = folderOf(song.path);
    const disc = byFolder.get(folder) ?? { folder, album: song.album ?? "Unknown album", artist: song.artist ?? "Unknown artist", titles: [] };
    disc.titles.push(song.title);
    byFolder.set(folder, disc);
  }
  return [...byFolder.values()];
}

/** The reason kept with a flagged disc. */
export function reripReason(titles: string[]): string {
  const shown = titles.slice(0, 4).join(", ");
  return `No sound at all in ${titles.length === 1 ? "a song" : `${titles.length} songs`}: ${shown}${titles.length > 4 ? ", …" : ""} (found by the audio defect scan).`;
}
