// A profile's favorites and plays kept in step between the phone and the Jellyfin server (D213). Favorites merge three
// ways with what both held last time: a heart added on either side stays, one removed on either side goes; hearts on
// songs the other side does not have are left alone. Plays since the last round are counted on the server, so Recently
// played follows the profile. Pure, with the server's client passed in.

import { mergeSongs } from "../src/playlist-sync.ts";
import { songKey } from "./flags.ts";
import type { Manifest } from "./home-sync.ts";
import type { Jellyfin, ServerSong, Session } from "./jellyfin-phone.ts";

export type LocalSong = { id: string; title: string; artist: string | null; album_artist?: string | null; album: string | null };
type Listed = ServerSong & { artists: string[] };

/** At most this many songs are looked up on the server by name in one round (the ones the phone did not fetch from it). */
const LOOKUPS = 150;
/** The first round sends only this many of the newest plays, not years of them. */
const FIRST_PLAYS = 100;

/** Finds the same song on the other side: from the record of what was fetched, else by artist and title (the album breaking ties). */
export function songMatcher(client: Pick<Jellyfin, "searchSongs">, session: Session, library: LocalSong[], manifest: Manifest) {
  const byId = new Map(library.map((s) => [s.id, s]));
  const serverOfLocal = new Map<string, string>();
  const localOfServer = new Map<string, string>();
  for (const file of Object.values(manifest.files)) {
    if (file.mediaId && byId.has(file.mediaId)) {
      serverOfLocal.set(file.mediaId, file.id);
      localOfServer.set(file.id, file.mediaId);
    }
  }
  const byKey = new Map<string, LocalSong[]>();
  for (const song of library) {
    for (const artist of new Set([song.artist, song.album_artist].filter((a): a is string => !!a))) {
      const key = songKey({ title: song.title, artist });
      byKey.set(key, [...(byKey.get(key) ?? []), song]);
    }
  }
  const album = (name: string | null | undefined): string => songKey({ title: "", artist: name ?? "" });
  let lookups = 0;
  const asked = new Map<string, string | null>();
  return {
    localFor(server: Listed): string | null {
      const exact = localOfServer.get(server.id);
      if (exact) return exact;
      const names = server.artists?.length ? server.artists : [server.artist ?? ""];
      const found = names.flatMap((artist) => byKey.get(songKey({ title: server.title, artist })) ?? []);
      return (found.find((s) => album(s.album) === album(server.album)) ?? found[0])?.id ?? null;
    },
    async serverFor(localId: string): Promise<string | null> {
      const known = serverOfLocal.get(localId);
      if (known) return known;
      const song = byId.get(localId);
      if (!song) return null;
      const key = songKey(song);
      if (asked.has(key)) return asked.get(key) ?? null;
      if (lookups >= LOOKUPS) return null;
      lookups += 1;
      const candidates = (await client.searchSongs(session, song.title)).filter((c) => [c.artist, ...c.artists].some((a) => songKey({ title: c.title, artist: a }) === key));
      const found = (candidates.find((c) => album(c.album) === album(song.album)) ?? candidates[0])?.id ?? null;
      asked.set(key, found);
      return found;
    },
  };
}

export type FavoriteRound = {
  /** Hearts to put on and take off on the phone. */
  add: string[];
  remove: string[];
  /**
   * The server song ids both sides hold now (kept for the next round). A heart on a song the phone does not have is
   * left out: were it kept, the song arriving later without a heart would look like the heart taken off.
   */
  state: string[];
  addedOnServer: number;
  removedOnServer: number;
};

export async function syncFavorites(
  client: Pick<Jellyfin, "favoriteSongs" | "setFavorite" | "searchSongs">,
  session: Session,
  local: string[],
  library: LocalSong[],
  manifest: Manifest,
  base: string[] | null,
): Promise<FavoriteRound> {
  const match = songMatcher(client, session, library, manifest);
  const remote = await client.favoriteSongs(session);
  const remoteIds = remote.map((s) => s.id);
  const phoneOf = new Map<string, string>();
  for (const song of remote) {
    const mine = match.localFor(song);
    if (mine) phoneOf.set(song.id, mine);
  }
  const localOnServer = new Map<string, string>(); // server id -> phone id
  const loved = new Set(local);
  const reverse = new Map([...phoneOf].map(([server, phone]) => [phone, server]));
  for (const id of local) {
    const server = reverse.get(id) ?? (await match.serverFor(id));
    if (server) localOnServer.set(server, id);
  }
  // A heart the phone cannot show (it has no such song) counts as held, so it is not taken for removed here.
  const unholdable = remoteIds.filter((id) => !phoneOf.has(id));
  // And one agreed last time whose phone song could not be matched just now is left as it was on both sides.
  const unsure = (base ?? []).filter((id) => !localOnServer.has(id) && phoneOf.has(id) && loved.has(phoneOf.get(id)!));
  const merged = mergeSongs(base, [...new Set([...localOnServer.keys(), ...unholdable, ...unsure])], remoteIds);
  const agreed = new Set(merged);
  const onServer = new Set(remoteIds);
  const toServer = merged.filter((id) => !onServer.has(id));
  const offServer = remoteIds.filter((id) => !agreed.has(id));
  for (const id of toServer) await client.setFavorite(session, id, true);
  for (const id of offServer) await client.setFavorite(session, id, false);
  const add = merged.flatMap((id) => {
    const phone = localOnServer.get(id) ?? phoneOf.get(id);
    return phone && !loved.has(phone) ? [phone] : [];
  });
  // Off the phone: only hearts the server was agreed to hold and no longer does.
  const remove = (base ?? []).filter((id) => !agreed.has(id)).flatMap((id) => {
    const phone = localOnServer.get(id) ?? phoneOf.get(id);
    return phone && loved.has(phone) ? [phone] : [];
  });
  const held = merged.filter((id) => localOnServer.has(id) || phoneOf.has(id));
  return { add: [...new Set(add)], remove: [...new Set(remove)], state: held, addedOnServer: toServer.length, removedOnServer: offServer.length };
}

/** Counts on the server the songs played here since `since` (`stats`: song -> [times, when last]). Returns the new `since`. */
export async function sendPlays(
  client: Pick<Jellyfin, "markPlayed" | "searchSongs">,
  session: Session,
  stats: Record<string, [number, number] | number[]>,
  library: LocalSong[],
  manifest: Manifest,
  since: number | null,
): Promise<number> {
  const match = songMatcher(client, session, library, manifest);
  let plays = Object.entries(stats)
    .map(([id, entry]) => ({ id, at: Number(entry[1] ?? 0) }))
    .filter((p) => p.at > (since ?? 0))
    .sort((a, b) => a.at - b.at);
  if (since === null) plays = plays.slice(-FIRST_PLAYS);
  let sent = since ?? 0;
  for (const play of plays) {
    const server = await match.serverFor(play.id);
    if (server) await client.markPlayed(session, server, new Date(play.at));
    sent = Math.max(sent, play.at);
  }
  return sent;
}
