import { test } from "node:test";
import assert from "node:assert/strict";
import { countdown, smartList } from "./smart-lists.ts";
import type { PhoneTrack } from "./native.ts";

const track = (id: string, added = 0): PhoneTrack => ({ id, title: id, added, duration_ms: 1000 }) as unknown as PhoneTrack;
const tracks = [track("a", 10), track("b", 30), track("c", 20), track("d", 0)];

test("recently played: the latest first; never played songs are left out", () => {
  const stats = { a: [1, 100], c: [5, 300] } as Record<string, [number, number]>;
  assert.deepEqual(smartList("recent", tracks, stats).map((t) => t.id), ["c", "a"]);
});

test("recently added: newest first, songs with no date left out; and the limit applies", () => {
  assert.deepEqual(smartList("added", tracks, {}).map((t) => t.id), ["b", "c", "a"]);
  assert.deepEqual(smartList("added", tracks, {}, 2).map((t) => t.id), ["b", "c"]);
});

test("not played yet: everything with no plays, in library order", () => {
  assert.deepEqual(smartList("never", tracks, { b: [1, 1] }).map((t) => t.id), ["a", "c", "d"]);
});

test("the countdown reads as minutes and seconds, rounding up", () => {
  assert.equal(countdown(725_000), "12:05");
  assert.equal(countdown(1), "0:01");
  assert.equal(countdown(-5), "0:00");
});
