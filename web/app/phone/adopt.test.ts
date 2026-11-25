import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncSong } from "./jellyfin-phone.ts";
import { findAdoptions, isOwnFolder, score, THRESHOLD, type LocalSong } from "./adopt.ts";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const song = (n: number, extra: Partial<SyncSong> = {}): SyncSong => ({ id: hex(n), title: `Song ${n}`, artist: "Band", albumArtist: "Band", album: "Record", albumId: hex(900), track: n, disc: null, year: 1999, container: "mp3", size: 5_000_000 + n, etag: `e${n}`, durationMs: 200_000 + n * 1000, ...extra });
const local = (n: number, extra: Partial<LocalSong> = {}): LocalSong => ({ id: `${100 + n}`, title: `Song ${n}`, artist: "Band", albumArtist: "Band", album: "Record", folder: "Music/Band/Record/", file: `0${n} - Song ${n}.mp3`, size: 5_000_000 + n, durationMs: 200_000 + n * 1000, ...extra });

test("the same file is recognised by its title, artist, album, length and size", () => {
  const found = findAdoptions([song(1), song(2)], [local(1), local(2)], new Set());
  assert.deepEqual(found.map((f) => [f.song.id, f.local.id, f.level]), [[hex(1), "101", "exact"], [hex(2), "102", "exact"]]);
  assert.ok(score(song(1), local(1)) >= THRESHOLD + 50);
});

test("the same song with another size is recognised as a different version, not skipped and not replaced", () => {
  const found = findAdoptions([song(1)], [local(1, { size: 4_200_000 })], new Set());
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, "differs");
});

test("a song with the same title by another artist, or a very different length, is not the same song", () => {
  assert.equal(score(song(1), local(1, { artist: "Other", albumArtist: "Other" })), 0);
  assert.equal(score(song(1), local(1, { durationMs: 340_000 })), 0, "a live or extended version");
  assert.deepEqual(findAdoptions([song(1)], [local(1, { artist: "Other", albumArtist: "Other" })], new Set()), []);
});

test("names are compared the way playlists compare them: case, accents, feat. and brackets do not matter", () => {
  const server = song(1, { title: "Café Song (Remastered)", artist: "The Band feat. Guest", albumArtist: "The Band" });
  const phone = local(1, { title: "cafe song", artist: "The Band", albumArtist: "" });
  assert.equal(findAdoptions([server], [phone], new Set()).length, 1);
});

test("a song with no usable tags on the phone is found by its file and folder when the length and size agree", () => {
  const found = findAdoptions([song(3)], [local(3, { artist: "", albumArtist: "", album: "", folder: "Music/Band/Record/" })], new Set());
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, "exact");
});

test("each phone song is matched to one server song only, the closer one first, and kept songs are not matched again", () => {
  // Two server songs with the same title (an album and a single): the phone has one copy, of the album version.
  const album = song(1, { id: hex(11), album: "Record", size: 5_000_001, durationMs: 201_000 });
  const single = song(1, { id: hex(12), album: "Single", size: 3_900_000, durationMs: 196_000 });
  const found = findAdoptions([single, album], [local(1)], new Set());
  assert.equal(found.length, 1);
  assert.equal(found[0]!.song.id, hex(11));
  assert.deepEqual(findAdoptions([song(1)], [local(1)], new Set(["101"])), [], "already kept");
});

test("two identical copies on the phone: one is recognised, the other is left alone", () => {
  const found = findAdoptions([song(1)], [local(1, { id: "201", folder: "Music/A/" }), local(1, { id: "202", folder: "Music/B/" })], new Set());
  assert.equal(found.length, 1);
});

test("songs in the program's own folder are told from the person's own", () => {
  assert.equal(isOwnFolder("Music/MediaVerse Home/Band/Record/"), true);
  assert.equal(isOwnFolder("Music/Band/Record/"), false);
  assert.equal(isOwnFolder("Music/MediaVerse Home 2/Band/"), false);
});
