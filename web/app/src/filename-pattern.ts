// Tags from file names with a pattern, as Mp3tag and TagScanner do ("%track% - %title%"). Pure rules, tested apart from
// the page (Review > Fix tags > "Tags from file names…"). The program tries the usual patterns on every file of the
// folder; when exactly one fits all of them it is used, otherwise the person is asked to choose or to type their own.
// Nothing is written from here: the values are typed into the table and the person presses Apply.

export type NameField = "artist" | "title" | "track" | "disc" | "album" | "year";

export const NAME_FIELDS: { field: NameField; label: string }[] = [
  { field: "track", label: "Track number" },
  { field: "title", label: "Title" },
  { field: "artist", label: "Artist" },
  { field: "disc", label: "Disc number" },
  { field: "album", label: "Album" },
  { field: "year", label: "Year" },
];

/** The patterns tried, most specific first. A pattern that is only "%title%" is never offered as an answer. */
export const COMMON_PATTERNS = [
  "%disc%-%track% - %title%",
  "%disc%-%track% %title%",
  "%track% - %artist% - %title%",
  "%artist% - %track% - %title%",
  "%track% - %title%",
  "%track%. %title%",
  "%track%-%title%",
  "%track% %title%",
  "%artist% - %title%",
];

const LETTERS = new Set<NameField>(["artist", "title", "album"]);

export type Compiled = { pattern: string; regex: RegExp; fields: NameField[] };

/** A pattern as a matcher, or an error in words (an unknown %field%, a field twice, nothing to match). */
export function compilePattern(pattern: string): Compiled | { error: string } {
  const text = pattern.trim();
  if (!text) return { error: "Type a pattern, for example %track% - %title%." };
  const known = new Set(NAME_FIELDS.map((f) => f.field));
  const fields: NameField[] = [];
  let source = "";
  let last = 0;
  for (const match of text.matchAll(/%([a-z]+)%/gi)) {
    const field = match[1].toLowerCase() as NameField;
    if (!known.has(field)) return { error: `“%${match[1]}%” is not a field this can fill (use ${NAME_FIELDS.map((f) => `%${f.field}%`).join(", ")}).` };
    if (fields.includes(field)) return { error: `%${field}% is used twice.` };
    source += escape(text.slice(last, match.index)) + (field === "year" ? "(\\d{4})" : LETTERS.has(field) ? "(.+?)" : "(\\d{1,3})");
    fields.push(field);
    last = (match.index ?? 0) + match[0].length;
  }
  if (!fields.length) return { error: "The pattern needs at least one field such as %title%." };
  source += escape(text.slice(last));
  return { pattern: text, regex: new RegExp(`^${source}$`, "i"), fields };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name with underscores for spaces ("01_Bleed_Black") reads as spaces. */
function tidy(stem: string): string {
  return /\s/.test(stem) || !stem.includes("_") ? stem : stem.replace(/_+/g, " ");
}

/** What a file name says under a pattern, or null when the name does not fit it. */
export function parseName(compiled: Compiled, stem: string): Partial<Record<NameField, string>> | null {
  const match = compiled.regex.exec(stem.trim()) ?? compiled.regex.exec(tidy(stem).trim());
  if (!match) return null;
  const out: Partial<Record<NameField, string>> = {};
  const underscores = !/\s/.test(stem);
  compiled.fields.forEach((field, index) => {
    const raw = match[index + 1].trim();
    const value = underscores && LETTERS.has(field) ? raw.replace(/_+/g, " ").trim() : raw;
    out[field] = field === "track" || field === "disc" ? String(Number(value)) : value;
  });
  return out;
}

export type PatternFit = { pattern: string; matched: number; total: number; sane: boolean; sample: Partial<Record<NameField, string>>[] };

/** How well one pattern fits the folder's file names. `sane`: track numbers (when the pattern has them) are not repeated. */
export function fitPattern(pattern: string, stems: readonly string[]): PatternFit | null {
  const compiled = compilePattern(pattern);
  if ("error" in compiled) return null;
  const parsed = stems.map((stem) => parseName(compiled, stem));
  const hits = parsed.filter((p): p is Partial<Record<NameField, string>> => p !== null);
  const tracks = hits.map((h) => `${h.disc ?? ""}/${h.track ?? ""}`);
  // A loose pattern can "fit" by swallowing a separator ("%track% %title%" reads "01 - Song" as the title "- Song") or by taking a
  // track number for an artist; such a fit is not a real one.
  const looksWrong = (h: Partial<Record<NameField, string>>): boolean =>
    (["artist", "title", "album"] as const).some((f) => /^[-–—._,]/.test(h[f] ?? "")) || (["artist", "album"] as const).some((f) => /^\d+$/.test(h[f] ?? ""));
  // Every title starting with its own number ("01 Intro" under %track%-%title% for "1-01 Intro") means the pattern missed a field.
  const numberedTitles = compiled.fields.includes("title") && hits.length > 0 && hits.every((h) => /^\d{1,3}[\s.]/.test(h.title ?? ""));
  const sane = (!compiled.fields.includes("track") || new Set(tracks).size === tracks.length) && !hits.some(looksWrong) && !numberedTitles;
  return { pattern: compiled.pattern, matched: hits.length, total: stems.length, sane, sample: hits.slice(0, 4) };
}

export type Detection = {
  /** The pattern to use without asking: exactly one fits every file. */
  obvious: string | null;
  /** Patterns that fit every file, or nearly (at least 80 %), best first. */
  choices: PatternFit[];
};

/** Tries the usual patterns on the folder's file names (without extensions). */
export function detectPattern(stems: readonly string[]): Detection {
  if (stems.length === 0) return { obvious: null, choices: [] };
  const fits = COMMON_PATTERNS.map((p) => fitPattern(p, stems)).filter((f): f is PatternFit => f !== null && f.sane && f.matched > 0);
  const full = fits.filter((f) => f.matched === f.total);
  const near = fits.filter((f) => f.matched < f.total && f.matched / f.total >= 0.8);
  // One full fit is obvious, unless it only fits because it is a looser form of another ("%track% %title%" also reads "01 - Song"),
  // which the stricter patterns above would have caught first as a different single fit.
  return { obvious: full.length === 1 ? full[0].pattern : null, choices: [...full, ...near] };
}

/** The edits (path to field to value) a pattern gives for the files, in the table's field names. Files that do not fit get none. */
export function editsFromNames(files: readonly { path: string; stem: string }[], pattern: string): Record<string, Record<string, string>> {
  const compiled = compilePattern(pattern);
  const edits: Record<string, Record<string, string>> = {};
  if ("error" in compiled) return edits;
  for (const file of files) {
    const parsed = parseName(compiled, file.stem);
    if (!parsed) continue;
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(parsed)) {
      if (!value) continue;
      fields[field] = value;
    }
    if (Object.keys(fields).length) edits[file.path] = fields;
  }
  return edits;
}
