import assert from "node:assert/strict";
import { test } from "node:test";
import { clickRow, rangeKeys } from "./lyrics-select.ts";

const order = ["a", "b", "c", "d", "e", "f"];

test("a range runs between two rows, either way round", () => {
  assert.deepEqual(rangeKeys(order, 1, 3), ["b", "c", "d"]);
  assert.deepEqual(rangeKeys(order, 4, 2), ["c", "d", "e"]);
  assert.deepEqual(rangeKeys(order, 2, 2), ["c"]);
  assert.deepEqual(rangeKeys(order, 0, 9), [], "a row that is not shown gives nothing");
});

test("a click ticks one row; shift-click ticks everything down to it", () => {
  let state = clickRow(new Set(), order, null, 1, true, false);
  assert.deepEqual([...state.selected], ["b"]);
  state = clickRow(state.selected, order, state.anchor, 4, true, true);
  assert.deepEqual([...state.selected].sort(), ["b", "c", "d", "e"]);
  // shift-click on a ticked row's box unticks the whole stretch
  state = clickRow(state.selected, order, state.anchor, 2, false, true);
  assert.deepEqual([...state.selected], ["b"]);
});

test("shift without an earlier click is an ordinary click", () => {
  const state = clickRow(new Set(), order, null, 3, true, true);
  assert.deepEqual([...state.selected], ["d"]);
});
