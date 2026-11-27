import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCandidate, lengthGap, lengthText, lyricsWebSearchUrl, yourSong, lookupSummary, textToUse, type LyricsCandidate } from "./lyrics-lookup-format.ts";

const candidate = (extra: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
  id: 1,
  track: "Song",
  artist: "Band",
  album: "LP",
  duration: 201.4,
  instrumental: false,
  plain: "words",
  synced: "[00:01.00]words",
  ...extra,
});

test("a candidate reads in one line", () => {
  assert.equal(describeCandidate(candidate()), "Band — Song (LP, 3:21): time-stamped lyrics");
  assert.equal(describeCandidate(candidate({ synced: null })), "Band — Song (LP, 3:21): plain lyrics");
  assert.equal(describeCandidate(candidate({ instrumental: true, plain: null, synced: null, album: null, duration: null })), "Band — Song: instrumental");
  assert.equal(lengthText(null), "");
  assert.equal(lengthText(59.6), "1:00");
});

test("time-stamped lyrics are preferred, and instrumentals give no text", () => {
  assert.equal(textToUse(candidate()), "[00:01.00]words");
  assert.equal(textToUse(candidate({ synced: " " })), "words");
  assert.equal(textToUse(candidate({ plain: null, synced: null, instrumental: true })), null);
});

test("the summary says what was found", () => {
  assert.match(lookupSummary({ via: "exact", results: [candidate()] }), /has this song/);
  assert.match(lookupSummary({ via: "search", results: [candidate(), candidate()] }), /2 similar songs/);
  assert.match(lookupSummary({ via: "search", results: [] }), /no lyrics/);
});

test("words from another version or another artist are labelled as such", () => {
  assert.match(describeCandidate(candidate({ other_version: true, synced: null })), /another version/);
  assert.match(describeCandidate(candidate({ other_artist: true, synced: null })), /another artist/);
  assert.match(lookupSummary({ via: "other_artists", results: [candidate({ other_artist: true })] }), /original or a cover/);
});

test("the window says how a candidate's length compares with the song's own", () => {
  assert.equal(lengthGap(254, 252), "same length");
  assert.equal(lengthGap(260, 250), "0:10 longer");
  assert.equal(lengthGap(240, 250), "0:10 shorter");
  assert.equal(lengthGap(240, null), "");
  assert.equal(yourSong("Song", "Band", "LP", 252), "Your song: Band — Song (LP, 4:12)");
  assert.match(describeCandidate(candidate({ duration: 261 }), 250), /0:11 longer than your song/);
});

test("the web search asks for the artist, album, song and lyrics, and leaves out what is unknown", () => {
  assert.equal(lyricsWebSearchUrl("New Wave", "Against Me!", "New Wave"), "https://www.google.com/search?q=Against%20Me!%20New%20Wave%20New%20Wave%20lyrics");
  assert.equal(lyricsWebSearchUrl("A & B?", null, ""), "https://www.google.com/search?q=A%20%26%20B%3F%20lyrics");
});
