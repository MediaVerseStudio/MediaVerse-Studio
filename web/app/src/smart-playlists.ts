// Rule-based ("smart") playlists and the Auto-DJ's choice of songs (owner's list 2026-11-23, issue #10). A smart playlist is a set of rules over what the library
// knows about each song (its tags, when it was added, whether it has a heart, how often and how lately it was played); it is worked out when it is opened, so it
// is always up to date. Music only: podcasts will be kept out of every rule (issue #11). Pure, so it is unit tested.

import type { LibrarySong } from "./library-format";

export type Field = "genre" | "artist" | "album" | "title" | "year" | "added_days" | "heart" | "plays" | "last_played_days" | "length_min";
export type Operator = "contains" | "not_contains" | "is" | "is_not" | "gt" | "lt";
export type Rule = { field: Field; op: Operator; value: string };
export type Sort = "random" | "title" | "artist" | "newest" | "most_played" | "year";
export type Smart = { id: string; name: string; match: "all" | "any"; rules: Rule[]; sort: Sort; limit: number | null };

/** What the rules need to know besides the tags. */
export type Facts = {
  hearts: ReadonlySet<string>;
  plays: ReadonlyMap<string, { count: number; last: number }>;
  /** Now, in seconds since 1970. */
  now: number;
};

export const FIELDS: { field: Field; label: string; kind: "text" | "number" | "heart"; hint?: string }[] = [
  { field: "genre", label: "Genre", kind: "text" },
  { field: "artist", label: "Artist", kind: "text" },
  { field: "album", label: "Album", kind: "text" },
  { field: "title", label: "Title", kind: "text" },
  { field: "year", label: "Year", kind: "number" },
  { field: "added_days", label: "Added (days ago)", kind: "number", hint: "added to the library this many days ago" },
  { field: "plays", label: "Times played", kind: "number" },
  { field: "last_played_days", label: "Last played (days ago)", kind: "number", hint: "a song never played counts as very long ago" },
  { field: "length_min", label: "Length (minutes)", kind: "number" },
  { field: "heart", label: "Has a heart", kind: "heart" },
];

export const OPERATORS: Record<"text" | "number" | "heart", { op: Operator; label: string }[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "not_contains", label: "does not contain" },
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
  ],
  number: [
    { op: "is", label: "is" },
    { op: "gt", label: "is more than" },
    { op: "lt", label: "is less than" },
  ],
  heart: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
  ],
};

const kindOf = (field: Field): "text" | "number" | "heart" => FIELDS.find((f) => f.field === field)?.kind ?? "text";
const norm = (text: string): string => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const DAY = 86_400;

function numberOf(field: Field, song: LibrarySong, facts: Facts): number | null {
  switch (field) {
    case "year":
      return song.release_year ?? null;
    case "added_days":
      return song.added_secs ? Math.max(0, (facts.now - song.added_secs) / DAY) : null;
    case "plays":
      return facts.plays.get(song.source_uri)?.count ?? 0;
    case "last_played_days": {
      const last = facts.plays.get(song.source_uri)?.last;
      return last ? Math.max(0, (facts.now - last) / DAY) : 36_500;
    }
    case "length_min":
      return song.length_ms ? song.length_ms / 60_000 : null;
    default:
      return null;
  }
}

function textOf(field: Field, song: LibrarySong): string {
  switch (field) {
    case "genre":
      return song.genre ?? "";
    case "artist":
      return `${song.artist ?? ""} ${song.album_artist ?? ""}`;
    case "album":
      return song.album ?? "";
    case "title":
      return song.title;
    default:
      return "";
  }
}

export function ruleMatches(rule: Rule, song: LibrarySong, facts: Facts): boolean {
  const kind = kindOf(rule.field);
  if (kind === "heart") {
    const has = facts.hearts.has(song.source_uri);
    const wanted = norm(rule.value) !== "no";
    return rule.op === "is_not" ? has !== wanted : has === wanted;
  }
  if (kind === "number") {
    const have = numberOf(rule.field, song, facts);
    const want = Number(rule.value);
    if (have === null || !Number.isFinite(want)) return false;
    if (rule.op === "gt") return have > want;
    if (rule.op === "lt") return have < want;
    return rule.field === "year" || rule.field === "plays" ? have === want : Math.floor(have) === Math.floor(want);
  }
  const have = norm(textOf(rule.field, song));
  const want = norm(rule.value);
  if (!want) return false;
  switch (rule.op) {
    case "contains":
      return have.includes(want);
    case "not_contains":
      return !have.includes(want);
    case "is":
      return have === want || have.split(/\s+/).includes(want) && rule.field === "artist";
    case "is_not":
      return have !== want;
    default:
      return false;
  }
}

