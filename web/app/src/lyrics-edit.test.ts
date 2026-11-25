import assert from "node:assert/strict";
import { test } from "node:test";
import { type Edit, History, deleteRange, insertText, joinWithNext, joinWithPrevious, splitLine, textBetween } from "./lyrics-edit.ts";
import type { SyncLine } from "./lyrics-sync.ts";

const song: SyncLine[] = [
  { text: "Hey ho", ms: 1000 },
  { text: "Let's go", ms: 3000 },
  { text: "Hey ho", ms: 5000 },
];
const words = (lines: SyncLine[]): string[] => lines.map((l) => l.text);
const times = (lines: SyncLine[]): (number | null)[] => lines.map((l) => l.ms);

test("Enter splits a line: the first half keeps its time, the second has none", () => {
  const { lines, caret } = splitLine(song, { row: 1, col: 5 });
  assert.deepEqual(words(lines), ["Hey ho", "Let's", " go", "Hey ho"]);
  assert.deepEqual(times(lines), [1000, 3000, null, 5000]);
  assert.deepEqual(caret, { row: 2, col: 0 });
});

test("deleting a selection across lines joins what is left and keeps the first line's time", () => {
  const { lines, caret } = deleteRange(song, { row: 0, col: 4 }, { row: 2, col: 3 });
  assert.deepEqual(words(lines), ["Hey  ho"]);
  assert.deepEqual(times(lines), [1000]);
  assert.deepEqual(caret, { row: 0, col: 4 });
  const same = deleteRange(song, { row: 2, col: 3 }, { row: 0, col: 4 });
  assert.deepEqual(words(same.lines), words(lines), "the two ends can be given in either order");
});

test("Backspace at the start of a line joins the line before; Delete at the end joins the next", () => {
  const back = joinWithPrevious(song, 1);
  assert.deepEqual(words(back.lines), ["Hey hoLet's go", "Hey ho"]);
  assert.deepEqual(back.caret, { row: 0, col: 6 });
  assert.equal(joinWithPrevious(song, 0).lines, song, "nothing before the first line");
  const forward = joinWithNext(song, 0);
  assert.deepEqual(words(forward.lines), ["Hey hoLet's go", "Hey ho"]);
  assert.equal(joinWithNext(song, 2).lines, song, "nothing after the last line");
});

test("whole copied lines pasted at the start of a line go in above it, untimed, without splitting anything", () => {
  const { lines, caret } = insertText(song, { row: 2, col: 0 }, "Hey ho\nLet's go\n");
  assert.deepEqual(words(lines), ["Hey ho", "Let's go", "Hey ho", "Let's go", "Hey ho"]);
  assert.deepEqual(times(lines), [1000, 3000, null, null, 5000]);
  assert.deepEqual(caret, { row: 4, col: 0 });
});

test("text of several lines pasted in the middle of a line splits it like a word processor does", () => {
  const { lines, caret } = insertText(song, { row: 0, col: 3 }, "A\nB\nC");
  assert.deepEqual(words(lines), ["HeyA", "B", "C ho", "Let's go", "Hey ho"]);
  assert.deepEqual(times(lines), [1000, null, null, 3000, 5000]);
  assert.deepEqual(caret, { row: 2, col: 1 });
});

test("a single piece of text goes into the line and keeps its time", () => {
  const { lines, caret } = insertText(song, { row: 1, col: 0 }, "Oh, ");
  assert.equal(lines[1]!.text, "Oh, Let's go");
  assert.equal(lines[1]!.ms, 3000);
  assert.deepEqual(caret, { row: 1, col: 4 });
});

test("pasting into lyrics with no lines at all makes the lines", () => {
  const { lines } = insertText([], { row: 0, col: 0 }, "one\ntwo\n");
  assert.deepEqual(words(lines), ["one", "two"]);
});

test("a copy is the words between the ends, lines separated by line breaks, without times", () => {
  assert.equal(textBetween(song, { row: 0, col: 4 }, { row: 1, col: 5 }), "ho\nLet's");
  assert.equal(textBetween(song, { row: 1, col: 0 }, { row: 2, col: 0 }), "Let's go\n", "whole lines end with a line break so they paste back as whole lines");
});

test("undo and redo step back through the changes; typing in one line is one step", () => {
  let clock = 0;
  const history = new History(200, () => clock);
  const at = (lines: SyncLine[]): Edit => ({ lines, caret: { row: 0, col: 0 } });
  let state = at(song);
  const change = (next: SyncLine[], key = ""): void => {
    history.record(state, key);
    state = at(next);
    clock += 100;
  };
  change(splitLine(state.lines, { row: 0, col: 3 }).lines);
  change([{ text: "a", ms: null }], "type:0");
  change([{ text: "ab", ms: null }], "type:0");
  change([{ text: "abc", ms: null }], "type:0");
  assert.equal(history.undo(state)?.lines.length, 4, "the three letters were one step");
  const before = history.undo(at([{ text: "x", ms: null }]));
  assert.deepEqual(words(before!.lines), words(song));
  assert.equal(history.undo(state), null);
  assert.deepEqual(words(history.redo(at(song))!.lines), ["x"], "redo returns the state that was undone last");
  history.record(state);
  assert.equal(history.canRedo, false, "a new change forgets the redo steps");
});
