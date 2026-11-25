import assert from "node:assert/strict";
import { test } from "node:test";
import { albumKey, batchRequests, commonValue, groupTracks, isVariousArtists, mostCommon, problemNames, suggestion, suspectedAlbums, withoutDiscLabel, type IssueTrack } from "./tag-batch.ts";

const track = (id: string, folder: string, extra: Partial<IssueTrack> = {}): IssueTrack => ({
  id,
  title: `Song ${id}`,
  artist: "Band",
  album: null,
  album_artist: null,
  genre: null,
  release_year: null,
  track_number: Number(id),
  source_uri: `C:\\m\\${folder}\\${id}.mp3`,
  suggestions: [],
  ...extra,
});

const tracks = [
  track("1", "A\\LP", { suggestions: ["Suggested album: LP", "Suggested album artist: Band"] }),
  track("2", "A\\LP", { suggestions: ["Suggested album: LP", "Suggested album artist: Band"] }),
  track("3", "B\\Other", { artist: "Other", suggestions: ["Suggested album: Other"] }),
];

test("suggestions and problem names are read from the suggestion text", () => {
  assert.equal(suggestion(tracks[0], "Suggested album"), "LP");
  assert.equal(suggestion(tracks[0], "Suggested genre"), null);
  assert.deepEqual(problemNames(tracks[0]), ["album", "album artist"]);
  assert.deepEqual(problemNames(track("9", "X", { suggestions: ["Genre needs review.", "Suggested Title: Foo"] })), ["genre", "title"]);
});

test("tracks can be grouped several ways, biggest group first", () => {
  assert.deepEqual(groupTracks(tracks, "problem").map((g) => [g.label, g.tracks.length]), [["album + album artist", 2], ["album", 1]]);
  assert.deepEqual(groupTracks(tracks, "folder").map((g) => [g.label, g.tracks.length]), [["A / LP", 2], ["B / Other", 1]]);
  assert.deepEqual(groupTracks(tracks, "suggested_album").map((g) => g.label), ["LP", "Other"]);
  assert.deepEqual(groupTracks(tracks, "suggested_artist").map((g) => g.label), ["Band", "No suggested artist"]);
  assert.deepEqual(groupTracks(tracks, "current_artist").map((g) => g.label), ["Band", "Other"]);
  assert.deepEqual(groupTracks([], "folder"), []);
});

test("a shared value is found only when every track agrees", () => {
  assert.equal(commonValue(tracks.slice(0, 2), (t) => suggestion(t, "Suggested album")), "LP");
  assert.equal(commonValue(tracks, (t) => suggestion(t, "Suggested album")), null);
  assert.equal(commonValue([], () => "x"), null);
  assert.equal(commonValue(tracks, () => null), null);
});

test("a batch edit replaces filled fields and keeps each track's own value for blank ones", () => {
  const requests = batchRequests(tracks.slice(1), { artist: "", album: "LP", album_artist: "Band", genre: "", release_year: "1999", compilation: undefined });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].artist, "Other", "blank keeps the track's own artist");
  assert.equal(requests[0].album, "LP");
  assert.equal(requests[0].release_year, 1999);
  assert.equal(requests[0].title, "Song 2");
  assert.equal(requests[0].track_number, 2);
  assert.equal("compilation" in requests[0], false, "left alone when not asked");
  const flagged = batchRequests(tracks, { artist: "", album: "", album_artist: "Various Artists", genre: "", release_year: "x", compilation: true });
  assert.equal(flagged[0].compilation, true);
  assert.equal(flagged[0].release_year, null, "an invalid year is ignored");
  assert.equal(batchRequests(tracks, { artist: "", album: "", album_artist: "", genre: "", release_year: "", compilation: false })[0].compilation, false);
});

test("Various Artists is recognised in any case", () => {
  assert.equal(isVariousArtists("Various Artists"), true);
  assert.equal(isVariousArtists(" various artists "), true);
  assert.equal(isVariousArtists("Band"), false);
  assert.equal(isVariousArtists(null), false);
});

const song = (n: number, album: string | null, extra: Partial<IssueTrack> = {}): IssueTrack => ({
  id: `t${n}`, title: `Song ${n}`, artist: "1876", album, album_artist: "1876", genre: "Punk", release_year: 2018, track_number: n,
  source_uri: `C:\\m\\1876\\${album ?? "x"}\\${n}.mp3`, suggestions: [], ...extra,
});

