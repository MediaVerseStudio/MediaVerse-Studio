// Pure logic for the editable album table on the Rip page (owner, 2026-11-20): the album as the tag editor shows it, every
// box editable, one row per track with a tick for ripping. A chosen release fills it in; typing in the album artist
// carries down to the tracks that followed it ("smart fill"); choosing another release marks what changed.
// No DOM, so it is unit tested.

import type { Candidate, CandidateTrack } from "./rip-format.ts";

export type EditRow = { number: number; title: string; artist: string };

export type AlbumEdit = {
  album: string;
  albumArtist: string;
  year: string;
  genre: string;
  rows: EditRow[];
};

/** The table for a chosen release: a track with no artist of its own shows the album artist. */
export function fromCandidate(candidate: Candidate): AlbumEdit {
  return {
    album: candidate.album,
    albumArtist: candidate.album_artist,
    year: candidate.year ? String(candidate.year) : "",
    genre: candidate.genre ?? "",
    rows: candidate.tracks.map((track) => ({ number: track.number, title: track.title, artist: track.artist || candidate.album_artist })),
  };
}

/** An empty table for a disc of `count` tracks (the album entered by hand). */
export function blankAlbum(count: number): AlbumEdit {
  return { album: "", albumArtist: "", year: "", genre: "", rows: Array.from({ length: count }, (_, i) => ({ number: i + 1, title: "", artist: "" })) };
}

/** The album artist changed: tracks that had the old one (or none) follow it; a track with its own artist keeps it. */
export function withAlbumArtist(edit: AlbumEdit, albumArtist: string): AlbumEdit {
  const old = edit.albumArtist;
  return { ...edit, albumArtist, rows: edit.rows.map((row) => (row.artist === "" || row.artist === old ? { ...row, artist: albumArtist } : row)) };
}

/** Titles pasted one per line (a leading "01 ", "1." or "1)" dropped when every line has one) fill the rows in order. */
export function withPastedTitles(edit: AlbumEdit, text: string): AlbumEdit {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // Numbers are dropped only when every line starts with one in order, so "99 Luftballons" stays whole.
  const numbered = lines.length > 0 && lines.every((line, i) => new RegExp(`^0*${i + 1}\\s*[.)\\-:]?\\s+\\S`).test(line));
  const titles = numbered ? lines.map((line) => line.replace(/^\d{1,3}\s*[.)\-:]?\s+/, "")) : lines;
  return { ...edit, rows: edit.rows.map((row, i) => (i < titles.length ? { ...row, title: titles[i]! } : row)) };
}

/** The edited table applied to the release it started from: what `rip_disc` takes as `candidate`. */
export function toCandidate(edit: AlbumEdit, base: Candidate | null): Candidate {
  const year = Number.parseInt(edit.year.trim(), 10);
  const albumArtist = edit.albumArtist.trim();
  const tracks: CandidateTrack[] = edit.rows.map((row) => {
    const title = row.title.trim();
    const artist = row.artist.trim();
    return { number: row.number, title: title || `Track ${String(row.number).padStart(2, "0")}`, artist: artist && artist !== albumArtist ? artist : null };
  });
  return {
    source: "manual",
    quality: "exact",
    ...base,
    album: edit.album.trim(),
    album_artist: albumArtist,
    year: year >= 1000 && year <= 2999 ? year : null,
    genre: edit.genre.trim() || null,
    tracks,
  };
}

/** What is different between two tables, for marking a choice of release: header fields, and the numbers of rows whose title or artist differ. */
export function differences(before: AlbumEdit, after: AlbumEdit): { fields: ("album" | "albumArtist" | "year" | "genre")[]; titles: number[]; artists: number[] } {
  const fields = (["album", "albumArtist", "year", "genre"] as const).filter((key) => before[key].trim() !== after[key].trim());
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const titles: number[] = [];
  const artists: number[] = [];
  for (const row of after.rows) {
    const old = before.rows.find((r) => r.number === row.number);
    if (!old) {
      titles.push(row.number);
      continue;
    }
    if (!same(old.title, row.title)) titles.push(row.number);
    if (!same(old.artist, row.artist)) artists.push(row.number);
  }
  return { fields, titles, artists };
}

const FIELD_NAMES = { album: "album title", albumArtist: "album artist", year: "year", genre: "genre" } as const;

/** One sentence about what choosing a release changed, or "" when it changed nothing. */
export function describeDifferences(diff: ReturnType<typeof differences>): string {
  const parts: string[] = [];
  if (diff.fields.length > 0) parts.push(diff.fields.map((f) => FIELD_NAMES[f]).join(", "));
  const list = (numbers: number[]): string => (numbers.length > 4 ? `${numbers.length} tracks` : `track${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`);
  if (diff.titles.length > 0) parts.push(`the titles of ${list(diff.titles)}`);
  if (diff.artists.length > 0) parts.push(`the artist of ${list(diff.artists)}`);
  return parts.length === 0 ? "" : `Differs from what was shown before: ${parts.join("; ")}.`;
}

/** Why the rip cannot start from this table, or null. Every ticked track needs nothing else; the album and artist are needed. */
export function editProblem(edit: AlbumEdit): string | null {
  if (edit.album.trim() === "" || edit.albumArtist.trim() === "") return "Type the album and the artist.";
  return null;
}

/** Track lengths from the disc's table of contents (75 sectors a second): "3:12" for each track, in order. */
export function discLengths(starts: number[], leadout: number): string[] {
  return starts.map((start, i) => {
    const seconds = Math.round(((starts[i + 1] ?? leadout) - start) / 75);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  });
}
