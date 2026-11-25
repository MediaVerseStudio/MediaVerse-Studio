// The library's sorting, grouping and formatting rules (the Windows Media Player-style library, D52), kept apart from
// the page so they can be tested.

export type LibrarySong = {
  album: string | null;
  album_artist: string | null;
  artist: string | null;
  genre: string | null;
  release_year: number | null;
  title: string;
  source_uri: string;
  track_number: number | null;
  length_ms?: number | null;
  bitrate_kbps?: number | null;
  disc_number?: number | null;
  size_bytes?: number | null;
  added_secs?: number | null;
};

/** The name a song is filed under on the artist wall: its album artist, else its artist. */
export function artistOf(song: LibrarySong): string {
  return song.album_artist?.trim() || song.artist?.trim() || "Unknown artist";
}

/** One key for an artist however the name is spelt: capitals, accents and the kind of apostrophe do not matter. */
export function artistKey(name: string): string {
  return sortKey(name, false).replace(/[‘’`]/g, "'");
}

const ARTICLE = /^(the|a|an)\s+(?=\S)/i;

/** The key a name sorts by: without accents and case, and (when asked) without a leading "The", "A" or "An". */
export function sortKey(name: string, ignoreArticles: boolean): string {
  const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (ignoreArticles ? plain.replace(ARTICLE, "") : plain).toLocaleLowerCase();
}

export function compareNames(left: string, right: string, ignoreArticles: boolean): number {
  return sortKey(left, ignoreArticles).localeCompare(sortKey(right, ignoreArticles), undefined, { numeric: true });
}

/** The letter heading a name is grouped under: A to Z, or "#" for numbers and symbols. */
export function letterOf(name: string, ignoreArticles: boolean): string {
  const first = sortKey(name, ignoreArticles).charAt(0).toLocaleUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}

export type AlbumGroup = { name: string; year: number | null; genre: string | null; songs: LibrarySong[]; lengthMs: number };
export type ArtistGroup = { name: string; songs: LibrarySong[]; albums: AlbumGroup[]; lengthMs: number; genre: string | null };
export type LetterGroup = { letter: string; artists: ArtistGroup[] };

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [value, count] of counts) {
    if (count > most) [best, most] = [value, count];
  }
  return best;
}

export function totalLength(songs: LibrarySong[]): number {
  return songs.reduce((sum, song) => sum + (song.length_ms ?? 0), 0);
}

export type AlbumOrder = "year-asc" | "year-desc" | "name";

/** An artist's albums, in the chosen order (albums without a year come last when ordered by year). */
export function albumsOf(songs: LibrarySong[], order: AlbumOrder, ignoreArticles: boolean): AlbumGroup[] {
  const byName = new Map<string, LibrarySong[]>();
  for (const song of songs) {
    const name = song.album?.trim() || "Unknown album";
    const list = byName.get(name);
    if (list) list.push(song);
    else byName.set(name, [song]);
  }
  const albums = [...byName].map(([name, list]) => {
    const years = list.map((s) => s.release_year).filter((y): y is number => y !== null);
    return { name, year: years.length ? Math.min(...years) : null, genre: mostCommon(list.map((s) => s.genre)), songs: list, lengthMs: totalLength(list) };
  });
  const byYear = (a: AlbumGroup, b: AlbumGroup, direction: number) =>
    a.year === b.year ? compareNames(a.name, b.name, ignoreArticles) : a.year === null ? 1 : b.year === null ? -1 : direction * (a.year - b.year);
  return albums.sort((a, b) => (order === "name" ? compareNames(a.name, b.name, ignoreArticles) : byYear(a, b, order === "year-asc" ? 1 : -1)));
}

/** Every artist, sorted and grouped under letter headings. `filter` keeps artists whose name contains it. */
export function artistWall(songs: LibrarySong[], ignoreArticles: boolean, filter = ""): LetterGroup[] {
  // Names that differ only in capitals, accents or the kind of apostrophe are one artist ("Alice in Chains" and
  // "Alice In Chains"; owner's library, 2026-11-05), shown with the spelling most of their songs use.
  const byKey = new Map<string, LibrarySong[]>();
  for (const song of songs) {
    const key = artistKey(artistOf(song));
    const list = byKey.get(key);
    if (list) list.push(song);
    else byKey.set(key, [song]);
  }
  const byArtist = new Map<string, LibrarySong[]>();
  for (const list of byKey.values()) byArtist.set(mostCommon(list.map(artistOf)) ?? artistOf(list[0]), list);
  const wanted = sortKey(filter, false);
  const artists = [...byArtist]
    .filter(([name]) => !wanted || sortKey(name, false).includes(wanted))
    .sort(([a], [b]) => compareNames(a, b, ignoreArticles))
    .map(([name, list]) => ({ name, songs: list, albums: albumsOf(list, "year-asc", ignoreArticles), lengthMs: totalLength(list), genre: mostCommon(list.map((s) => s.genre)) }));
  const groups: LetterGroup[] = [];
  for (const artist of artists) {
    const letter = letterOf(artist.name, ignoreArticles);
    const last = groups.at(-1);
    if (last?.letter === letter) last.artists.push(artist);
    else groups.push({ letter, artists: [artist] });
  }
  return groups;
}

/**
 * A credit without its guests: "Band feat. Singer", "Band (ft. Singer)", "Band featuring Singer" are "Band". "&",
 * "and" and "with" stay: they are often part of a band's name (Me First & The Gimme Gimmes). Same rule as the TV's.
 */
export function withoutFeatured(credit: string): string {
  const cut = credit.replace(/\s*[([]\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]\s*$/i, "").replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, "");
  return cut.trim() || credit.trim();
}

/**
 * The artist a song credits when that is not who it is filed under (owner, 2026-11-10): a song on a Various Artists
 * compilation is filed under "Various Artists" but credits its own band. Null when it is filed under its own artist.
 */
export function guestOf(song: LibrarySong): string | null {
  const credit = song.artist?.trim();
  if (!credit) return null;
  const name = withoutFeatured(credit);
  return artistKey(name) === artistKey(artistOf(song)) ? null : name;
}

/** The songs on other artists' albums (compilations) that credit this artist (an `artistKey`). */
export function alsoAppearsOn<T extends LibrarySong>(songs: T[], key: string): T[] {
  return songs.filter((song) => {
    const guest = guestOf(song);
    return guest !== null && artistKey(guest) === key;
  });
}

/**
 * Artists who are on the library only as guests, never as an album artist (a band that is on compilations only).
 * They are not on the artists wall (owner, 2026-11-10) but a search finds them, and their page lists the albums.
 */
export function guestArtists(songs: LibrarySong[], ignoreArticles: boolean, filter = ""): ArtistGroup[] {
  const filed = new Set(songs.map((song) => artistKey(artistOf(song))));
  const byKey = new Map<string, { names: string[]; songs: LibrarySong[] }>();
  for (const song of songs) {
    const guest = guestOf(song);
    if (guest === null) continue;
    const key = artistKey(guest);
    if (filed.has(key)) continue;
    const entry = byKey.get(key);
    if (entry) {
      entry.names.push(guest);
      entry.songs.push(song);
    } else byKey.set(key, { names: [guest], songs: [song] });
  }
  const wanted = sortKey(filter, false);
  return [...byKey.values()]
    .map((entry) => ({ name: mostCommon(entry.names) ?? entry.names[0], songs: entry.songs }))
    .filter(({ name }) => !wanted || sortKey(name, false).includes(wanted))
    .sort((a, b) => compareNames(a.name, b.name, ignoreArticles))
    .map(({ name, songs: list }) => ({ name, songs: list, albums: albumsOf(list, "year-asc", ignoreArticles), lengthMs: totalLength(list), genre: mostCommon(list.map((s) => s.genre)) }));
}

export function formatLength(ms: number | null | undefined): string {
  if (!ms) return "";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** A total playing time the way Windows Media Player words it: "71 minutes", "6.6 hours". */
export function formatTotal(ms: number): string {
  if (ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${(ms / 3_600_000).toFixed(1)} hours`;
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDate(secs: number | null | undefined): string {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The columns the song list can show. */
export type ColumnId = "number" | "title" | "length" | "artist" | "album_artist" | "genre" | "year" | "bitrate" | "size" | "added" | "disc" | "type";

export const COLUMNS: { id: ColumnId; label: string; width: number; numeric?: boolean }[] = [
  { id: "number", label: "#", width: 44, numeric: true },
  { id: "title", label: "Title", width: 320 },
  { id: "length", label: "Length", width: 70, numeric: true },
  { id: "artist", label: "Contributing artist", width: 210 },
  { id: "album_artist", label: "Album artist", width: 180 },
  { id: "genre", label: "Genre", width: 130 },
  { id: "year", label: "Year", width: 60, numeric: true },
  { id: "bitrate", label: "Bitrate", width: 80, numeric: true },
  { id: "size", label: "Size", width: 80, numeric: true },
  { id: "added", label: "Date added", width: 120 },
  { id: "disc", label: "Disc", width: 50, numeric: true },
  { id: "type", label: "File type", width: 70 },
];

export function cellText(song: LibrarySong, column: ColumnId): string {
  switch (column) {
    case "number": return song.track_number ? String(song.track_number) : "";
    case "title": return song.title;
    case "length": return formatLength(song.length_ms);
    case "artist": return song.artist ?? "";
    case "album_artist": return song.album_artist ?? "";
    case "genre": return song.genre ?? "";
    case "year": return song.release_year ? String(song.release_year) : "";
    case "bitrate": return song.bitrate_kbps ? `${song.bitrate_kbps} kbps` : "";
    case "size": return formatSize(song.size_bytes);
    case "added": return formatDate(song.added_secs);
    case "disc": return song.disc_number ? String(song.disc_number) : "";
    case "type": return (song.source_uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toUpperCase();
  }
}

function sortValue(song: LibrarySong, column: ColumnId): number | string | null {
  switch (column) {
    case "number": return song.disc_number || song.track_number ? (song.disc_number ?? 1) * 1000 + (song.track_number ?? 999) : null;
    case "length": return song.length_ms ?? null;
    case "year": return song.release_year;
    case "bitrate": return song.bitrate_kbps ?? null;
    case "size": return song.size_bytes ?? null;
    case "added": return song.added_secs ?? null;
    case "disc": return song.disc_number ?? null;
    default: return cellText(song, column).toLocaleLowerCase() || null;
  }
}

/** Songs ordered by a column; empty values always last, ties by track number then title. */
export function sortSongs(songs: LibrarySong[], column: ColumnId, descending = false): LibrarySong[] {
  const tie = (a: LibrarySong, b: LibrarySong) => (sortValue(a, "number") as number ?? 1e9) - (sortValue(b, "number") as number ?? 1e9) || a.title.localeCompare(b.title);
  return [...songs].sort((a, b) => {
    const x = sortValue(a, column);
    const y = sortValue(b, column);
    if (x === y || (x === null && y === null)) return tie(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return (descending ? -order : order) || tie(a, b);
  });
}
