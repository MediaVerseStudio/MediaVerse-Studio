// The phone's Jellyfin client (D96): finding the server, signing in with Quick Connect (nothing to type), searching songs
// and reading or writing playlists. The calls are the ones checked against Jellyfin 12.4 on 2026-11-14. Requests go
// through `Http`: in the app that is the native relay (apps/android HomeHttp.kt, home-network addresses only, since the
// page itself is https and may not fetch plain http); in a desktop browser it is fetch.

import type { Named } from "./flags.ts";

export const JELLYFIN_PORT = 8096;

/** `binary`: the reply's body is the answer's bytes as base64 (desktop only; used for pictures). */
export type HttpRequest = { method?: string; url: string; headers?: Record<string, string>; body?: string; timeout?: number; binary?: boolean };
export type HttpReply = { status: number; body: string };
export type Http = (request: HttpRequest) => Promise<HttpReply>;

export type Server = { base: string; name: string; id: string; version: string };
export type Session = { base: string; name: string; serverId: string; userId: string; token: string };
export type ServerSong = Named & { id: string; durationMs: number; /** Its place in a playlist (needed to remove it from that playlist), when read from one. */ entryId?: string };
export type ServerPlaylist = { id: string; name: string };
export type ServerArtist = { id: string; name: string; imageTag: string | null; musicBrainzId: string | null };
/** An album as the server lists it for choosing what to keep (`songs`: how many, when the server says). */
export type ServerAlbum = { id: string; title: string; artist: string; year: number | null; songs: number | null };
/** A song to keep on the phone: what names it, where its file is, and what changes when the file is edited (D177). */
export type SyncSong = { id: string; title: string; artist: string; albumArtist: string; album: string; albumId: string | null; track: number | null; disc: number | null; year: number | null; container: string; size: number; etag: string | null; durationMs: number };
type SyncItem = LibraryItem & { MediaSources?: Array<{ Size?: number; ETag?: string; Container?: string }>; Container?: string };

/** One song of a server answer as a [SyncSong], or null when it has no usable id. */
export function syncSongFrom(item: SyncItem): SyncSong | null {
  if (!item?.Id || !/^[0-9a-f]{32}$/i.test(item.Id)) return null;
  const source = item.MediaSources?.[0];
  const artists = (item.Artists ?? []).filter(Boolean);
  return {
    id: item.Id.toLowerCase(),
    title: item.Name ?? "",
    artist: artists[0] ?? item.AlbumArtist ?? "",
    albumArtist: item.AlbumArtist ?? artists[0] ?? "",
    album: item.Album ?? "",
    albumId: item.AlbumId ?? null,
    track: item.IndexNumber ?? null,
    disc: item.ParentIndexNumber ?? null,
    year: item.ProductionYear ?? null,
    container: String(source?.Container ?? item.Container ?? "").toLowerCase().split(",")[0] ?? "",
    size: Number(source?.Size ?? 0) || 0,
    etag: source?.ETag ?? null,
    durationMs: Math.round((item.RunTimeTicks ?? 0) / 10_000),
  };
}

/** A song as the server lists it for the library views. */
export type LibraryItem = { Id: string; Name?: string; Album?: string; AlbumId?: string; AlbumArtist?: string; Artists?: string[]; Genres?: string[]; ProductionYear?: number; IndexNumber?: number; ParentIndexNumber?: number; RunTimeTicks?: number; DateCreated?: string };
/** The server's answer for a song's lyrics: `Start` is in ticks (100 ns). */
export type ServerLyrics = { Lyrics?: Array<{ Text?: string; Start?: number }> };
type ArtistItem = { Id: string; Name?: string; ImageTags?: { Primary?: string }; ProviderIds?: { MusicBrainzArtist?: string } };

export class JellyfinProblem extends Error {
  readonly kind: "unreachable" | "signed_out" | "other" | "not_enabled";
  constructor(message: string, kind: "unreachable" | "signed_out" | "other" | "not_enabled") {
    super(message);
    this.kind = kind;
  }
}

export const STORE = "mediaverse.phone.jellyfin";

