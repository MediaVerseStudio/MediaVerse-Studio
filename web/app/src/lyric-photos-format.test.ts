import assert from "node:assert/strict";
import test from "node:test";
import { type PhotoSong, type ReadResult, albumsOf, assign, findAlbums, folderOf, initialAssignment, panelLabel, panelPicture, reviewEntry, tidyWords, turned, unusedPanels } from "./lyric-photos-format.ts";

const song = (path: string, title: string, number: number | null, artist = "MxPx", album = "Living in the Chaos"): PhotoSong => ({ path, title, artist, album, number });

test("songs become albums by folder, in track order", () => {
  const albums = albumsOf([
    song("C:\\Music\\MxPx\\Chaos\\02 Mind Control.mp3", "Mind Control", 2),
    song("C:\\Music\\MxPx\\Chaos\\01 The Good Days.mp3", "The Good Days", 1),
    song("C:\\Music\\Other\\x.mp3", "X", null, "Other", "Single"),
  ]);
  assert.equal(albums.length, 2);
  assert.deepEqual(albums[0]!.songs.map((s) => s.title), ["The Good Days", "Mind Control"]);
  assert.equal(albums[0]!.label, "MxPx — Living in the Chaos (2 songs)");
  assert.equal(folderOf("C:\\a\\b\\c.mp3"), "C:\\a\\b");
});

test("typing words finds albums that contain all of them", () => {
  const albums = albumsOf([song("C:\\a\\1.mp3", "A", 1), song("C:\\b\\1.mp3", "B", 1, "Amy Winehouse", "Back to Black")]);
  assert.equal(findAlbums(albums, "mxpx chaos").length, 1);
  assert.equal(findAlbums(albums, "").length, 2);
  assert.equal(findAlbums(albums, "black amy")[0]!.songs[0]!.title, "B");
});

const result: ReadResult = {
  photos: ["a.jpg"],
  panels: [
    { photo: 0, title: "THE GOOD DAYS", score: 0.9, lines: ["a", "", "b"], text: "a\n\nb", track: 0, similarity: 1 },
    { photo: 0, title: "", score: 0.7, lines: ["credits"], text: "credits", track: null, similarity: null },
    { photo: 0, title: "MIND CONTROL", score: 0.9, lines: ["c"], text: "c", track: 1, similarity: 1 },
  ],
  tracks: [
    { index: 0, path: "p0", title: "The Good Days", panel: 0 },
    { index: 1, path: "p1", title: "Mind Control", panel: 2 },
    { index: 2, path: "p2", title: "Panic Attack", panel: null },
  ],
  words_known: 100,
};

test("the sidecar's matching is the start, and a panel is used once", () => {
  let current = initialAssignment(result);
  assert.deepEqual(current, [0, 2, null]);
  assert.deepEqual(unusedPanels(current, 3), [1]);
  current = assign(current, 2, 2); // give Mind Control's panel to Panic Attack
  assert.deepEqual(current, [0, null, 2]);
  current = assign(current, 1, null);
  assert.deepEqual(current, [0, null, 2]);
  assert.deepEqual(unusedPanels(current, 3), [1]);
});

test("a panel is named with its heading, its lines and a warning for a doubtful reading", () => {
  assert.equal(panelLabel(result.panels[0]!, 1), "1. THE GOOD DAYS — 2 lines, photo 1");
  assert.equal(panelLabel(result.panels[1]!, 2), "2. (no heading) — 1 lines, photo 1, doubtful reading");
});

test("the review entry carries the words as one photo candidate", () => {
  const entry = reviewEntry(song("C:\\a\\1.mp3", "The Good Days", 1), "  line one\nline two \n");
  assert.equal(entry.path, "C:\\a\\1.mp3");
  assert.equal(entry.candidates[0]!.source, "photo");
  assert.equal(entry.candidates[0]!.plain, "line one\nline two");
  assert.equal(tidyWords("\n\na  \n\n\n\nb\n"), "a\n\nb");
});


test("a photo turns a quarter at a time and wraps round", () => {
  assert.equal(turned(0, 1), 90);
  assert.equal(turned(270, 1), 0);
  assert.equal(turned(0, -1), 270);
  assert.equal(turned(90, -1), 0);
});

test("a page shows its own cut-out, or else the whole photo it was read from", () => {
  const panel = { photo: 1, title: "A", score: 1, lines: [], text: "", track: null, similarity: null };
  const result = { photos: ["a.jpg", "b.jpg"], pictures: ["AAA", "BBB"], panels: [panel], tracks: [], words_known: 0 } as ReadResult;
  assert.equal(panelPicture(result, panel), "BBB");
  assert.equal(panelPicture(result, { ...panel, crop_base64: "CUT" }), "CUT");
  assert.equal(panelPicture({ ...result, pictures: undefined }, panel), null);
});
