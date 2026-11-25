// The phone's playlists kept in step with the home Jellyfin server (D177), the phone's side of what the computer does in src/playlist-sync.ts: a playlist made on
// the phone is on the server for the TV and the computer, one made there comes to the phone (with the songs the phone has), and a change on either side is merged
// with what both held at the last round (an addition on either side stays, a removal on either side wins). Songs the phone does not have are never lost from a
// server playlist because of that, and songs the server does not have stay in the phone's playlist. Playlists are matched by name (a rename is a new playlist and
// the old one going). The flag lists ("Problem tracks", "Problem Playlist ...") are the flag sync's, not this. Pure, with the server's client passed in.

import { isInbox, MASTER_NAME, songKey } from "./flags.ts";
import type { Jellyfin, ServerSong, Session } from "./jellyfin-phone.ts";
import type { Manifest } from "./home-sync.ts";
import { addSongs, entryOf, resolvePlaylist, type PhonePlaylist } from "./phone-playlists.ts";
import { mergeSongs } from "../src/playlist-sync.ts";

/** For each playlist (by its lower-case name): its name and the server song ids it held at the last round. */
export type PhonePlaylistState = Record<string, { name: string; ids: string[] }>;

type Client = Pick<Jellyfin, "playlists" | "playlistSongs" | "createPlaylist" | "addToPlaylist" | "removeFromPlaylist" | "deletePlaylist" | "searchSongs">;
type LocalSong = { id: string; title: string; artist: string | null; album_artist?: string | null; album: string | null; duration_ms?: number };

export type PhonePlaylistReport = { madeOnServer: number; madeHere: number; deletedOnServer: number; deletedHere: number; addedOnServer: number; removedOnServer: number; addedHere: number; removedHere: number; notOnServer: number; notHere: number; failed: string[] };

export type PhonePlaylistIo = {
  client: Client;
  session: Session;
  playlists: PhonePlaylist[];
  library: LocalSong[];
  /** The songs fetched from the server: their server id and the phone's own id for the file (exact, no guessing). */
  manifest: Manifest;
  state: PhonePlaylistState;
  now: number;
  newId: () => string;
};

const CHUNK = 50;
const chunks = <T>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const keyOf = (name: string): string => name.trim().toLocaleLowerCase();
const isFlagList = (name: string): boolean => name === MASTER_NAME || isInbox(name);
/** At most this many songs are looked up on the server by name in one round (the ones the phone did not fetch from it). */
const LOOKUPS = 150;

