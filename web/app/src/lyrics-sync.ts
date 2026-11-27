// Pure logic for the lyrics timing editor in Review › Lyrics › To review (owner, 2026-11-06): a candidate's lines,
// each with a time or none, moved earlier or later while the song plays, and turned into the text saved in the song
// (time-stamped .lrc text when every line has a time, plain words otherwise). No DOM, so it is unit tested.

/** `mine`: the person timed this line by hand (a tap, now, a nudge). The Lyric AI keeps such a line where it is and times the others around it (D172). */
export type SyncLine = { text: string; ms: number | null; mine?: boolean };

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** The lines of a candidate: its time-stamped lyrics when it has them, else its plain words without times. */
export function linesOf(synced: string | null, plain: string | null): SyncLine[] {
  if (synced && synced.trim()) {
    const lines: SyncLine[] = [];
    for (const raw of synced.replace(/\r\n?/g, "\n").split("\n")) {
      const stamps = [...raw.matchAll(STAMP)];
      if (stamps.length === 0) continue; // [ar:…] and similar header tags, or stray text
      const text = raw.replace(STAMP, "").trim();
      for (const stamp of stamps) {
        const fraction = stamp[3] ?? "0";
        const ms = Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + Math.round(Number(`0.${fraction}`) * 1000);
        lines.push({ text, ms });
      }
    }
    if (lines.length > 0) return lines.sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
  }
  const words = (plain ?? "").replace(/\r\n?/g, "\n").split("\n").map((t) => t.trim());
  while (words.length && words[0] === "") words.shift();
  while (words.length && words[words.length - 1] === "") words.pop();
  return words.map((text) => ({ text, ms: null }));
}

const sung = (line: SyncLine): boolean => line.text !== "";

const LABEL_WORDS = new Set(["chorus", "verse", "bridge", "intro", "outro", "instrumental", "solo", "guitar solo", "refrain", "pre-chorus", "pre chorus", "hook", "interlude", "break"]);

/**
 * Whether a line of a band's lyrics is a section label (`[Chorus]`, `(Instrumental)`, `Verse 2`) and not sung. The same rule as the Lyric AI's timing step:
 * a line in square brackets is always a label; one in parentheses only when it names a label word (`(Ooh, ooh)` is sung).
 */
export function isSectionLabel(line: string): boolean {
  const t = line.trim();
  if (/^\[.*\]$/.test(t)) return true;
  const inner = /^\((.*)\)$/.exec(t)?.[1] ?? t;
  return LABEL_WORDS.has(inner.trim().replace(/[\d\s:]+$/, "").toLowerCase());
}

/** The words with the section labels taken out (blank lines between verses stay). */
export function withoutLabels(plain: string | null): string {
  return (plain ?? "").replace(/\r\n?/g, "\n").split("\n").filter((line) => !isSectionLabel(line)).join("\n");
}

