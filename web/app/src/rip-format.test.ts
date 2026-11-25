import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveBlocker,
  buildRipRequest,
  titlesProblem,
  describeRead,
  describeAudio,
  describeLengthFit,
  lengthFitStrong,
  busyRetryDelay,
  describeRetry,
  editionsOfOneAlbum,
  releaseLines,
  describeVerification,
  libraryBlocker,
  overallPercent,
  readyProblem,
  summarizeResult,
  trackListFor,
  type Candidate,
  type RipChoices,
  type RipResult,
} from "./rip-format.ts";

const candidate: Candidate = {
  source: "musicbrainz",
  album: "Energy",
  album_artist: "Operation Ivy",
  tracks: [
    { number: 1, title: "Knowledge" },
    { number: 2, title: "Freeze Up" },
  ],
};

function choices(overrides: Partial<RipChoices> = {}): RipChoices {
  return {
    device: "\\\\.\\E:",
    candidate,
    manual: { album: "", artist: "" },
    tracks: [],
    archive: true,
    mp3: true,
    mp3Quality: "v0",
    keepWav: false,
    ...overrides,
  };
}

const goodView = { archive_enabled: true, archive_dir: "D:\\Archive", library_dir: "D:\\Music" };

test("the archive switch needs a folder, and no folder is needed when it is off", () => {
  assert.match(archiveBlocker({ ...goodView, archive_dir: null }, true) ?? "", /no archive folder is chosen/);
  assert.match(archiveBlocker(null, true) ?? "", /no archive folder/);
  assert.equal(archiveBlocker({ ...goodView, archive_dir: null }, false), null);
  assert.equal(archiveBlocker(goodView, true), null);
});

test("MP3 copies need a music folder", () => {
  assert.match(libraryBlocker({ ...goodView, library_dir: null }, true) ?? "", /no music folder/);
  assert.equal(libraryBlocker({ ...goodView, library_dir: null }, false), null);
});

test("the rip button waits for a drive, an album and at least one output", () => {
  assert.equal(readyProblem(choices(), goodView, true), null);
  assert.match(readyProblem(choices({ device: "" }), goodView, true) ?? "", /drive/);
  assert.match(readyProblem(choices(), goodView, false) ?? "", /Look up/);
  assert.match(readyProblem(choices({ archive: false, mp3: false }), goodView, true) ?? "", /at least one output/);
  assert.match(readyProblem(choices(), { ...goodView, archive_dir: null }, true) ?? "", /archive folder/);
});

test("a chosen album is sent whole and every track is implied", () => {
  const request = buildRipRequest(choices(), [1, 2]);
  assert.equal(request.candidate, candidate);
  assert.equal(request.tracks, undefined);
  assert.equal(request.archive, true);
  assert.equal(request.mp3_quality, "v0");
  assert.equal(request.output_dir, undefined, "the program picks the working folder");
});

test("a partial selection is sent sorted, and hand-entered details are trimmed", () => {
  const typed = buildRipRequest(choices({ candidate: null, manual: { album: "Timeless & Dimeless", artist: "WitchDoktors", year: " 2008 ", genre: " Punk ", titles: "1. First\n\n02 Second song\n3) Third\nFourth" } }), [1, 2, 3, 4]);
  assert.deepEqual(typed.metadata, {
    album: "Timeless & Dimeless",
    album_artist: "WitchDoktors",
    artist: "WitchDoktors",
    release_year: 2008,
    genre: "Punk",
    tracks: { "1": { title: "First" }, "2": { title: "Second song" }, "3": { title: "Third" }, "4": { title: "Fourth" } },
  });
  assert.equal(titlesProblem("a\nb", 3), "You typed 2 titles, but the disc has 3 tracks.");
  assert.equal(titlesProblem("a\nb\nc", 3), null);
  assert.equal(titlesProblem("", 3), null, "titles are optional");
  assert.equal(titlesProblem("a", null), null, "unknown track count: nothing to compare");
  const request = buildRipRequest(choices({ candidate: null, manual: { album: " Mine ", artist: " Me " }, tracks: [3, 1] }), [1, 2, 3, 4]);
  assert.deepEqual(request.tracks, [1, 3]);
  assert.deepEqual(request.metadata, { album: "Mine", album_artist: "Me", artist: "Me" });
  assert.equal(request.candidate, undefined);
});

test("placeholder tracks are numbered for a hand-entered album", () => {
  const list = trackListFor({ candidate: null }, 3);
  assert.deepEqual(list.map((t) => t.title), ["Track 01", "Track 02", "Track 03"]);
  assert.equal(trackListFor({ candidate }, 99), candidate.tracks);
});

test("verification wording is plain", () => {
  assert.match(describeVerification({ kind: "matched", confidence: 7 }), /seen 7 times/);
  assert.match(describeVerification({ kind: "unavailable" }), /Not confirmed/);
  assert.match(describeVerification({ kind: "no_match" }), /Differs from AccurateRip/);
  assert.match(describeVerification({ kind: "no_match" }, { samples: -441, confidence: 4 }), /another pressing \(shifted 441 samples\)/);
});

