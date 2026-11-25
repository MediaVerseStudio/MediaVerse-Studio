import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_WINNER, albumsByFolder, luckySettle, luckySpin, newAlbums, playedThreshold, recentlyPlayedAlbums, type HistoryEntry, type LibraryTrack } from "./home-format.ts";

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("\\"));
const track = (folder: string, name: string, n: number, album = folder): LibraryTrack => ({ title: name, artist: "A", album, source_uri: `${folder}\\${name}.mp3`, track_number: n });
const library = [track("C:\\m\\X", "two", 2), track("C:\\m\\X", "one", 1), track("C:\\m\\Y", "solo", 1), track("C:\\m\\Z", "z", 1)];
const albums = albumsByFolder(library, folderOf);

test("tracks are grouped into albums by folder, in track order", () => {
  assert.equal(albums.size, 3);
  assert.deepEqual(albums.get("C:\\m\\X")!.tracks.map((t) => t.title), ["one", "two"]);
});

test("the New shelf lists newest albums once each, skipping files that are no longer in the library", () => {
  const files = [
    { path: "C:\\m\\Y\\solo.mp3", modified: 50 },
    { path: "C:\\m\\X\\one.mp3", modified: 300 },
    { path: "C:\\m\\X\\two.mp3", modified: 200 },
    { path: "C:\\gone\\q.mp3", modified: 999 },
  ];
  assert.deepEqual(newAlbums(files, albums, folderOf, 10).map((a) => a.key), ["C:\\m\\X", "C:\\m\\Y"]);
  assert.equal(newAlbums(files, albums, folderOf, 1).length, 1);
});

const entry = (path: string, last: number, count: number): HistoryEntry => ({ path, title: null, artist: null, album: null, last_played: last, count });

test("recently played albums are most recent first and unique", () => {
  const entries = [entry("C:\\m\\X\\one.mp3", 10, 1), entry("C:\\m\\Y\\solo.mp3", 30, 1), entry("C:\\m\\X\\two.mp3", 20, 1), entry("C:\\old\\a.mp3", 99, 1)];
  assert.deepEqual(recentlyPlayedAlbums(entries, albums, folderOf, 5).map((a) => a.key), ["C:\\m\\Y", "C:\\m\\X"]);
});

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const many = Array.from({ length: 9 }, (_, i) => ({ key: `album-${i}` }));

test("the lucky spin lands on an album not played lately, once, with covers still to scroll after it", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const recent = new Set(many.slice(0, 8).map((a) => a.key));
    const spin = luckySpin(many, recent, 30, seeded(seed))!;
    assert.equal(spin.strip.length, 30);
    assert.equal(spin.winner, 30 - 1 - AFTER_WINNER);
    assert.equal(spin.strip[spin.winner].key, "album-8", "the only album not played lately");
    assert.equal(spin.strip.filter((a) => a === spin.strip[spin.winner]).length, 1, "the winner passes by only once");
    for (let i = 1; i < spin.strip.length; i++) assert.notEqual(spin.strip[i], spin.strip[i - 1], "no cover beside itself");
  }
});

test("the lucky spin copes with a small library, everything played lately, and an empty one", () => {
  assert.equal(luckySpin([], new Set(), 30, Math.random), null);
  const one = luckySpin([{ key: "only" }], new Set(["only"]), 12, Math.random)!;
  assert.equal(one.strip.length, 12);
  assert.equal(one.strip[one.winner].key, "only");
  const all = luckySpin(many, new Set(many.map((a) => a.key)), 20, seeded(7))!;
  assert.ok(many.includes(all.strip[all.winner]), "with nothing fresh it still picks an album");
  const short = luckySpin(many, new Set(), 3, seeded(3))!;
  assert.equal(short.strip.length, 3);
  assert.equal(short.winner, 0);
});

test("a play counts after 30 seconds, or half of a short track", () => {
  assert.equal(playedThreshold(240), 30);
  assert.equal(playedThreshold(40), 20);
  assert.equal(playedThreshold(Number.NaN), 30);
  assert.equal(playedThreshold(0), 30);
});

import { pinnedAlbums, type Pin } from "./home-format.ts";

test("pinned albums come newest pin first and albums that left the library are skipped", () => {
  const pins: Pin[] = [
    { folder: "C:\\m\\X", album: "X", artist: "A", pinned_at: 5 },
    { folder: "C:\\m\\Z", album: "Z", artist: "A", pinned_at: 9 },
    { folder: "C:\\gone", album: "G", artist: "A", pinned_at: 99 },
  ];
  assert.deepEqual(pinnedAlbums(pins, albums).map((a) => a.key), ["C:\\m\\Z", "C:\\m\\X"]);
  assert.deepEqual(pinnedAlbums([], albums), []);
});

test("the lucky reel settles in one of four ways, with sizes and timings that change from spin to spin", () => {
  const seen = new Set<string>();
  let state = 12345;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const timings = new Set<number>();
  for (let i = 0; i < 400; i += 1) {
    const s = luckySettle(random);
    seen.add(s.kind);
    timings.add(s.spinMs);
    assert.ok(s.spinMs >= 4200 && s.spinMs <= 5600, "the spin keeps its length range");
    assert.ok(s.settleMs >= 300 && s.settleMs <= 1400);
    assert.ok(s.swings.length >= 1 && s.swings.length <= 4);
    assert.ok(Math.abs(s.over) <= 0.55 && Math.abs(s.over) >= 0.05);
    for (const swing of s.swings) assert.ok(Math.abs(swing) < 0.31, "no swing is bigger than a third of a cover");
    if (s.kind === "overshoot" || s.kind === "bounce" || s.kind === "tick") assert.ok(s.over < 0, `${s.kind} runs past the album`);
    if (s.kind === "short") assert.ok(s.over > 0, "short stops before the album");
  }
  assert.deepEqual([...seen].sort(), ["bounce", "overshoot", "short", "tick"]);
  assert.ok(timings.size > 100, "the timings vary");
});

test("an overshoot's swings alternate sides and get smaller", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 48271) % 2_147_483_647) / 2_147_483_647);
  let checked = 0;
  for (let i = 0; i < 300; i += 1) {
    const s = luckySettle(random);
    if (s.kind !== "overshoot") continue;
    checked += 1;
    for (let k = 1; k < s.swings.length; k += 1) {
      assert.ok(s.swings[k]! * s.swings[k - 1]! < 0, "sides alternate");
      assert.ok(Math.abs(s.swings[k]!) < Math.abs(s.swings[k - 1]!), "each swing is smaller");
    }
  }
  assert.ok(checked > 20);
});
