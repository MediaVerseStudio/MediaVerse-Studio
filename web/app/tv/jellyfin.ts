// Music from a Jellyfin server on the home network (D42). Jellyfin is a free media server people run on a NAS
// or a computer; its web interface (checked against Jellyfin 12.4 on the owner's PC) lists music, streams it
// with seeking, sends covers at any size and allows the TV app's requests (CORS "*").
// Finding: like MediaVerse Studio, each address on the home network is asked (Jellyfin's own discovery uses a
// network broadcast a TV web app cannot send). Signing in: Jellyfin's Quick Connect, so nothing is typed with the
// remote: the TV shows a 6-digit code, the owner enters it in Jellyfin (profile > Quick Connect) on a phone or
// computer, and the TV is given a token of its own, which can be revoked in Jellyfin's Dashboard > Devices.

import type { LyricLine, TrackLyrics } from "../src/lyrics-format.ts";
import type { ServerTrack } from "./library.ts";

export const JELLYFIN_PORT = 8096;

export type JellyfinServer = { base: string; name: string; id: string; version: string };
export type JellyfinSession = { base: string; name: string; serverId: string; userId: string; token: string };

const STORE = "mediaverse.tv.jellyfin";
const DEVICE_STORE = "mediaverse.tv.device-id";

/** A stable ID for this TV in Jellyfin's device list. */
function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_STORE);
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(DEVICE_STORE, id);
    }
    return id;
  } catch {
    return "mediaverse-tv";
  }
}

function authHeader(token?: string): string {
  const parts = [`Client="MediaVerse Studio TV"`, `Device="Samsung TV"`, `DeviceId="${deviceId()}"`, `Version="${typeof __TV_VERSION__ === "string" ? __TV_VERSION__ : "0"}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

async function call<T>(base: string, path: string, options: { token?: string; method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const reply = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: { Authorization: authHeader(options.token), ...(options.body ? { "Content-Type": "application/json" } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    if (reply.status === 401) throw new JellyfinError("Jellyfin no longer accepts this TV. Sign in again.", "signed_out");
    if (!reply.ok) throw new JellyfinError(`Jellyfin answered with an error (${reply.status}).`, "other");
    const text = await reply.text();
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof JellyfinError) throw error;
    throw new JellyfinError("The Jellyfin server did not answer.", "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

type JellyfinErrorKind = "unreachable" | "signed_out" | "not_enabled" | "other";
export class JellyfinError extends Error {
  readonly kind: JellyfinErrorKind;
  constructor(message: string, kind: JellyfinErrorKind) {
    super(message);
    this.kind = kind;
  }
}

/** Whether a Jellyfin server answers at this address ("192.168.1.20" or with a port). */
export async function probeJellyfin(host: string, timeoutMs = 1_500): Promise<JellyfinServer | null> {
  const base = /:\d+$/.test(host) ? `http://${host}` : `http://${host}:${JELLYFIN_PORT}`;
  try {
    const info = await call<{ ServerName?: string; Id?: string; Version?: string; ProductName?: string }>(base, "/System/Info/Public", { timeoutMs });
    if (!info || !info.Id || !/jellyfin/i.test(info.ProductName ?? "")) return null;
    return { base, name: info.ServerName || host, id: info.Id, version: info.Version ?? "" };
  } catch {
    return null;
  }
}

/**
 * Quick Connect: asks the server for a code to show on the TV, then waits until the owner approves it in
 * Jellyfin (or `signal` stops it, or five minutes pass). Resolves to the signed-in session.
 */
export async function quickConnect(server: JellyfinServer, showCode: (code: string) => void, signal: { stopped: boolean }): Promise<JellyfinSession | null> {
  const enabled = await call<boolean>(server.base, "/QuickConnect/Enabled").catch(() => false);
  if (!enabled) throw new JellyfinError("Quick Connect is switched off on this Jellyfin server (Dashboard > General > Quick Connect).", "not_enabled");
  const started = await call<{ Code: string; Secret: string }>(server.base, "/QuickConnect/Initiate", { method: "POST" });
  showCode(started.Code);
  const until = Date.now() + 5 * 60_000;
  while (!signal.stopped && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const state = await call<{ Authenticated: boolean }>(server.base, `/QuickConnect/Connect?secret=${encodeURIComponent(started.Secret)}`).catch(() => null);
    if (state?.Authenticated) {
      const signedIn = await call<{ AccessToken: string; User: { Id: string } }>(server.base, "/Users/AuthenticateWithQuickConnect", { method: "POST", body: { Secret: started.Secret } });
      return { base: server.base, name: server.name, serverId: server.id, userId: signedIn.User.Id, token: signedIn.AccessToken };
    }
  }
  return null;
}

type Item = {
  Id: string;
  Name?: string;
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  Artists?: string[];
  ProductionYear?: number;
  IndexNumber?: number;
  Genres?: string[];
  ParentId?: string;
};

/** A Jellyfin song as the TV app's track: the album's ID groups songs and names the cover. */
export function trackFromItem(item: Item): ServerTrack {
  return {
    id: item.Id,
    title: item.Name || "Untitled",
    artist: item.Artists?.length ? item.Artists.join(", ") : (item.AlbumArtist ?? null),
    album: item.Album ?? null,
    album_artist: item.AlbumArtist ?? null,
    genre: item.Genres?.[0] ?? null,
    year: item.ProductionYear ?? null,
    track_number: item.IndexNumber ?? null,
    folder: item.Album ?? null,
    cover_key: item.AlbumId || item.ParentId || item.Id,
  };
}

/** Every song the signed-in user can see, a page at a time. */
export async function fetchJellyfinLibrary(session: JellyfinSession, progress?: (count: number) => void): Promise<ServerTrack[]> {
  const tracks: ServerTrack[] = [];
  const page = 2_000;
  for (let start = 0; ; start += page) {
    const reply = await call<{ Items: Item[]; TotalRecordCount: number }>(
      session.base,
      `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Genres,ProductionYear,ParentId&SortBy=AlbumArtist,Album,ParentIndexNumber,IndexNumber&StartIndex=${start}&Limit=${page}`,
      { token: session.token, timeoutMs: 60_000 },
    );
    tracks.push(...reply.Items.map(trackFromItem));
    progress?.(tracks.length);
    if (reply.Items.length < page || tracks.length >= reply.TotalRecordCount) return tracks;
  }
}

export function jellyfinAudioUrl(session: JellyfinSession, id: string): string {
  return `${session.base}/Audio/${encodeURIComponent(id)}/stream?static=true&api_key=${encodeURIComponent(session.token)}`;
}

export function jellyfinCoverUrl(session: JellyfinSession, track: ServerTrack, size: number): string {
  return `${session.base}/Items/${encodeURIComponent(track.cover_key)}/Images/Primary?maxHeight=${size}&maxWidth=${size}&quality=85`;
}

/** Jellyfin lyrics (synced lines start in ticks of 100 ns) in the app's own form. */
export function lyricsFromJellyfin(reply: { Lyrics?: Array<{ Text?: string; Start?: number }> } | null): TrackLyrics {
  const raw = reply?.Lyrics ?? [];
  const synced = raw.length > 0 && raw.every((line) => typeof line.Start === "number");
  if (synced) {
    const lines: LyricLine[] = raw.map((line) => ({ ms: Math.round((line.Start ?? 0) / 10_000), text: line.Text ?? "" }));
    return { plain: null, synced: true, lines, source: "tag" };
  }
  const plain = raw.map((line) => line.Text ?? "").join("\n").trim();
  return { plain: plain || null, synced: false, lines: [], source: plain ? "tag" : null };
}

export async function fetchJellyfinLyrics(session: JellyfinSession, id: string): Promise<TrackLyrics> {
  try {
    return lyricsFromJellyfin(await call(session.base, `/Audio/${encodeURIComponent(id)}/Lyrics`, { token: session.token }));
  } catch {
    return lyricsFromJellyfin(null);
  }
}

export function savedJellyfin(): JellyfinSession | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return saved && typeof saved.base === "string" && typeof saved.token === "string" && typeof saved.userId === "string" ? saved : null;
  } catch {
    return null;
  }
}

