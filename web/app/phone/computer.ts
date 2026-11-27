// The phone's side of keeping in step with MediaVerse Studio on a computer over Wi-Fi (D214), with no server needed.
// It answers the same questions the Jellyfin client does (songs, artists, albums, playlists, favorites), so the rules
// that keep music, playlists and hearts in step (home-sync.ts, phone-playlist-sync.ts, profile-sync.ts) work for both.
// The computer's side is web/app/electron/share-sync.js. Pure, with the HTTP passed in, so it is unit tested.

import { songKey, type Flag } from "./flags.ts";
import { syncFavorites, type LocalSong } from "./profile-sync.ts";
import type { Manifest } from "./home-sync.ts";
import { JellyfinProblem, type Http, type HttpReply, type ServerAlbum, type ServerArtist, type ServerPlaylist, type ServerSong, type Session, type SyncSong } from "./jellyfin-phone.ts";

export const COMPUTER_PORT = 47700;
export const COMPUTER_STORE = "mediaverse.phone.computer";
/** The song list is asked for again after this long (one round of syncing asks for it several times). */
const LIST_FOR_MS = 60_000;

/** One song as the computer lists it. */
export type ComputerTrack = { id: string; title: string; artist: string; album_artist: string; album: string; track: number | null; disc: number | null; year: number | null; duration_ms: number; ext: string; size: number; etag: string };
/** `unavailable`: marked songs whose file the computer cannot read just now. `partial`: a playlist holding songs it cannot name. */
export type ComputerState = { favorites: string[]; flagged: string[]; unavailable?: string[]; playlists: Array<{ id: string; name: string; ids: string[]; partial?: boolean }> };
type Listed = ServerSong & { artists: string[] };

const lower = (text: string): string => text.trim().toLocaleLowerCase();
const byWho = (t: ComputerTrack): string => t.album_artist || t.artist;
export const artistId = (name: string): string => `artist:${lower(name)}`;
export const albumId = (t: Pick<ComputerTrack, "album" | "album_artist" | "artist">): string => `album:${lower(t.album_artist || t.artist)}\u001f${lower(t.album)}`;

const asServerSong = (t: ComputerTrack): Listed => ({ id: t.id, title: t.title, artist: t.artist || t.album_artist, album: t.album, artists: [...new Set([t.artist, t.album_artist].filter(Boolean))], durationMs: t.duration_ms, entryId: t.id });
const asSyncSong = (t: ComputerTrack): SyncSong => ({ id: t.id, title: t.title, artist: t.artist || t.album_artist, albumArtist: byWho(t), album: t.album, albumId: albumId(t), track: t.track, disc: t.disc, year: t.year, container: t.ext, size: t.size, etag: t.etag, durationMs: t.duration_ms });
const sortAlbumOrder = (a: ComputerTrack, b: ComputerTrack): number => byWho(a).localeCompare(byWho(b)) || a.album.localeCompare(b.album) || (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 0) - (b.track ?? 0);

/** "192.168.1.20", with or without a port or "http://", as the computer's address. */
export function computerBase(host: string): string | null {
  const clean = host.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!clean || /\s/.test(clean)) return null;
  return /:\d+$/.test(clean) ? `http://${clean}` : `http://${clean}:${COMPUTER_PORT}`;
}

export class Computer {
  private http: Http;
  private listed: { key: string; at: number; tracks: ComputerTrack[]; uploads: boolean } | null = null;
  constructor(http: Http) {
    this.http = http;
  }