test("progress moves forward through reading and the later steps", () => {
  const read = overallPercent("rip", { job_id: "j", kind: "rip", tracks_done: 1, tracks_total: 2, done: 50, total: 100 }, 2);
  const archive = overallPercent("archive", { job_id: "j", kind: "archive", tracks_done: 0, tracks_total: 2 }, 2);
  const mp3 = overallPercent("mp3", { job_id: "j", kind: "mp3", tracks_done: 1, tracks_total: 2 }, 2);
  assert.ok(read > 0 && read < 70, `${read}`);
  assert.ok(archive >= 70 && archive < mp3 && mp3 <= 100, `${archive} ${mp3}`);
  assert.equal(overallPercent("rip", { job_id: "j", kind: "rip", tracks_done: 2, tracks_total: 2, done: 0, total: 0 }, 0), 100);
});

test("the automatic defect scan is summarised", () => {
  const summary = summarizeResult({
    tracks: [{ number: 1, verification: { kind: "unavailable" } }, { number: 2, verification: { kind: "unavailable" } }],
    warnings: [],
    defect_scan: [{ track: 1, report: { verdict: "clean" } }, { track: 2, report: { verdict: "suspect" } }],
  });
  assert.ok(summary.lines.some((l) => l.includes("2 tracks AccurateRip could not confirm") && l.includes("look at track 2")), summary.lines.join("|"));
  const clean = summarizeResult({ tracks: [{ number: 1, verification: { kind: "unavailable" } }], warnings: [], defect_scan: [{ track: 1, report: { verdict: "clean" } }] });
  assert.ok(clean.lines.some((l) => l.includes("nothing suspicious found")));
});

