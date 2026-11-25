// Spelling by region (owner, 2026-11-23): American English is the default; British, Canadian, New Zealand and Australian English are choices. Only the spelling of
// the program's own words changes (colour/color, organise/organize, levelling/leveling...), never the names of songs, albums or artists, so it is applied only to
// the program's own text (see dialect-ui.ts). Pure, so it is unit tested. The word lists are curated, not rules: advertise, surprise and exercise are spelt with
// -ise everywhere, so a general -ise to -ize rule would be wrong.

export type Dialect = "en-US" | "en-GB" | "en-CA" | "en-NZ" | "en-AU";

export const DIALECTS: { id: Dialect; label: string; note: string }[] = [
  { id: "en-US", label: "English (United States)", note: "color, organize, leveling" },
  { id: "en-GB", label: "English (United Kingdom)", note: "colour, organise, levelling" },
  { id: "en-CA", label: "English (Canada)", note: "colour, organize, levelling" },
  { id: "en-NZ", label: "English (New Zealand)", note: "colour, organise, levelling" },
  { id: "en-AU", label: "English (Australia)", note: "colour, organise, levelling" },
];

export const DEFAULT_DIALECT: Dialect = "en-US";

export function cleanDialect(value: unknown): Dialect {
  return DIALECTS.find((d) => d.id === value)?.id ?? DEFAULT_DIALECT;
}

type Family = { us: string; cw: string; endings: string[] };

/** Spellings the Commonwealth varieties share: -our, -re, grey, doubled l, catalogue, licence, defence. */
const SHARED: Family[] = [
  { us: "color", cw: "colour", endings: ["", "s", "ed", "ing", "ful", "less"] },
  { us: "favor", cw: "favour", endings: ["", "s", "ed", "ing"] },
  { us: "favorite", cw: "favourite", endings: ["", "s"] },
  { us: "honor", cw: "honour", endings: ["", "s", "ed", "ing"] },
  { us: "behavior", cw: "behaviour", endings: ["", "s", "al"] },
  { us: "neighbor", cw: "neighbour", endings: ["", "s", "hood", "hoods"] },
  { us: "flavor", cw: "flavour", endings: ["", "s", "ed"] },
  { us: "humor", cw: "humour", endings: ["", "s"] },
  { us: "labor", cw: "labour", endings: ["", "s"] },
  { us: "rumor", cw: "rumour", endings: ["", "s"] },
  { us: "center", cw: "centre", endings: ["", "s"] },
  { us: "centered", cw: "centred", endings: [""] },
  { us: "centering", cw: "centring", endings: [""] },
  { us: "theater", cw: "theatre", endings: ["", "s"] },
  { us: "fiber", cw: "fibre", endings: ["", "s"] },
  { us: "gray", cw: "grey", endings: ["", "s", "ed", "ish"] },
  { us: "leveling", cw: "levelling", endings: [""] },
  { us: "leveled", cw: "levelled", endings: [""] },
  { us: "canceled", cw: "cancelled", endings: [""] },
  { us: "canceling", cw: "cancelling", endings: [""] },
  { us: "labeled", cw: "labelled", endings: [""] },
  { us: "labeling", cw: "labelling", endings: [""] },
  { us: "traveling", cw: "travelling", endings: [""] },
  { us: "modeling", cw: "modelling", endings: [""] },
  { us: "signaled", cw: "signalled", endings: [""] },
  { us: "catalog", cw: "catalogue", endings: ["", "s"] },
  { us: "cataloged", cw: "catalogued", endings: [""] },
  { us: "cataloging", cw: "cataloguing", endings: [""] },
  { us: "license", cw: "licence", endings: ["", "s"] },
  { us: "defense", cw: "defence", endings: ["", "s"] },
];

const IZE_STEMS = ["organ", "custom", "recogn", "normal", "minim", "maxim", "optim", "synchron", "categor", "author", "summar", "initial", "final", "util", "person", "priorit", "visual", "standard", "real", "special", "general", "local", "digit", "capital", "character", "emphas", "apolog", "harmon", "memor", "mobil", "modern", "central", "stabil"];
const IZE_ENDINGS: [string, string][] = [["ize", "ise"], ["izes", "ises"], ["ized", "ised"], ["izing", "ising"], ["ization", "isation"], ["izations", "isations"], ["izer", "iser"], ["izers", "isers"]];
const YZE: Family = { us: "analyze", cw: "analyse", endings: [""] };

/** Spellings only some varieties use: -ise and -yse (British, New Zealand, Australian; Canadians write -ize). */
const ISE: Family[] = [
  ...IZE_STEMS.flatMap((stem) => IZE_ENDINGS.map(([us, cw]) => ({ us: stem + us, cw: stem + cw, endings: [""] }))),
  ...["", "s", "d"].map((e) => ({ us: `analyze${e}`, cw: `analyse${e}`, endings: [""] })),
  { us: "analyzing", cw: "analysing", endings: [""] },
  { us: "analyzer", cw: "analyser", endings: ["", "s"] },
];
void YZE;

function pairs(families: Family[]): [string, string][] {
  return families.flatMap((f) => f.endings.map((e): [string, string] => [f.us + e, f.cw + e]));
}

const SHARED_PAIRS = pairs(SHARED);
const ISE_PAIRS = pairs(ISE);

/** Whether a variety writes the Commonwealth form of each family. */
function uses(dialect: Dialect): { shared: boolean; ise: boolean } {
  switch (dialect) {
    case "en-US":
      return { shared: false, ise: false };
    case "en-CA":
      return { shared: true, ise: false };
    default:
      return { shared: true, ise: true };
  }
}

const compiled = new Map<Dialect, { re: RegExp; map: Map<string, string> }>();

function tableFor(dialect: Dialect): { re: RegExp; map: Map<string, string> } {
  const found = compiled.get(dialect);
  if (found) return found;
  const want = uses(dialect);
  const map = new Map<string, string>();
  const add = (list: [string, string][], commonwealth: boolean): void => {
    for (const [us, cw] of list) {
      if (commonwealth) map.set(us, cw);
      else map.set(cw, us);
    }
  };
  add(SHARED_PAIRS, want.shared);
  add(ISE_PAIRS, want.ise);
  const words = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const table = { re, map };
  compiled.set(dialect, table);
  return table;
}

function withCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0]!.toUpperCase()) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
}

/** The text spelt the way `dialect` spells it. */
export function convertText(text: string, dialect: Dialect): string {
  if (!text) return text;
  const { re, map } = tableFor(dialect);
  return text.replace(re, (word) => {
    const to = map.get(word.toLowerCase());
    return to ? withCase(word, to) : word;
  });
}
