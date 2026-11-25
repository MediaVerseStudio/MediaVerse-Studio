import assert from "node:assert/strict";
import { test } from "node:test";
import { type DriveHistory, historyLines } from "./drive-history.ts";

const base: DriveHistory = {
  name: "ASUS BW-16D1HT",
  discs: 12,
  failures: 0,
  tracks: 150,
  matched: 120,
  shifted: 20,
  differing: 6,
  unconfirmed: 4,
  skipped_blocks: 0,
  cache_doubts: 0,
  verified_percent: 95,
  recent: { discs: 8, verified_percent: 95, trouble: 0 },
  notes: ["Nothing worrying in the record."],
};

test("a drive's record is read out as plain facts", () => {
  assert.deepEqual(historyLines(base), [
    "12 discs ripped (150 tracks).",
    "AccurateRip confirmed 95% of the tracks it could check (120 matched, 20 matched another pressing, 6 differed, 4 had no AccurateRip entry).",
    "No unreadable blocks and no doubts about the drive's cache.",
  ]);
});

test("problems and failures are stated, and an empty record says nothing", () => {
  const lines = historyLines({ ...base, discs: 1, tracks: 11, shifted: 0, differing: 0, unconfirmed: 0, skipped_blocks: 1, cache_doubts: 3, failures: 2 });
  assert.equal(lines[0], "1 disc ripped (11 tracks).");
  assert.match(lines[2], /1 block could not be read; the drive's cache was doubted 3 times/);
  assert.equal(lines[3], "2 rips failed because the drive failed or lost the disc.");
  assert.deepEqual(historyLines({ ...base, discs: 0, tracks: 0, verified_percent: null }), []);
});
