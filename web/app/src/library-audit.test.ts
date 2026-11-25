import assert from "node:assert/strict";
import test from "node:test";
import { describeMissing, findCopies, findMissingTracks, titleKey } from "./library-audit.ts";
import type { LibrarySong } from "./library-format.ts";

let n = 0;
function song(folder: string, title: string, over: Partial<LibrarySong> = {}): LibrarySong {
  n += 1;
  return { album: "Hang", album_artist: "Lagwagon", artist: "Lagwagon", genre: null, release_year: 2003, title, source_uri: `C:\\Music\\${folder}\\${n}-${title}.mp3`, track_number: null, ...over };
}
const album = (folder: string, numbers: number[], over: Partial<LibrarySong> = {}) => numbers.map((t) => song(folder, `Song ${t}`, { track_number: t, ...over }));

test("a hole in the track numbers is reported, with the numbers missing", () => {
  const found = findMissingTracks(album("Lagwagon\\Hang", [1, 2, 4, 5, 6]));
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].missing, [3]);
  assert.equal(found[0].have, 5);
  assert.equal(found[0].last, 6);
  assert.equal(describeMissing(found[0]), "Track 3 is missing");
  assert.equal(describeMissing({ ...found[0], missing: [3, 7] }), "Tracks 3 and 7 are missing");
  assert.equal(describeMissing({ ...found[0], missing: [3, 4, 9] }), "Tracks 3, 4 and 9 are missing");
});

test("a complete album, an unnumbered folder and a hand-picked folder are not reported", () => {
  const songs = [
    ...album("A\\Whole", [1, 2, 3, 4]),
    ...["x", "y", "z"].map((t) => song("B\\Loose", t)),
    ...album("C\\Picked", [1, 12, 40]),
  ];
  assert.deepEqual(findMissingTracks(songs), []);
});

test("each disc is looked at on its own, and a missing first track counts", () => {
  const songs = [...album("Set", [1, 2, 3], { disc_number: 1 }), ...album("Set", [2, 3], { disc_number: 2 })];
  const found = findMissingTracks(songs);
  assert.equal(found.length, 1);
  assert.equal(found[0].disc, 2);
  assert.deepEqual(found[0].missing, [1]);
});

test("a compilation is marked, and the likeliest losses come first", () => {
  const comp = album("V\\Mix", [1, 2, 5], { album_artist: "Various Artists", artist: "Someone" });
  const lost = album("L\\Real", [1, 2, 3, 4, 6]);
  const many = album("M\\Many", [1, 2, 3, 7, 9, 10]);
  const found = findMissingTracks([...comp, ...many, ...lost]);
  assert.deepEqual(found.map((a) => a.folder.split("\\").pop()), ["Real", "Mix", "Many"]);
  assert.deepEqual(found.map((a) => a.compilation), [false, true, false]);
});

test("titles compare without case, accents or punctuation, but a bracket keeps a version apart", () => {
  assert.equal(titleKey("Café  Del Mar!"), titleKey("cafe del mar"));
  assert.equal(titleKey("Don’t Stop"), titleKey("Don't Stop"));
  assert.notEqual(titleKey("Reign (Live)"), titleKey("Reign"));
});

test("the same file in a folder twice is an identical copy and comes first", () => {
  const a = song("Hang", "Reign", { track_number: 2, length_ms: 201727, size_bytes: 5000 });
  const b = song("Hang", "Reign", { track_number: 2, length_ms: 201727, size_bytes: 5000 });
  const elsewhere = [song("Best Of", "Burn", { album: "Best Of", length_ms: 100000 }), song("Hang", "Burn", { length_ms: 100500 })];
  const groups = findCopies([...elsewhere, a, b]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, "Reign");
  assert.equal(groups[0].kind, "copies");
  assert.equal(groups[0].identical, true);
  assert.equal(groups[1].kind, "elsewhere");
  assert.equal(groups[1].files.length, 2);
});

test("the same album in two folders is a copy; a live version and a placeholder title are not", () => {
  const groups = findCopies([
    song("Hang", "Reign", { length_ms: 200000, size_bytes: 1 }),
    song("Hang (1)", "Reign", { length_ms: 200400, size_bytes: 2 }),
    song("Live", "Reign", { album: "Live", length_ms: 260000 }),
    song("One", "Track 1", { length_ms: 1000 }),
    song("Two", "Track 1", { length_ms: 1000 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "copies");
  assert.equal(groups[0].identical, false);
  assert.equal(groups[0].files.length, 2, "the 4:20 live version has another length");
});

test("different artists with the same title are not copies", () => {
  const groups = findCopies([song("A", "Intro", { artist: "One", album_artist: "One", length_ms: 5000 }), song("B", "Intro", { artist: "Two", album_artist: "Two", length_ms: 5000 })]);
  assert.deepEqual(groups, []);
});
