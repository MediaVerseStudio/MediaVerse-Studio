import assert from "node:assert/strict";
import { test } from "node:test";
import { SCAN_BATCH, batches, clock, describeCounts, describeFinding, describeVerdict, listedFindings, worthListing, type ScanReport, type TrackScan } from "./defect-format.ts";

const report: ScanReport = {
  verdict: "suspect",
  seconds: 200,
  counts: { click: 2, dropout: 1, stuck: 0, clipping: 120 },
  truncated: false,
  findings: [
    { kind: "click", time_ms: 72_500, length_ms: 0, strength: 0.8 },
    { kind: "dropout", time_ms: 123_000, length_ms: 300, strength: 0.7 },
    { kind: "clipping", time_ms: 5_000, length_ms: 1, strength: 0.2 },
  ],
};

test("times and findings read plainly", () => {
  assert.equal(clock(72_500), "1:12");
  assert.equal(clock(0), "0:00");
  assert.equal(describeFinding(report.findings[0]), "Click or pop at 1:12");
  assert.equal(describeFinding(report.findings[1]), "Dropout (300 ms) at 2:03");
  assert.equal(describeFinding({ kind: "stuck", time_ms: 1000, length_ms: 2500, strength: 1 }), "Stuck sound (2.5 s) at 0:01");
});

test("counts and verdicts are in words, and clipping is counted but not listed", () => {
  assert.equal(describeCounts(report.counts), "2 clicks, 1 dropout, 120 clipped stretches");
  assert.equal(describeCounts({ click: 0, dropout: 0, stuck: 0, clipping: 0 }), "no findings");
  assert.match(describeVerdict(report), /Likely audible/);
  assert.match(describeVerdict({ ...report, verdict: "clean" }), /Nothing suspicious/);
  assert.deepEqual(listedFindings(report).map((f) => f.kind), ["click", "dropout"]);
});

import { groupFindings, snippetWindow } from "./defect-format.ts";

test("findings close together are one place to listen to, per kind", () => {
  const stuck = (time_ms: number) => ({ kind: "stuck" as const, time_ms, length_ms: 2, strength: 0.3 });
  const grouped = groupFindings([stuck(192_877), stuck(192_882), stuck(193_100), { kind: "click", time_ms: 192_900, length_ms: 0, strength: 0.5 }, stuck(250_000)]);
  assert.equal(grouped.length, 3);
  assert.equal(describeFinding(grouped[0]), "Stuck sound (225 ms) at 3:12, 3 times close together");
  assert.equal(describeFinding(grouped[1]), "Click or pop at 3:12");
  assert.equal(describeFinding(grouped[2]), "Stuck sound at 4:10");
});

test("a listening sample puts the defect at its midpoint, without starting before the song", () => {
  assert.deepEqual(snippetWindow(60_000, 8), { start: 56, stop: 64 });
  assert.deepEqual(snippetWindow(60_000, 5), { start: 57.5, stop: 62.5 });
  assert.deepEqual(snippetWindow(1_000, 8), { start: 0, stop: 8 }, "near the start the sample begins at 0");
  assert.deepEqual(snippetWindow(0, 12), { start: 0, stop: 12 });
  assert.deepEqual(snippetWindow(-5, 8), { start: 0, stop: 8 });
});

test("large scans are split into batches the sidecar accepts", () => {
  assert.deepEqual(batches(0, 500), []);
  assert.deepEqual(batches(1096, 500), [[0, 500], [500, 1000], [1000, 1096]]);
  assert.ok(batches(100_000, SCAN_BATCH).every(([a, b]) => b - a <= 1000), "never more than the sidecar's limit");
});

test("only songs worth a listen are listed", () => {
  const scan = (verdict: "clean" | "minor" | "suspect") => ({ path: "x.mp3", ok: true, report: { verdict } }) as unknown as TrackScan;
  assert.equal(worthListing(scan("clean")), false);
  assert.equal(worthListing(scan("minor")), true);
  assert.equal(worthListing({ path: "x.mp3", ok: false, error: "unreadable" } as unknown as TrackScan), true);
});

test("a song with no sound at all is described as such", () => {
  const silent: ScanReport = { verdict: "suspect", seconds: 120, counts: { click: 0, dropout: 0, stuck: 0, clipping: 0, silent: 1 }, truncated: false, findings: [{ kind: "silent", time_ms: 0, length_ms: 120_000, strength: 1 }] };
  assert.equal(describeCounts(silent.counts), "no sound at all");
  assert.match(describeVerdict(silent), /No sound at all/);
  assert.equal(describeFinding(silent.findings[0]!), "No sound at all (120.0 s) at 0:00");
  assert.equal(worthListing({ path: "x", ok: true, report: silent }), true);
});
