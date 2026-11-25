import assert from "node:assert/strict";
import test from "node:test";
import { lyricsFromJellyfin, probeJellyfin, trackFromItem } from "./jellyfin.ts";

test("Jellyfin songs become tracks grouped by album", () => {
  const track = trackFromItem({ Id: "a1", Name: "The End", Album: "Warped 2006", AlbumId: "alb", AlbumArtist: "Various Artists", Artists: ["Saves the Day"], ProductionYear: 2006, IndexNumber: 1, Genres: ["Punk", "Rock"] });
  assert.deepEqual(track, { id: "a1", title: "The End", artist: "Saves the Day", album: "Warped 2006", album_artist: "Various Artists", genre: "Punk", year: 2006, track_number: 1, folder: "Warped 2006", cover_key: "alb" });
  assert.equal(trackFromItem({ Id: "x" }).title, "Untitled");
  assert.equal(trackFromItem({ Id: "x", ParentId: "p" }).cover_key, "p");
});

test("Jellyfin lyrics: synced lines in ticks, or plain text", () => {
  const synced = lyricsFromJellyfin({ Lyrics: [{ Text: "One", Start: 12_340_000 }, { Text: "Two", Start: 25_000_000 }] });
  assert.equal(synced.synced, true);
  assert.deepEqual(synced.lines, [{ ms: 1234, text: "One" }, { ms: 2500, text: "Two" }]);
  const plain = lyricsFromJellyfin({ Lyrics: [{ Text: "Line a" }, { Text: "Line b" }] });
  assert.deepEqual([plain.synced, plain.plain], [false, "Line a\nLine b"]);
  assert.deepEqual(lyricsFromJellyfin(null), { plain: null, synced: false, lines: [], source: null });
});

test("only a Jellyfin server counts when probing an address", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const address = String(input);
    if (address.startsWith("http://10.0.0.9:8096/")) return new Response(JSON.stringify({ ServerName: "NAS", Id: "abc", Version: "12.4.0", ProductName: "Jellyfin Server" }));
    if (address.startsWith("http://10.0.0.8:8096/")) return new Response(JSON.stringify({ ServerName: "Other", Id: "z", ProductName: "Emby Server" }));
    throw new TypeError("refused");
  }) as typeof fetch;
  try {
    assert.deepEqual(await probeJellyfin("10.0.0.9"), { base: "http://10.0.0.9:8096", name: "NAS", id: "abc", version: "12.4.0" });
    assert.equal(await probeJellyfin("10.0.0.8"), null);
    assert.equal(await probeJellyfin("10.0.0.7"), null);
  } finally {
    globalThis.fetch = original;
  }
});
