// Playlists shared through Jellyfin (owner, 2026-11-22: playlists are shared, the server comes first, the computer's own
// list is the fallback when there is no server), so the TV and phone see what is made here and this computer sees what is
// made there. The computer's songs and the server's are matched by the end of the file's path (the last three parts,
// ignoring case: this computer reads the share as M:\Artist\Album\song.mp3, the server holds /music/Artist/Album/song.mp3).
//
// Per playlist, a three-way merge against what both sides held at the last round (`before`): a song added on either side
// is kept on both; a song taken out on either side is taken out of both; with no last round (the first time) nothing is
// taken out. Playlists are matched by name. Made on one side only: made on the other too. Taken out of this computer's
// list (a playlist deleted or renamed here that was synced before): its server copy is deleted (the playlist only, never
// a song). A playlist deleted on the server is NOT deleted here (the next round makes it on the server again), so a
// server hiccup can never empty this computer's lists. The flag lists ("Problem tracks", "Problem Playlist …") are never
// touched. Songs one side cannot find on the other (not in the library, or not on the server) are kept where they are.
// Pure logic with the Jellyfin client passed in, so it is unit tested without a server.

import { isInbox, MASTER_NAME } from "../phone/flags.ts";
import { JellyfinProblem, type Jellyfin, type Session } from "../phone/jellyfin-phone.ts";

export type PcPlaylist = { id: string; name: string; paths: string[] };
/** For each computer playlist (by its id): its name and the server songs it held at the last round. */
export type PlaylistSyncState = Record<string, { name: string; ids: string[] }>;

type Client = Pick<Jellyfin, "serverSongs" | "playlists" | "playlistSongs" | "createPlaylist" | "addToPlaylist" | "removeFromPlaylist" | "deletePlaylist">;

export type PlaylistSyncReport = {
  /** Playlists made on the server and on this computer. */
  madeOnServer: number;
  madeHere: number;
  /** Songs moved onto the server's lists and onto this computer's, and songs taken out of each. */
  addedOnServer: number;
  addedHere: number;
  removedOnServer: number;
  removedHere: number;
  /** Server playlists deleted because they were deleted or renamed here. */
  deletedOnServer: number;
  /** Songs of this computer's playlists the server does not have, and server songs this computer's library does not have. */
  notOnServer: number;
  notHere: number;
  /** Playlists left for the next round: changed here while this round ran, or one that failed (the others went on). */
  postponed: number;
  failed: string[];
};

/** The last three parts of a file's path, lower case, with either kind of slash: what two views of the same share have in common. */
export function tailKey(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).slice(-3).join("/").toLowerCase();
}

const CHUNK = 50;
const chunks = <T>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));
const isFlagList = (name: string): boolean => name === MASTER_NAME || isInbox(name);
const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * The merge of one playlist: `local` and `remote` are the song lists (server IDs) on this computer and on the server,
 * `base` what both held last time (null the first time). Remote order first, then what was added here.
 */
export function mergeSongs(base: string[] | null, local: string[], remote: string[]): string[] {
  const was = new Set(base ?? []);
  const here = new Set(local);
  const there = new Set(remote);
  const kept = (id: string): boolean => base === null || !was.has(id) || (here.has(id) && there.has(id));
  return unique([...remote, ...local].filter((id) => kept(id)));
}

export type SyncIo = {
  client: Client;
  session: Session;
  /** The computer's playlists now. */
  playlists: PcPlaylist[];
  /** Every file in the computer's library (its own paths). */
  libraryPaths: string[];
  /** Saves a playlist here (new when `id` is missing) and returns its id. */
  savePlaylist: (playlist: { id?: string; name: string; paths: string[] }) => Promise<string>;
  /** A computer playlist as it is right now (it may have changed while the round waited for the server). */
  latest: (id: string) => PcPlaylist | undefined;
};

/** A map from key to value where a key two different values share is ambiguous and answers nothing (two songs must never be taken for one). */
function uniqueMap<T>(entries: Array<[string, T]>): Map<string, T> {
  const map = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const [key, value] of entries) {
    if (map.has(key) && map.get(key) !== value) ambiguous.add(key);
    map.set(key, value);
  }
  for (const key of ambiguous) map.delete(key);
  return map;
}

