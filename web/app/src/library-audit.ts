// Review > Missing & copies: what the library's own tags say is missing or doubled, worked out from the songs already
// loaded (no scan, no network, nothing written). Two reports:
//  - albums whose track numbers have holes ("1, 2, 4, 5": song 3 is missing), and
//  - songs that appear more than once: real copies (same folder, or the same album twice) and the same song on other
//    albums (a best-of, a compilation), which is often right.
// Compilations and mixes are marked, because a folder of picked songs has holes on purpose.

import { artistKey, artistOf, type LibrarySong } from "./library-format.ts";

export type MissingAlbum = {
  folder: string;
  /** One song of the album, for opening its folder. */
  sample: string;
  album: string;
  artist: string;
  disc: number;
  /** Songs on this disc that have a track number. */
  have: number;
  /** The highest track number found. */
  last: number;
  missing: number[];
  compilation: boolean;
};

export type CopyFile = { path: string; album: string; folder: string; lengthMs: number | null; bytes: number | null; kbps: number | null; track: number | null };
export type CopyGroup = {
  title: string;
  artist: string;
  /** `copies`: the same folder, or the same album twice. `elsewhere`: the same song on different albums. */
  kind: "copies" | "elsewhere";
  /** Every file has the same size and length: very probably the same file twice. */
  identical: boolean;
  files: CopyFile[];
};

export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

const VARIOUS = /^(various|various artists|va|v\.a\.|soundtrack|original soundtrack|ost)$/i;

/** Songs of an album by many artists, or filed under "Various Artists": its holes are normal. */
function isCompilation(songs: LibrarySong[]): boolean {
  if (songs.some((s) => VARIOUS.test((s.album_artist ?? "").trim()))) return true;
  const albumArtists = new Set(songs.map((s) => artistKey(s.album_artist ?? "")).filter(Boolean));
  if (albumArtists.size === 1) return false;
  return new Set(songs.map((s) => artistKey(s.artist ?? ""))).size > 3;
}

const MOST_HOLES = 20;
const MOST_TRACKS = 99;

/**
 * Albums (a folder and disc) whose track numbers skip some: "track 3 is missing". Needs at least two numbered songs, most
 * songs numbered, and not an implausible number of holes (a folder of a few songs numbered 1, 12, 40 is a hand-picked
 * folder, not an album missing songs). Fewest missing first: one gap in twelve songs is the likeliest real loss.
 */
export function findMissingTracks(songs: LibrarySong[]): MissingAlbum[] {
  const byDisc = new Map<string, LibrarySong[]>();
  for (const song of songs) {
    const key = `${folderOf(song.source_uri)}\u0000${song.disc_number && song.disc_number > 0 ? song.disc_number : 1}`;
    const list = byDisc.get(key);
    if (list) list.push(song);
    else byDisc.set(key, [song]);
  }
  const found: MissingAlbum[] = [];
  for (const [key, group] of byDisc) {
    const numbered = group.filter((s) => s.track_number && s.track_number > 0 && s.track_number <= MOST_TRACKS);
    if (numbered.length < 2 || numbered.length * 10 < group.length * 6) continue;
    const present = new Set(numbered.map((s) => s.track_number as number));
    const last = Math.max(...present);
    const missing: number[] = [];
    for (let n = 1; n <= last; n += 1) if (!present.has(n)) missing.push(n);
    if (!missing.length || missing.length > MOST_HOLES || missing.length > present.size) continue;
    const [folder, disc] = key.split("\u0000");
    const first = group[0];
    found.push({
      folder,
      sample: first.source_uri,
      disc: Number(disc),
      album: first.album?.trim() || "Unknown album",
      artist: artistOf(first),
      have: present.size,
      last,
      missing,
      compilation: isCompilation(group),
    });
  }
  return found.sort((a, b) => a.missing.length - b.missing.length || a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.disc - b.disc);
}

/** A title reduced for comparing: no case, accents or punctuation. Brackets are kept, so "(Live)" is a different song. */
export function titleKey(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^\p{L}\p{N}()[\]]+/gu, " ")
    .trim();
}

/** Titles that say nothing ("Track 4", "Untitled", "Unknown"): two of them are not the same song. */
function isPlaceholderTitle(title: string): boolean {
  const key = titleKey(title);
  return key === "" || /^(track|audio track|song|untitled|unknown|no title)( \d+)?$/.test(key) || /^\d+$/.test(key);
}

const SAME_LENGTH_MS = 3000;

/** Songs split into groups whose lengths follow each other within three seconds (a song and its copy). */
function byLength(files: LibrarySong[]): LibrarySong[][] {
  const known = files.filter((f) => typeof f.length_ms === "number").sort((a, b) => (a.length_ms as number) - (b.length_ms as number));
  const unknown = files.filter((f) => typeof f.length_ms !== "number");
  const groups: LibrarySong[][] = [];
  for (const file of known) {
    const group = groups[groups.length - 1];
    if (group && (file.length_ms as number) - (group[group.length - 1].length_ms as number) <= SAME_LENGTH_MS) group.push(file);
    else groups.push([file]);
  }
  if (unknown.length) groups.push(unknown);
  return groups;
}

function toCopyFile(song: LibrarySong): CopyFile {
  return {
    path: song.source_uri,
    album: song.album?.trim() || "Unknown album",
    folder: folderOf(song.source_uri),
    lengthMs: song.length_ms ?? null,
    bytes: song.size_bytes ?? null,
    kbps: song.bitrate_kbps ?? null,
    track: song.track_number ?? null,
  };
}

/**
 * Songs found more than once: the same artist and title, with lengths within three seconds. Real copies (two in a
 * folder, or the same album in two folders) come first, the very same file first of those; then the same song on other
 * albums. Placeholder titles are never compared.
 */
export function findCopies(songs: LibrarySong[]): CopyGroup[] {
  const byTitle = new Map<string, LibrarySong[]>();
  for (const song of songs) {
    if (isPlaceholderTitle(song.title)) continue;
    const key = `${artistKey(song.artist ?? song.album_artist ?? "")}\u0000${titleKey(song.title)}`;
    const list = byTitle.get(key);
    if (list) list.push(song);
    else byTitle.set(key, [song]);
  }
  const groups: CopyGroup[] = [];
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    for (const group of byLength(same)) {
      if (group.length < 2) continue;
      const folders = group.map((s) => folderOf(s.source_uri));
      const albums = group.map((s) => `${artistKey(artistOf(s))}\u0000${titleKey(s.album ?? "")}`);
      const sameFolder = new Set(folders).size < folders.length;
      const sameAlbum = new Set(albums).size < albums.length && !albums.every((a) => a.endsWith("\u0000"));
      const sizes = group.map((s) => s.size_bytes);
      const identical = sizes.every((b) => typeof b === "number" && b === sizes[0]) && new Set(group.map((s) => s.length_ms)).size === 1;
      groups.push({
        title: group[0].title,
        artist: group[0].artist?.trim() || artistOf(group[0]),
        kind: sameFolder || sameAlbum ? "copies" : "elsewhere",
        identical,
        files: group.map(toCopyFile),
      });
    }
  }
  const rank = (g: CopyGroup): number => (g.kind === "copies" ? (g.identical ? 0 : 1) : 2);
  return groups.sort((a, b) => rank(a) - rank(b) || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
}

/** "Track 3 is missing" / "Tracks 3 and 7 are missing" / "Tracks 3, 4 and 9 are missing". */
export function describeMissing(album: MissingAlbum): string {
  const numbers = album.missing.map(String);
  const list = numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
  return numbers.length === 1 ? `Track ${list} is missing` : `Tracks ${list} are missing`;
}