/** The Authorization header Jellyfin wants (also given to the app for fetching a song, D177). */
export function authHeader(deviceId: string, device: string, token?: string): string {
  return header(deviceId, device, token);
}

function header(deviceId: string, device: string, token?: string): string {
  const parts = [`Client="MediaVerse Studio Phone"`, `Device="${device.replace(/"/g, "")}"`, `DeviceId="${deviceId}"`, `Version="1"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

export class Jellyfin {
  private http: Http;
  private deviceId: string;
  private device: string;
  constructor(http: Http, deviceId: string, device: string) {
    this.http = http;
    this.deviceId = deviceId;
    this.device = device;
  }

  private async call<T>(base: string, path: string, options: { token?: string; method?: string; body?: unknown; timeout?: number } = {}): Promise<T> {
    let reply: HttpReply;
    try {
      reply = await this.http({
        method: options.method ?? "GET",
        url: `${base}${path}`,
        headers: { Authorization: header(this.deviceId, this.device, options.token), ...(options.body ? { "Content-Type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        timeout: options.timeout,
      });
    } catch {
      throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    }
    if (reply.status === -1 || reply.status === -2) throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    if (reply.status === 401) throw new JellyfinProblem("Jellyfin no longer accepts this phone. Sign in again.", "signed_out");
    if (reply.status < 200 || reply.status >= 300) throw new JellyfinProblem(`Jellyfin answered with an error (${reply.status}).`, "other");
    return (reply.body ? JSON.parse(reply.body) : null) as T;
  }

  /** Whether a Jellyfin server answers at this address ("192.168.1.20", or with a port). */
  async probe(host: string, timeout = 2_000): Promise<Server | null> {
    const clean = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!clean) return null;
    const base = /:\d+$/.test(clean) ? `http://${clean}` : `http://${clean}:${JELLYFIN_PORT}`;
    try {
      const info = await this.call<{ ServerName?: string; Id?: string; Version?: string; ProductName?: string }>(base, "/System/Info/Public", { timeout });
      if (!info?.Id || !/jellyfin/i.test(info.ProductName ?? "")) return null;
      return { base, name: info.ServerName || clean, id: info.Id, version: info.Version ?? "" };
    } catch {
      return null;
    }
  }

  /** Quick Connect: shows a code, waits until it is approved in Jellyfin (profile > Quick Connect), signs in. */
  async quickConnect(server: Server, showCode: (code: string) => void, signal: { stopped: boolean }, wait = 2_000): Promise<Session | null> {
    const enabled = await this.call<boolean>(server.base, "/QuickConnect/Enabled").catch(() => false);
    if (!enabled) throw new JellyfinProblem("Quick Connect is switched off on this Jellyfin server (Dashboard > General > Quick Connect).", "not_enabled");
    const started = await this.call<{ Code: string; Secret: string }>(server.base, "/QuickConnect/Initiate", { method: "POST" });
    showCode(started.Code);
    const until = Date.now() + 5 * 60_000;
    while (!signal.stopped && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const state = await this.call<{ Authenticated: boolean }>(server.base, `/QuickConnect/Connect?secret=${encodeURIComponent(started.Secret)}`).catch(() => null);
      if (state?.Authenticated) {
        const signedIn = await this.call<{ AccessToken: string; User: { Id: string } }>(server.base, "/Users/AuthenticateWithQuickConnect", { method: "POST", body: { Secret: started.Secret } });
        return { base: server.base, name: server.name, serverId: server.id, userId: signedIn.User.Id, token: signedIn.AccessToken };
      }
    }
    return null;
  }

  /** Every album artist the server holds, with the tag of its main picture (null: the server has no picture for it). */
  async albumArtists(session: Session): Promise<ServerArtist[]> {
    const found: ServerArtist[] = [];
    for (let start = 0; start < 100_000; start += 500) {
      const reply = await this.call<{ Items: ArtistItem[]; TotalRecordCount?: number }>(
        session.base,
        `/Artists/AlbumArtists?userId=${encodeURIComponent(session.userId)}&Recursive=true&Fields=ProviderIds&StartIndex=${start}&Limit=500`,
        { token: session.token, timeout: 60_000 },
      );
      for (const item of reply.Items) found.push({ id: item.Id, name: item.Name ?? "", imageTag: item.ImageTags?.Primary ?? null, musicBrainzId: item.ProviderIds?.MusicBrainzArtist ?? null });
      if (reply.Items.length < 500 || found.length >= (reply.TotalRecordCount ?? Infinity)) break;
    }
    return found;
  }

  /** Artists who appear on songs but have no album of their own on the server (compilations, guest spots): every performer minus the album artists. */
  async guestArtists(session: Session, albumArtists: ServerArtist[]): Promise<ServerArtist[]> {
    const own = new Set(albumArtists.map((a) => a.id));
    const found: ServerArtist[] = [];
    for (let start = 0; start < 200_000; start += 500) {
      const reply = await this.call<{ Items: ArtistItem[]; TotalRecordCount?: number }>(
        session.base,
        `/Artists?userId=${encodeURIComponent(session.userId)}&Recursive=true&Fields=ProviderIds&StartIndex=${start}&Limit=500`,
        { token: session.token, timeout: 60_000 },
      );
      for (const item of reply.Items) if (!own.has(item.Id)) found.push({ id: item.Id, name: item.Name ?? "", imageTag: item.ImageTags?.Primary ?? null, musicBrainzId: item.ProviderIds?.MusicBrainzArtist ?? null });
      if (reply.Items.length < 500 || start + reply.Items.length >= (reply.TotalRecordCount ?? Infinity)) break;
    }
    return found;
  }

  /** An artist's main picture as base64 (a JPEG at most `maxWidth` wide), or null when the server cannot give it. */
  async artistPhoto(session: Session, artist: ServerArtist, maxWidth = 1000): Promise<string | null> {
    if (!artist.imageTag) return null;
    let reply: HttpReply;
    try {
      reply = await this.http({
        url: `${session.base}/Items/${encodeURIComponent(artist.id)}/Images/Primary?tag=${encodeURIComponent(artist.imageTag)}&maxWidth=${maxWidth}&quality=90&format=Jpg`,
        headers: { Authorization: header(this.deviceId, this.device, session.token) },
        timeout: 30_000,
        binary: true,
      });
    } catch {
      throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    }
    if (reply.status === -1 || reply.status === -2) throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    if (reply.status === 401) throw new JellyfinProblem("Jellyfin no longer accepts this computer. Sign in again.", "signed_out");
    return reply.status >= 200 && reply.status < 300 && reply.body ? reply.body : null;
  }

  /** Songs matching a search word (the title), with every artist name the server holds for each. */
  async searchSongs(session: Session, term: string): Promise<Array<ServerSong & { artists: string[] }>> {
    const reply = await this.call<{ Items: Item[] }>(
      session.base,
      `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Album&Limit=60&SearchTerm=${encodeURIComponent(term)}`,
      { token: session.token, timeout: 20_000 },
    );
    return reply.Items.map(songFromItem);
  }

  /** Asks the server to look for changed files (Dashboard > Libraries > Scan). Needs an administrator's account; anyone else is refused (403). */
  async refreshLibrary(session: Session): Promise<void> {
    await this.call(session.base, "/Library/Refresh", { token: session.token, method: "POST", timeout: 20_000 });
  }

  /** Every song the server holds with the file it was read from (the server's own path), a page at a time. */
  async serverSongs(session: Session): Promise<Array<{ id: string; path: string }>> {
    const found: Array<{ id: string; path: string }> = [];
    for (let start = 0; start < 500_000; start += 2_000) {
      const reply = await this.call<{ Items: Array<{ Id: string; Path?: string }>; TotalRecordCount?: number }>(
        session.base,
        `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path&StartIndex=${start}&Limit=2000`,
        { token: session.token, timeout: 90_000 },
      );
      for (const item of reply.Items) if (item.Path) found.push({ id: item.Id, path: item.Path });
      if (reply.Items.length < 2_000 || found.length >= (reply.TotalRecordCount ?? Infinity)) break;
    }
    return found;
  }

  /** A page of the server's songs with what the library lists show (the server alone as the library, D173). */
  async audioItems(session: Session, start: number, limit: number): Promise<{ items: LibraryItem[]; total: number }> {
    const reply = await this.call<{ Items: LibraryItem[]; TotalRecordCount?: number }>(
      session.base,
      `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Genres,DateCreated,ProductionYear&SortBy=AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName&StartIndex=${start}&Limit=${limit}`,
      { token: session.token, timeout: 90_000 },
    );
    return { items: reply.Items, total: reply.TotalRecordCount ?? reply.Items.length };
  }

  /** A song's lyrics as the server holds them (read from a .lrc file or the file's tag), or null when it has none. */
  async songLyrics(session: Session, songId: string): Promise<ServerLyrics | null> {
    try {
      return await this.call<ServerLyrics>(session.base, `/Audio/${encodeURIComponent(songId)}/Lyrics`, { token: session.token, timeout: 20_000 });
    } catch (thrown) {
      if (thrown instanceof JellyfinProblem && thrown.kind === "other") return null; // 404: no lyrics
      throw thrown;
    }
  }

  /** An item's main picture as base64 (a JPEG at most `maxWidth` wide), or null when it has none. */
  async itemPicture(session: Session, itemId: string, maxWidth = 700): Promise<string | null> {
    let reply: HttpReply;
    try {
      reply = await this.http({
        url: `${session.base}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=${maxWidth}&quality=90&format=Jpg`,
        headers: { Authorization: header(this.deviceId, this.device, session.token) },
        timeout: 30_000,
        binary: true,
      });
    } catch {
      throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    }
    if (reply.status === -1 || reply.status === -2) throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable");
    if (reply.status === 401) throw new JellyfinProblem("Jellyfin no longer accepts this computer. Sign in again.", "signed_out");
    return reply.status >= 200 && reply.status < 300 && reply.body ? reply.body : null;
  }

  /** The albums an artist has on the server (or every album), for choosing what to keep on the phone (D177). */
  async albums(session: Session, artistId?: string): Promise<ServerAlbum[]> {
    const found: ServerAlbum[] = [];
    for (let start = 0; start < 100_000; start += 500) {
      const reply = await this.call<{ Items: Array<{ Id: string; Name?: string; AlbumArtist?: string; ProductionYear?: number; ChildCount?: number }>; TotalRecordCount?: number }>(
        session.base,
        `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=MusicAlbum&Fields=ChildCount&SortBy=ProductionYear,SortName${artistId ? `&AlbumArtistIds=${encodeURIComponent(artistId)}` : ""}&StartIndex=${start}&Limit=500`,
        { token: session.token, timeout: 60_000 },
      );
      for (const item of reply.Items) found.push({ id: item.Id, title: item.Name ?? "", artist: item.AlbumArtist ?? "", year: item.ProductionYear ?? null, songs: item.ChildCount ?? null });
      if (reply.Items.length < 500 || found.length >= (reply.TotalRecordCount ?? Infinity)) break;
    }
    return found;
  }

  /** The songs of one thing the person chose to keep (an artist, an album, a playlist, or everything), with what is needed to download and to tell when the file changed. */
  async songsFor(session: Session, source: { kind: "all" | "artist" | "appears" | "album" | "playlist"; id?: string }): Promise<SyncSong[]> {
    const fields = "MediaSources,DateCreated,ProductionYear";
    const out: SyncSong[] = [];
    for (let start = 0; start < 1_000_000; start += 500) {
      const path =
        source.kind === "playlist"
          ? `/Playlists/${encodeURIComponent(source.id ?? "")}/Items?userId=${encodeURIComponent(session.userId)}&Fields=${fields}&StartIndex=${start}&Limit=500`
          : `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=${fields}&SortBy=AlbumArtist,Album,ParentIndexNumber,IndexNumber${
              source.kind === "artist" ? `&AlbumArtistIds=${encodeURIComponent(source.id ?? "")}` : source.kind === "appears" ? `&ArtistIds=${encodeURIComponent(source.id ?? "")}` : source.kind === "album" ? `&ParentId=${encodeURIComponent(source.id ?? "")}` : ""
            }&StartIndex=${start}&Limit=500`;
      const reply = await this.call<{ Items: SyncItem[]; TotalRecordCount?: number }>(session.base, path, { token: session.token, timeout: 90_000 });
      for (const item of reply.Items) {
        const song = syncSongFrom(item);
        if (song) out.push(song);
      }
      if (reply.Items.length < 500 || start + reply.Items.length >= (reply.TotalRecordCount ?? Infinity)) break;
    }
    return out;
  }

  async playlists(session: Session): Promise<ServerPlaylist[]> {
    const reply = await this.call<{ Items: Array<{ Id: string; Name?: string }> }>(
      session.base,
      `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Playlist&Limit=500`,
      { token: session.token, timeout: 20_000 },
    );
    return reply.Items.map((item) => ({ id: item.Id, name: item.Name ?? "" }));
  }

  /** The songs in a playlist, with every artist name the server holds for each. */
  async playlistSongs(session: Session, id: string): Promise<Array<ServerSong & { artists: string[] }>> {
    const reply = await this.call<{ Items: Item[] }>(
      session.base,
      `/Playlists/${encodeURIComponent(id)}/Items?userId=${encodeURIComponent(session.userId)}&Fields=Album&Limit=5000`,
      { token: session.token, timeout: 30_000 },
    );
    return reply.Items.map(songFromItem);
  }

  /** Adds songs to an existing playlist (a song already in it is added again by Jellyfin, so callers check first). */
  async addToPlaylist(session: Session, playlistId: string, songIds: string[]): Promise<void> {
    if (!songIds.length) return;
    await this.call(session.base, `/Playlists/${encodeURIComponent(playlistId)}/Items?ids=${songIds.map(encodeURIComponent).join(",")}&userId=${encodeURIComponent(session.userId)}`, { token: session.token, method: "POST" });
  }

  /** Removes entries (each song's `entryId` in that playlist, not the song's own ID) from a playlist. */
  async removeFromPlaylist(session: Session, playlistId: string, entryIds: string[]): Promise<void> {
    if (!entryIds.length) return;
    await this.call(session.base, `/Playlists/${encodeURIComponent(playlistId)}/Items?entryIds=${entryIds.map(encodeURIComponent).join(",")}`, { token: session.token, method: "DELETE" });
  }

  /** Deletes a whole playlist (never the songs in it). */
  async deletePlaylist(session: Session, playlistId: string): Promise<void> {
    await this.call(session.base, `/Items/${encodeURIComponent(playlistId)}`, { token: session.token, method: "DELETE" });
  }

  async createPlaylist(session: Session, name: string, songIds: string[]): Promise<string> {
    const made = await this.call<{ Id: string }>(session.base, "/Playlists", {
      token: session.token,
      method: "POST",
      body: { Name: name, Ids: songIds, UserId: session.userId, MediaType: "Audio" },
    });
    return made.Id;
  }
}

type Item = { Id: string; Name?: string; Album?: string; AlbumArtist?: string; Artists?: string[]; RunTimeTicks?: number; PlaylistItemId?: string };

function songFromItem(item: Item): ServerSong & { artists: string[] } {
  const artists = [...new Set([...(item.Artists ?? []), ...(item.AlbumArtist ? [item.AlbumArtist] : [])].filter(Boolean))];
  return { id: item.Id, title: item.Name ?? "", artist: artists[0] ?? "", album: item.Album ?? "", artists, durationMs: Math.round((item.RunTimeTicks ?? 0) / 10_000), entryId: item.PlaylistItemId };
}

/** One entry per artist name, so a song credited to several artists matches under any of them. */
export function perArtist<T extends Named & { artists: string[] }>(songs: T[]): Array<T & { artist: string }> {
  return songs.flatMap((song) => (song.artists.length ? song.artists : [song.artist ?? ""]).map((artist) => ({ ...song, artist })));
}

export function savedSession(): Session | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return saved && typeof saved.base === "string" && typeof saved.token === "string" && typeof saved.userId === "string" ? saved : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(STORE, JSON.stringify(session));
    else localStorage.removeItem(STORE);
  } catch {
    // signed in again next time
  }
}