/** The songs a smart playlist holds right now, in its order and within its limit. */
export function evaluate(smart: Smart, songs: LibrarySong[], facts: Facts, random: () => number = Math.random): LibrarySong[] {
  const rules = smart.rules.filter((r) => r.value.trim() !== "" || kindOf(r.field) === "heart");
  const hit = songs.filter((song) => {
    if (!rules.length) return true;
    return smart.match === "any" ? rules.some((r) => ruleMatches(r, song, facts)) : rules.every((r) => ruleMatches(r, song, facts));
  });
  const key = (s: LibrarySong): string => `${norm(s.artist ?? s.album_artist ?? "")}\u0000${norm(s.album ?? "")}\u0000${String(s.track_number ?? 0).padStart(3, "0")}`;
  switch (smart.sort) {
    case "title":
      hit.sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
      break;
    case "artist":
      hit.sort((a, b) => key(a).localeCompare(key(b)));
      break;
    case "newest":
      hit.sort((a, b) => (b.added_secs ?? 0) - (a.added_secs ?? 0));
      break;
    case "most_played":
      hit.sort((a, b) => (facts.plays.get(b.source_uri)?.count ?? 0) - (facts.plays.get(a.source_uri)?.count ?? 0));
      break;
    case "year":
      hit.sort((a, b) => (a.release_year ?? 9999) - (b.release_year ?? 9999));
      break;
    default:
      for (let i = hit.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [hit[i], hit[j]] = [hit[j]!, hit[i]!];
      }
  }
  return smart.limit && smart.limit > 0 ? hit.slice(0, smart.limit) : hit;
}

/** Cleans a smart playlist read from storage; null when it is not one. */
export function cleanSmart(value: unknown): Smart | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || typeof v.name !== "string" || !v.name.trim()) return null;
  const rules = (Array.isArray(v.rules) ? v.rules : []).flatMap((r): Rule[] => {
    const x = r as Record<string, unknown>;
    const field = FIELDS.find((f) => f.field === x?.field)?.field;
    if (!field) return [];
    const ops = OPERATORS[kindOf(field)].map((o) => o.op);
    const op = ops.find((o) => o === x.op) ?? ops[0]!;
    return [{ field, op, value: typeof x.value === "string" ? x.value.slice(0, 120) : "" }];
  });
  const sorts: Sort[] = ["random", "title", "artist", "newest", "most_played", "year"];
  return {
    id: v.id.slice(0, 40),
    name: v.name.trim().slice(0, 80),
    match: v.match === "any" ? "any" : "all",
    rules,
    sort: sorts.find((s) => s === v.sort) ?? "random",
    limit: typeof v.limit === "number" && Number.isFinite(v.limit) && v.limit > 0 ? Math.min(5000, Math.floor(v.limit)) : null,
  };
}

// ---- Auto-DJ: when the queue runs out, more songs that fit what has been playing.

export type DjSong = LibrarySong;

/** How well a candidate fits the song that just played: the same genre, the same artist, the same decade. */
export function likeness(current: DjSong, other: DjSong): number {
  let score = 0;
  const genre = norm(current.genre ?? "");
  if (genre && genre === norm(other.genre ?? "")) score += 3;
  const artist = norm(current.album_artist ?? current.artist ?? "");
  if (artist && artist === norm(other.album_artist ?? other.artist ?? "")) score += 2;
  if (current.release_year && other.release_year && Math.floor(current.release_year / 10) === Math.floor(other.release_year / 10)) score += 1;
  return score;
}

/**
 * `count` songs to play next: songs like `current`, never one already queued or recently played, a different artist from the one before so it does not stay on one
 * band; chosen at random among the best fits so it does not repeat the same run.
 */
export function pickForAutoDj(current: DjSong, library: DjSong[], avoid: ReadonlySet<string>, count: number, random: () => number = Math.random): DjSong[] {
  const out: DjSong[] = [];
  const taken = new Set(avoid);
  let from = current;
  for (let n = 0; n < count; n++) {
    const pool = library.filter((s) => !taken.has(s.source_uri) && norm(s.artist ?? "") !== norm(from.artist ?? ""));
    if (!pool.length) break;
    const scored = pool.map((s) => ({ s, score: likeness(current, s) + random() * 1.5 })).sort((a, b) => b.score - a.score);
    const best = scored[Math.floor(random() * Math.min(5, scored.length))]!.s;
    out.push(best);
    taken.add(best.source_uri);
    from = best;
  }
  return out;
}
