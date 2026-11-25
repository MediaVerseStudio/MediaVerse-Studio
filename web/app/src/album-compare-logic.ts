// Review > Album IDs, "Compare": pure rules for the side-by-side view of an album's own tags and a MusicBrainz release
// (D111): what to tick, what to send to adopt the ticked values, and whether the song lengths hint at a ripping problem.

export type CompareRow = {
  path: string;
  name: string;
  yours: { track: number | null; disc: number | null; title: string; artist: string; length_ms: number | null };
  release: { number: number; title: string; artist: string; length_ms: number | null } | null;
  diff_ms: number | null;
  differs: string[];
  extra: boolean;
};
export type AlbumField = { field: "album" | "album_artist" | "year" | "genre"; yours: string; release: string; differs: boolean };
export type Comparison = {
  release: { id: string; release_group_id: string; title: string; artist: string; date: string; country: string; label: string; catalog_number: string; barcode: string; url: string; tracks: number };
  songs: number;
  album: AlbumField[];
  rows: CompareRow[];
  missing: { number: number; title: string; length_ms: number | null }[];
};

/** A song within this of its release track's length counts as the same length (pressings differ by a moment). */
export const LENGTH_OK_MS = 1500;
/** Beyond this a difference is another edition's track, not a skipped section. */
const SUSPECT_LIMIT_MS = 30_000;

export type RipHint = {
  /** `agree`: nothing to see. `suspect`: a few songs are a little off while the rest agree. `edition`: most differ. */
  level: "agree" | "suspect" | "edition" | "unknown";
  text: string;
  /** The songs that are a little off. */
  suspects: { name: string; track: number | null; diff_ms: number }[];
};

function plusMinus(ms: number): string {
  const seconds = Math.abs(ms) / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s ${ms < 0 ? "shorter" : "longer"}`;
}

/**
 * Do the song lengths hint at a problem while ripping? When most songs match the release to within a second or two and
 * a few are off by a few seconds, a section may have been skipped or damaged (a re-rip may be worth it). When most
 * songs differ, the person more likely has another edition or pressing.
 */
export function ripHint(rows: CompareRow[]): RipHint {
  const compared = rows.filter((r) => r.diff_ms !== null);
  if (compared.length < 3) return { level: "unknown", text: "Too few song lengths to compare.", suspects: [] };
  const off = compared.filter((r) => Math.abs(r.diff_ms as number) > LENGTH_OK_MS);
  const share = (compared.length - off.length) / compared.length;
  if (off.length === 0) return { level: "agree", text: "Every song's length agrees with the release (within 1.5 seconds).", suspects: [] };
  const suspects = off
    .filter((r) => Math.abs(r.diff_ms as number) <= SUSPECT_LIMIT_MS)
    .map((r) => ({ name: r.name, track: r.release?.number ?? r.yours.track, diff_ms: r.diff_ms as number }));
  if (share >= 0.6 && suspects.length === off.length) {
    const list = suspects.slice(0, 4).map((s) => `${s.track !== null ? `track ${s.track}` : s.name} is ${plusMinus(s.diff_ms)}`).join(", ");
    const shorter = suspects.filter((s) => s.diff_ms < 0).length;
    const cause = shorter === suspects.length ? "A section may have been skipped or damaged while ripping" : shorter === 0 ? "Extra or repeated audio is possible, or it is a different cut" : "Audio may have been skipped or repeated while ripping";
    return {
      level: "suspect",
      text: `${off.length === 1 ? "One song is" : `${off.length} songs are`} a little off while the others agree (${list}). ${cause}: consider flagging this disc for a re-rip.`,
      suspects,
    };
  }
  return {
    level: "edition",
    text: share < 0.4 ? "Most song lengths differ: this is probably another edition or pressing than yours, not a ripping problem." : "Several song lengths differ: this may be another edition than yours.",
    suspects: [],
  };
}

/** A short reason to keep with a re-rip flag, from the hint. */
export function ripReason(hint: RipHint): string {
  if (hint.level !== "suspect") return "";
  const first = hint.suspects[0];
  const what = first.track !== null ? `track ${first.track}` : first.name;
  return `${what} is ${plusMinus(first.diff_ms)} than MusicBrainz says${hint.suspects.length > 1 ? ` (and ${hint.suspects.length - 1} more)` : ""}; the other songs agree`;
}

/** The keys of every value that differs, for "Tick all differences". */
export function differenceKeys(c: Comparison): string[] {
  const keys: string[] = [];
  for (const a of c.album) if (a.differs) keys.push(`album:${a.field}`);
  for (const row of c.rows) for (const field of row.differs) keys.push(`song:${row.path}:${field}`);
  return keys;
}

/** What `adopt_release_values` takes for the ticked keys. */
export function adoptArguments(path: string, c: Comparison, ticked: ReadonlySet<string>): { path: string; release_id: string; album_fields: string[]; songs: { path: string; fields: string[] }[] } {
  const album_fields = c.album.filter((a) => ticked.has(`album:${a.field}`)).map((a) => a.field);
  const songs = c.rows
    .map((row) => ({ path: row.path, fields: row.differs.filter((f) => ticked.has(`song:${row.path}:${f}`)) }))
    .filter((s) => s.fields.length > 0);
  return { path, release_id: c.release.id, album_fields, songs };
}

/** How many values the ticked keys will write (an album value goes into every song). */
export function adoptCount(c: Comparison, ticked: ReadonlySet<string>): number {
  const a = adoptArguments("", c, ticked);
  return a.album_fields.length * c.songs + a.songs.reduce((sum, s) => sum + s.fields.length, 0);
}

export function clock(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function difference(ms: number | null): string {
  if (ms === null) return "";
  const s = ms / 1000;
  return `${s > 0 ? "+" : ""}${s.toFixed(1)} s`;
}