export async function syncPhonePlaylists(io: PhonePlaylistIo): Promise<{ playlists: PhonePlaylist[]; state: PhonePlaylistState; report: PhonePlaylistReport }> {
  const report: PhonePlaylistReport = { madeOnServer: 0, madeHere: 0, deletedOnServer: 0, deletedHere: 0, addedOnServer: 0, removedOnServer: 0, addedHere: 0, removedHere: 0, notOnServer: 0, notHere: 0, failed: [] };
  const byId = new Map(io.library.map((s) => [s.id, s]));
  const serverOfLocal = new Map<string, string>();
  const localOfServer = new Map<string, string>();
  for (const file of Object.values(io.manifest.files)) {
    if (file.mediaId && byId.has(file.mediaId)) {
      serverOfLocal.set(file.mediaId, file.id);
      localOfServer.set(file.id, file.mediaId);
    }
  }
  // The library by artist and title, to find the phone's song for a server song it did not fetch from the server.
  const localByKey = new Map<string, LocalSong[]>();
  for (const song of io.library) {
    for (const artist of new Set([song.artist, song.album_artist].filter((a): a is string => !!a))) {
      const key = songKey({ title: song.title, artist });
      localByKey.set(key, [...(localByKey.get(key) ?? []), song]);
    }
  }
  const localFor = (server: ServerSong & { artists?: string[] }): LocalSong | null => {
    const exact = localOfServer.get(server.id);
    if (exact) return byId.get(exact) ?? null;
    const names = server.artists?.length ? server.artists : [server.artist ?? ""];
    const found = names.flatMap((artist) => localByKey.get(songKey({ title: server.title, artist })) ?? []);
    if (!found.length) return null;
    const sameAlbum = found.filter((s) => songKey({ title: "", artist: s.album ?? "" }) === songKey({ title: "", artist: server.album ?? "" }));
    return (sameAlbum[0] ?? found[0]) ?? null;
  };
  let lookups = 0;
  const serverCache = new Map<string, string | null>();
  /** The server's id of a phone song: from the record, else asked by title (a few per round). */
  async function serverIdOf(song: LocalSong): Promise<string | null> {
    const known = serverOfLocal.get(song.id);
    if (known) return known;
    const key = songKey(song);
    if (serverCache.has(key)) return serverCache.get(key) ?? null;
    if (lookups >= LOOKUPS) return null;
    lookups += 1;
    const candidates = (await io.client.searchSongs(io.session, song.title)).filter((c) => [c.artist, ...c.artists].some((a) => songKey({ title: c.title, artist: a }) === key));
    const sameAlbum = candidates.filter((c) => songKey({ title: "", artist: c.album ?? "" }) === songKey({ title: "", artist: song.album ?? "" }));
    const found = (sameAlbum[0] ?? candidates[0])?.id ?? null;
    serverCache.set(key, found);
    return found;
  }

  const remoteLists = (await io.client.playlists(io.session)).filter((l) => !isFlagList(l.name));
  const remoteByKey = new Map(remoteLists.map((l) => [keyOf(l.name), l]));
  const localByName = new Map(io.playlists.filter((p) => !isFlagList(p.name)).map((p) => [keyOf(p.name), p]));
  const next: PhonePlaylist[] = io.playlists.filter((p) => isFlagList(p.name));
  const state: PhonePlaylistState = {};

  const keys = unique([...localByName.keys(), ...remoteByKey.keys(), ...Object.keys(io.state)]);
  for (const key of keys) {
    const local = localByName.get(key);
    const remote = remoteByKey.get(key);
    const before = io.state[key];
    try {
      // The phone's songs in this playlist as server ids (and which entries have none).
      const localIds: string[] = [];
      const songByServerId = new Map<string, LocalSong>();
      const unmapped: PhonePlaylist["entries"] = [];
      if (local) {
        const resolved = resolvePlaylist(local, io.library, byId);
        const resolvedIds = new Set(resolved.map((s) => s.id));
        for (const entry of local.entries) if (!resolvedIds.has(entry.id) && !resolved.some((s) => songKey(s) === songKey(entry))) unmapped.push(entry);
        for (const song of resolved) {
          const id = await serverIdOf(song);
          if (id) {
            localIds.push(id);
            songByServerId.set(id, song);
          } else {
            report.notOnServer += 1;
            unmapped.push(entryOf(song));
          }
        }
      }
      const localUnique = unique(localIds);

      if (local && remote) {
        const remoteSongs = await io.client.playlistSongs(io.session, remote.id);
        const remoteIds = unique(remoteSongs.map((s) => s.id));
        const localForServer = new Map<string, LocalSong | null>(remoteSongs.map((s) => [s.id, localFor(s as ServerSong & { artists?: string[] })]));
        // Songs the phone does not have are on the server's list and stay there: for the merge the phone counts as holding them.
        const missingHere = remoteIds.filter((id) => !localForServer.get(id));
        const merged = mergeSongs(before ? before.ids : null, unique([...localUnique, ...missingHere]), remoteIds);
        const add = merged.filter((id) => !remoteIds.includes(id));
        const mergedSet = new Set(merged);
        const drop = remoteSongs.filter((s) => !mergedSet.has(s.id));
        for (const part of chunks(add)) await io.client.addToPlaylist(io.session, remote.id, part);
        const entries = unique(drop.map((s) => s.entryId).filter((e): e is string => !!e));
        for (const part of chunks(entries)) await io.client.removeFromPlaylist(io.session, remote.id, part);
        report.addedOnServer += add.length;
        report.removedOnServer += unique(drop.map((s) => s.id)).length;
        // The phone's playlist: the merged songs it has, in that order, then the entries that have no server song.
        const byServer = new Map<string, LocalSong>(songByServerId);
        for (const s of remoteSongs) {
          const mine = localForServer.get(s.id);
          if (mine && !byServer.has(s.id)) byServer.set(s.id, mine);
        }
        const rebuilt: PhonePlaylist = { ...local, entries: [] };
        const have = merged.map((id) => byServer.get(id)).filter((s): s is LocalSong => !!s);
        rebuilt.entries = [...have.map(entryOf), ...unmapped.filter((e) => !have.some((s) => s.id === e.id))];
        const was = new Set(local.entries.map((e) => e.id));
        report.addedHere += rebuilt.entries.filter((e) => !was.has(e.id)).length;
        report.removedHere += local.entries.filter((e) => !rebuilt.entries.some((r) => r.id === e.id)).length;
        report.notHere += merged.filter((id) => !byServer.has(id)).length;
        const changed = rebuilt.entries.length !== local.entries.length || rebuilt.entries.some((e, i) => e.id !== local.entries[i]?.id);
        next.push(changed ? { ...rebuilt, updated: io.now } : local);
        state[key] = { name: local.name, ids: merged };
      } else if (local && !remote) {
        const baseIds = new Set(before?.ids ?? []);
        const unchanged = !!before && localUnique.length === baseIds.size && localUnique.every((id) => baseIds.has(id));
        if (before && unchanged) {
          report.deletedHere += 1; // it was deleted on the server and not changed here
          continue;
        }
        const id = await io.client.createPlaylist(io.session, local.name, localUnique);
        void id;
        report.madeOnServer += 1;
        report.addedOnServer += localUnique.length;
        next.push(local);
        state[key] = { name: local.name, ids: localUnique };
      } else if (!local && remote) {
        if (before) {
          await io.client.deletePlaylist(io.session, remote.id); // deleted on the phone
          report.deletedOnServer += 1;
          continue;
        }
        const remoteSongs = await io.client.playlistSongs(io.session, remote.id);
        const ids = unique(remoteSongs.map((s) => s.id));
        const mine = unique(remoteSongs.flatMap((s) => { const song = localFor(s as ServerSong & { artists?: string[] }); return song ? [song] : []; }).map((s) => s.id));
        const made: PhonePlaylist = { id: io.newId(), name: remote.name, entries: [], updated: io.now };
        addSongs(made, mine.map((id) => byId.get(id)).filter((s): s is LocalSong => !!s), io.now);
        report.madeHere += 1;
        report.addedHere += made.entries.length;
        report.notHere += ids.length - made.entries.length;
        next.push(made);
        state[key] = { name: remote.name, ids };
      }
    } catch (thrown) {
      // The server being away or signing out ends the round (the caller says so); one playlist failing does not stop the others.
      if (thrown && typeof thrown === "object" && "kind" in thrown && ((thrown as { kind: string }).kind === "unreachable" || (thrown as { kind: string }).kind === "signed_out")) throw thrown;
      report.failed.push(`${local?.name ?? remote?.name ?? key}: ${thrown instanceof Error ? thrown.message : "not synced"}`);
      if (local) next.push(local);
      if (before) state[key] = before;
    }
  }
  return { playlists: next, state, report };
}

export function describePlaylistReport(report: PhonePlaylistReport): string {
  const parts: string[] = [];
  if (report.madeOnServer) parts.push(`${report.madeOnServer} playlist${report.madeOnServer === 1 ? "" : "s"} sent to the server`);
  if (report.madeHere) parts.push(`${report.madeHere} playlist${report.madeHere === 1 ? "" : "s"} brought to the phone`);
  if (report.deletedHere || report.deletedOnServer) parts.push(`${report.deletedHere + report.deletedOnServer} deleted to match`);
  const songs = report.addedOnServer + report.removedOnServer + report.addedHere + report.removedHere;
  if (songs && !report.madeOnServer && !report.madeHere) parts.push("playlist songs updated both ways");
  if (report.failed.length) parts.push(`${report.failed.length} playlist problem${report.failed.length === 1 ? "" : "s"}: ${report.failed[0]}`);
  return parts.length ? `Playlists: ${parts.join("; ")}.` : "";
}
