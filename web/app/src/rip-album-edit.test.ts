import assert from "node:assert/strict";
import test from "node:test";
import { blankAlbum, describeDifferences, differences, discLengths, editProblem, fromCandidate, toCandidate, withAlbumArtist, withPastedTitles } from "./rip-album-edit.ts";
import type { Candidate } from "./rip-format.ts";

const candidate: Candidate = {
  source: "musicbrainz",
  source_id: "abc",
  album: "Living in the Chaos",
  album_artist: "MxPx",
  year: 2026,
  genre: null,
  quality: "exact",
  cover_art_release: "cover1",
  tracks: [
    { number: 1, title: "The Good Days" },
    { number: 2, title: "Mind Control", artist: "Guest" },
    { number: 3, title: "Panic Attack" },
  ],
};

test("a chosen release fills the table, and the album artist shows on tracks with none of their own", () => {
  const edit = fromCandidate(candidate);
  assert.deepEqual(edit.rows.map((r) => r.artist), ["MxPx", "Guest", "MxPx"]);
  assert.equal(edit.year, "2026");
  assert.equal(edit.genre, "");
});

test("changing the album artist carries down to the tracks that followed it only", () => {
  const edit = withAlbumArtist(fromCandidate(candidate), "MXPX");
  assert.deepEqual(edit.rows.map((r) => r.artist), ["MXPX", "Guest", "MXPX"]);
  assert.equal(withAlbumArtist(blankAlbum(2), "Me").rows[1]!.artist, "Me");
});

test("edits go back onto the release and keep what the release knew", () => {
  const edit = fromCandidate(candidate);
  edit.rows[0]!.title = "  The Good Days (edit) ";
  edit.year = "2025";
  edit.genre = "Punk";
  const result = toCandidate(edit, candidate);
  assert.equal(result.cover_art_release, "cover1");
  assert.equal(result.source_id, "abc");
  assert.equal(result.year, 2025);
  assert.equal(result.genre, "Punk");
  assert.equal(result.tracks[0]!.title, "The Good Days (edit)");
  assert.equal(result.tracks[0]!.artist, null, "same as the album artist: stored as none");
  assert.equal(result.tracks[1]!.artist, "Guest");
});

test("an album typed by hand becomes a candidate, empty titles become Track NN", () => {
  const edit = blankAlbum(3);
  edit.album = "A";
  edit.albumArtist = "B";
  edit.rows[1]!.title = "Two";
  const result = toCandidate(edit, null);
  assert.deepEqual(result.tracks.map((t) => t.title), ["Track 01", "Two", "Track 03"]);
  assert.equal(result.source, "manual");
  assert.equal(result.year, null);
});

test("pasted titles fill the rows; numbers are dropped only when every line has one in order", () => {
  assert.deepEqual(withPastedTitles(blankAlbum(3), "1. a\n2. b\n3. c").rows.map((r) => r.title), ["a", "b", "c"]);
  assert.deepEqual(withPastedTitles(blankAlbum(3), "99 Luftballons\nTwo\nThree").rows.map((r) => r.title), ["99 Luftballons", "Two", "Three"]);
  assert.deepEqual(withPastedTitles(blankAlbum(3), "a\nb").rows.map((r) => r.title), ["a", "b", ""]);
});

test("choosing another release says what changed", () => {
  const before = fromCandidate(candidate);
  const other = fromCandidate({ ...candidate, year: 2025, tracks: [candidate.tracks[0]!, { number: 2, title: "Mind Control (Live)" }, candidate.tracks[2]!] });
  const diff = differences(before, other);
  assert.deepEqual(diff.fields, ["year"]);
  assert.deepEqual(diff.titles, [2]);
  assert.deepEqual(diff.artists, [2]);
  assert.equal(describeDifferences(diff), "Differs from what was shown before: year; the titles of track 2; the artist of track 2.");
  assert.equal(describeDifferences(differences(before, before)), "");
  assert.equal(differences(before, { ...before, rows: before.rows.map((r) => ({ ...r, title: r.title.toUpperCase() })) }).titles.length, 0, "capitals alone are not a difference");
});

test("the rip needs an album and an artist, and lengths come from the table of contents", () => {
  assert.equal(editProblem(blankAlbum(2)), "Type the album and the artist.");
  assert.equal(editProblem({ ...blankAlbum(2), album: "A", albumArtist: "B" }), null);
  assert.deepEqual(discLengths([0, 75 * 143], 75 * 143 + 75 * 192), ["2:23", "3:12"]);
});