  private async call<T>(base: string, path: string, options: { key?: string; body?: unknown; timeout?: number } = {}): Promise<T> {
    let reply: HttpReply;
    try {
      reply = await this.http({
        method: options.body === undefined ? "GET" : "POST",
        url: `${base}${path}`,
        headers: { ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        timeout: options.timeout,
      });
    } catch {
      throw new JellyfinProblem("The computer did not answer.", "unreachable");
    }
    if (reply.status === -1 || reply.status === -2) throw new JellyfinProblem("The computer did not answer.", "unreachable");
    let answer: { message?: string } | null = null;
    try {
      answer = reply.body ? (JSON.parse(reply.body) as { message?: string }) : null;
    } catch {
      /* a plain-text answer */
    }
    const said = answer?.message ?? (answer ? "" : reply.body);
    // 401 with a key: the phone was removed on the computer. 403 "not a phone": paired some other way.
    if (options.key && (reply.status === 401 || reply.status === 403)) throw new JellyfinProblem(said || "The computer no longer accepts this phone. Pair it again.", "signed_out");
    if (reply.status < 200 || reply.status >= 300) throw new JellyfinProblem(said || `The computer answered with an error (${reply.status}).`, "other");
    return answer as T;
  }

  /** The computer's name when MediaVerse Studio is sharing at this address, else null. */
  async hello(base: string, timeout = 3_000): Promise<{ base: string; name: string } | null> {
    try {
      const info = await this.call<{ app?: string; computer?: string }>(base, "/api/hello", { timeout });
      return info?.app === "MediaVerse Studio" ? { base, name: info.computer || "Computer" } : null;
    } catch {
      return null;
    }
  }

  /** Asks to pair: the computer then shows a code (someone must have pressed "Pair a TV or phone" there). */
  async startPairing(base: string, device: string): Promise<void> {
    await this.call(base, `/api/pair?kind=phone&name=${encodeURIComponent(device)}`, { timeout: 8_000 });
  }

  async confirmPairing(base: string, name: string, code: string): Promise<Session> {
    const reply = await this.call<{ key: string }>(base, `/api/pair/confirm?code=${encodeURIComponent(code.replace(/\D/g, ""))}`, { timeout: 8_000 });
    this.listed = null;
    return { base, name, serverId: name, userId: "computer", token: reply.key };
  }

  async probe(base: string, timeout = 3_000): Promise<{ base: string; name: string; id: string; version: string } | null> {
    const found = await this.hello(base, timeout);
    // Asked at the start of every round: the round then reads the songs as they are now.
    this.listed = null;
    return found ? { base, name: found.name, id: found.name, version: "" } : null;
  }

  async list(session: Session, fresh = false): Promise<ComputerTrack[]> {
    const key = `${session.base} ${session.token}`;
    if (!fresh && this.listed?.key === key && Date.now() - this.listed.at < LIST_FOR_MS) return this.listed.tracks;
    const reply = await this.call<{ tracks: ComputerTrack[]; uploads?: boolean }>(session.base, "/api/sync/library", { key: session.token, timeout: 60_000 });
    this.listed = { key, at: Date.now(), tracks: reply.tracks, uploads: reply.uploads === true };
    return reply.tracks;
  }

  /** Whether the computer takes new music from phones, as of the last list. */
  takesUploads(): boolean {
    return this.listed?.uploads === true;
  }

  state(session: Session): Promise<ComputerState> {
    return this.call<ComputerState>(session.base, "/api/sync/state", { key: session.token, timeout: 30_000 });
  }

  private async change(session: Session, action: string, body: unknown): Promise<{ id?: string }> {
    return this.call<{ id?: string }>(session.base, `/api/sync/${action}`, { key: session.token, body, timeout: 30_000 });
  }

  /** Where one song's file is fetched from. */
  songRequest(session: Session, songId: string): { url: string; headers: Record<string, string> } {
    return { url: `${session.base}/api/audio/${songId}`, headers: { Authorization: `Bearer ${session.token}` } };
  }

  async songsFor(session: Session, source: { kind: "all" | "artist" | "appears" | "album" | "playlist"; id?: string }): Promise<SyncSong[]> {
    const tracks = await this.list(session);
    if (source.kind === "playlist") {
      const found = (await this.state(session)).playlists.find((p) => p.id === source.id);
      // A playlist that is gone must not look like an empty one: an error keeps its songs on the phone.
      if (!found) throw new JellyfinProblem("A chosen playlist is no longer on the computer. Untick it under Playlists.", "other");
      const byId = new Map(tracks.map((t) => [t.id, t]));
      return found.ids.flatMap((id) => (byId.has(id) ? [asSyncSong(byId.get(id)!)] : []));
    }
    const chosen = tracks.filter((t) => {
      if (source.kind === "all") return true;
      if (source.kind === "artist") return artistId(byWho(t)) === source.id;
      if (source.kind === "appears") return artistId(t.artist) === source.id && artistId(byWho(t)) !== source.id;
      return albumId(t) === source.id;
    });
    return [...chosen].sort(sortAlbumOrder).map(asSyncSong);
  }

  private static artistsFrom(names: string[]): ServerArtist[] {
    const found = new Map<string, string>();
    for (const name of names) if (name && !found.has(artistId(name))) found.set(artistId(name), name);
    return [...found].map(([id, name]) => ({ id, name, imageTag: null, musicBrainzId: null })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async albumArtists(session: Session): Promise<ServerArtist[]> {
    return Computer.artistsFrom((await this.list(session)).map(byWho));
  }

  async guestArtists(session: Session, albumArtists: ServerArtist[]): Promise<ServerArtist[]> {
    const own = new Set(albumArtists.map((a) => a.id));
    return Computer.artistsFrom((await this.list(session)).map((t) => t.artist)).filter((a) => !own.has(a.id));
  }

  async albums(session: Session, artist?: string): Promise<ServerAlbum[]> {
    const found = new Map<string, ServerAlbum>();
    for (const t of await this.list(session)) {
      if (!t.album || (artist && artistId(byWho(t)) !== artist)) continue;
      const id = albumId(t);
      const album = found.get(id);
      if (album) album.songs = (album.songs ?? 0) + 1;
      else found.set(id, { id, title: t.album, artist: byWho(t), year: t.year, songs: 1 });
    }
    return [...found.values()].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title));
  }

  async playlists(session: Session): Promise<ServerPlaylist[]> {
    return (await this.state(session)).playlists.map((p) => ({ id: p.id, name: p.name }));
  }

  async playlistSongs(session: Session, id: string): Promise<Listed[]> {
    const [tracks, state] = [await this.list(session), await this.state(session)];
    const list = state.playlists.find((p) => p.id === id);
    if (!list) throw new JellyfinProblem("That playlist is no longer on the computer.", "other");
    // An error leaves it as it is on both sides: its missing songs must not look taken off.
    if (list.partial) throw new JellyfinProblem("Some of its songs cannot be found on the computer just now, so it is left as it is.", "other");
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return list.ids.flatMap((song) => (byId.has(song) ? [asServerSong(byId.get(song)!)] : []));
  }

  async createPlaylist(session: Session, name: string, songIds: string[]): Promise<string> {
    return (await this.change(session, "playlist/create", { name, ids: songIds })).id ?? "";
  }

  async addToPlaylist(session: Session, playlistId: string, songIds: string[]): Promise<void> {
    if (songIds.length) await this.change(session, "playlist/edit", { id: playlistId, add: songIds });
  }

  async removeFromPlaylist(session: Session, playlistId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length) await this.change(session, "playlist/edit", { id: playlistId, remove: entryIds });
  }

