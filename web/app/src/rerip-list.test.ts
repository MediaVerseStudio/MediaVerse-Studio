import assert from "node:assert/strict";
import { test } from "node:test";
import { RERIP_PLAYLIST, discsOf, reripReason, silentSongs } from "./rerip-list.ts";
import type { ScanReport } from "./defect-format.ts";

const report = (silent: number, verdict: ScanReport["verdict"] = "suspect"): ScanReport => ({ verdict, seconds: 120, counts: { click: 0, dropout: 0, stuck: 0, clipping: 0, silent }, truncated: false, findings: [] });

test("only songs with no sound at all are picked from the scan results", () => {
  const results = [
    { path: "a", report: report(1) },
    { path: "b", report: report(0) },
    { path: "c", report: { ...report(0), counts: { click: 3, dropout: 0, stuck: 0, clipping: 0 } } },
  ];
  assert.deepEqual(silentSongs(results).map((r) => r.path), ["a"]);
});

test("the discs of the silent songs are listed once each, with their titles", () => {
  const discs = discsOf([
    { path: "M:\\Various\\Punk-O-Rama\\15 Cow.mp3", title: "Don't Have The Cow", album: "Punk-O-Rama, Vol. 2", artist: "Various Artists" },
    { path: "M:\\Various\\Punk-O-Rama\\16 Give.mp3", title: "Give You Nothing", album: "Punk-O-Rama, Vol. 2", artist: "Various Artists" },
    { path: "M:\\The Unseen\\Anger\\07 What.mp3", title: "What Happened-", album: null, artist: null },
  ]);
  assert.equal(discs.length, 2);
  assert.deepEqual(discs[0], { folder: "M:\\Various\\Punk-O-Rama", album: "Punk-O-Rama, Vol. 2", artist: "Various Artists", titles: ["Don't Have The Cow", "Give You Nothing"] });
  assert.deepEqual([discs[1]!.album, discs[1]!.artist], ["Unknown album", "Unknown artist"]);
});

test("the reason says how many songs and which, without running on", () => {
  assert.match(reripReason(["One"]), /^No sound at all in a song: One \(/);
  assert.match(reripReason(["a", "b", "c", "d", "e", "f"]), /6 songs: a, b, c, d, …/);
  assert.equal(RERIP_PLAYLIST, "Needs re-ripping");
});
