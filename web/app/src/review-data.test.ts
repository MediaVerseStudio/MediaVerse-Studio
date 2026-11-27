import assert from "node:assert/strict";
import { test } from "node:test";
import { albumsWithLowCover, checkProblem, albumsWithoutCover, albumsWithoutLyrics, defectList, markSaved, markedGood, scanCoverage, type DefectResult, type GapFile, type GapTrack } from "./review-data.ts";

const t = (folder: string, n: number, artist = "Band"): GapTrack => ({ title: `Song ${n}`, artist, album: folder, source_uri: `C:\\m\\${folder}\\${n}.mp3` });
const tracks = [t("A", 1), t("A", 2), t("B", 1, "Other"), t("C", 1)];
const file = (track: GapTrack, cover: boolean, lyrics: boolean): GapFile => ({ path: track.source_uri, cover, lyrics, mp3: true });

test("albums without a cover are listed once each, ignoring files the library does not know", () => {
  const files = [file(tracks[0], false, true), file(tracks[1], false, true), file(tracks[2], true, true), file(tracks[3], false, true), { path: "C:\\other\\x.mp3", cover: false, lyrics: false, mp3: true }];
  const gaps = albumsWithoutCover(files, tracks);
  assert.deepEqual(gaps.map((g) => [g.album, g.tracks.length, g.mp3Paths.length]), [["A", 2, 2], ["C", 1, 1]]);
});

test("tracks without lyrics are grouped by album", () => {
  const files = [file(tracks[0], true, false), file(tracks[1], true, true), file(tracks[2], true, false)];
  const gaps = albumsWithoutLyrics(files, tracks);
  assert.deepEqual(gaps.map((g) => [g.album, g.tracks.map((x) => x.title)]), [["A", ["Song 1"]], ["B", ["Song 1"]]]);
});

test("songs known to be instrumental are not listed as missing lyrics", () => {
  const files = [file(tracks[0], true, false), file(tracks[1], true, false), file(tracks[2], true, false)];
  const gaps = albumsWithoutLyrics(files, tracks, new Set([tracks[1].source_uri, tracks[2].source_uri]));
  assert.deepEqual(gaps.map((g) => [g.album, g.tracks.map((x) => x.title)]), [["A", ["Song 1"]]]);
});

const result = (track: GapTrack, verdict: "clean" | "minor" | "suspect"): DefectResult => ({ path: track.source_uri, scanned_at: 1, report: { verdict, seconds: 100, counts: {}, findings: [] } });

test("defect lists show the worst first and skip clean and vanished tracks", () => {
  const list = defectList([result(tracks[0], "minor"), result(tracks[1], "suspect"), result(tracks[2], "clean"), { ...result(tracks[3], "suspect"), path: "C:\\gone.mp3" }], tracks);
  assert.deepEqual(list.map((x) => [x.track.title, x.result.report.verdict]), [["Song 2", "suspect"], ["Song 1", "minor"]]);
});

test("songs marked as good leave the defect list and are counted instead", () => {
  const results = [result(tracks[0], "suspect"), { ...result(tracks[1], "suspect"), reviewed_good: true }, { ...result(tracks[2], "minor"), reviewed_good: true, path: "C:\\gone.mp3" }];
  assert.deepEqual(defectList(results, tracks).map((x) => x.track.title), ["Song 1"]);
  assert.equal(markedGood(results, tracks), 1, "a marked song that left the library is not counted");
});

test("scan coverage counts what has been scanned", () => {
  const coverage = scanCoverage([result(tracks[0], "clean"), result(tracks[1], "clean")], tracks);
  assert.equal(coverage.scanned, 2);
  assert.deepEqual(coverage.unscanned.map((x) => x.title), ["Song 1", "Song 1"]);
});

test("the compact artwork list knows each album's artist, year and size, and a save updates it in place", () => {
  const songs: GapTrack[] = [
    { ...t("D", 1, "Guest"), album_artist: "Main Band", release_year: 1997 },
    { ...t("D", 2), album_artist: "Main Band", release_year: null },
    t("D", 3),
  ];
  const files = [file(songs[0], false, true), file(songs[1], true, true), { ...file(songs[2], false, true), mp3: false }];
  const [gap] = albumsWithoutCover(files, songs);
  assert.equal(gap.albumArtist, "Main Band");
  assert.equal(gap.year, 1997);
  assert.equal(gap.total, 3, "every song in the folder counts, also those with a cover");
  assert.deepEqual(gap.albumMp3Paths, [songs[0].source_uri, songs[1].source_uri], "a picture goes on every MP3 of the album");
  assert.deepEqual(gap.mp3Paths, [songs[0].source_uri]);
  const after = markSaved(files, [songs[0].source_uri, songs[1].source_uri], { frontCover: true });
  assert.deepEqual(albumsWithoutCover(after, songs).map((g) => g.total), [3], "the WAV still has no cover, so the album stays");
  assert.deepEqual(albumsWithoutCover(markSaved(after, [songs[2].source_uri], { frontCover: true }), songs), []);
  assert.equal(markSaved(files, [songs[0].source_uri], { lyrics: false })[0].cover, false, "only the field that changed");
});

test("low-resolution covers are listed per album", () => {
  const songs: GapTrack[] = [t("Small", 1), t("Small", 2), t("Fine", 1), t("Big", 1), t("Bare", 1)];
  const files: GapFile[] = [
    { ...file(songs[0], true, true), cover_size: [200, 200] },
    { ...file(songs[1], true, true), cover_size: [600, 600] }, // the album's best cover counts
    { ...file(songs[2], true, true), cover_size: [1000, 1000] },
    { ...file(songs[3], true, true), cover_size: [1400, 1400] },
    { ...file(songs[4], false, true), cover_size: null },
  ];
  assert.deepEqual(albumsWithLowCover(files, songs, 500).map((g) => g.album), [], "600 × 600 is enough at 500");
  const under1000 = albumsWithLowCover(files, songs, 1000);
  assert.deepEqual(under1000.map((g) => [g.album, g.coverSize]), [["Small", [600, 600]]], "1000 × 1000 is not low; an album without a cover is in Missing");
});

test("a check that read nothing, or matched no song in the list, is not reported as all well", () => {
  const file: GapFile = { path: "M:\\A\\1.mp3", cover: true, lyrics: true, mp3: true };
  const track: GapTrack = { title: "One", artist: "A", album: "B", source_uri: "M:\\A\\1.mp3" };
  assert.match(checkProblem([], [track]) ?? "", /no songs were found/);
  assert.match(checkProblem([file], []) ?? "", /song list is not ready/);
  assert.equal(checkProblem([file], [track]), null);
});
