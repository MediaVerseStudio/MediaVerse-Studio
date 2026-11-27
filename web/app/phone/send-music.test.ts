import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { newForLibrary, sendPath, serverListing, type OwnSong } from "./send-music.ts";

const { cleanUploadPath } = createRequire(import.meta.url)("../electron/share-sync.js");
const song = (id: string, title: string, artist: string, album: string, file = `${title}.mp3`): OwnSong => ({ id, title, artist, album_artist: artist, album, file, size: 100 });

test("only music the computer lacks is offered, by album", () => {
  const phone = [song("6", "Old", "Band", "Live at Home"), song("1", "Old", "Band", "Had"), song("2", "New", "Band", "Bought"), song("3", "Newer", "Band", "Bought"), song("4", "Sent", "Band", "Bought"), song("5", "Memo", "Me", "Voice", "memo.amr")];
  const albums = newForLibrary(phone, [{ title: "old", artist: "BAND", album_artist: "", album: "had" }], new Set(["4"]));
  assert.deepEqual(albums.map((a) => [a.title, a.songs.map((s) => s.id), a.bytes]), [["Bought", ["2", "3"], 200], ["Live at Home", ["6"], 100]], "the same song on another album is another recording");
});

test("a server song counts under each artist it is credited to", () => {
  const listed = serverListing([{ Id: "1", Name: "Duet", Artists: ["Ann", "Ben"], AlbumArtist: "Ann", Album: "Together" }]);
  const phone = [{ ...song("1", "Duet", "Ben", "Together"), album_artist: "Ben" }, song("2", "Duet", "Cat", "Together")];
  assert.deepEqual(newForLibrary(phone, listed, new Set()).flatMap((a) => a.songs.map((s) => s.id)), ["2"]);
});

test("every path the phone makes is one the computer accepts", () => {
  const awkward = ['AC/DC: "Live?"', "CON", "...dots...", "nul.band", "  ", "a".repeat(300), "Ünïcode ♪", "trail. ", "com1"];
  for (const name of awkward) {
    const path = sendPath(song("1", name, name, name, `${name}.FLAC`));
    assert.ok(path, name);
    assert.ok(cleanUploadPath(path), `${name} -> ${path}`);
  }
  assert.equal(sendPath(song("1", "x", "y", "z", "x.txt")), null);
});
