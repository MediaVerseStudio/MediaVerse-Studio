import { test } from "node:test";
import assert from "node:assert/strict";
import { letterStarts, playWindow, positionNow, queueInPlayOrder, rowForLetter, songsAndLength, visibleRange } from "./phone-logic.ts";

test("letters jump to their first row, or the next letter that has one", () => {
  const starts = letterStarts(["10cc", "AFI", "Aqua", "The Beatles", "Descendents"]);
  assert.equal(starts.get("#"), 0);
  assert.equal(starts.get("A"), 1);
  assert.equal(starts.get("B"), 3, "a leading The is ignored");
  assert.equal(rowForLetter(starts, "C", 5), 4, "no C: the D that follows");
  assert.equal(rowForLetter(starts, "Z", 5), 4, "nothing after: the last row");
});

test("only the rows on screen and a few around them are drawn", () => {
  assert.deepEqual(visibleRange(0, 600, 60, 13546), [0, 18]);
  assert.deepEqual(visibleRange(6000, 600, 60, 13546), [92, 118]);
  assert.deepEqual(visibleRange(0, 600, 60, 3), [0, 3]);
});

test("the clock moves on between the app's updates while playing, never past the end", () => {
  assert.equal(positionNow({ position: 1000, duration: 5000, playing: true }, 100, 400), 1300);
  assert.equal(positionNow({ position: 1000, duration: 5000, playing: false }, 100, 400), 1000);
  assert.equal(positionNow({ position: 4900, duration: 5000, playing: true }, 0, 1000), 5000);
});

test("a long list plays from the chosen song, a short one keeps everything", () => {
  const many = Array.from({ length: 5000 }, (_, i) => i);
  assert.deepEqual(playWindow(many, 4500, 1000).items.slice(0, 2), [4500, 4501]);
  assert.equal(playWindow(many, 4500, 1000).items.length, 500);
  assert.deepEqual(playWindow([1, 2, 3], 2), { items: [1, 2, 3], index: 2 });
});

test("the queue is shown in play order", () => {
  assert.deepEqual(queueInPlayOrder(["a", "b", "c"], [2, 0, 1]), [{ id: "c", index: 2 }, { id: "a", index: 0 }, { id: "b", index: 1 }]);
  assert.deepEqual(queueInPlayOrder(["a", "b"], undefined), [{ id: "a", index: 0 }, { id: "b", index: 1 }]);
});

test("album lengths read naturally", () => {
  assert.equal(songsAndLength(1, 200_000), "1 song, 3 min");
  assert.equal(songsAndLength(24, 95 * 60_000), "24 songs, 1 h 35 min");
});
