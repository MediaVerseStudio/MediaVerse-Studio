import assert from "node:assert/strict";
import { test } from "node:test";
import { currentLine, plainLines, sortedLines, sourceLabel } from "./lyrics-format.ts";

const lines = [
  { ms: 1000, text: "one" },
  { ms: 4000, text: "two" },
  { ms: 9000, text: "three" },
];

test("the current line is the last one that has started", () => {
  assert.equal(currentLine(lines, 0), -1);
  assert.equal(currentLine(lines, 999), -1);
  assert.equal(currentLine(lines, 1000), 0);
  assert.equal(currentLine(lines, 3999), 0);
  assert.equal(currentLine(lines, 4000), 1);
  assert.equal(currentLine(lines, 600_000), 2);
  assert.equal(currentLine([], 5000), -1);
});

test("lines are put in time order and plain lyrics keep their verse breaks", () => {
  assert.deepEqual(sortedLines([lines[2], lines[0], lines[1]]).map((l) => l.text), ["one", "two", "three"]);
  assert.deepEqual(plainLines("a\r\nb\n\nc"), ["a", "b", "", "c"]);
});

test("the source is named in words", () => {
  assert.match(sourceLabel("tag"), /tags/);
  assert.match(sourceLabel("lrc_file"), /\.lrc/);
  assert.equal(sourceLabel(null), "");
});
