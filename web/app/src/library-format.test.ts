import { test } from "node:test";
import assert from "node:assert/strict";
import { albumsOf, alsoAppearsOn, artistKey, artistWall, cellText, guestArtists, guestOf, withoutFeatured, compareNames, formatLength, formatTotal, letterOf, sortKey, sortSongs, type LibrarySong } from "./library-format.ts";

const song = (title: string, more: Partial<LibrarySong> = {}): LibrarySong => ({
  album: null, album_artist: null, artist: null, genre: null, release_year: null, title, source_uri: `C:\\M\\${title}.mp3`, track_number: null, ...more,
});

test("a leading The, A or An is ignored when asked", () => {
  assert.equal(sortKey("The Abruptors", true), "abruptors");
  assert.equal(sortKey("The Abruptors", false), "the abruptors");
  assert.equal(sortKey("A Perfect Circle", true), "perfect circle");
  assert.equal(sortKey("The The", true), "the", "a name that is only an article keeps it");
  assert.equal(sortKey("Theory of a Deadman", true), "theory of a deadman", "only a whole word");
  assert.equal(letterOf("The Abruptors", true), "A");
  assert.equal(letterOf("¡TchKunG!", true), "#");
  assert.equal(letterOf("Émilie Simon", true), "E", "accents are filed under their letter");
  assert.ok(compareNames("The Abruptors", "Adam Sandler", true) < 0);
  assert.ok(compareNames("2 Live Crew", "10,000 Maniacs", true) < 0, "numbers in order");
});

test("the artist wall groups by letter under album artist and ignores The", () => {
  const wall = artistWall(
    [
      song("1", { artist: "AFI", album: "Crash Love", release_year: 2009, length_ms: 60_000 }),
      song("2", { artist: "Guest", album_artist: "The Abruptors", album: "LP" }),
      song("3", { artist: "Against Me!", album: "New Wave", release_year: 2007 }),
      song("4", { artist: "Against Me!", album: "Searching", release_year: 2003 }),
      song("5", { artist: "88 Fingers Louie" }),
    ],
    true,
  );
  assert.deepEqual(wall.map((g) => g.letter), ["#", "A"]);
  assert.deepEqual(wall[1].artists.map((a) => a.name), ["The Abruptors", "AFI", "Against Me!"]);
  assert.deepEqual(wall[1].artists[2].albums.map((a) => a.name), ["Searching", "New Wave"], "albums oldest first");
  assert.equal(artistWall([song("x", { artist: "AFI" }), song("y", { artist: "Blink-182" })], true, "blink")[0].artists[0].name, "Blink-182");
});

test("album order and song sorting", () => {
  const songs = [song("b", { album: "Z", release_year: 2001 }), song("a", { album: "Y" }), song("c", { album: "X", release_year: 1999 })];
  assert.deepEqual(albumsOf(songs, "year-asc", true).map((a) => a.name), ["X", "Z", "Y"], "no year: last");
  assert.deepEqual(albumsOf(songs, "year-desc", true).map((a) => a.name), ["Z", "X", "Y"]);
  assert.deepEqual(albumsOf(songs, "name", true).map((a) => a.name), ["X", "Y", "Z"]);
  const tracks = [song("Two", { track_number: 2, length_ms: 300_000 }), song("One", { track_number: 1 }), song("Three", { track_number: 3, length_ms: 100_000 })];
  assert.deepEqual(sortSongs(tracks, "number").map((s) => s.title), ["One", "Two", "Three"]);
  assert.deepEqual(sortSongs(tracks, "length").map((s) => s.title), ["Three", "Two", "One"], "no length: last");
  assert.deepEqual(sortSongs(tracks, "length", true).map((s) => s.title), ["Two", "Three", "One"], "still last when descending");
});

test("formatting", () => {
  assert.equal(formatLength(95_000), "1:35");
  assert.equal(formatLength(3_725_000), "1:02:05");
  assert.equal(formatTotal(71 * 60_000), "71 minutes");
  assert.equal(formatTotal(6.6 * 3_600_000), "6.6 hours");
  assert.equal(cellText(song("x", { bitrate_kbps: 245 }), "bitrate"), "245 kbps");
  assert.equal(cellText(song("x"), "type"), "MP3");
});

test("artists spelt with other capitals or apostrophes are one artist", () => {
  const songs = [
    song("1", { artist: "Alice in Chains", album: "Dirt" }),
    song("2", { artist: "Alice in Chains", album: "Dirt" }),
    song("3", { artist: "Alice In Chains", album: "Jar of Flies" }),
    song("4", { album_artist: "Scott Bradlee’s Postmodern Jukebox", album: "Swing" }),
    song("5", { album_artist: "Scott Bradlee's Postmodern Jukebox", album: "Swing 2" }),
  ];
  const artists = artistWall(songs, true).flatMap((g) => g.artists.map((a) => [a.name, a.songs.length]));
  assert.deepEqual(artists, [["Alice in Chains", 3], ["Scott Bradlee’s Postmodern Jukebox", 2]]);
});


test("a compilation song credits its own band: it is on that band's page, not on the wall", () => {
  const songs = [
    song("a", { artist: "NOFX", album: "Punk in Drublic", release_year: 1994 }),
    song("b", { artist: "NOFX", album_artist: "Various Artists", album: "Fat Music", release_year: 1996 }),
    song("c", { artist: "Strung Out feat. A Singer", album_artist: "Various Artists", album: "Fat Music", release_year: 1996 }),
    song("d", { artist: "Strung Out", album_artist: "Various Artists", album: "Another Mix" }),
    song("e", { artist: "Me First & The Gimme Gimmes", album_artist: "Various Artists", album: "Fat Music" }),
  ];
  assert.equal(withoutFeatured("Band (ft. Singer)"), "Band");
  assert.equal(guestOf(songs[0]), null, "filed under its own artist");
  assert.equal(guestOf(songs[2]), "Strung Out", "guests are dropped");
  assert.equal(guestOf(song("x", { artist: "Solo" })), null);
  const wall = artistWall(songs, true).flatMap((g) => g.artists.map((a) => a.name));
  assert.deepEqual(wall.sort(), ["NOFX", "Various Artists"], "compilation-only bands are not on the wall");
  assert.deepEqual(alsoAppearsOn(songs, artistKey("NOFX")).map((s) => s.title), ["b"], "a band with albums of its own also appears on compilations");
  const guests = guestArtists(songs, true);
  assert.deepEqual(guests.map((g) => g.name), ["Me First & The Gimme Gimmes", "Strung Out"], "only those never filed as an album artist; NOFX is not here");
  assert.deepEqual(guests[1].songs.map((s) => s.title), ["c", "d"]);
  assert.deepEqual(guests[1].albums.map((a) => a.name).sort(), ["Another Mix", "Fat Music"]);
  assert.deepEqual(guestArtists(songs, true, "strung").map((g) => g.name), ["Strung Out"], "the search filter");
});
