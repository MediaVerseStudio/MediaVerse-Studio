import assert from "node:assert/strict";
import { test } from "node:test";
import { fileUrl, matchKey, parsePlaylist, pathFromLocation, resolveEntries, toM3u8, toXspf } from "./playlist-files.ts";

const song = (title: string, artist: string, album: string, ms: number, file: string) => ({ title, artist, album, album_artist: null, genre: null, release_year: null, track_number: 1, length_ms: ms, source_uri: file });
const mine = [
  song("Ode to My Car", "Adam Sandler", "What the Hell Happened to Me?", 235_000, "C:\\Music\\Adam Sandler\\What the Hell\\03 Ode to My Car.mp3"),
  song("Ocean Avenue", "Yellowcard", "Ocean Avenue", 199_000, "C:\\Music\\Yellowcard\\Ocean Avenue\\02 Ocean Avenue.mp3"),
  song("Ocean Avenue", "Yellowcard", "Live from Las Vegas", 260_000, "C:\\Music\\Yellowcard\\Live\\05 Ocean Avenue.mp3"),
  song("Rock & Roll (Remastered 2012)", "Led Zeppelin", "IV", 220_000, "C:\\Music\\Led Zeppelin\\IV\\04 Rock & Roll.mp3"),
];

test("an exported XSPF reads back with every song found again", () => {
  const xspf = toXspf("Road trip <2026>", mine);
  assert.match(xspf, /<title>Road trip &lt;2026&gt;<\/title>/);
  assert.match(xspf, /<location>file:\/\/\/C:\/Music\/Adam%20Sandler\//);
  const read = parsePlaylist(xspf);
  assert.equal(read.name, "Road trip <2026>");
  assert.equal(read.entries.length, 4);
  assert.deepEqual(resolveEntries(read.entries, mine).songs, mine, "by file, in order");
});

test("a friend's playlist finds the songs by artist and title wherever their files are, and skips the rest", () => {
  const theirs = toXspf("Theirs", [
    song("Ocean Avenue", "Yellowcard", "Live from Las Vegas", 259_000, "D:\\Tunes\\yc\\live.mp3"),
    song("ROCK AND ROLL", "Led Zeppelin feat. Nobody", "Led Zeppelin IV", 221_000, "D:\\Tunes\\lz.mp3"),
    song("Not Mine", "Someone", "Else", 100_000, "D:\\Tunes\\x.mp3"),
  ]);
  const { songs, missing } = resolveEntries(parsePlaylist(theirs).entries, mine);
  assert.deepEqual(songs.map((s) => s.source_uri), [mine[2].source_uri, mine[3].source_uri], "the live version (same album), and Rock & Roll despite the spelling");
  assert.deepEqual(missing.map((m) => m.title), ["Not Mine"]);
});

test("M3U8 out and in, and JSPF in", () => {
  const m3u = toM3u8("Mix", mine.slice(0, 2));
  assert.match(m3u, /^#EXTM3U\r\n#PLAYLIST:Mix\r\n#EXTINF:235,Adam Sandler - Ode to My Car\r\nC:\\Music/);
  const read = parsePlaylist(m3u, "C:\\x\\Mix.m3u8");
  assert.equal(read.name, "Mix");
  assert.deepEqual(read.entries[1], { durationMs: 199_000, artist: "Yellowcard", title: "Ocean Avenue", location: "C:\\Music\\Yellowcard\\Ocean Avenue\\02 Ocean Avenue.mp3" });
  // Another computer's paths: found by the #EXTINF words instead.
  const elsewhere = parsePlaylist("#EXTM3U\n#EXTINF:236,Adam Sandler - Ode To My Car\n/home/pat/music/ode.mp3\nplain.mp3\n", "friends.m3u");
  assert.equal(elsewhere.name, "friends");
  const found = resolveEntries(elsewhere.entries, mine);
  assert.deepEqual(found.songs, [mine[0]]);
  assert.equal(found.missing.length, 1);
  const jspf = JSON.stringify({ playlist: { title: "From ListenBrainz", track: [{ title: "Ocean Avenue", creator: "Yellowcard", album: "Ocean Avenue", duration: 199_500, identifier: ["https://musicbrainz.org/recording/x"] }] } });
  const fromJson = parsePlaylist(jspf);
  assert.equal(fromJson.name, "From ListenBrainz");
  assert.deepEqual(resolveEntries(fromJson.entries, mine).songs, [mine[1]]);
});

test("locations and names", () => {
  assert.equal(pathFromLocation(fileUrl("C:\\Music\\A & B\\#1 Song.mp3")), "C:\\Music\\A & B\\#1 Song.mp3");
  assert.equal(matchKey("Beyoncé – Halo (Live) [Remastered]"), "beyonce halo");
  assert.equal(matchKey("Song feat. Guest"), "song");
});
