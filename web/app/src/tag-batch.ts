// Grouping tracks that have tag issues, and turning one shared edit into a write request per track.
// No DOM or bridge access, so it is unit tested.

export type IssueTrack = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  release_year: number | null;
  track_number: number | null;
  source_uri: string;
  suggestions: string[];
};

export type GroupMode = "problem" | "folder" | "suggested_artist" | "suggested_album" | "current_artist" | "suspected_album";

export const GROUP_MODES: { value: GroupMode; label: string }[] = [
  { value: "problem", label: "What is missing or uncertain" },
  { value: "folder", label: "Album folder" },
  { value: "suggested_artist", label: "Same suggested artist" },
  { value: "suggested_album", label: "Same suggested album" },
  { value: "current_artist", label: "Current artist" },
  { value: "suspected_album", label: "Suspected album (tags disagree)" },
];

export type TrackGroup = { key: string; label: string; tracks: IssueTrack[] };

/** The value of a suggestion such as "Suggested artist: X", or null. */
export function suggestion(track: IssueTrack, label: string): string | null {
  const found = track.suggestions.find((s) => s.startsWith(`${label}: `));
  return found ? found.slice(label.length + 2) : null;
}

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** The names of the things a track has suggestions for ("Suggested album artist" becomes "album artist"). */
export function problemNames(track: IssueTrack): string[] {
  return track.suggestions
    .map((s) => (s.includes(":") ? s.split(":")[0].replace(/^Suggested /i, "") : s.replace(/ needs review\.?$/i, "")).trim().toLowerCase())
    .filter(Boolean);
}

export function groupTracks(tracks: IssueTrack[], mode: GroupMode): TrackGroup[] {
  const groups = new Map<string, TrackGroup>();
  const add = (key: string, label: string, track: IssueTrack): void => {
    const group = groups.get(key) ?? { key, label, tracks: [] };
    group.tracks.push(track);
    groups.set(key, group);
  };
  for (const track of tracks) {
    switch (mode) {
      case "problem": {
        const names = problemNames(track);
        const label = names.length === 0 ? "Other" : [...new Set(names)].sort().join(" + ");
        add(label, label, track);
        break;
      }
      case "folder": {
        const folder = folderOf(track.source_uri);
        add(folder, folder.split(/[\\/]/).slice(-2).join(" / ") || "(no folder)", track);
        break;
      }
      case "suggested_artist": {
        const value = suggestion(track, "Suggested artist") ?? suggestion(track, "Suggested album artist");
        add(value ?? "(no suggested artist)", value ?? "No suggested artist", track);
        break;
      }
      case "suggested_album": {
        const value = suggestion(track, "Suggested album");
        add(value ?? "(no suggested album)", value ?? "No suggested album", track);
        break;
      }
      default: {
        const value = track.artist ?? "Unknown artist";
        add(value, value, track);
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.tracks.length - a.tracks.length || a.label.localeCompare(b.label));
}

/** The value all the tracks share for a field, or null when they differ or have none. */
export function commonValue(tracks: IssueTrack[], pick: (track: IssueTrack) => string | null): string | null {
  if (tracks.length === 0) return null;
  const first = pick(tracks[0]);
  return first !== null && first !== "" && tracks.every((t) => pick(t) === first) ? first : null;
}

export type BatchEdit = {
  artist: string;
  album: string;
  album_artist: string;
  genre: string;
  release_year: string;
  /** true: set the compilation flag; false: remove it; undefined: leave it. */
  compilation: boolean | undefined;
};

/**
 * One write request per track. A filled-in field replaces the value on every selected track; a blank field keeps
 * each track's own value. The title and track number are never changed by a batch edit.
 */
export function batchRequests(tracks: IssueTrack[], edit: BatchEdit): Record<string, unknown>[] {
  const year = edit.release_year.trim() === "" ? null : Number(edit.release_year);
  return tracks.map((track) => ({
    source_uri: track.source_uri,
    title: track.title,
    track_number: track.track_number,
    artist: edit.artist.trim() || track.artist,
    album: edit.album.trim() || track.album,
    album_artist: edit.album_artist.trim() || track.album_artist,
    genre: edit.genre.trim() || track.genre,
    release_year: year !== null && Number.isInteger(year) && year > 0 ? year : track.release_year,
    ...(edit.compilation === undefined ? {} : { compilation: edit.compilation }),
  }));
}

export const VARIOUS_ARTISTS = "Various Artists";

export function isVariousArtists(albumArtist: string | null): boolean {
  return albumArtist !== null && albumArtist.trim().toLowerCase() === VARIOUS_ARTISTS.toLowerCase();
}

// ---- Suspected albums (ADR 0008): one album whose tracks are tagged inconsistently ----

/** Album names that many unrelated albums share; for these the artist is part of the match too. */
const GENERIC_ALBUMS = new Set(["greatest hits", "the best of", "best of", "live", "unknown album", "untitled", "singles", "demo", "demos", "ep", "the collection", "collection", "hits", "rarities", "b sides", "unplugged", "acoustic"]);

/** An album name reduced to what identifies it: case, accents, punctuation, and disc or edition labels ignored. */
export function albumKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([{][^)\]}]*(disc|disk|cd|remaster|deluxe|edition|bonus|version|expanded|anniversary)[^)\]}]*[)\]}]/g, " ")
    .replace(/\b(disc|disk|cd)\s*\d+\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DISC_LABEL = /\s*(?:[([{]\s*(?:disc|disk|cd)\s*\d+[^)\]}]*[)\]}]|[-–,:]?\s*\b(?:disc|disk|cd)\s*\d+\b)/gi;

