// The editing rules of the lyrics timing editor (owner, 2026-11-22: "as easy to use as a good Word document, with a now button and a time stamp on each line"):
// a song's lyrics are lines, each with a time or none; the person selects several lines, copies, cuts and pastes them between other lines, splits a line with Enter,
// joins two with Backspace or Delete, and undoes it all. No DOM here, so it is unit tested; `lyric-timing-editor.ts` turns the browser's selection into these positions.
//
// Times: a line keeps its time while its words are edited; when a line is split the second half has no time; text pasted or typed in as new lines has no time
// (a repeated chorus is sung at a new moment, so its lines are timed again with "now"); two lines joined keep the first one's time.

import type { SyncLine } from "./lyrics-sync";

/** A place in the lyrics: the line (from 0) and the character in it (from 0). */
export type Pos = { row: number; col: number };
export type Edit = { lines: SyncLine[]; caret: Pos };

const clampPos = (lines: SyncLine[], pos: Pos): Pos => {
  const row = Math.min(Math.max(pos.row, 0), Math.max(lines.length - 1, 0));
  return { row, col: Math.min(Math.max(pos.col, 0), lines[row]?.text.length ?? 0) };
};

/** `a` before `b`, or the same place. */
export function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

/** Enter: the line splits at the caret; the second half has no time. */
export function splitLine(lines: SyncLine[], at: Pos): Edit {
  const p = clampPos(lines, at);
  const line = lines[p.row] ?? { text: "", ms: null };
  const next = [...lines];
  next.splice(p.row, 1, { text: line.text.slice(0, p.col), ms: line.ms }, { text: line.text.slice(p.col), ms: null });
  return { lines: next, caret: { row: p.row + 1, col: 0 } };
}

/** Everything between two places removed (a selection deleted or cut); the first line keeps its time and takes what is left of the last one. */
export function deleteRange(lines: SyncLine[], a: Pos, b: Pos): Edit {
  const [from, to] = ordered(clampPos(lines, a), clampPos(lines, b));
  if (lines.length === 0) return { lines, caret: { row: 0, col: 0 } };
  const first = lines[from.row]!;
  const joined: SyncLine = { text: first.text.slice(0, from.col) + lines[to.row]!.text.slice(to.col), ms: first.ms };
  const next = [...lines];
  next.splice(from.row, to.row - from.row + 1, joined);
  return { lines: next, caret: from };
}

/** Backspace at the start of a line: it joins the line before (which keeps its time). Nothing happens on the first line. */
export function joinWithPrevious(lines: SyncLine[], row: number): Edit {
  if (row <= 0 || row >= lines.length) return { lines, caret: { row: Math.max(0, row), col: 0 } };
  return deleteRange(lines, { row: row - 1, col: lines[row - 1]!.text.length }, { row, col: 0 });
}

/** Delete at the end of a line: the next line joins it. */
export function joinWithNext(lines: SyncLine[], row: number): Edit {
  if (row < 0 || row >= lines.length - 1) return { lines, caret: { row: Math.max(0, row), col: lines[row]?.text.length ?? 0 } };
  return deleteRange(lines, { row, col: lines[row]!.text.length }, { row: row + 1, col: 0 });
}

/**
 * Text typed or pasted at a place (a selection is deleted first by the caller). Text with no line break goes into the line. Text of several lines splits the line at the
 * caret: the first piece joins the text before the caret, the last the text after it, and the lines between become new lines without times. Whole lines (the text ends
 * with a line break) pasted at the very start of a line go in above it, so copied lines can be dropped between existing ones without splitting anything.
 */
export function insertText(lines: SyncLine[], at: Pos, text: string): Edit {
  const clean = text.replace(/\r\n?/g, "\n");
  if (lines.length === 0) {
    const pieces = clean.replace(/\n$/, "").split("\n");
    return { lines: pieces.map((t) => ({ text: t, ms: null })), caret: { row: pieces.length - 1, col: pieces[pieces.length - 1]!.length } };
  }
  const p = clampPos(lines, at);
  const line = lines[p.row]!;
  const pieces = clean.split("\n");
  if (pieces.length === 1) {
    const next = [...lines];
    next[p.row] = { text: line.text.slice(0, p.col) + clean + line.text.slice(p.col), ms: line.ms };
    return { lines: next, caret: { row: p.row, col: p.col + clean.length } };
  }
  if (clean.endsWith("\n") && p.col === 0) {
    const whole = clean.slice(0, -1).split("\n").map((t): SyncLine => ({ text: t, ms: null }));
    const next = [...lines];
    next.splice(p.row, 0, ...whole);
    return { lines: next, caret: { row: p.row + whole.length, col: 0 } };
  }
  const head = line.text.slice(0, p.col) + pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  const middle = pieces.slice(1, -1).map((t): SyncLine => ({ text: t, ms: null }));
  const next = [...lines];
  next.splice(p.row, 1, { text: head, ms: line.ms }, ...middle, { text: last + line.text.slice(p.col), ms: null });
  return { lines: next, caret: { row: p.row + pieces.length - 1, col: last.length } };
}

/** The words between two places as plain text, lines separated by a line break (what a copy puts on the clipboard). Times are not copied. */
export function textBetween(lines: SyncLine[], a: Pos, b: Pos): string {
  const [from, to] = ordered(clampPos(lines, a), clampPos(lines, b));
  if (lines.length === 0) return "";
  if (from.row === to.row) return lines[from.row]!.text.slice(from.col, to.col);
  const parts = [lines[from.row]!.text.slice(from.col)];
  for (let r = from.row + 1; r < to.row; r += 1) parts.push(lines[r]!.text);
  parts.push(lines[to.row]!.text.slice(0, to.col));
  return parts.join("\n");
}

/** Whether a line's words changed or the lines were added, removed or moved (so more than the times have to be redrawn). */
export function sameWords(a: SyncLine[], b: SyncLine[]): boolean {
  return a.length === b.length && a.every((line, i) => line.text === b[i]!.text);
}

/** Undo and redo: snapshots of the lines, with the caret to come back to. Typing in one line is one step, not one per letter (`coalesce`). */
export class History {
  private past: Edit[] = [];
  private future: Edit[] = [];
  private lastKey = "";
  private lastAt = 0;

  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit = 200, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }

  /** Remembers the state before a change. Changes with the same non-empty `key` within `windowMs` of each other are one step. */
  record(before: Edit, key = "", windowMs = 800): void {
    const at = this.now();
    if (key && key === this.lastKey && at - this.lastAt <= windowMs && this.past.length > 0) {
      this.lastAt = at;
      return;
    }
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.lastKey = key;
    this.lastAt = at;
  }

  undo(current: Edit): Edit | null {
    const before = this.past.pop();
    if (!before) return null;
    this.future.push(current);
    this.lastKey = "";
    return before;
  }

  redo(current: Edit): Edit | null {
    const after = this.future.pop();
    if (!after) return null;
    this.past.push(current);
    this.lastKey = "";
    return after;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
