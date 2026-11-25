import assert from "node:assert/strict";
import { test } from "node:test";
import { fillTo, pickCollage, tileSpan } from "./collage.ts";

const t = (path: string) => ({ source_uri: path });
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("\\"));

test("one track per album folder, capped", () => {
  const tracks = [t("C:\\m\\A\\x\\1.mp3"), t("C:\\m\\A\\x\\2.mp3"), t("C:\\m\\B\\y\\1.mp3"), t("C:\\m\\C\\z\\1.mp3")];
  const picked = pickCollage(tracks, 10, folderOf);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((p) => p.source_uri.split("\\").slice(0, -1).join("\\"))).size, 3);
  assert.equal(pickCollage(tracks, 2, folderOf).length, 2);
  assert.deepEqual(pickCollage([], 5, folderOf), []);
});

test("tile sizes are mostly small with some larger ones", () => {
  const spans = Array.from({ length: 65 }, (_, i) => tileSpan(i));
  assert.ok(spans.every((s) => s === 1 || s === 2 || s === 3));
  assert.ok(spans.filter((s) => s === 1).length > spans.length / 2);
  assert.ok(spans.includes(3) && spans.includes(2));
});

test("a small set is repeated to fill the wall", () => {
  assert.deepEqual(fillTo(["a", "b"], 5), ["a", "b", "a", "b", "a"]);
  assert.deepEqual(fillTo([], 5), []);
});

import { rankCollage, tileSize } from "./collage.ts";

test("the playing album comes first, then the queue, then the same artist, then everything else", () => {
  const song = (folder: string, artist: string) => ({ source_uri: `C:\\m\\${folder}\\1.mp3`, artist });
  const library = [song("a", "Band"), song("b", "Other"), song("c", "band"), song("d", "Third"), song("e", "Fourth")];
  const queue = [song("d", "Third"), song("a", "Band")];
  const ranked = rankCollage(library, queue, library[0], 10, (p) => p.slice(0, p.lastIndexOf("\\")));
  const named = ranked.map((r) => [r.track.source_uri.split("\\")[2], r.tier]);
  assert.deepEqual(named.slice(0, 3), [["a", "current"], ["d", "queue"], ["c", "artist"]]);
  // The rest of the library follows in a varied (not alphabetical) order.
  assert.deepEqual(named.slice(3).map(([folder]) => folder).sort(), ["b", "e"]);
  assert.ok(named.slice(3).every(([, tier]) => tier === "library"));
  assert.equal(rankCollage(library, queue, library[0], 2, (p) => p.slice(0, p.lastIndexOf("\\"))).length, 2);
  assert.equal(rankCollage([], [], null, 5, (p) => p).length, 0);
});

test("emphasised covers are larger than the rest", () => {
  assert.equal(tileSize("current", 0), 3);
  assert.equal(tileSize("queue", 3), 2);
  assert.equal(tileSize("artist", 4), 2);
  assert.equal(tileSize("library", 5), 1);
});

import { hashText, planWall, varietySize } from "./collage.ts";

const folder = (p: string) => p.slice(0, p.lastIndexOf("\\"));
const album = (n: number, artist = "Band") => ({ source_uri: `C:\\m\\album${n}\\1.mp3`, artist });

test("sizes come from a stable hash and are varied", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  const sizes = Array.from({ length: 400 }, (_, i) => varietySize(hashText(`album${i}`)));
  for (const size of [1, 2, 3, 4]) assert.ok(sizes.includes(size as 1 | 2 | 3 | 4), `size ${size} occurs`);
  const small = sizes.filter((s) => s === 1).length;
  assert.ok(small > 140 && small < 260, `about half are small (${small})`);
});

test("the wall plan has the playing album biggest, varied sizes, and fills the screen", () => {
  const library = Array.from({ length: 60 }, (_, i) => album(i, i % 7 === 0 ? "Band" : `Other${i}`));
  const ranked = rankCollage(library, [library[5], library[9]], library[0], 90, folder);
  const plan = planWall(ranked, 160, folder);
  const current = plan.find((t) => t.tier === "current")!;
  assert.equal(current.size, 5);
  assert.equal(Math.max(...plan.map((t) => t.size)), 5, "nothing is bigger than the playing album");
  assert.ok(plan.filter((t) => t.size === 5).length === 1);
  assert.ok(new Set(plan.map((t) => t.size)).size >= 4, "at least four different sizes");
  assert.ok(plan.reduce((sum, t) => sum + t.size * t.size, 0) >= 160, "the plan covers the wall");
  assert.ok(plan.filter((t) => t.tier === "library" && t.size === 4).length <= 4, "few huge library tiles");
  const queued = plan.filter((t) => t.tier === "queue");
  assert.ok(queued.length >= 2 && queued.every((t) => t.size >= 2), "queue albums are at least medium");
  // The same input always gives the same wall.
  assert.deepEqual(planWall(ranked, 160, folder).map((t) => [t.track.source_uri, t.size]), plan.map((t) => [t.track.source_uri, t.size]));
});

test("large tiles are spread out, not clumped at the start", () => {
  const library = Array.from({ length: 80 }, (_, i) => album(i, `Artist${i}`));
  const plan = planWall(rankCollage(library, [], library[0], 80, folder), 200, folder);
  const positions = plan.map((t, i) => (t.size >= 3 ? i : -1)).filter((i) => i >= 0);
  assert.ok(positions.length >= 4);
  assert.ok(positions[positions.length - 1] - positions[0] > plan.length / 3, `large tiles span the order: ${positions.join(",")}`);
});

test("a tiny library still gets a varied, full wall", () => {
  const plan = planWall(rankCollage([album(1)], [], album(1), 10, folder), 150, folder);
  assert.ok(plan.length > 5);
  assert.ok(new Set(plan.map((t) => t.size)).size >= 3);
  assert.deepEqual(planWall([], 100, folder), []);
});
