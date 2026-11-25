// Artist names spelt more than one way in the tags ("AFI" and "A.F.I.", "Guns N' Roses" and "Guns N Roses"), or not spelt
// the way MusicBrainz spells them, found so the Review page can offer the right spelling (D97, D101). Pure logic,
// tested without the page.

import type { LibrarySong } from "./library-format";

/** One spelling of an artist's name and how many songs carry it (as Artist or as Album artist). */
export type Spelling = { name: string; songs: number };

/** Names that are probably one artist: the spellings, and the one suggested. */
export type NameGroup = {
  key: string;
  spellings: Spelling[];
  suggested: string;
  paths: string[];
  /** The spelling MusicBrainz uses for this artist, when it was asked and knows it. */
  official?: string;
  /** Why a single name is listed, in words. */
  reason?: string;
};

/** What MusicBrainz was asked about: the exact spelling asked -> its official spelling ("" when it does not know). */
export type Canonical = Map<string, string>;

/** Whitespace of every kind collapsed to single spaces and trimmed (the no-break and wide spaces too). */
export const cleanName = (name: string): string => name.replace(/[\s  -​　]+/g, " ").trim();

/** Things in a name that look the same on screen but are not: stray spaces, curly quotes and the like. */
export function oddities(name: string): string[] {
  const found: string[] = [];
  if (/^[\s ​]/.test(name)) found.push("a space at the start");
  if (/[\s ​]$/.test(name)) found.push("a space at the end");
  if (/ {2,}/.test(name.trim())) found.push("a double space");
  if (/[  -​　]/.test(name.trim())) found.push("a no-break or wide space");
  if (/[‘’]/.test(name)) found.push("a curly apostrophe");
  if (/[“”]/.test(name)) found.push("curly quote marks");
  if (/[‐-―]/.test(name)) found.push("a long dash");
  return found;
}

/** The name as shown, with a space at either end made visible as ␣ so two lookalikes can be told apart. */
export const visibleName = (name: string): string => name.replace(/^[\s ]+|[\s ]+$/g, (m) => "␣".repeat(m.length));

/**
 * One key for names that differ only in punctuation, spacing, capitals, accents, "&" against "and" or a leading "The":
 * "A.F.I.", "AFI" and "a f i" share one. Names with nothing letter-like in them have no key (they are never grouped).
 */
export function looseKey(name: string): string {
  const plain = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/^\s*the\s+(?=\S)/, "");
  return plain.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** How much punctuation a spelling has: of two equally common spellings the plainer one is suggested. */
const punctuation = (name: string): number => (name.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;

/** The spelling to suggest when no official one is known: the most songs, then the least punctuation, then the shortest. */
export function suggestSpelling(spellings: Spelling[]): string {
  return [...spellings].sort((a, b) => b.songs - a.songs || punctuation(a.name) - punctuation(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))[0].name;
}

/**
 * Every name that needs a look, biggest first: names the songs spell in more than one way, and single names that are not
 * spelt the way MusicBrainz spells them or carry stray spacing. The suggestion is MusicBrainz's own spelling when it is
 * known (even if no song uses it); otherwise the commonest, plainest spelling. A song counts once under each distinct name
 * it carries in its Artist and Album artist tags. Names are kept exactly as tagged, so "AFI" and "AFI " are two spellings.
 */
export function similarNames(songs: LibrarySong[], canonical: Canonical = new Map(), settled: Settled = {}): NameGroup[] {
  const byKey = new Map<string, { spellings: Map<string, number>; paths: Set<string> }>();
  for (const song of songs) {
    const names = new Set([song.artist, song.album_artist].filter((n): n is string => !!n && n.trim() !== ""));
    for (const name of names) {
      const key = looseKey(name);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) byKey.set(key, (entry = { spellings: new Map(), paths: new Set() }));
      entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
      entry.paths.add(song.source_uri);
    }
  }
  const groups: NameGroup[] = [];
  for (const [key, entry] of byKey) {
    const spellings = [...entry.spellings].map(([name, count]) => ({ name, songs: count })).sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name));
    const official = spellings.map((s) => canonical.get(s.name) || canonical.get(cleanName(s.name))).find((o): o is string => !!o && looseKey(o) === key);
    const only = spellings[0].name;
    const single = spellings.length === 1;
    // Already decided, and nothing has changed since: not listed again (the band's own spelling can differ from MusicBrainz's).
    const decision = settled[key];
    if (decision && decision.signature === signatureOf(spellings.map((s) => s.name))) continue;
    const wrongOfficially = single && official !== undefined && official !== only;
    const strayOnly = single && cleanName(only) !== only;
    if (single && !wrongOfficially && !strayOnly) continue;
    const suggested = decision?.chosen ?? official ?? (single ? cleanName(only) : suggestSpelling(spellings.map((s) => ({ name: cleanName(s.name), songs: s.songs }))));
    const listed = spellings.some((s) => s.name === suggested) ? spellings : [...spellings, { name: suggested, songs: 0 }];
    const reason = !single ? undefined : wrongOfficially ? `MusicBrainz spells this artist “${official}”.` : "The name has stray spacing.";
    groups.push({ key, spellings: listed, suggested, paths: [...entry.paths], ...(official ? { official } : {}), ...(reason ? { reason } : {}) });
  }
  return groups.sort((a, b) => b.paths.length - a.paths.length || a.suggested.localeCompare(b.suggested));
}

/**
 * What the person has already decided about a name (2026-11-17): after "Use this spelling" (the band's own spelling may differ from MusicBrainz's) or
 * "Leave as it is", the name is not listed again while its spellings are exactly what they were when it was settled. `chosen` is the spelling the
 * person picked, which later beats MusicBrainz's as the suggestion should the name come back (a new song with another spelling).
 */
export type Settled = Record<string, { signature: string; chosen?: string }>;

/** The spellings of one name as one string, in a fixed order: what "settled" is compared with. */
export const signatureOf = (names: string[]): string => [...names].sort().join("\u0001");

/** Reads stored decisions, keeping only well-formed entries. */
export function parseSettled(raw: unknown): Settled {
  const out: Settled = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as { signature?: unknown; chosen?: unknown } | null;
      if (v && typeof v.signature === "string") out[key] = { signature: v.signature, ...(typeof v.chosen === "string" ? { chosen: v.chosen } : {}) };
    }
  }
  return out;
}

const SETTLED_KEY = "mediaverse.artist-names-settled";

export function loadSettled(): Settled {
  try {
    return parseSettled(JSON.parse(localStorage.getItem(SETTLED_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export function saveSettled(settled: Settled): void {
  try {
    localStorage.setItem(SETTLED_KEY, JSON.stringify(settled));
  } catch {
    // kept for this session only
  }
}

/** Every distinct artist and album artist spelling in the songs, exactly as tagged: what MusicBrainz is asked about. */
export function distinctNames(songs: LibrarySong[]): string[] {
  const names = new Set<string>();
  for (const song of songs) for (const name of [song.artist, song.album_artist]) if (name && name.trim() !== "") names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** What the person is told before a rename. */
export function describeRename(group: NameGroup, to: string): string {
  const others = group.spellings.filter((s) => s.name !== to && s.songs > 0);
  const songs = others.reduce((sum, s) => sum + s.songs, 0);
  return `Change ${others.map((s) => `“${visibleName(s.name)}”`).join(" and ")} to “${to}” in ${songs} song tag${songs === 1 ? "" : "s"}?`;
}
