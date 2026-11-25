// Which albums and tracks the Review page lists as missing artwork, missing lyrics or having audio defects.
// No DOM or bridge access, so it is unit tested.

/** A picture inside a song that breaks the embedding rules (over 1000 pixels, PNG, or 500 KB or more). */
export type EmbedIssue = { kind: "front_cover" | "back_cover" | "artist_photo" | "other"; width: number; height: number; kb: number; png: boolean };
/** `cover_size`: the best front cover there is for the song (in it or in its folder), [width, height]. */
export type GapFile = { path: string; cover: boolean; lyrics: boolean; mp3: boolean; cover_size?: [number, number] | null; embed_issues?: EmbedIssue[] };
export type GapTrack = { title: string; artist: string | null; album: string | null; source_uri: string; album_artist?: string | null; release_year?: number | null; track_number?: number | null; length_ms?: number | null };

/** `tracks`/`mp3Paths`: the songs with the gap; `albumMp3Paths`: every MP3 in the album's folder (a picture is
 * saved on all of them); `total`: how many songs the folder has; `coverSize`: the album's best front cover;
 * `issues`: its pictures too large to embed, the largest of each kind. */
export type AlbumGap = {
  folder: string;
  album: string;
  artist: string;
  tracks: GapTrack[];
  mp3Paths: string[];
  albumArtist?: string;
  year?: number | null;
  total?: number;
  albumMp3Paths?: string[];
  coverSize?: [number, number] | null;
  issues?: EmbedIssue[];
};

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** Albums whose best front cover is smaller than `threshold` pixels on its shorter side (owner, 2026-11-05: find
 * and replace low-resolution artwork, under 500 × 500 or under 1000 × 1000). Albums with no cover at all are in
 * the Missing list instead. */
export function albumsWithLowCover(files: GapFile[], tracks: GapTrack[], threshold: number): AlbumGap[] {
  const best = new Map<string, [number, number] | null>();
  for (const file of files) {
    const folder = folderOf(file.path);
    const size = file.cover_size ?? null;
    const have = best.get(folder);
    if (have === undefined || (size && (!have || Math.min(...size) > Math.min(...have)))) best.set(folder, size);
  }
  const low = (file: GapFile): boolean => {
    const size = best.get(folderOf(file.path));
    return file.cover && !!size && Math.min(...size) < threshold;
  };
  const gaps = albumGroups(files, tracks, low);
  for (const gap of gaps) gap.coverSize = best.get(gap.folder) ?? null;
  return gaps.sort((a, b) => Math.min(...(a.coverSize ?? [0, 0])) - Math.min(...(b.coverSize ?? [0, 0])) || (a.albumArtist ?? "").localeCompare(b.albumArtist ?? ""));
}

/** Albums with a picture inside the songs that breaks the embedding rules, with the largest of each kind. */
export function albumsWithLargeEmbedded(files: GapFile[], tracks: GapTrack[]): AlbumGap[] {
  const gaps = albumGroups(files, tracks, (file) => (file.embed_issues?.length ?? 0) > 0);
  const byFolder = new Map<string, EmbedIssue[]>();
  for (const file of files) {
    for (const issue of file.embed_issues ?? []) {
      const list = byFolder.get(folderOf(file.path)) ?? [];
      const same = list.findIndex((i) => i.kind === issue.kind);
      if (same < 0) list.push(issue);
      else if (issue.kb > list[same].kb) list[same] = issue;
      byFolder.set(folderOf(file.path), list);
    }
  }
  for (const gap of gaps) gap.issues = byFolder.get(gap.folder) ?? [];
  const best = new Map<string, [number, number]>();
  for (const file of files) {
    const size = file.cover_size;
    const have = best.get(folderOf(file.path));
    if (size && (!have || Math.min(...size) > Math.min(...have))) best.set(folderOf(file.path), size);
  }
  for (const gap of gaps) gap.coverSize = best.get(gap.folder) ?? null;
  return gaps;
}

/** The groups of Artwork > Oversized images (owner, 2026-11-05): pictures that need resizing (over 1000 pixels),
 * then those taking too much room, over 500 KB or 200 to 500 KB (that group can be ignored), and small PNGs that
 * only need to become JPEG. An album goes in the group of its worst picture. */
export type OversizedGroup = "resize" | "over500" | "png" | "over200";
export const OVERSIZED_GROUPS: OversizedGroup[] = ["resize", "png", "over500", "over200"];

export function oversizedGroup(gap: AlbumGap): OversizedGroup {
  const issues = gap.issues ?? [];
  if (issues.some((i) => Math.max(i.width, i.height) > 1000)) return "resize";
  if (issues.some((i) => i.png)) return "png";
  if (issues.some((i) => i.kb >= 500)) return "over500";
  return "over200";
}

/** Albums (one per folder) where at least one track has no cover, by what the library knows of its tracks: with
 * the album artist, year and number of songs for the compact list. */
export function albumsWithoutCover(files: GapFile[], tracks: GapTrack[]): AlbumGap[] {
  return albumGroups(files, tracks, (file) => !file.cover);
}