  async deletePlaylist(session: Session, playlistId: string): Promise<void> {
    await this.change(session, "playlist/delete", { id: playlistId });
  }

  async searchSongs(session: Session, term: string): Promise<Listed[]> {
    const wanted = songKey({ title: term, artist: "" });
    return (await this.list(session)).filter((t) => songKey({ title: t.title, artist: "" }) === wanted).slice(0, 60).map(asServerSong);
  }

  private async marked(session: Session, which: "favorites" | "flagged"): Promise<Listed[]> {
    const [tracks, state] = [await this.list(session), await this.state(session)];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return state[which].flatMap((id) => (byId.has(id) ? [asServerSong(byId.get(id)!)] : []));
  }

  favoriteSongs(session: Session): Promise<Listed[]> {
    return this.marked(session, "favorites");
  }

  async setFavorite(session: Session, songId: string, on: boolean): Promise<void> {
    await this.change(session, "favorite", { id: songId, on });
  }

  flaggedSongs(session: Session): Promise<Listed[]> {
    return this.marked(session, "flagged");
  }

  async setFlag(session: Session, songId: string, on: boolean): Promise<void> {
    await this.change(session, "flag", { id: songId, on });
  }
}

/** What the phone and the computer agreed on at the last round; null before the first. */
export type MarkState = { favorites: string[] | null; flags: string[] | null };

/**
 * One round of hearts and flags with the computer, each merged with what both held last time: one added on either side
 * stays, one removed on either side goes, and ones for songs the phone does not have are left alone.
 */
export async function syncMarks(io: { client: Computer; session: Session; favorites: string[]; flags: Flag[]; library: LocalSong[]; manifest: Manifest; state: MarkState; /** False: flags only. */ hearts?: boolean }): Promise<{ favoritesAdd: string[]; favoritesRemove: string[]; flagsAdd: string[]; flagsRemove: string[]; state: MarkState; sentFavorites: number; sentFlags: number }> {
  const { client, session, library, manifest } = io;
  await client.list(session, true); // what the computer has now
  // Songs the computer cannot read just now take no part: neither taken off here nor sent there.
  const away = new Set((await client.state(session)).unavailable ?? []);
  const awayHere = new Set(Object.values(manifest.files).flatMap((f) => (away.has(f.id) && f.mediaId ? [f.mediaId] : [])));
  const here = (list: string[]): string[] => list.filter((id) => !awayHere.has(id));
  const agreed = (list: string[] | null): string[] | null => list?.filter((id) => !away.has(id)) ?? null;
  const hearts = io.hearts === false ? { add: [], remove: [], state: io.state.favorites, addedOnServer: 0 } : await syncFavorites(client, session, here(io.favorites), library, manifest, agreed(io.state.favorites));
  const asFavorites = { favoriteSongs: (s: Session) => client.flaggedSongs(s), setFavorite: (s: Session, id: string, on: boolean) => client.setFlag(s, id, on), searchSongs: (s: Session, term: string) => client.searchSongs(s, term) };
  const flagged = await syncFavorites(asFavorites, session, here(io.flags.map((f) => f.id)), library, manifest, agreed(io.state.flags));
  return {
    favoritesAdd: hearts.add,
    favoritesRemove: hearts.remove,
    flagsAdd: flagged.add,
    flagsRemove: flagged.remove,
    state: { favorites: hearts.state, flags: flagged.state },
    sentFavorites: hearts.addedOnServer,
    sentFlags: flagged.addedOnServer,
  };
}

export function savedComputer(storage: Pick<Storage, "getItem"> = localStorage): Session | null {
  try {
    const saved = JSON.parse(storage.getItem(COMPUTER_STORE) ?? "null") as Session | null;
    return saved && typeof saved.base === "string" && typeof saved.token === "string" ? saved : null;
  } catch {
    return null;
  }
}

export function saveComputer(session: Session | null, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (session) storage.setItem(COMPUTER_STORE, JSON.stringify(session));
    else storage.removeItem(COMPUTER_STORE);
  } catch {
    /* paired again next time */
  }
}
