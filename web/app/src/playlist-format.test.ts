import assert from "node:assert/strict";
import { test } from "node:test";
import { moved, newName, searchLibrary, withSongs, withoutPlaces } from "./playlist-format.ts";

test("songs are added at the end once, and taken out by place", () => {
  assert.deepEqual(withSongs(["a", "b"], ["b", "c", "c", "d"]), { paths: ["a", "b", "c", "d"], added: 2 });
  assert.deepEqual(withoutPlaces(["a", "b", "c", "d"], [0, 2]), ["b", "d"]);
});

test("songs move up and down as a block, and drop where they are dragged", () => {
  const list = ["a", "b", "c", "d", "e"];
  assert.deepEqual(moved(list, [2, 3], "up"), { paths: ["a", "c", "d", "b", "e"], places: [1, 2] });
  assert.deepEqual(moved(list, [2, 3], "down"), { paths: ["a", "b", "e", "c", "d"], places: [3, 4] });
  assert.deepEqual(moved(list, [0], "up"), { paths: list, places: [0] }, "already at the top");
  assert.deepEqual(moved(list, [4], "down"), { paths: list, places: [4] }, "already at the bottom");
  assert.deepEqual(moved(list, [4], 1).paths, ["a", "e", "b", "c", "d"], "dragged up before b");
  assert.deepEqual(moved(list, [0, 1], 4).paths, ["c", "d", "a", "b", "e"], "dragged down before e");
  assert.deepEqual(moved(list, [1], 5).paths, ["a", "c", "d", "e", "b"], "dragged to the end");
});

test("a new playlist gets a free name", () => {
  assert.equal(newName([]), "New playlist");
  assert.equal(newName(["new playlist", "New playlist 2"]), "New playlist 3");
});

test("the library search finds albums and song titles, whatever the capitals and accents", () => {
  const song = (title: string, album: string, artist: string, track: number) => ({ title, album, artist, album_artist: null, genre: null, release_year: null, source_uri: `${artist}/${album}/${title}`, track_number: track });
  const songs = [
    song("Ode to My Car", "What the Hell Happened to Me?", "Adam Sandler", 3),
    song("Ocean Avenue", "Ocean Avenue", "Yellowcard", 2),
    song("Way Away", "Ocean Avenue", "Yellowcard", 1),
    song("Racecar Café", "Carnival", "Someone", 1),
  ];
  const found = searchLibrary(songs, "CAR");
  assert.deepEqual(found.songs.map((s) => s.title), ["Ode to My Car", "Racecar Café"]);
  assert.deepEqual(found.albums.map((a) => a.name), ["Carnival"]);
  const ocean = searchLibrary(songs, "ocean");
  assert.deepEqual(ocean.albums[0].songs.map((s) => s.title), ["Way Away", "Ocean Avenue"], "an album's songs in track order");
  assert.deepEqual(searchLibrary(songs, "cafe").songs.map((s) => s.title), ["Racecar Café"], "accents do not matter");
  assert.deepEqual(searchLibrary(songs, "  "), { albums: [], songs: [] });
});
