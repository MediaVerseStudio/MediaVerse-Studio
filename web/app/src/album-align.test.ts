import assert from "node:assert/strict";
import { test } from "node:test";
import { changesFor, describeCover, describeField, songsToFix, type AlignAlbum } from "./album-align.ts";

const album: AlignAlbum = {
  folder: "C:\\Music\\AFI\\Crash Love",
  name: "AFI\\Crash Love",
  songs: 12,
  fields: [{ field: "genre", majority: "Punk Rock", count: 11, songs: [{ path: "C:\\Music\\AFI\\Crash Love\\04 Song.mp3", value: "Rock" }] }],
  cover: { have: 11, missing: ["C:\\Music\\AFI\\Crash Love\\04 Song.mp3", "C:\\Music\\AFI\\Crash Love\\05 Other.mp3"], source: "C:\\Music\\AFI\\Crash Love\\01.mp3" },
  issues: 3,
};

test("the panel says what the album says and which songs differ", () => {
  assert.equal(describeField(album.fields[0]), "Genre: 11 songs say “Punk Rock”; 04 Song.mp3 says “Rock”");
  assert.equal(describeField({ ...album.fields[0], songs: [{ path: "a\\1.mp3", value: null }] }), "Genre: 11 songs say “Punk Rock”; 1.mp3 has none");
  assert.match(describeCover(album.cover!, 12), /11 of 12 songs have the album's picture; 2 songs have none/);
});

test("the fix writes the album's value into each odd song, and counts songs once", () => {
  assert.deepEqual(changesFor(album), [{ path: "C:\\Music\\AFI\\Crash Love\\04 Song.mp3", field: "genre", value: "Punk Rock" }]);
  assert.equal(songsToFix(album), 2);
});