/** The albums (one per folder) with at least one song for which `listed` is true, with the album's details. */
function albumGroups(files: GapFile[], tracks: GapTrack[], listed: (file: GapFile) => boolean): AlbumGap[] {
  const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
  const folders = new Map<string, AlbumGap>();
  for (const file of files) {
    if (!listed(file)) continue;
    const track = byPath.get(file.path);
    if (!track) continue;
    const folder = folderOf(file.path);
    const gap = folders.get(folder) ?? { folder, album: track.album ?? "Unknown album", artist: track.artist ?? "Unknown artist", tracks: [], mp3Paths: [] };
    gap.tracks.push(track);
    if (file.mp3) gap.mp3Paths.push(file.path);
    folders.set(folder, gap);
  }
  for (const file of files) {
    const gap = folders.get(folderOf(file.path));
    if (!gap) continue;
    gap.total = (gap.total ?? 0) + 1;
    if (file.mp3) (gap.albumMp3Paths ??= []).push(file.path);
    const track = byPath.get(file.path);
    if (track?.album_artist && !gap.albumArtist) gap.albumArtist = track.album_artist;
    if (track?.release_year && !gap.year) gap.year = track.release_year;
  }
  for (const gap of folders.values()) gap.albumArtist ??= gap.artist;
  return [...folders.values()].sort((a, b) => (a.albumArtist ?? a.artist).localeCompare(b.albumArtist ?? b.artist) || a.album.localeCompare(b.album));
}

/** After pictures or lyrics were saved: the scan results updated for those files, without reading the library
 * again (that took long and made the list feel slow). */
export function markSaved(files: GapFile[], paths: string[], change: MediaChange): GapFile[] {
  const saved = new Set(paths);
  return files.map((file) => {
    if (!saved.has(file.path)) return file;
    const next = { ...file };
    if (change.frontCover !== undefined) next.cover = change.frontCover;
    if (change.lyrics !== undefined) next.lyrics = change.lyrics;
    if (change.coverSize !== undefined) next.cover_size = change.coverSize;
    if (change.fixedKinds?.length) next.embed_issues = (file.embed_issues ?? []).filter((i) => !change.fixedKinds!.includes(i.kind));
    return next;
  });
}

/** What a save changed: whether the songs now have a front cover, its best size, the kinds of picture now within
 * the embedding rules, and whether they have lyrics. */
export type MediaChange = { frontCover?: boolean; coverSize?: [number, number] | null; fixedKinds?: string[]; lyrics?: boolean };
/** Tracks with no lyrics, grouped by album for display, in library order within each album. `instrumental`: songs known to
 * have no words (LRCLIB says so); they are not "missing". */
export function albumsWithoutLyrics(files: GapFile[], tracks: GapTrack[], instrumental: ReadonlySet<string> = new Set()): AlbumGap[] {
  const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
  const folders = new Map<string, AlbumGap>();
  for (const file of files) {
    if (file.lyrics || instrumental.has(file.path)) continue;
    const track = byPath.get(file.path);
    if (!track) continue;
    const folder = folderOf(file.path);
    const gap = folders.get(folder) ?? { folder, album: track.album ?? "Unknown album", artist: track.artist ?? "Unknown artist", tracks: [], mp3Paths: [] };
    gap.tracks.push(track);
    if (file.mp3) gap.mp3Paths.push(file.path);
    folders.set(folder, gap);
  }
  return [...folders.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
}

export type DefectResult = {
  path: string;
  scanned_at: number;
  /** The person listened and marked this version of the file as good. */
  reviewed_good?: boolean;
  report: { verdict: "clean" | "minor" | "suspect"; seconds: number; counts: Record<string, number>; findings: { kind: string; time_ms: number; length_ms: number; strength: number }[] };
};

const RANK = { suspect: 0, minor: 1, clean: 2 } as const;

/** Scan results to list: tracks with a problem first (worst first), only for tracks still in the library, and not
 * the ones the person already listened to and marked as good. */
export function defectList(results: DefectResult[], tracks: GapTrack[]): { track: GapTrack; result: DefectResult }[] {
  const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
  return results
    .flatMap((result) => {
      const track = byPath.get(result.path);
      return track && result.report.verdict !== "clean" && result.reviewed_good !== true ? [{ track, result }] : [];
    })
    .sort((a, b) => RANK[a.result.report.verdict] - RANK[b.result.report.verdict] || a.track.title.localeCompare(b.track.title));
}

/** How many current results the person marked as good (still in the library). */
export function markedGood(results: DefectResult[], tracks: GapTrack[]): number {
  const inLibrary = new Set(tracks.map((t) => t.source_uri));
  return results.filter((r) => r.reviewed_good === true && inLibrary.has(r.path)).length;
}

/** How many library tracks have a current scan result, and how many do not. */
export function scanCoverage(results: DefectResult[], tracks: GapTrack[]): { scanned: number; unscanned: GapTrack[] } {
  const done = new Set(results.map((r) => r.path));
  const unscanned = tracks.filter((t) => !done.has(t.source_uri));
  return { scanned: tracks.length - unscanned.length, unscanned };
}