test("a result summary reports failures and unconfirmed tracks honestly", () => {
  const result: RipResult = {
    tracks: [
      { number: 1, verification: { kind: "matched", confidence: 3 } },
      { number: 2, verification: { kind: "unavailable" } },
    ],
    warnings: ["AccurateRip has no reference for track 2"],
    archive: { dir: "D:\\Archive", tracks: [{ track: 1, ok: true }, { track: 2, ok: false, error: "already exists" }] },
    mp3: { dir: "D:\\Music", tracks: [{ track: 1, ok: true }, { track: 2, ok: true }] },
    wav_removed: 0,
    files: ["a.wav", "b.wav"],
  };
  const summary = summarizeResult(result);
  assert.equal(summary.ok, false);
  assert.equal(summary.heading, "Ripped, but not everything was saved");
  assert.ok(summary.lines.some((line) => line.includes("1 not confirmed")));
  assert.ok(summary.lines.some((line) => line.includes("track 2: already exists")));
  assert.ok(summary.lines.some((line) => line.includes("WAV files were kept")));
  assert.deepEqual(summary.warnings, result.warnings);

  const clean = summarizeResult({
    tracks: [{ number: 1, verification: { kind: "matched" } }],
    warnings: [],
    mp3: { dir: "D:\\Music", tracks: [{ track: 1, ok: true }] },
    wav_removed: 1,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.heading, "Finished");
});

test("a damaged disc is the first thing the results say, with where and what to do", () => {
  const health = {
    state: "damaged" as const,
    headline: "One track could not be read cleanly: track 5.",
    tracks: [{ number: 5, state: "damaged" as const, reasons: ["12 blocks of audio could not be read between 1:12 and 1:15."], passes: 3 }, { number: 7, state: "recovered" as const, reasons: [], passes: 2 }],
    advice: ["Clean the disc."],
  };
  const result = { tracks: [{ number: 5, verification: { kind: "no_match" as const } }, { number: 7, verification: { kind: "matched" as const } }], warnings: [], disc_health: health };
  const summary = summarizeResult(result);
  assert.equal(summary.heading, "Finished: the disc had problems");
  assert.equal(summary.health?.state, "damaged");
  assert.equal(describeRead(health, 5), "Damaged: could not be read cleanly");
  assert.equal(describeRead(health, 7), "Trouble spots, fixed by reading it 2 times");
  assert.equal(describeRead(health, 1), "Read cleanly");
  assert.equal(describeRead(undefined, 1), "Read cleanly");
  assert.equal(describeRetry({ job_id: "j", kind: "rip_retry", track: 5, pass: 2, passes: 3 }), "Re-reading track 5 (read 2 of 3)");
  assert.equal(summarizeResult({ tracks: [], warnings: [] }).health, null);
});

test("an edition is told apart by its date, country, label, catalogue number, format and barcode", () => {
  const base = { source: "musicbrainz", album: "Energy", album_artist: "Operation Ivy", tracks: [] };
  const uk = { ...base, release: { date: "1998-03-02", country: "GB", label: "Hellcat", catalog_number: "ABC 1", format: "CD", barcode: "0123", status: "Official" } };
  assert.deepEqual(releaseLines(uk), ["1998-03-02 · GB · Hellcat · ABC 1 · CD", "Barcode 0123"]);
  assert.deepEqual(releaseLines({ ...base, year: 2007 }), ["2007"], "only a year when that is all there is");
  assert.deepEqual(releaseLines({ ...base, release: { status: "Promotion" } }), ["Promotion"]);
  assert.deepEqual(releaseLines(base), []);
  assert.equal(editionsOfOneAlbum([uk, { ...uk, album: "ENERGY", album_artist: "operation ivy" }]), true);
  assert.equal(editionsOfOneAlbum([uk, { ...uk, album: "Another" }]), false);
  assert.equal(editionsOfOneAlbum([uk]), false);
});

test("track lengths that all agree make a strong fit and say so in plain words", () => {
  const strong = { compared: 14, total: 14, within: 14, worst_ms: 1800 };
  assert.equal(lengthFitStrong(strong), true);
  assert.deepEqual(describeLengthFit(strong), { kind: "good", text: "Track lengths agree with your disc (all 14 within 3 seconds): very likely the right album." });
  const partlyListed = { compared: 13, total: 14, within: 13, worst_ms: 900 };
  assert.equal(lengthFitStrong(partlyListed), true);
  assert.match(describeLengthFit(partlyListed)!.text, /13 of 14 within 3 seconds/);
});

test("a disagreeing album is a warning, a partly agreeing one is information, and no lengths say nothing", () => {
  assert.equal(describeLengthFit({ compared: 10, total: 10, within: 2, worst_ms: 90_000 })!.kind, "warn");
  const some = { compared: 10, total: 10, within: 9, worst_ms: 42_000 };
  assert.equal(lengthFitStrong(some), false);
  assert.deepEqual(describeLengthFit(some), { kind: "info", text: "9 of 10 track lengths agree with your disc (the biggest difference is 42 seconds)." });
  assert.equal(describeLengthFit(null), null);
  assert.equal(lengthFitStrong(undefined), false);
  assert.equal(lengthFitStrong({ compared: 3, total: 3, within: 3, worst_ms: 0 }), false, "three tracks are never enough to be sure");
  assert.equal(lengthFitStrong({ compared: 5, total: 14, within: 5, worst_ms: 0 }), false, "most tracks must have a length");
});

test("a busy source is asked again after a growing pause, and only a few times", () => {
  const busy = [{ code: "rate_limited" }];
  assert.deepEqual([0, 1, 2, 3, 4, 7].map((n) => busyRetryDelay(busy, n)), [15, 30, 60, 120, 120, 120]);
  assert.equal(busyRetryDelay(busy, 8), null, "eight tries are enough");
  assert.equal(busyRetryDelay([{ code: "connection_failed" }], 0), null, "only a busy source is retried");
  assert.equal(busyRetryDelay([], 0), null);
});
test("the audio check reads in words per track, and only a different song is a warning", () => {
  const check = {
    state: "mixed" as const,
    headline: "AcoustID recognised 1 track as the songs you chose, but 1 track sounds like another song than its title.",
    tracks: [
      { number: 1, state: "other" as const, title: "The Leaving Song", artist: "AFI", sounds_like: 2 },
      { number: 2, state: "agrees" as const, title: "Girl's Not Grey" },
      { number: 3, state: "unknown" as const },
      { number: 4, state: "failed" as const, problem: "down" },
      { number: 5, state: "named" as const, title: "Bleed Black", artist: "AFI" },
    ],
    album_hint: { title: "Sing the Sorrow", artist: "AFI", tracks: 3, of: 4 },
  };
  assert.deepEqual(describeAudio(check, 1), { text: "Sounds like “The Leaving Song” by AFI (the title of track 2)", warn: true });
  assert.deepEqual(describeAudio(check, 2), { text: "Recognised: the song you chose", warn: false });
  assert.equal(describeAudio({ ...check, tracks: [{ number: 2, state: "agrees", tag_ids: true }] }, 2).text, "Recognised: the song you chose (ids saved in the file)");
  assert.equal(describeAudio({ ...check, tracks: [{ number: 5, state: "named", title: "Bleed Black", artist: "AFI", named: true }] }, 5).text, "Named from the audio: “Bleed Black” by AFI");
  assert.deepEqual(describeAudio(check, 3), { text: "Not in AcoustID's database", warn: false });
  assert.equal(describeAudio(check, 4).warn, false);
  assert.equal(describeAudio(check, 5).text, "Recognised as “Bleed Black” by AFI");
  assert.deepEqual(describeAudio(undefined, 1), { text: "Not checked", warn: false });
  const summary = summarizeResult({ tracks: [{ number: 1, verification: { kind: "matched" } }], warnings: [], audio_check: check });
  assert.ok(summary.lines.some((l) => l.startsWith("AcoustID: AcoustID recognised")));
  assert.ok(summary.lines.some((l) => l.includes("best guess for the album: “Sing the Sorrow” by AFI (3 of the 4 recognised tracks)")));
  assert.equal(summarizeResult({ tracks: [], warnings: [] }).lines.some((l) => l.includes("AcoustID")), false, "nothing is said when AcoustID is off");
});
