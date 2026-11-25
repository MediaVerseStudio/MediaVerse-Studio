import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, describeRename, distinctNames, looseKey, oddities, parseSettled, signatureOf, similarNames, suggestSpelling, visibleName } from "./artist-names.ts";
import type { LibrarySong } from "./library-format.ts";

const song = (path: string, artist: string | null, album_artist: string | null = null): LibrarySong => ({
  album: "A", album_artist, artist, genre: null, release_year: null, title: path, source_uri: `C:\\M\\${path}.mp3`, track_number: null,
});

test("names that differ only by punctuation, spacing, case, accents, & or The share a key", () => {
  assert.equal(looseKey("A.F.I."), looseKey("AFI"));
  assert.equal(looseKey("Guns N' Roses"), looseKey("Guns N Roses"));
  assert.equal(looseKey("Beyoncé"), looseKey("beyonce"));
  assert.equal(looseKey("Heaven & Hell"), looseKey("Heaven and Hell"));
  assert.equal(looseKey("The Cure"), looseKey("Cure"));
  assert.notEqual(looseKey("AFI"), looseKey("AF"));
  assert.equal(looseKey("!!!"), "", "no letters, no key");
});

test("a band spelt two ways is one group with the commoner spelling suggested", () => {
  const songs = [song("1", "AFI", "AFI"), song("2", "AFI", "AFI"), song("3", "A.F.I.", "A.F.I."), song("4", "Blink-182", "Blink-182")];
  const groups = similarNames(songs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].suggested, "AFI");
  assert.deepEqual(groups[0].spellings, [{ name: "AFI", songs: 2 }, { name: "A.F.I.", songs: 1 }]);
  assert.equal(groups[0].paths.length, 3, "Blink-182 is not part of it");
});

test("a tie goes to the plainer spelling, and a song with both tags in one spelling counts once", () => {
  assert.equal(suggestSpelling([{ name: "A.F.I.", songs: 2 }, { name: "AFI", songs: 2 }]), "AFI");
  const groups = similarNames([song("1", "A.F.I.", "AFI")]);
  assert.deepEqual(groups[0].spellings.map((s) => s.songs), [1, 1]);
  assert.equal(groups[0].paths.length, 1);
});

test("one spelling, empty names and symbol-only names make no group", () => {
  assert.deepEqual(similarNames([song("1", "AFI"), song("2", "AFI"), song("3", null, "   "), song("4", "!!!"), song("5", "???")]), []);
});

test("the question names what changes", () => {
  const [group] = similarNames([song("1", "AFI"), song("2", "AFI"), song("3", "A.F.I.")]);
  assert.equal(describeRename(group, "AFI"), "Change “A.F.I.” to “AFI” in 1 song tag?");
});

test("MusicBrainz's own spelling is the suggestion, even when most songs use another", () => {
  const songs = [song("1", "A.F.I."), song("2", "A.F.I."), song("3", "A.F.I."), song("4", "AFI")];
  const canonical = new Map([["AFI", "AFI"], ["A.F.I.", "AFI"]]);
  const [group] = similarNames(songs, canonical);
  assert.equal(group.suggested, "AFI", "not the commoner A.F.I.");
  assert.equal(group.official, "AFI");
  // With no answer from MusicBrainz it is the commoner spelling, as before.
  assert.equal(similarNames(songs)[0].suggested, "A.F.I.");
});

test("an official spelling nobody uses is still offered, and a lone name that differs from it is listed", () => {
  const songs = [song("1", "A.F.I."), song("2", "A.F.I")];
  const [group] = similarNames(songs, new Map([["A.F.I.", "AFI"]]));
  assert.equal(group.suggested, "AFI");
  assert.deepEqual(group.spellings.map((s) => s.name), ["A.F.I", "A.F.I.", "AFI"]);
  const lone = similarNames([song("1", "Guns N Roses"), song("2", "Guns N Roses")], new Map([["Guns N Roses", "Guns N' Roses"]]));
  assert.equal(lone.length, 1);
  assert.equal(lone[0].suggested, "Guns N' Roses");
  assert.match(lone[0].reason ?? "", /MusicBrainz spells this artist/);
  // A name MusicBrainz agrees with, or does not know, is left alone.
  assert.deepEqual(similarNames([song("1", "AFI")], new Map([["AFI", "AFI"]])), []);
  assert.deepEqual(similarNames([song("1", "Nobody")], new Map([["Nobody", ""]])), []);
});

test("a stray space is a spelling of its own, shown and found", () => {
  const groups = similarNames([song("1", "AFI "), song("2", "AFI "), song("3", "AFI")]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].spellings.map((s) => s.name), ["AFI ", "AFI"]);
  assert.equal(groups[0].suggested, "AFI");
  assert.equal(visibleName("AFI "), "AFI␣");
  assert.deepEqual(oddities("AFI "), ["a space at the end"]);
  assert.deepEqual(oddities("Guns N’ Roses"), ["a curly apostrophe"]);
  assert.deepEqual(oddities("AFI"), []);
  const alone = similarNames([song("1", "Blink-182 ")]);
  assert.equal(alone[0].reason, "The name has stray spacing.");
  assert.equal(alone[0].suggested, "Blink-182");
  assert.equal(cleanName("  The   Cure\u00a0"), "The Cure");
});

test("every distinct spelling is what MusicBrainz is asked about", () => {
  assert.deepEqual(distinctNames([song("1", "B", "A"), song("2", "A", "A "), song("3", null, "  ")]), ["A", "A ", "B"]);
});

test("a name the person settled is not listed again, even when MusicBrainz spells it differently", () => {
  // The band writes itself "A.F.I."; MusicBrainz says "AFI". After "Use A.F.I." every song says A.F.I.
  const songs = [song("1", "A.F.I.", "A.F.I."), song("2", "A.F.I.", "A.F.I.")];
  const canonical = new Map([["A.F.I.", "AFI"]]);
  assert.equal(similarNames(songs, canonical).length, 1, "before it is settled the official spelling is offered");
  const settled = { [looseKey("A.F.I.")]: { signature: signatureOf(["A.F.I."]), chosen: "A.F.I." } };
  assert.equal(similarNames(songs, canonical, settled).length, 0, "settled: gone from the list");
});

test("a settled name comes back, with the chosen spelling suggested, when its spellings change", () => {
  const settled = { [looseKey("A.F.I.")]: { signature: signatureOf(["A.F.I."]), chosen: "A.F.I." } };
  const songs = [song("1", "A.F.I.", "A.F.I."), song("2", "AFI", "AFI")];
  const groups = similarNames(songs, new Map([["A.F.I.", "AFI"]]), settled);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].suggested, "A.F.I.", "the person's own choice beats MusicBrainz's");
});

test("leaving a name as it is hides it only while its spellings stay the same", () => {
  const songs = [song("1", "AFI", "AFI"), song("2", "A.F.I.", "A.F.I.")];
  const settled = { [looseKey("AFI")]: { signature: signatureOf(["AFI", "A.F.I."]) } };
  assert.equal(similarNames(songs, new Map(), settled).length, 0);
  assert.equal(similarNames([...songs, song("3", "A F I", "A F I")], new Map(), settled).length, 1);
});

test("stored decisions are read defensively", () => {
  assert.deepEqual(parseSettled(null), {});
  assert.deepEqual(parseSettled({ a: { signature: "x", chosen: "y" }, b: { signature: 3 }, c: "no" }), { a: { signature: "x", chosen: "y" } });
});