/** Errors that mean the server is away or no longer accepts this computer end the round; anything else only fails one playlist. */
const endsRound = (error: unknown): boolean => error instanceof JellyfinProblem && (error.kind === "unreachable" || error.kind === "signed_out");

export async function syncPlaylists(io: SyncIo, before: PlaylistSyncState): Promise<{ report: PlaylistSyncReport; state: PlaylistSyncState }> {
  const { client, session } = io;
  const report: PlaylistSyncReport = { madeOnServer: 0, madeHere: 0, addedOnServer: 0, addedHere: 0, removedOnServer: 0, removedHere: 0, deletedOnServer: 0, notOnServer: 0, notHere: 0, postponed: 0, failed: [] };
  const state: PlaylistSyncState = {};
  // The library not read yet (or empty): nothing could be matched, and nothing must be written on a guess.
  if (!io.libraryPaths.length) return { report, state: before };

  // Song identity across the two sides: server ID <-> the end of the path <-> this computer's path.
  const serverSongs = await client.serverSongs(session);
  // The last three parts of a path can be the same for two songs (flat folders, "CD1/01 Intro.mp3" under two artists): such a key matches nothing.
  const idByTail = uniqueMap(serverSongs.map((song): [string, string] => [tailKey(song.path), song.id]));
  const tailById = new Map(serverSongs.map((song) => [song.id, tailKey(song.path)]));
  const pathByTail = uniqueMap(io.libraryPaths.map((path): [string, string] => [tailKey(path), path]));
  const toId = (path: string): string | undefined => idByTail.get(tailKey(path));
  const toPath = (id: string): string | undefined => {
    const tail = tailById.get(id);
    return tail === undefined ? undefined : pathByTail.get(tail);
  };

  const remote = (await client.playlists(session)).filter((list) => !isFlagList(list.name));
  const remoteByName = new Map(remote.map((list) => [list.name, list]));
  const mine = io.playlists.filter((list) => !isFlagList(list.name));
  const mineIds = new Set(mine.map((list) => list.id));

  // Deleted or renamed here since the last round: the server's copy goes (the playlist only). Not when this computer has no
  // playlists at all: its list may simply not be read yet, and deleting the last one by hand then leaves a server copy at worst.
  for (const [id, was] of mine.length ? Object.entries(before) : []) {
    const renamed = mine.find((list) => list.id === id && list.name !== was.name);
    if (mineIds.has(id) && !renamed) continue;
    const gone = remoteByName.get(was.name);
    if (gone && !mine.some((list) => list.name === was.name)) {
      await client.deletePlaylist(session, gone.id);
      remoteByName.delete(was.name);
      report.deletedOnServer++;
    }
  }

  for (const playlist of mine) {
    const last = before[playlist.id];
    try {
    const base = last && last.name === playlist.name ? last.ids : null;
    const there = remoteByName.get(playlist.name);
    const localIds = unique(playlist.paths.map(toId).filter((id): id is string => !!id));
    const notOnServerPaths = playlist.paths.filter((path) => !toId(path));
    report.notOnServer += notOnServerPaths.length;

    if (!there) {
      if (localIds.length) {
        await client.createPlaylist(session, playlist.name, localIds);
        report.madeOnServer++;
      }
      state[playlist.id] = { name: playlist.name, ids: localIds };
      continue;
    }

    const current = await client.playlistSongs(session, there.id);
    const remoteIds = unique(current.map((song) => song.id));
    // A server song this library cannot hold is not "taken out here": it simply cannot be on this side's list.
    const unholdable = [...(base ?? []), ...remoteIds].filter((id) => !toPath(id));
    const merged = mergeSongs(base, unique([...localIds, ...unholdable]), remoteIds);

    // To the server.
    const mergedSet = new Set(merged);
    const remoteSet = new Set(remoteIds);
    const toAdd = merged.filter((id) => !remoteSet.has(id));
    const entries = unique(current.filter((song) => !mergedSet.has(song.id) && song.entryId).map((song) => song.entryId!));
    for (const part of chunks(toAdd)) await client.addToPlaylist(session, there.id, part);
    for (const part of chunks(entries)) await client.removeFromPlaylist(session, there.id, part);
    report.addedOnServer += toAdd.length;
    report.removedOnServer += entries.length;

    // To this computer: the merged songs in order, then the songs this computer's list holds that the server cannot (kept).
    const ownPath = new Map<string, string>();
    for (const path of playlist.paths) {
      const id = toId(path);
      if (id && !ownPath.has(id)) ownPath.set(id, path);
    }
    const wanted: string[] = [];
    for (const id of merged) {
      const path = ownPath.get(id) ?? toPath(id);
      if (path) wanted.push(path);
      else report.notHere++;
    }
    const keep = playlist.paths.filter((path) => !toId(path));
    const next = unique([...wanted, ...keep]);
    // A reordering alone is not a change worth writing: the same songs, in any order, are the same list.
    const had = new Set(playlist.paths);
    const sameSongs = next.length === had.size && next.every((path) => had.has(path));
    if (!sameSongs) {
      // Changed here while the round waited for the server: writing the old list back would lose that change, so this playlist
      // waits for the next round (the server side is already in step, and the last round's state is kept so nothing is misread).
      const now = io.latest(playlist.id);
      if (now && now.paths.join("\n") !== playlist.paths.join("\n")) {
        report.postponed++;
        if (last) state[playlist.id] = last;
        continue;
      }
      await io.savePlaylist({ id: playlist.id, name: playlist.name, paths: next });
      report.addedHere += next.filter((path) => !playlist.paths.includes(path)).length;
      report.removedHere += playlist.paths.filter((path) => !next.includes(path)).length;
    }
    state[playlist.id] = { name: playlist.name, ids: merged };
    } catch (error) {
      if (endsRound(error)) throw error;
      report.failed.push(`${playlist.name}: ${error instanceof Error ? error.message : String(error)}`);
      if (last) state[playlist.id] = last;
    }
  }

  // Made on the server only: made here too (its songs this computer's library has).
  const names = new Set(mine.map((list) => list.name.toLocaleLowerCase()));
  for (const list of remote) {
    // (Names that differ only by capitals, or a second server playlist of the same name, are not brought in: this computer refuses two of a name.)
    if (names.has(list.name.toLocaleLowerCase()) || remoteByName.get(list.name)?.id !== list.id) continue;
    names.add(list.name.toLocaleLowerCase());
    try {
      const songs = unique((await client.playlistSongs(session, list.id)).map((song) => song.id));
      const paths: string[] = [];
      for (const id of songs) {
        const path = toPath(id);
        if (path) paths.push(path);
        else report.notHere++;
      }
      if (!paths.length) continue;
      const id = await io.savePlaylist({ name: list.name, paths: unique(paths) });
      state[id] = { name: list.name, ids: songs };
      report.madeHere++;
    } catch (error) {
      if (endsRound(error)) throw error;
      report.failed.push(`${list.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { report, state };
}

/** What the person is told (nothing when nothing changed). */
export function describePlaylistSync(report: PlaylistSyncReport): string {
  const songs = (n: number): string => `${n} song${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (report.madeOnServer) parts.push(`${report.madeOnServer} playlist${report.madeOnServer === 1 ? "" : "s"} made on the server`);
  if (report.madeHere) parts.push(`${report.madeHere} playlist${report.madeHere === 1 ? "" : "s"} brought in from the server`);
  if (report.addedOnServer) parts.push(`${songs(report.addedOnServer)} added on the server`);
  if (report.addedHere) parts.push(`${songs(report.addedHere)} added here`);
  if (report.removedOnServer || report.removedHere) parts.push(`${songs(report.removedOnServer + report.removedHere)} taken out`);
  if (report.deletedOnServer) parts.push(`${report.deletedOnServer} server playlist${report.deletedOnServer === 1 ? "" : "s"} deleted (deleted or renamed here)`);
  if (report.notOnServer) parts.push(`${songs(report.notOnServer)} in playlists here ${report.notOnServer === 1 ? "is" : "are"} not on the server`);
  if (report.notHere) parts.push(`${songs(report.notHere)} on the server ${report.notHere === 1 ? "is" : "are"} not in this library`);
  if (report.failed.length) parts.push(`${report.failed.length} playlist${report.failed.length === 1 ? "" : "s"} could not be synced (${report.failed[0]})`);
  return parts.length ? `Playlists: ${parts.join("; ")}.` : "";
}