/** mm:ss.cc, the .lrc form. */
export function stampText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const minutes = Math.floor(total / 6000);
  const seconds = Math.floor((total % 6000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
}

/** One line moved earlier (negative) or later; never before the start. A line without a time stays without. */
export function nudge(lines: SyncLine[], index: number, deltaMs: number): SyncLine[] {
  return lines.map((line, i) => (i === index && line.ms !== null ? { ...line, ms: Math.max(0, line.ms + deltaMs), mine: true } : line));
}

/** Every timed line moved by the same amount (the whole song's lyrics a little early or late). */
export function shiftAll(lines: SyncLine[], deltaMs: number): SyncLine[] {
  return lines.map((line) => (line.ms === null ? line : { ...line, ms: Math.max(0, line.ms + deltaMs) }));
}

/** One line given the time `ms` (the place the song is at). */
export function stamp(lines: SyncLine[], index: number, ms: number): SyncLine[] {
  return lines.map((line, i) => (i === index ? { ...line, ms: Math.max(0, Math.round(ms)), mine: true } : line));
}

export function clearTimes(lines: SyncLine[]): SyncLine[] {
  return lines.map(({ text }) => ({ text, ms: null }));
}

/** What the Lyric AI is asked: the sung lines (not blank, not a section label) with their numbers in `lines`, and which were timed by hand. `all`: ignore the hand timing. */
export function aiRequest(lines: SyncLine[], all = false): { at: number[]; lines: { text: string; ms: number | null; mine: boolean }[] } {
  const at: number[] = [];
  const sent: { text: string; ms: number | null; mine: boolean }[] = [];
  lines.forEach((line, i) => {
    if (line.text.trim() === "" || isSectionLabel(line.text)) return;
    at.push(i);
    sent.push({ text: line.text.trim(), ms: line.ms, mine: !all && line.mine === true && line.ms !== null });
  });
  return { at, lines: sent };
}

/**
 * The Lyric AI's answer put into the lines (`at`: the number in `lines` of each line it was sent). A line is taken only when it still says what was sent (the person may have
 * kept editing while it listened). The lines the AI placed get its time and are no longer "mine"; a line it could not place keeps what it had. Returns the new lines and how many took a time.
 */
export function takeAiTimes(lines: SyncLine[], at: number[], sent: { text: string }[], answer: { ms: number; placed: boolean }[], all = false): { lines: SyncLine[]; taken: number; kept: number } {
  const next = lines.map((line) => ({ ...line }));
  let taken = 0;
  let kept = 0;
  at.forEach((row, k) => {
    const line = next[row];
    const reply = answer[k];
    if (!line || !reply || line.text.trim() !== sent[k]?.text) return;
    if (!all && line.mine === true && line.ms !== null) {
      kept += 1; // a hand-timed line stays exactly as it is
      return;
    }
    if (!reply.placed) return;
    line.ms = reply.ms;
    delete line.mine;
    taken += 1;
  });
  return { lines: next, taken, kept };
}

/** The first sung line still without a time, or -1: the line the Tap button times next. */
export function nextUntimed(lines: SyncLine[]): number {
  return lines.findIndex((line) => sung(line) && line.ms === null);
}

/** The line being sung at `ms`: the last timed line, in list order, that has started. -1 before the first. */
export function lineAt(lines: SyncLine[], ms: number): number {
  let found = -1;
  lines.forEach((line, i) => {
    if (line.ms !== null && line.ms <= ms) found = i;
  });
  return found;
}

/** How many sung lines have a time, of how many. */
export function timedCount(lines: SyncLine[]): { timed: number; total: number } {
  const singing = lines.filter(sung);
  return { timed: singing.filter((l) => l.ms !== null).length, total: singing.length };
}

/**
 * The text to save into the song: .lrc text (in time order, without the blank lines between verses) when every sung
 * line has a time, otherwise the plain words with their verse breaks.
 */
export function textToSave(lines: SyncLine[]): { text: string; synced: boolean } {
  const { timed, total } = timedCount(lines);
  if (total > 0 && timed === total) {
    const ordered = lines.filter(sung).sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
    return { text: ordered.map((l) => `[${stampText(l.ms ?? 0)}]${l.text}`).join("\n"), synced: true };
  }
  return { text: lines.map((l) => l.text).join("\n"), synced: false };
}

export type ReviewCandidate = {
  track: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  confidence: number;
  synced: boolean | string | null;
  other_version?: boolean;
  other_artist?: boolean;
  length_unknown?: boolean;
  /** "lyric-ai" for a pick the Lyric AI checked against the singing (and timed); its confidence is how well the words fit what is sung. */
  source?: string | null;
  /** A timing result for the song's own words (a band's, with its labels): approving it replaces only the timing, never the words (D169). */
  band_words?: boolean;
};

/** Whether the lines in the editor still say the same words as `original` (one line per row): blank lines and spacing do not count. Times do not matter. */
export function sameSungWords(lines: SyncLine[], original: string | null): boolean {
  const clean = (texts: string[]): string[] => texts.map((t) => t.trim()).filter(Boolean);
  const before = clean((original ?? "").split(/\r?\n/));
  const now = clean(lines.map((l) => l.text));
  return before.length === now.length && before.every((t, i) => t === now[i]);
}

/** "another version (live or an edit)", "the same song by another artist" or "", for the list and the editor. */
export function candidateKind(c: ReviewCandidate): string {
  if (c.source === "whisper-draft") return "AI draft from listening: check the words";
  if (c.source === "lyric-ai") return "AI-checked against the singing";
  if (c.source === "photo") return "Read from a booklet photo: check every word";
  if (c.source === "yours") return "typed or pasted here";
  if (c.other_artist) return "same song, another artist";
  if (c.other_version) return "another version";
  if (c.length_unknown) return "length not compared";
  return "same length";
}

const normalised = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** How alike two lines are, 0 to 1 (letters and digits only, by edit distance). */
function likeness(a: string, b: string): number {
  if (a === b) return 1;
  if (a === "" || b === "") return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
}

/**
 * The words of `target` (no times) given the times of the same song's `donor` lines, line by line in order: each sung line takes the time of the next donor line
 * (looking a few ahead) that says nearly the same. Lines with no match keep no time. Used when the Lyric AI timed a booklet-photo candidate as a separate candidate.
 */
export function carryTimes(target: SyncLine[], donor: SyncLine[]): { lines: SyncLine[]; carried: number; total: number } {
  const timed = donor.filter((line) => line.ms !== null && line.text.trim() !== "");
  let next = 0;
  let carried = 0;
  let total = 0;
  const lines = target.map((line) => {
    if (!sung(line)) return line;
    total += 1;
    const text = normalised(line.text);
    let best = -1;
    let bestScore = 0;
    for (let k = next; k < Math.min(timed.length, next + 8); k += 1) {
      const score = likeness(text, normalised(timed[k]!.text));
      if (score > bestScore) {
        best = k;
        bestScore = score;
        if (score === 1) break;
      }
    }
    if (best < 0 || bestScore < 0.75) return line;
    next = best + 1;
    carried += 1;
    return { ...line, ms: timed[best]!.ms };
  });
  return { lines, carried, total };
}