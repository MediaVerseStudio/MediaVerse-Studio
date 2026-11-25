// The computer's side of the shared problem-track list (D96). Phones and TVs upload their new flags to a Jellyfin
// server as playlists named "Problem Playlist 2026-11-14 19:40 (device)"; this folds those into the master playlist
// "Problem tracks", turns the songs it also has into flags on the Review page, puts flags made here into the master
// list, and takes a song out of the master list when it is marked Done here. Inbox playlists are deleted once merged
// (a playlist only, never a song). Pure logic with a Jellyfin client passed in, so it is unit tested without a server.

import { isInbox, MASTER_NAME, pickServerSong, songKey, type Flag as DeviceFlag, type Named } from "../phone/flags.ts";
import { perArtist, type Jellyfin, type ServerSong, type Session } from "../phone/jellyfin-phone.ts";

export type FlagLike = { path: string; title: string | null; artist: string | null; album: string | null };
export type SongLike = { title: string; artist: string | null; album: string | null; album_artist: string | null; source_uri: string; length_ms?: number | null };

type Client = Pick<Jellyfin, "searchSongs" | "playlists" | "playlistSongs" | "createPlaylist" | "addToPlaylist" | "removeFromPlaylist" | "deletePlaylist">;
type Listed = ServerSong & { artists: string[] };

export type ProblemReport = {
  /** Songs added to the master list from phones and TVs, and from flags made on this computer. */
  fromDevices: number;
  fromComputer: number;
  /** Songs taken out of the master list because they were marked Done here. */
  doneRemoved: number;
  inboxesRemoved: number;
  /** Songs on the master list that this computer's library has and that are not flagged here yet: to be flagged. */
  newFlags: SongLike[];
  /** Songs on the master list this computer's library does not have, and flags here the server has no song for. */
  notInLibrary: number;
  notOnServer: number;
};

const keysOf = (song: Listed): string[] => perArtist([song]).map(songKey);
const holds = (keys: Set<string>, song: Listed): boolean => keysOf(song).some((key) => keys.has(key));

/**
 * One round. `done` lists songs (by `songKey`) marked Done here whose removal from the master list is still due.
 * Throws if the server cannot be reached part-way; nothing is deleted before the merge has been written.
 */
export async function syncProblemTracks(client: Client, session: Session, input: { flags: FlagLike[]; library: SongLike[]; done: string[] }): Promise<ProblemReport> {
  const done = new Set(input.done);
  const lists = await client.playlists(session);
  const master = lists.find((list) => list.name === MASTER_NAME);
  const inboxes = lists.filter((list) => isInbox(list.name));

  const masterSongs: Listed[] = master ? await client.playlistSongs(session, master.id) : [];
  const masterKeys = new Set(masterSongs.flatMap(keysOf));
  const inboxSongs: Listed[] = [];
  for (const inbox of inboxes) inboxSongs.push(...(await client.playlistSongs(session, inbox.id)));

  // What goes into the master list: inbox songs, then flags made on this computer.
  const adding = new Map<string, Listed>();
  const addedKeys = new Set<string>();
  const take = (song: Listed): boolean => {
    if (adding.has(song.id) || holds(masterKeys, song) || holds(done, song) || holds(addedKeys, song)) return false;
    adding.set(song.id, song);
    for (const key of keysOf(song)) addedKeys.add(key);
    return true;
  };
  let fromDevices = 0;
  for (const song of inboxSongs) if (take(song)) fromDevices++;

  let fromComputer = 0;
  let notOnServer = 0;
  for (const flag of input.flags) {
    const key = songKey(flag);
    if (masterKeys.has(key) || done.has(key) || addedKeys.has(key)) continue;
    const asDevice: DeviceFlag = { id: flag.path, title: flag.title ?? "", artist: flag.artist ?? "", album: flag.album ?? "", durationMs: 0, at: 0, sent: null };
    const song = pickServerSong(asDevice, perArtist(await client.searchSongs(session, flag.title ?? "")));
    if (!song) {
      notOnServer++;
      continue;
    }
    const listed = song as Listed;
    if (take({ ...listed, artists: listed.artists ?? [listed.artist ?? ""] })) fromComputer++;
  }

  // Write the merge, then take out what was marked Done, then delete the inboxes that were read.
  let masterId = master?.id ?? null;
  if (adding.size) {
    const ids = [...adding.keys()];
    if (masterId) await client.addToPlaylist(session, masterId, ids);
    else masterId = await client.createPlaylist(session, MASTER_NAME, ids);
  }
  let doneRemoved = 0;
  if (master) {
    const doomed = masterSongs.filter((song) => holds(done, song));
    const entries = [...new Set(doomed.map((song) => song.entryId).filter((id): id is string => !!id))];
    if (entries.length) await client.removeFromPlaylist(session, master.id, entries);
    doneRemoved = new Set(doomed.map((song) => song.id)).size;
  }
  for (const inbox of inboxes) await client.deletePlaylist(session, inbox.id);

  // Flags for the songs on the master list that this computer has.
  const onList: Listed[] = [...masterSongs.filter((song) => !holds(done, song)), ...adding.values()];
  const flagged = new Set(input.flags.map(songKey));
  const flaggedPaths = new Set(input.flags.map((flag) => flag.path));
  const byKey = new Map<string, SongLike[]>();
  for (const song of input.library) {
    for (const artist of new Set([song.artist, song.album_artist].filter((a): a is string => !!a?.trim()))) {
      const key = songKey({ title: song.title, artist });
      byKey.set(key, [...(byKey.get(key) ?? []), song]);
    }
  }
  const newFlags = new Map<string, SongLike>();
  const unmatched = new Set<string>();
  for (const song of onList) {
    const keys = keysOf(song);
    if (keys.some((key) => flagged.has(key))) continue;
    const candidates = keys.flatMap((key) => byKey.get(key) ?? []).filter((c) => !flaggedPaths.has(c.source_uri));
    if (!candidates.length) {
      unmatched.add(song.id);
      continue;
    }
    const sameAlbum = candidates.filter((c) => c.album && song.album && songKey({ title: "", artist: c.album }) === songKey({ title: "", artist: song.album }));
    newFlags.set((sameAlbum[0] ?? candidates[0]).source_uri, sameAlbum[0] ?? candidates[0]);
  }

  return { fromDevices, fromComputer, doneRemoved, inboxesRemoved: inboxes.length, newFlags: [...newFlags.values()], notInLibrary: unmatched.size, notOnServer };
}

/** What the person is told after a round. */
export function describeProblemSync(report: ProblemReport): string {
  const parts: string[] = [];
  const songs = (n: number): string => `${n} song${n === 1 ? "" : "s"}`;
  if (report.fromDevices) parts.push(`${songs(report.fromDevices)} added from phones and TVs`);
  if (report.fromComputer) parts.push(`${songs(report.fromComputer)} from this computer's flags added to the shared list`);
  if (report.newFlags.length) parts.push(`${songs(report.newFlags.length)} flagged for review here`);
  if (report.doneRemoved) parts.push(`${songs(report.doneRemoved)} cleared from the shared list`);
  if (report.notInLibrary) parts.push(`${songs(report.notInLibrary)} on the list ${report.notInLibrary === 1 ? "is" : "are"} not in this computer's library`);
  if (report.notOnServer) parts.push(`${songs(report.notOnServer)} flagged here not found on the server`);
  return parts.length ? `Synced: ${parts.join("; ")}.` : "Synced: nothing new.";
}

export type { Named };