/** An album name without its disc label ("Wrecktrospective [Disc 2]" becomes "Wrecktrospective"). */
export function withoutDiscLabel(name: string): string {
  return name.replace(DISC_LABEL, "").trim();
}

/** The value most tracks have for a field (ties go to the first seen), or null when none has one. */
export function mostCommon(tracks: IssueTrack[], pick: (track: IssueTrack) => string | null): string | null {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const value = pick(track)?.trim();
    // Placeholders such as "Unknown genre" are not worth proposing to every track.
    if (value && !/^unknown\b/i.test(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export type SuspectedAlbum = TrackGroup & {
  /** What disagrees, in words: "album spelling (3 versions)", "album artist missing on 2 tracks", ... */
  differences: string[];
  /** The most common value of each album-wide field, offered as the fix. */
  proposal: { album: string; album_artist: string; release_year: string; genre: string };
};

/**
 * Groups the library's tracks into albums by `albumKey` (the tag, else the suggested album), and returns the
 * ones whose tracks disagree on the album name's spelling, the album artist, the year or the genre. The track
 * artist is allowed to differ (compilations). Worst first.
 */
export function suspectedAlbums(tracks: IssueTrack[]): SuspectedAlbum[] {
  const byKey = new Map<string, IssueTrack[]>();
  for (const track of tracks) {
    const name = track.album ?? suggestion(track, "Suggested album");
    if (!name) continue;
    let key = albumKey(name);
    if (key === "") continue;
    if (GENERIC_ALBUMS.has(key)) key += `|${albumKey(track.album_artist ?? track.artist ?? "")}`;
    const list = byKey.get(key) ?? [];
    list.push(track);
    byKey.set(key, list);
  }
  const result: SuspectedAlbum[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const distinct = (pick: (t: IssueTrack) => string | null): Set<string> => new Set(group.map(pick).filter((v): v is string => v !== null && v.trim() !== "").map((v) => v.trim()));
    const missing = (pick: (t: IssueTrack) => string | null): number => group.filter((t) => !pick(t)?.trim()).length;
    const differences: string[] = [];
    // The discs of one set are named "... [Disc 1]", "... [Disc 2]": that is not a spelling difference, and the
    // album name must then not be proposed for every track (it would rename the other discs).
    const hasDiscLabels = group.some((t) => t.album !== null && withoutDiscLabel(t.album) !== t.album.trim());
    const spellings = distinct((t) => (t.album === null ? null : withoutDiscLabel(t.album)));
    if (spellings.size > 1) differences.push(`album spelling (${spellings.size} versions${hasDiscLabels ? "; several discs, fix the names by hand" : ""})`);
    const fields: [string, (t: IssueTrack) => string | null][] = [
      ["album artist", (t) => t.album_artist],
      ["year", (t) => (t.release_year === null ? null : String(t.release_year))],
      ["genre", (t) => t.genre],
    ];
    for (const [label, pick] of fields) {
      const values = distinct(pick);
      const without = missing(pick);
      if (values.size > 1) differences.push(`${label} (${values.size} versions)`);
      else if (values.size === 1 && without > 0) differences.push(`${label} missing on ${without} track${without === 1 ? "" : "s"}`);
    }
    if (differences.length === 0) continue;
    const album = mostCommon(group, (t) => t.album) ?? "";
    const shownName = hasDiscLabels ? withoutDiscLabel(album) : album;
    result.push({
      key,
      label: `${shownName || key}${hasDiscLabels ? " (several discs)" : ""} — ${differences.join(", ")}`,
      tracks: group,
      differences,
      proposal: {
        // Blank keeps each track's own album name: used when the discs of a set carry their own labels.
        album: hasDiscLabels ? "" : album,
        album_artist: mostCommon(group, (t) => t.album_artist) ?? "",
        release_year: mostCommon(group, (t) => (t.release_year === null ? null : String(t.release_year))) ?? "",
        genre: mostCommon(group, (t) => t.genre) ?? "",
      },
    });
  }
  return result.sort((a, b) => b.differences.length - a.differences.length || b.tracks.length - a.tracks.length || a.label.localeCompare(b.label));
}
