// Which music on the phone the library does not have, and where each song goes in its incoming folder (D214, D215).
// The library is the computer's or the Jellyfin server's. A song is left out only when the library lists it under the same artist, title and album: a live or compilation version is
// another recording, and a doubtful one is better offered (it waits to be looked over) than lost with the phone.
// Pure, so it is unit tested.

import { safeName } from "./home-sync.ts";
import { songKey } from "./flags.ts";
import type { LibraryItem } from "./jellyfin-phone.ts";

export type OwnSong = { id: string; title: string; artist: string | null; album_artist?: string | null; album: string | null; file?: string; size?: number };
export type SendSong = { id: string; title: string; path: string; size: number };
export type SendAlbum = { key: string; title: string; artist: string; songs: SendSong[]; bytes: number };
/** A song as the library there names it. */
export type Listing = { title: string; artist: string; album_artist: string; album: string };

/** The largest file that is taken. */
export const MAX_SEND = 1.5 * 1024 * 1024 * 1024;
const KINDS = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|wv)$/i;

/** A folder name Windows accepts (it keeps a few names for itself). */
const folder = (text: string, fallback: string): string => {
  const name = safeName(text, fallback);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? `_${name}` : name;
};

/** "Artist/Album/file.mp3", or null when the file is not a kind of song that is taken. */
export function sendPath(song: OwnSong): string | null {
  const file = song.file ?? "";
  const kind = KINDS.exec(file)?.[1]?.toLowerCase();
  if (!kind) return null;
  const stem = folder(file.slice(0, -(kind.length + 1)), folder(song.title, "Song"));
  return `${folder(song.album_artist || song.artist || "", "Unknown artist")}/${folder(song.album ?? "", "Unknown album")}/${stem}.${kind}`;
}

const release = (artist: string, title: string, album: string): string => `${songKey({ title, artist })}\u0000${songKey({ title: album, artist: "" })}`;

/** The Jellyfin server's songs, one entry for each artist a song is credited to. */
export function serverListing(items: LibraryItem[]): Listing[] {
  return items.flatMap((item) => {
    const artists = (item.Artists ?? []).filter(Boolean);
    return (artists.length ? artists : [""]).map((artist) => ({ title: item.Name ?? "", artist, album_artist: item.AlbumArtist ?? "", album: item.Album ?? "" }));
  });
}

/** The phone's songs the library lacks, by album. `skip`: ids already sent, or fetched from there. */
export function newForLibrary(songs: OwnSong[], library: Listing[], skip: Set<string>): SendAlbum[] {
  const there = new Set(library.flatMap((t) => [t.artist, t.album_artist].filter(Boolean).map((artist) => release(artist, t.title, t.album))));
  const albums = new Map<string, SendAlbum>();
  for (const song of songs) {
    if (skip.has(song.id) || !song.size || song.size > MAX_SEND) continue;
    if ([song.artist, song.album_artist].some((artist) => artist && there.has(release(artist, song.title, song.album ?? "")))) continue;
    const path = sendPath(song);
    if (!path) continue;
    const key = path.slice(0, path.lastIndexOf("/")).toLocaleLowerCase();
    const album = albums.get(key) ?? { key, title: song.album || "Unknown album", artist: song.album_artist || song.artist || "Unknown artist", songs: [], bytes: 0 };
    album.songs.push({ id: song.id, title: song.title, path, size: song.size });
    album.bytes += song.size;
    albums.set(key, album);
  }
  return [...albums.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
}
