import assert from "node:assert/strict";
import test from "node:test";
import { fromFileName, readTags, tagLength } from "./tags.ts";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const ascii = (text: string) => new TextEncoder().encode(text);
const synchsafe = (n: number) => new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function id3v23(frames: Array<[string, Uint8Array]>): Uint8Array {
  const body = concat(...frames.map(([id, data]) => concat(ascii(id), be32(data.length), new Uint8Array(2), data)), new Uint8Array(20));
  return concat(ascii("ID3"), new Uint8Array([3, 0, 0]), synchsafe(body.length), body);
}
const text = (value: string, encoding = 0) =>
  encoding === 1
    ? concat(new Uint8Array([1, 0xff, 0xfe]), new Uint8Array(new Uint16Array([...value].map((c) => c.charCodeAt(0))).buffer))
    : concat(new Uint8Array([encoding]), encoding === 3 ? ascii(value) : Uint8Array.from([...value].map((c) => c.charCodeAt(0))));

test("ID3v2.3 text frames and the front cover", () => {
  const picture = concat(new Uint8Array([0]), ascii("image/jpeg"), new Uint8Array([0, 3]), ascii("cover"), new Uint8Array([0]), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  const tag = id3v23([
    ["TIT2", text("Carousel")],
    ["TPE1", text("Café Tacvba", 1)],
    ["TALB", text("Skamic Con 2019", 3)],
    ["TPE2", text("Various")],
    ["TRCK", text("3/14")],
    ["TYER", text("2019")],
    ["TCON", text("(4)")],
    ["APIC", picture],
  ]);
  assert.equal(tagLength(tag.subarray(0, 10)), tag.length);
  const tags = readTags(concat(tag, new Uint8Array([0xff, 0xfb])));
  assert.equal(tags.title, "Carousel");
  assert.equal(tags.artist, "Café Tacvba");
  assert.equal(tags.album, "Skamic Con 2019");
  assert.equal(tags.album_artist, "Various");
  assert.equal(tags.track_number, 3);
  assert.equal(tags.year, 2019);
  assert.equal(tags.genre, undefined);
  assert.equal(tags.picture?.mime, "image/jpeg");
  assert.deepEqual([...tags.picture!.data], [0xff, 0xd8, 0xff, 0xe0]);
});

test("FLAC Vorbis comments and picture", () => {
  const comments = ["TITLE=Song", "ARTIST=Band", "ALBUM=Record", "TRACKNUMBER=7", "DATE=1999-05-01", "albumartist=Band"];
  const vorbis = concat(le32(6), ascii("vendor"), le32(comments.length), ...comments.map((c) => concat(le32(ascii(c).length), ascii(c))));
  const pictureData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const pictureBlock = concat(be32(3), be32(9), ascii("image/png"), be32(0), new Uint8Array(16), be32(pictureData.length), pictureData);
  const block = (type: number, data: Uint8Array, last = false) => concat(new Uint8Array([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data);
  const file = concat(ascii("fLaC"), block(0, new Uint8Array(34)), block(4, vorbis), block(6, pictureBlock, true), new Uint8Array(8));
  assert.equal(tagLength(file.subarray(0, 10)), -1);
  const tags = readTags(file);
  assert.deepEqual({ ...tags, picture: undefined }, { title: "Song", artist: "Band", album: "Record", album_artist: "Band", track_number: 7, year: 1999, picture: undefined });
  assert.equal(tags.picture?.mime, "image/png");
});

test("damaged or unknown files give nothing, and file names fill in", () => {
  assert.deepEqual(readTags(new Uint8Array([1, 2, 3])), {});
  assert.equal(tagLength(new Uint8Array(10)), null);
  const broken = concat(ascii("ID3"), new Uint8Array([3, 0, 0]), synchsafe(500), ascii("TIT2"), be32(9999));
  assert.deepEqual(readTags(broken), {});
  assert.deepEqual(fromFileName("Music/Bracket/Novelty Forever/03 - Warren's Song.mp3"), { title: "Warren's Song", track_number: 3, album: "Novelty Forever", artist: "Bracket" });
  assert.deepEqual(fromFileName("song.flac"), { title: "song", track_number: undefined, album: undefined, artist: undefined });
});
