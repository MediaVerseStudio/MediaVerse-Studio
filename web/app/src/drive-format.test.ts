import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DriveProfile,
  describeCache,
  describeError,
  describeOffset,
  describeOffsetOutcome,
  describeRepeatReads,
  describeTransfer,
  driveName,
  formatDevice,
  formatKilobytes,
  formatOffset,
  progressFor,
  toApiError,
} from "./drive-format.ts";

const profile = (overrides: Partial<DriveProfile> = {}): DriveProfile => ({
  identity: { vendor: "ASUS", model: "BW-16D1HT", revision: "3.11", connection: "unknown" },
  read_offset: { value: 6, provenance: "measured" },
  offset_evidence: { disc: "x", tracks_matched: [2, 14, 26], checksum_versions: [2], date: "2026-11-01" },
  cache: { value: { kind: "between", cached_through: 28, uncached_at: 32 }, provenance: "measured" },
  max_transfer_sectors: { value: 55, provenance: "measured" },
  repeat_reads_agree: true,
  ...overrides,
});

test("formats offsets with signs and plurals", () => {
  assert.equal(formatOffset(6), "+6 samples");
  assert.equal(formatOffset(-1), "−1 sample");
  assert.equal(formatOffset(0), "0 samples");
});

test("formats sector counts as sizes", () => {
  assert.equal(formatKilobytes(30), "69 KB");
  assert.equal(formatKilobytes(1200), "2.7 MB");
});

test("a measured offset is described as verified, with its evidence", () => {
  const text = describeOffset(profile());
  assert.match(text, /\+6 samples \(verified on this drive\)/);
  assert.match(text, /tracks 2, 14, 26/);
  assert.match(text, /2026-11-01/);
});

test("a suggested or manual offset is never described as verified", () => {
  for (const provenance of ["suggested", "manual"] as const) {
    const text = describeOffset(profile({ read_offset: { value: 6, provenance }, offset_evidence: null }));
    assert.doesNotMatch(text, /verified on/);
    assert.match(text, /not (yet checked|verified)/);
  }
});

test("missing profile data reads as not tested yet", () => {
  assert.equal(describeOffset(null), "Not checked yet");
  assert.equal(describeCache(undefined), "Not tested yet");
  assert.equal(describeTransfer(null), "Not tested yet");
  assert.equal(describeRepeatReads(null), "Not tested yet");
});

test("describes each cache result", () => {
  assert.match(describeCache(profile()), /About 28–32 sectors/);
  assert.equal(describeCache(profile({ cache: { value: { kind: "none" }, provenance: "measured" } })), "No audio cache detected");
  assert.match(
    describeCache(profile({ cache: { value: { kind: "at_least", sectors: 4800 }, provenance: "measured" } })),
    /Larger than 4800 sectors.*may not bypass/,
  );
});

test("repeat-read failures carry a warning", () => {
  assert.equal(describeRepeatReads(profile()), "Yes");
  assert.match(describeRepeatReads(profile({ repeat_reads_agree: false })), /^No/);
});

test("progress combines the three steps into one percentage", () => {
  assert.deepEqual(progressFor("read_test", 0, 2), { percent: 0, label: "Testing reads", stepNumber: 1 });
  assert.equal(progressFor("cache_test", 10, 20).percent, 38);
  assert.equal(progressFor("offset_check", 3, 3).percent, 100);
  assert.equal(progressFor("offset_check", 1, 3).stepNumber, 3);
  assert.equal(progressFor("something_new", 1, 1).percent, 0);
  assert.equal(progressFor("read_test", 5, 0).percent, 0);
});

test("offset outcomes: only a measured result is verified", () => {
  assert.equal(describeOffsetOutcome({ kind: "measured", offset: 6, tracks: [2, 3], versions: [2] }).verified, true);
  const missing = describeOffsetOutcome({ kind: "needs_disc", reason: "this disc is not in the AccurateRip database" });
  assert.equal(missing.verified, false);
  assert.match(missing.text, /Insert a different audio CD/);
  assert.equal(describeOffsetOutcome({ kind: "inconclusive", reason: "x" }).verified, false);
});

test("errors get friendly text, and unknown ones keep their message", () => {
  assert.match(describeError({ code: "no_disc", message: "" }), /no readable audio CD/);
  assert.match(describeError({ code: "cancelled", message: "" }), /Nothing was changed/);
  assert.equal(describeError({ code: "weird", message: "Disk on fire" }), "Disk on fire");
});

test("normalises thrown values from the bridge", () => {
  assert.deepEqual(toApiError({ code: "no_disc", message: "m" }), { code: "no_disc", message: "m" });
  assert.equal(toApiError(new Error("Unsupported MediaVerse command: list_drives")).code, "unknown_command");
  assert.equal(toApiError(new Error("boom")).code, "error");
  assert.equal(toApiError("text").message, "text");
});

test("names a drive from its vendor and model, falling back to the device", () => {
  assert.equal(driveName({ device: "E:", vendor: "ASUS", model: "BW-16D1HT" }), "ASUS BW-16D1HT");
  assert.equal(driveName({ device: "E:", vendor: " ", model: "" }), "E:");
});

test("shows drive letters without the raw device prefix", () => {
  assert.equal(formatDevice(String.raw`\\.\E:`), "E:");
  assert.equal(formatDevice("/dev/sr0"), "/dev/sr0");
  assert.equal(driveName({ device: String.raw`\\.\E:` }), "E:");
});

