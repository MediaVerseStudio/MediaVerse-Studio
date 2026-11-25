import assert from "node:assert/strict";
import { test } from "node:test";
import { stillOffered, tracksToCheck } from "./title-tidy-logic.ts";

test("only titles that start with a digit are sent to be checked, with the track number", () => {
  const sent = tracksToCheck([
    { source_uri: "a", title: "14 Donut Dan", artist: "Goldfinger", track_number: 14 },
    { source_uri: "b", title: "Donut Dan", artist: "Goldfinger" },
    { source_uri: "c", title: " 1. All For Nothing", artist: null, album_artist: "Face To Face" },
  ]);
  assert.deepEqual(sent, [
    { path: "a", title: "14 Donut Dan", artist: "Goldfinger", album_artist: "", track: 14 },
    { path: "c", title: " 1. All For Nothing", artist: "", album_artist: "Face To Face", track: null },
  ]);
});

test("songs just fixed are not offered again", () => {
  const items = [{ path: "a", from: "1 X", to: "X" }, { path: "b", from: "2 Y", to: "Y" }];
  assert.deepEqual(stillOffered(items, new Set(["a"])).map((i) => i.path), ["b"]);
});
