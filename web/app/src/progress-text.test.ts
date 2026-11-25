import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText, describeProgress } from "./progress-text.ts";

test("times are shown as minutes and seconds, with hours only when needed", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(65_400), "1:05");
  assert.equal(clockText(3_725_000), "1:02:05");
  assert.equal(clockText(-5), "0:00");
});

test("a bar with no total yet only says how long it has been going", () => {
  assert.equal(describeProgress("Reading the songs", 0, 0, 3000), "Reading the songs… 0:03 so far");
});

test("a bar says how far, how long, and about how long is left once there is something to go on", () => {
  assert.equal(describeProgress("Reading the songs", 1200, 12000, 60_000), "Reading the songs: 1,200 of 12,000 (10 %), 1:00 so far, about 9:00 left");
  assert.equal(describeProgress("Reading", 5, 100, 1000), "Reading: 5 of 100 (5 %), 0:01 so far", "no guess from the first few songs");
  assert.equal(describeProgress("Reading", 100, 100, 9000), "Reading: 100 of 100 (100 %), 0:09 so far");
});
