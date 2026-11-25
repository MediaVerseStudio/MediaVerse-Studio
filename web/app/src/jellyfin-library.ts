// The Jellyfin server alone as the music library (owner, 2026-11-23, D173): the songs, covers and lyrics come from the server, nothing is read from a folder.
// The program's lists were written for files, so a song of the server is given a name that looks enough like a path (`jellyfin:<album id>/<song id>`): every view
// that groups by folder then groups by album, and favorites, playlists, flags and history keep working (the sidecar accepts such names, `is_server_song`).
// What needs a file (ripping, editing tags, covers, lyrics, scanning for defects) is not offered in this mode; the bridge refuses it with a plain message.

import { Jellyfin, JellyfinProblem, type LibraryItem, type ServerLyrics, type Session } from "../phone/jellyfin-phone.ts";
import type { LyricLine, TrackLyrics } from "./lyrics-format.ts";
import type { ServerHandlerSet } from "./server-routing.ts";

/** A song of the server as the library lists use it (the same fields as a track read from a folder, less what only a file has). */
export type ServerTrack = {
  album: string | null;
  album_artist: string | null;
  artist: string | null;
  genre: string | null;
  id: string;
  release_year: number | null;
  title: string;
  source_uri: string;
  suggestions: string[];
  track_number: number | null;
  length_ms: number | null;
  bitrate_kbps: number | null;
  disc_number: number | null;
  size_bytes: number | null;
  added_secs: number | null;
};

const ID = /^[0-9a-f]{32}$/i;
const PAGE = 1000;

/** `jellyfin:<album id>/<song id>`; a song with no album is its own "album" (`loose-<song id>`) so the loose songs do not pile into one. */
export function songName(item: Pick<LibraryItem, "Id" | "AlbumId">): string | null {
  if (!ID.test(item.Id)) return null;
  const id = item.Id.toLowerCase();
  const album = item.AlbumId && ID.test(item.AlbumId) ? item.AlbumId.toLowerCase() : `loose-${id}`;
  return `jellyfin:${album}/${id}`;
}

export function trackOf(item: LibraryItem): ServerTrack | null {
  const name = songName(item);
  if (!name) return null;
  const artists = (item.Artists ?? []).filter(Boolean);
  const added = item.DateCreated ? Math.floor(Date.parse(item.DateCreated) / 1000) : NaN;
  return {
    album: item.Album || null,
    album_artist: item.AlbumArtist || null,
    artist: artists[0] ?? (item.AlbumArtist || null),
    genre: item.Genres?.[0] ?? null,
    id: item.Id.toLowerCase(),
    release_year: item.ProductionYear ?? null,
    title: item.Name || "Unknown title",
    source_uri: name,
    suggestions: [],
    track_number: item.IndexNumber ?? null,
    length_ms: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000) : null,
    bitrate_kbps: null,
    disc_number: item.ParentIndexNumber ?? null,
    size_bytes: null,
    added_secs: Number.isFinite(added) ? added : null,
  };
}

/** The server's id of a song and of the picture to show for it (its album's), from the song's name. */
export function partsOf(name: string): { song: string; picture: string } | null {
  const match = /^jellyfin:([A-Za-z0-9_-]{1,64})\/([0-9a-f]{32})$/i.exec(name);
  if (!match) return null;
  const album = match[1]!;
  return { song: match[2]!.toLowerCase(), picture: album.startsWith("loose-") ? match[2]!.toLowerCase() : album.toLowerCase() };
}

/** Jellyfin's lyrics as the player takes them. */
export function lyricsReply(found: ServerLyrics | null): TrackLyrics {
  const rows = (found?.Lyrics ?? []).map((row) => ({ text: String(row.Text ?? ""), ms: typeof row.Start === "number" ? Math.round(row.Start / 10_000) : null })).filter((row) => row.text.trim() !== "");
  if (rows.length === 0) return { plain: null, synced: false, lines: [], source: null };
  const synced = rows.every((row) => row.ms !== null);
  const lines: LyricLine[] = synced ? rows.map((row) => ({ ms: row.ms as number, text: row.text })) : [];
  return { plain: rows.map((row) => row.text).join("\n"), synced, lines, source: "server" };
}