export function saveJellyfin(session: JellyfinSession | null): void {
  try {
    if (session) localStorage.setItem(STORE, JSON.stringify(session));
    else localStorage.removeItem(STORE);
  } catch {
    // signed in again next time
  }
}

/** The signed-in user's playlists (id and name). */
export async function jellyfinPlaylistList(session: JellyfinSession): Promise<Array<{ id: string; name: string }>> {
  const found = await call<{ Items: Array<{ Id: string; Name?: string }> }>(
    session.base,
    `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Playlist&Limit=500`,
    { token: session.token, timeoutMs: 30_000 },
  );
  return found.Items.map((item) => ({ id: item.Id, name: item.Name ?? "" }));
}

/** A playlist's songs in order; `entry` is the song's place in that playlist (what removing it needs), `id` is the song. */
export async function jellyfinPlaylistEntries(session: JellyfinSession, playlistId: string): Promise<Array<{ id: string; entry: string }>> {
  const songs = await call<{ Items: Array<{ Id: string; PlaylistItemId?: string }> }>(
    session.base,
    `/Playlists/${encodeURIComponent(playlistId)}/Items?userId=${encodeURIComponent(session.userId)}&Limit=10000`,
    { token: session.token, timeoutMs: 30_000 },
  );
  return songs.Items.map((item) => ({ id: item.Id, entry: item.PlaylistItemId ?? "" }));
}

/** The Jellyfin user's own playlists with their songs in order, in the form the Playlists tab shows. */
export async function jellyfinPlaylists(session: JellyfinSession): Promise<Array<{ id: string; name: string; updated_at: number; ids: string[] }>> {
  const lists: Array<{ id: string; name: string; updated_at: number; ids: string[] }> = [];
  for (const playlist of await jellyfinPlaylistList(session)) {
    if (isSharedFlagList(playlist.name)) continue; // the flag lists are shown as flags, not as playlists
    try {
      const entries = await jellyfinPlaylistEntries(session, playlist.id);
      lists.push({ id: playlist.id, name: playlist.name || "Untitled playlist", updated_at: 0, ids: entries.map((entry) => entry.id) });
    } catch {
      // one unreadable playlist does not hide the others
    }
  }
  return lists;
}

