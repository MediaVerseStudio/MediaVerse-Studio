// Pure rules of Review > Fix tags that are worth testing apart from the page.

export type Difference = { field: string; to: string };
export type ProposedFile = { path: string; differences?: Difference[] };

/**
 * "Also replace values that differ from the release": the release's spelling of each differing field is added to the
 * edits as if the person had typed it, except for files and fields the person unticked, and except where they typed
 * something else. Returns a new object; the typed edits are not changed.
 */
export function withDifferences(
  edits: Record<string, Record<string, string>>,
  files: ProposedFile[],
  skipFiles: ReadonlySet<string>,
  skipFields: ReadonlySet<string>,
): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {};
  for (const [path, fields] of Object.entries(edits)) merged[path] = { ...fields };
  for (const file of files) {
    if (skipFiles.has(file.path)) continue;
    for (const difference of file.differences ?? []) {
      if (skipFields.has(difference.field) || merged[file.path]?.[difference.field] !== undefined) continue;
      (merged[file.path] ??= {})[difference.field] = difference.to;
    }
  }
  return merged;
}

export type FoundTrack = { number: number; title: string; artist?: string | null };
export type FoundAlbum = { album: string; album_artist: string; year?: number | null; genre?: string | null; tracks: FoundTrack[] };

/**
 * "Use these details" for an album nothing identified, once the person has picked a result of the search by name: what to
 * type into every song, as edits (file path to field to value). The songs are in track order and the album's tracks line up
 * with them one to one (the search only offers albums with as many tracks as the folder has songs). Nothing is written
 * until the person presses Apply.
 */
export function editsFromFound(paths: readonly string[], found: FoundAlbum): Record<string, Record<string, string>> {
  const edits: Record<string, Record<string, string>> = {};
  if (found.tracks.length !== paths.length) return edits;
  const tracks = [...found.tracks].sort((a, b) => a.number - b.number);
  paths.forEach((path, index) => {
    const track = tracks[index];
    const fields: Record<string, string> = { title: track.title, artist: track.artist?.trim() || found.album_artist, album: found.album, album_artist: found.album_artist, track: String(index + 1) };
    if (found.year) fields.year = String(found.year);
    if (found.genre?.trim()) fields.genre = found.genre.trim();
    for (const [field, value] of Object.entries(fields)) if (value.trim() === "") delete fields[field];
    edits[path] = fields;
  });
  return edits;
}
export type SourceSong = {
  album: string | null;
  album_artist: string | null;
  artist: string | null;
  genre: string | null;
  release_year: number | null;
  title: string;
  source_uri: string;
  track_number: number | null;
  disc_number?: number | null;
};

/** One album of the library (a folder), as "Copy tags from another album" offers it. */
export type LibraryAlbum = {
  folder: string;
  artist: string;
  album: string;
  year: number | null;
  genre: string | null;
  songs: { title: string; artist: string; track: number | null; disc: number | null }[];
};

export type CopyField = "title" | "artist" | "album" | "album_artist" | "year" | "genre" | "track" | "disc";
export const COPY_FIELDS: { field: CopyField; label: string; perSong: boolean }[] = [
  { field: "title", label: "Titles", perSong: true },
  { field: "artist", label: "Artists", perSong: true },
  { field: "track", label: "Track numbers", perSong: true },
  { field: "disc", label: "Disc numbers", perSong: true },
  { field: "album", label: "Album", perSong: false },
  { field: "album_artist", label: "Album artist", perSong: false },
  { field: "year", label: "Year", perSong: false },
  { field: "genre", label: "Genre", perSong: false },
];

const folderOf = (uri: string): string => uri.replace(/[\\/][^\\/]*$/, "");
const sameFolder = (a: string, b: string): boolean => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/**
 * The albums of the library that match what was typed (every word must be in the artist or album), other than the folder
 * being tagged, those with as many songs as the folder first, at most 12.
 */
export function libraryAlbums(songs: readonly SourceSong[], query: string, exclude: string, wantCount: number): LibraryAlbum[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const byFolder = new Map<string, SourceSong[]>();
  for (const song of songs) {
    const folder = folderOf(song.source_uri);
    if (sameFolder(folder, exclude)) continue;
    (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(song);
  }
  const albums: LibraryAlbum[] = [];
  for (const [folder, list] of byFolder) {
    const first = list[0];
    const artist = (first.album_artist ?? first.artist ?? "").trim();
    const album = (first.album ?? "").trim();
    const haystack = `${artist} ${album}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const ordered = [...list].sort((a, b) => (a.disc_number ?? 1) - (b.disc_number ?? 1) || (a.track_number ?? 999) - (b.track_number ?? 999) || a.title.localeCompare(b.title));
    albums.push({
      folder,
      artist,
      album,
      year: list.find((s) => s.release_year)?.release_year ?? null,
      genre: list.find((s) => s.genre?.trim())?.genre?.trim() ?? null,
      songs: ordered.map((s) => ({ title: s.title, artist: (s.artist ?? "").trim(), track: s.track_number, disc: s.disc_number ?? null })),
    });
  }
  const rank = (a: LibraryAlbum): number => (a.songs.length === wantCount ? 0 : 1);
  return albums.sort((a, b) => rank(a) - rank(b) || `${a.artist} ${a.album}`.localeCompare(`${b.artist} ${b.album}`)).slice(0, 12);
}

/**
 * What to type into the songs of a folder to copy fields from another album: album-wide fields go on every song; the
 * per-song ones (titles, artists, track and disc numbers) only when both have the same number of songs, matched in order.
 * Nothing is written until Apply.
 */
export function editsFromAlbum(paths: readonly string[], source: LibraryAlbum, fields: ReadonlySet<CopyField>): Record<string, Record<string, string>> {
  const edits: Record<string, Record<string, string>> = {};
  const sameCount = source.songs.length === paths.length;
  paths.forEach((path, index) => {
    const out: Record<string, string> = {};
    if (fields.has("album") && source.album) out.album = source.album;
    if (fields.has("album_artist") && source.artist) out.album_artist = source.artist;
    if (fields.has("year") && source.year) out.year = String(source.year);
    if (fields.has("genre") && source.genre) out.genre = source.genre;
    if (sameCount) {
      const song = source.songs[index];
      if (fields.has("title") && song.title) out.title = song.title;
      if (fields.has("artist") && (song.artist || source.artist)) out.artist = song.artist || source.artist;
      if (fields.has("track") && song.track) out.track = String(song.track);
      if (fields.has("disc") && song.disc) out.disc = String(song.disc);
    }
    if (Object.keys(out).length) edits[path] = out;
  });
  return edits;
}