/** Every song of the server, a page at a time (`progress`: songs read so far, and how many there are). */
export async function loadServerTracks(client: Jellyfin, session: Session, progress: (read: number, total: number) => void = () => undefined): Promise<ServerTrack[]> {
  const tracks: ServerTrack[] = [];
  for (let start = 0; start < 1_000_000; start += PAGE) {
    const page = await client.audioItems(session, start, PAGE);
    for (const item of page.items) {
      const track = trackOf(item);
      if (track) tracks.push(track);
    }
    progress(start + page.items.length, page.total);
    if (page.items.length < PAGE || start + page.items.length >= page.total) break;
  }
  return tracks;
}

/** What the page's bridge needs to answer for this library: the commands that read the folder, answered from the server instead. */
export type ServerHandlers = ServerHandlerSet;

/** An error in the form the sidecar's are, so the page shows it like any other. */
function problem(thrown: unknown): { code: string; message: string } {
  if (thrown instanceof JellyfinProblem) return { code: thrown.kind === "signed_out" ? "jellyfin_signed_out" : "jellyfin_unreachable", message: thrown.message };
  return { code: "jellyfin_error", message: String((thrown as Error)?.message ?? thrown) };
}

/** The Jellyfin library is chosen but this computer is not signed in to the server: the lists are empty and the first read says what to do. */
export function signedOutHandlers(): ServerHandlers {
  const refuse = async (): Promise<never> => {
    throw { code: "jellyfin_signed_out", message: "Sign in to the Jellyfin server under Settings > Jellyfin to use it as your library." };
  };
  return {
    library_snapshot: refuse,
    rescan_collection: refuse,
    collection_status: async () => ({ root: null }),
    recent_files: async () => ({ files: [] }),
    track_cover: async () => null,
    track_artist_photo: async () => null,
    track_lyrics: async () => lyricsReply(null),
  };
}

export function serverLibraryHandlers(client: Jellyfin, session: Session, onProgress: (read: number, total: number) => void = () => undefined): { handlers: ServerHandlers; tracks: () => ServerTrack[] } {
  let loaded: Promise<ServerTrack[]> | null = null;
  let current: ServerTrack[] = [];
  const read = (force: boolean): Promise<ServerTrack[]> => {
    if (force || loaded === null) {
      loaded = loadServerTracks(client, session, onProgress).then(
        (tracks) => (current = tracks),
        (thrown) => {
          loaded = null; // asked again next time
          throw problem(thrown);
        },
      );
    }
    return loaded;
  };
  const songOf = (args: Record<string, unknown>) => partsOf(String(args.path ?? ""));
  const handlers: ServerHandlers = {
    library_snapshot: async () => ({ tracks: await read(false) }),
    rescan_collection: async () => ({ tracks: await read(true) }),
    collection_status: async () => ({ root: `Jellyfin server: ${session.name}` }),
    recent_files: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 500);
      const tracks = await read(false);
      const newest = [...tracks].filter((t) => t.added_secs !== null).sort((a, b) => (b.added_secs ?? 0) - (a.added_secs ?? 0)).slice(0, limit);
      return { files: newest.map((t) => ({ path: t.source_uri, modified: t.added_secs ?? 0 })) };
    },
    track_cover: async (args) => {
      const parts = songOf(args);
      if (!parts) return null;
      try {
        const data = await client.itemPicture(session, parts.picture);
        return data ? { mime: "image/jpeg", data_base64: data, from: "server" } : null;
      } catch {
        return null; // no picture is shown; the list still works
      }
    },
    track_artist_photo: async () => null,
    track_lyrics: async (args) => {
      const parts = songOf(args);
      if (!parts) return lyricsReply(null);
      try {
        return lyricsReply(await client.songLyrics(session, parts.song));
      } catch {
        return lyricsReply(null);
      }
    },
  };
  return { handlers, tracks: () => current };
}