export async function createJellyfinPlaylist(session: JellyfinSession, name: string, songIds: string[]): Promise<string> {
  const made = await call<{ Id: string }>(session.base, "/Playlists", {
    token: session.token,
    method: "POST",
    body: { Name: name, Ids: songIds, UserId: session.userId, MediaType: "Audio" },
  });
  return made.Id;
}

/** The IDs go in the address, so long lists are sent 50 at a time. */
const inFifties = <T>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / 50) }, (_, i) => items.slice(i * 50, (i + 1) * 50));

export async function addToJellyfinPlaylist(session: JellyfinSession, playlistId: string, songIds: string[]): Promise<void> {
  for (const part of inFifties(songIds)) {
    await call(session.base, `/Playlists/${encodeURIComponent(playlistId)}/Items?ids=${part.map(encodeURIComponent).join(",")}&userId=${encodeURIComponent(session.userId)}`, {
      token: session.token,
      method: "POST",
    });
  }
}

export async function removeFromJellyfinPlaylist(session: JellyfinSession, playlistId: string, entries: string[]): Promise<void> {
  for (const part of inFifties(entries)) {
    await call(session.base, `/Playlists/${encodeURIComponent(playlistId)}/Items?entryIds=${part.map(encodeURIComponent).join(",")}`, { token: session.token, method: "DELETE" });
  }
}

/** The shared flag lists (D96): the computer's master "Problem tracks" and the devices' "Problem Playlist …" inboxes. */
export const FLAG_MASTER = "Problem tracks";
export const FLAG_INBOX_PREFIX = "Problem Playlist ";
export function isSharedFlagList(name: string): boolean {
  return name === FLAG_MASTER || name.startsWith(FLAG_INBOX_PREFIX);
}

/** The songs flagged in Jellyfin (every shared flag list), by song ID. */
export async function jellyfinFlagged(session: JellyfinSession): Promise<Set<string>> {
  const flagged = new Set<string>();
  for (const list of (await jellyfinPlaylistList(session)).filter((l) => isSharedFlagList(l.name))) {
    for (const entry of await jellyfinPlaylistEntries(session, list.id)) flagged.add(entry.id);
  }
  return flagged;
}

/**
 * Flags songs for the computer's Review page: into the master list when there is one, else into this TV's inbox
 * (made if needed; the computer folds inboxes into the master list). Songs already on a list are left alone.
 */
export async function flagInJellyfin(session: JellyfinSession, ids: string[], device: string, now: Date = new Date()): Promise<void> {
  if (!ids.length) return;
  const lists = (await jellyfinPlaylistList(session)).filter((l) => isSharedFlagList(l.name));
  const held = new Set<string>();
  for (const list of lists) for (const entry of await jellyfinPlaylistEntries(session, list.id)) held.add(entry.id);
  const wanted = [...new Set(ids)].filter((id) => !held.has(id));
  if (!wanted.length) return;
  const target = lists.find((l) => l.name === FLAG_MASTER) ?? lists.find((l) => l.name.endsWith(`(${device})`));
  if (target) {
    await addToJellyfinPlaylist(session, target.id, wanted);
    return;
  }
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  await createJellyfinPlaylist(session, `${FLAG_INBOX_PREFIX}${stamp} (${device})`, wanted);
}

/** Takes songs off every shared flag list (the song stays in the library and in other playlists). */
export async function unflagInJellyfin(session: JellyfinSession, ids: string[]): Promise<void> {
  const gone = new Set(ids);
  for (const list of (await jellyfinPlaylistList(session)).filter((l) => isSharedFlagList(l.name))) {
    const entries = (await jellyfinPlaylistEntries(session, list.id)).filter((entry) => gone.has(entry.id) && entry.entry).map((entry) => entry.entry);
    await removeFromJellyfinPlaylist(session, list.id, entries);
  }
}

/** IDs of the songs this Jellyfin user has marked as favorites. */
export async function jellyfinFavorites(session: JellyfinSession): Promise<string[]> {
  const reply = await call<{ Items: Array<{ Id: string }> }>(
    session.base,
    `/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Audio&Filters=IsFavorite&Limit=50000`,
    { token: session.token, timeoutMs: 30_000 },
  );
  return reply.Items.map((item) => item.Id);
}

/** Marks or unmarks a favorite in Jellyfin itself, so it shows in Jellyfin's own apps too. */
export async function setJellyfinFavorite(session: JellyfinSession, id: string, favorite: boolean): Promise<void> {
  await call(session.base, `/UserFavoriteItems/${encodeURIComponent(id)}?userId=${encodeURIComponent(session.userId)}`, {
    token: session.token,
    method: favorite ? "POST" : "DELETE",
  });
}
