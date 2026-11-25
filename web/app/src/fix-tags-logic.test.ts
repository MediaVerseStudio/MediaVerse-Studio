import assert from "node:assert/strict";
import test from "node:test";
import { editsFromFound, withDifferences } from "./fix-tags-logic.ts";

const files = [
  { path: "a.mp3", differences: [{ field: "title", to: "Reign" }, { field: "album", to: "Hang" }] },
  { path: "b.mp3", differences: [{ field: "title", to: "Poison in the Well" }] },
  { path: "c.mp3" },
];

test("the release's spelling is added for every differing field", () => {
  const merged = withDifferences({}, files, new Set(), new Set());
  assert.deepEqual(merged, { "a.mp3": { title: "Reign", album: "Hang" }, "b.mp3": { title: "Poison in the Well" } });
});

test("unticked files and fields are kept as they are", () => {
  const merged = withDifferences({}, files, new Set(["b.mp3"]), new Set(["album"]));
  assert.deepEqual(merged, { "a.mp3": { title: "Reign" } });
});

test("something the person typed wins, and the typed edits are not changed", () => {
  const typed = { "a.mp3": { title: "My own title" }, "c.mp3": { genre: "Punk" } };
  const merged = withDifferences(typed, files, new Set(), new Set());
  assert.equal(merged["a.mp3"].title, "My own title");
  assert.equal(merged["a.mp3"].album, "Hang");
  assert.deepEqual(merged["c.mp3"], { genre: "Punk" });
  assert.deepEqual(typed, { "a.mp3": { title: "My own title" }, "c.mp3": { genre: "Punk" } }, "the input is untouched");
});

test("details found by name become edits for every song, in track order", () => {
  const found = {
    album: "Timeless & Dimeless",
    album_artist: "WitchDoktors",
    year: 2019,
    genre: "Punk",
    tracks: [{ number: 2, title: "Second", artist: "Guest" }, { number: 1, title: "First" }],
  };
  const edits = editsFromFound(["a.mp3", "b.mp3"], found);
  assert.deepEqual(edits["a.mp3"], { title: "First", artist: "WitchDoktors", album: "Timeless & Dimeless", album_artist: "WitchDoktors", track: "1", year: "2019", genre: "Punk" });
  assert.equal(edits["b.mp3"].title, "Second");
  assert.equal(edits["b.mp3"].artist, "Guest", "a track by another artist keeps it");
  assert.equal(edits["b.mp3"].track, "2");
});

test("no year or genre means none is typed, and a different track count types nothing", () => {
  const found = { album: "A", album_artist: "B", tracks: [{ number: 1, title: "One" }] };
  assert.deepEqual(Object.keys(editsFromFound(["x.mp3"], found)["x.mp3"]).sort(), ["album", "album_artist", "artist", "title", "track"]);
  assert.deepEqual(editsFromFound(["x.mp3", "y.mp3"], found), {});
});
import { editsFromAlbum, libraryAlbums, type SourceSong } from "./fix-tags-logic.ts";

const song = (folder: string, title: string, track: number, extra: Partial<SourceSong> = {}): SourceSong => ({
  album: "Sing the Sorrow", album_artist: "AFI", artist: "AFI", genre: "Punk", release_year: 2003, title, source_uri: `${folder}\\${track}.mp3`, track_number: track, ...extra,
});

test("albums of the library that match the words typed, the same size first, never the folder itself", () => {
  const library = [
    song("C:\\Music\\AFI\\Sing", "Miseria Cantare", 1), song("C:\\Music\\AFI\\Sing", "Girl's Not Grey", 2),
    song("C:\\Music\\AFI\\Sing Deluxe", "Miseria Cantare", 1, { album: "Sing the Sorrow (Deluxe)" }), song("C:\\Music\\AFI\\Sing Deluxe", "Girl's Not Grey", 2, { album: "Sing the Sorrow (Deluxe)" }), song("C:\\Music\\AFI\\Sing Deluxe", "Bonus", 3, { album: "Sing the Sorrow (Deluxe)" }),
    song("C:\\Music\\Other\\X", "Whatever", 1, { album: "Another", artist: "Someone", album_artist: "Someone" }),
    song("C:\\Music\\Here", "Unknown", 1, { album: "Sing the Sorrow" }),
  ];
  const found = libraryAlbums(library, "afi sing", "c:/music/here", 2);
  assert.deepEqual(found.map((a) => a.album), ["Sing the Sorrow", "Sing the Sorrow (Deluxe)"], "two songs like the folder first");
  assert.equal(found[0].songs.length, 2);
  assert.deepEqual(libraryAlbums(library, "  ", "x", 2), [], "nothing typed, nothing listed");
});

test("copying an album types album-wide fields on every song and per-song fields only when the counts agree", () => {
  const source = libraryAlbums([song("C:\\M\\Sing", "Miseria Cantare", 1), song("C:\\M\\Sing", "Girl's Not Grey", 2)], "sing", "none", 2)[0];
  const all = new Set(["title", "artist", "track", "album", "album_artist", "year", "genre"] as const);
  const edits = editsFromAlbum(["a.mp3", "b.mp3"], source, all);
  assert.deepEqual(edits["b.mp3"], { album: "Sing the Sorrow", album_artist: "AFI", year: "2003", genre: "Punk", title: "Girl's Not Grey", artist: "AFI", track: "2" });
  const three = editsFromAlbum(["a.mp3", "b.mp3", "c.mp3"], source, all);
  assert.deepEqual(three["c.mp3"], { album: "Sing the Sorrow", album_artist: "AFI", year: "2003", genre: "Punk" }, "no titles when the counts differ");
  assert.deepEqual(editsFromAlbum(["a.mp3"], source, new Set(["genre"] as const)), { "a.mp3": { genre: "Punk" } });
});
