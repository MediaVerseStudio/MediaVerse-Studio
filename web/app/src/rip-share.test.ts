import assert from "node:assert/strict";
import { test } from "node:test";
import { attachUrl, detailsFromCandidate, detailsFromManual, gnudbArgs, musicbrainzRelease, shareOptions, trackLengthsMs } from "./rip-share.ts";
import type { LookupResult } from "./rip-format.ts";

const toc = { track_starts: [0, 17_015, 31_777], leadout: 43_280 };

test("MusicBrainz's attach link counts from the lead-in and puts the lead-out first", () => {
  assert.equal(attachUrl(toc), "https://musicbrainz.org/cdtoc/attach?toc=1+3+43430+150+17165+31927");
});

test("track lengths come from the table of contents", () => {
  assert.deepEqual(trackLengthsMs(toc), [226_867, 196_827, 153_373]);
});

test("a chosen album and a typed one become the same kind of details", () => {
  const candidate = detailsFromCandidate({
    source: "discogs", album: "Timeless & Dimeless", album_artist: "WitchDoktors", year: 2019, genre: "Punk", compilation: false,
    tracks: [{ number: 1, title: "A" }, { number: 2, title: "B", artist: "Guest" }, { number: 3, title: "C" }],
    release: { date: "2019", country: "UK", label: "Tribal Vibes", catalog_number: "TVCD102", barcode: "5024545875225" },
  });
  assert.equal(candidate.tracks[1].artist, "Guest");
  assert.equal(candidate.label, "Tribal Vibes");

  assert.equal(detailsFromManual({ album: "X", artist: "Y", titles: "a\nb" }, 3), "Type all 3 track titles first (one per line).");
  assert.equal(detailsFromManual({ album: "", artist: "Y", titles: "a\nb\nc" }, 3), "Type the album and the artist first.");
  const typed = detailsFromManual({ album: " X ", artist: " Y ", year: "2008", genre: "Rock", titles: "1. a\n2. b\n3. c" }, 3);
  assert.ok(typeof typed !== "string");
  assert.deepEqual([typed.album, typed.artist, typed.year, typed.tracks.map((t) => t.title)], ["X", "Y", 2008, ["a", "b", "c"]]);
});

test("the MusicBrainz seed gets the lengths and the gnudb arguments the toc", () => {
  const typed = detailsFromManual({ album: "X", artist: "Y", titles: "a\nb\nc" }, 3);
  assert.ok(typeof typed !== "string");
  const release = musicbrainzRelease(typed, toc);
  assert.deepEqual(release.tracks.map((t) => t.length_ms), [226_867, 196_827, 153_373]);
  assert.equal(musicbrainzRelease({ ...typed, compilation: true }, toc).artist, "Various Artists");
  const args = gnudbArgs(typed, toc, " me@example.com ", "");
  assert.deepEqual([args.email, args.category, args.toc], ["me@example.com", "", toc]);
});

test("a disc a database lists exactly is not offered to that database again", () => {
  const album = (quality: "exact" | "inexact") => ({ source: "x", album: "A", album_artist: "B", tracks: [], quality });
  const base = { automatic_choice: null, errors: [], sources_tried: [], toc } as unknown as LookupResult;
  assert.deepEqual(shareOptions({ ...base, candidates: [] }), { toc, musicbrainz: true, gnudb: true });
  assert.deepEqual(shareOptions({ ...base, candidates: [{ album: album("exact"), sources: ["musicbrainz"] }] }), { toc, musicbrainz: false, gnudb: true });
  assert.deepEqual(shareOptions({ ...base, candidates: [{ album: album("inexact"), sources: ["gnudb"] }] }), { toc, musicbrainz: true, gnudb: false });
  assert.deepEqual(shareOptions({ ...base, candidates: [], toc: undefined } as unknown as LookupResult), { toc: null, musicbrainz: false, gnudb: false });
  assert.deepEqual(shareOptions(null), { toc: null, musicbrainz: false, gnudb: false });
});
