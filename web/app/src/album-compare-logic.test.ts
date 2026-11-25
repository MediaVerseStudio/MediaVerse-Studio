import assert from "node:assert/strict";
import test from "node:test";
import { adoptArguments, adoptCount, clock, difference, differenceKeys, ripHint, ripReason, type CompareRow, type Comparison } from "./album-compare-logic.ts";

function row(n: number, diffMs: number | null, differs: string[] = []): CompareRow {
  return {
    path: `C:\\M\\${n}.mp3`,
    name: `0${n}`,
    yours: { track: n, disc: null, title: `Song ${n}`, artist: "AFI", length_ms: 200_000 },
    release: { number: n, title: `Song ${n}`, artist: "AFI", length_ms: 200_000 - (diffMs ?? 0) },
    diff_ms: diffMs,
    differs,
    extra: false,
  };
}
const comparison = (rows: CompareRow[]): Comparison => ({
  release: { id: "r1", release_group_id: "g1", title: "Black Sails in the Sunset", artist: "AFI", date: "1999", country: "US", label: "", catalog_number: "", barcode: "", url: "", tracks: rows.length },
  songs: rows.length,
  album: [
    { field: "album", yours: "Black Sails", release: "Black Sails in the Sunset", differs: true },
    { field: "album_artist", yours: "AFI", release: "AFI", differs: false },
    { field: "year", yours: "1999", release: "1999", differs: false },
    { field: "genre", yours: "Punk", release: "Punk Rock", differs: true },
  ],
  rows,
  missing: [],
});

test("every length agreeing is nothing to worry about", () => {
  const hint = ripHint([row(1, 300), row(2, -1200), row(3, 0), row(4, 800)]);
  assert.equal(hint.level, "agree");
});

test("a few songs a little off while the rest agree hints at a ripping problem, and says which", () => {
  const hint = ripHint([row(1, 200), row(2, 0), row(3, -4200), row(4, 100), row(5, 300), row(6, -50)]);
  assert.equal(hint.level, "suspect");
  assert.equal(hint.suspects.length, 1);
  assert.match(hint.text, /track 3 is 4\.2 s shorter/);
  assert.equal(ripReason(hint), "track 3 is 4.2 s shorter than MusicBrainz says; the other songs agree");
});

test("the hint names the likely cause by whether the songs are shorter or longer", () => {
  assert.match(ripHint([row(1, 0), row(2, 0), row(3, 0), row(4, -3000)]).text, /skipped or damaged/);
  assert.match(ripHint([row(1, 0), row(2, 0), row(3, 0), row(4, 3000)]).text, /Extra or repeated audio/);
  assert.match(ripHint([row(1, 0), row(2, 0), row(3, 0), row(4, 3000), row(5, -3000)]).text, /skipped or repeated/);
});

test("most songs differing means another edition, not a ripping problem", () => {
  const hint = ripHint([row(1, 5000), row(2, 4800), row(3, -6000), row(4, 7000), row(5, 100)]);
  assert.equal(hint.level, "edition");
  assert.equal(hint.suspects.length, 0);
  assert.equal(ripReason(hint), "");
});

test("a big difference is another edition's track, and too few lengths say nothing", () => {
  assert.equal(ripHint([row(1, 0), row(2, 0), row(3, 0), row(4, 90_000), row(5, 0)]).level, "edition");
  assert.equal(ripHint([row(1, 0), row(2, null)]).level, "unknown");
});

test("the ticks become the arguments of the adopt command, and a count", () => {
  const c = comparison([row(1, 0, []), row(2, 0, ["title"]), row(3, -4000, ["title", "track"])]);
  assert.deepEqual(differenceKeys(c), ["album:album", "album:genre", "song:C:\\M\\2.mp3:title", "song:C:\\M\\3.mp3:title", "song:C:\\M\\3.mp3:track"]);
  const ticked = new Set(["album:album", "song:C:\\M\\3.mp3:title", "song:C:\\M\\2.mp3:track"]);
  assert.deepEqual(adoptArguments("C:\\M", c, ticked), {
    path: "C:\\M",
    release_id: "r1",
    album_fields: ["album"],
    songs: [{ path: "C:\\M\\3.mp3", fields: ["title"] }],
  });
  assert.equal(adoptCount(c, ticked), 3 + 1, "the album title goes into all 3 songs, plus one song title (a tick on a value that does not differ is ignored)");
  assert.equal(adoptCount(c, new Set()), 0);
});

test("lengths and differences are shown plainly", () => {
  assert.equal(clock(201_500), "3:22");
  assert.equal(clock(null), "");
  assert.equal(difference(4200), "+4.2 s");
  assert.equal(difference(-4200), "-4.2 s");
  assert.equal(difference(null), "");
});