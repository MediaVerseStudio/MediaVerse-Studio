import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, directionOf, nextInDirection, type Box } from "./spatial.ts";

const box = (left: number, top: number, width = 100, height = 100): Box => ({ left, top, width, height });

// A 3 x 2 grid of tiles 100 px square with 20 px gaps.
const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 120), box(120, 120), box(240, 120)];

test("moves within a grid", () => {
  assert.equal(nextInDirection(grid[0], grid, "right"), 1);
  assert.equal(nextInDirection(grid[1], grid, "down"), 4);
  assert.equal(nextInDirection(grid[4], grid, "left"), 3);
  assert.equal(nextInDirection(grid[5], grid, "up"), 2);
});

test("nothing beyond the edge", () => {
  assert.equal(nextInDirection(grid[2], grid, "right"), -1);
  assert.equal(nextInDirection(grid[0], grid, "up"), -1);
});

test("a short last row: down from the last column goes to the nearest tile below", () => {
  const items = [box(0, 0), box(120, 0), box(240, 0), box(0, 120)];
  assert.equal(nextInDirection(items[2], items, "down"), 3);
});

test("an aligned item wins over a nearer diagonal one", () => {
  // From a wide menu bar item, down to the tile under it rather than a closer one off to the side.
  const from = box(500, 0, 200, 50);
  const items = [box(300, 60, 100, 100), box(550, 200, 100, 100)];
  assert.equal(nextInDirection(from, items, "down"), 1);
});

test("hidden (zero-size) items are skipped", () => {
  assert.equal(nextInDirection(grid[0], [box(120, 0, 0, 0), grid[2]], "right"), 1);
});

test("remote keys", () => {
  assert.equal(directionOf({ keyCode: 37 }), "left");
  assert.equal(directionOf({ key: "ArrowDown" }), "down");
  assert.equal(directionOf({ key: "a" }), null);
  assert.equal(commandOf({ keyCode: 10009 }), "back");
  assert.equal(commandOf({ keyCode: 10252 }), "playPause");
  assert.equal(commandOf({ key: "Enter", keyCode: 13 }), "ok");
  assert.equal(commandOf({ key: "MediaTrackNext" }), "next");
  assert.equal(commandOf({ key: "x" }), null);
});
