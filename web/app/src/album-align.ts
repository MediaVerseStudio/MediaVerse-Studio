// What the "Match-up" panel says about an album whose songs disagree (pure, so it is tested).

export type FieldIssue = { field: "album" | "album_artist" | "genre" | "year"; majority: string; count: number; songs: { path: string; value: string | null }[] };
export type CoverIssue = { have: number; missing: string[]; source: string | null };
export type AlignAlbum = { folder: string; name: string; songs: number; fields: FieldIssue[]; cover: CoverIssue | null; issues: number };

export const FIELD_LABELS: Record<FieldIssue["field"], string> = { album: "Album", album_artist: "Album artist", genre: "Genre", year: "Year" };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** "Genre: 11 songs say “Punk Rock”; 01 Song.mp3 says “Rock”" */
export function describeField(issue: FieldIssue): string {
  const odd = issue.songs.map((s) => `${fileName(s.path)} ${s.value ? `says “${s.value}”` : "has none"}`);
  const shown = odd.length > 3 ? [...odd.slice(0, 3), `and ${odd.length - 3} more`] : odd;
  return `${FIELD_LABELS[issue.field]}: ${plural(issue.count, "song")} say “${issue.majority}”; ${shown.join("; ")}`;
}

export function describeCover(cover: CoverIssue, songs: number): string {
  return `Cover: ${cover.have} of ${songs} songs have the album's picture; ${plural(cover.missing.length, "song")} ${cover.missing.length === 1 ? "has" : "have"} none.`;
}

/** The tag writes that make the odd songs match their album. */
export function changesFor(album: AlignAlbum): { path: string; field: string; value: string }[] {
  return album.fields.flatMap((issue) => issue.songs.map((s) => ({ path: s.path, field: issue.field, value: issue.majority })));
}

export function songsToFix(album: AlignAlbum): number {
  return new Set([...album.fields.flatMap((f) => f.songs.map((s) => s.path)), ...(album.cover?.missing ?? [])]).size;
}