test("album names match whatever the case, accents, punctuation and disc labels", () => {
  assert.equal(albumKey("Pow Wow Punk Rock"), albumKey("pow-wow punk rock!"));
  assert.equal(albumKey("Pow Wow Punk Rock (Disc 1)"), albumKey("POW WOW PUNK ROCK [Deluxe Edition]"));
  assert.equal(albumKey("Café Tacvba"), albumKey("Cafe Tacvba"));
  assert.equal(albumKey("Rock & Roll"), albumKey("Rock and Roll"));
  assert.notEqual(albumKey("Pow Wow"), albumKey("Pow Wow Punk Rock"));
});

test("an album split by different spellings and a missing album artist is one suspected album", () => {
  const tracks = [
    song(1, "Pow Wow Punk Rock"),
    song(2, "Pow Wow Punk Rock"),
    song(3, "Pow-Wow Punk Rock", { album_artist: null }),
    song(4, "pow wow punk rock", { release_year: 2019 }),
    song(5, "Another Album"),
    song(6, "Another Album"),
  ];
  const found = suspectedAlbums(tracks);
  assert.equal(found.length, 1, "the consistent album is left alone");
  const [album] = found;
  assert.equal(album.tracks.length, 4);
  assert.deepEqual(album.differences, ["album spelling (3 versions)", "album artist missing on 1 track", "year (2 versions)"]);
  assert.deepEqual(album.proposal, { album: "Pow Wow Punk Rock", album_artist: "1876", release_year: "2018", genre: "Punk" });
});

test("different track artists are fine (compilations), and generic names are matched per artist", () => {
  const compilation = [song(1, "Skampilation", { artist: "A", album_artist: "Various Artists" }), song(2, "Skampilation", { artist: "B", album_artist: "Various Artists" })];
  assert.deepEqual(suspectedAlbums(compilation), []);
  const greatest = [song(1, "Greatest Hits", { album_artist: "Band A", artist: "Band A", release_year: 1990 }), song(2, "Greatest Hits", { album_artist: "Band B", artist: "Band B", release_year: 2001 })];
  assert.deepEqual(suspectedAlbums(greatest), [], "two different bands' Greatest Hits are not one album");
});

test("the most common value wins, ignoring blanks", () => {
  const tracks = [song(1, "A", { genre: null }), song(2, "A", { genre: "Ska" }), song(3, "A", { genre: "Ska" }), song(4, "A", { genre: "Punk" })];
  assert.equal(mostCommon(tracks, (t) => t.genre), "Ska");
  assert.equal(mostCommon([song(1, "A", { genre: null })], (t) => t.genre), null);
});
test("the discs of a set are one album, but their disc labels are not spelling mistakes and are never overwritten", () => {
  const discs = [
    song(1, "Wrecktrospective [Disc 1]", { album_artist: "Various Artists", release_year: 2009 }),
    song(2, "Wrecktrospective [Disc 2]", { album_artist: "Various Artists", release_year: 2009 }),
    song(3, "Wrecktrospective [Disc 3]", { album_artist: "Various Artists", release_year: 2009 }),
  ];
  assert.deepEqual(suspectedAlbums(discs), [], "a consistent three-disc set is fine");
  const uneven = [...discs, song(4, "Wrecktrospective [Disc 3]", { album_artist: "Various Artists", release_year: 2008 })];
  const [found] = suspectedAlbums(uneven);
  assert.deepEqual(found.differences, ["year (2 versions)"]);
  assert.equal(found.proposal.album, "", "each track keeps its own disc's name");
  assert.equal(found.proposal.release_year, "2009");
  assert.match(found.label, /^Wrecktrospective \(several discs\)/);
  assert.equal(withoutDiscLabel("Modern Rock Live: Volume 1 [Disc 2]"), "Modern Rock Live: Volume 1");
  assert.equal(withoutDiscLabel("Live CD 2"), "Live");
  assert.equal(withoutDiscLabel("Discography"), "Discography", "a word starting with 'disc' is not a disc label");
});

test("placeholder values are never the proposal", () => {
  const tracks = [song(1, "A", { genre: "Unknown genre" }), song(2, "A", { genre: "Unknown genre" }), song(3, "A", { genre: "Ska" })];
  assert.equal(mostCommon(tracks, (t) => t.genre), "Ska");
  assert.equal(mostCommon([song(1, "A", { genre: "Unknown" })], (t) => t.genre), null);
});
