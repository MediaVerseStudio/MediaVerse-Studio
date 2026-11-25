import assert from "node:assert/strict";
import { test } from "node:test";
import { Jellyfin, type HttpRequest, type Session } from "../phone/jellyfin-phone.ts";
import { loadServerTracks, lyricsReply, partsOf, serverLibraryHandlers, signedOutHandlers, songName, trackOf } from "./jellyfin-library.ts";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const SESSION: Session = { base: "http://192.168.68.13:8096", name: "Home", serverId: "s", userId: "u1", token: "tok" };

/** A fake server: `songs` listed a page at a time, pictures and lyrics by item id. */
function fakeServer(songs: object[], extra: { pictures?: Record<string, string>; lyrics?: Record<string, object> } = {}) {
  const requests: HttpRequest[] = [];
  const http = async (request: HttpRequest) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/Users/u1/Items") {
      const start = Number(url.searchParams.get("StartIndex"));
      const limit = Number(url.searchParams.get("Limit"));
      return { status: 200, body: JSON.stringify({ Items: songs.slice(start, start + limit), TotalRecordCount: songs.length }) };
    }
    const picture = /^\/Items\/([0-9a-f]{32})\/Images\/Primary$/.exec(url.pathname);
    if (picture) return extra.pictures?.[picture[1]!] ? { status: 200, body: extra.pictures[picture[1]!]! } : { status: 404, body: "" };
    const lyrics = /^\/Audio\/([0-9a-f]{32})\/Lyrics$/.exec(url.pathname);
    if (lyrics) return extra.lyrics?.[lyrics[1]!] ? { status: 200, body: JSON.stringify(extra.lyrics[lyrics[1]!]) } : { status: 404, body: "" };
    return { status: 404, body: "" };
  };
  return { client: new Jellyfin(http, "dev", "Computer"), requests };
}

const song = (n: number, extra: object = {}) => ({ Id: hex(n), Name: `Song ${n}`, Album: "Record", AlbumId: hex(1000), AlbumArtist: "Band", Artists: ["Band", "Guest"], Genres: ["Rock"], ProductionYear: 1999, IndexNumber: n, ParentIndexNumber: 1, RunTimeTicks: 2_450_000_000, DateCreated: "2026-01-02T03:04:05.0000000Z", ...extra });

test("a song of the server is named like a path to its album, so the folder views group by album", () => {
  assert.equal(songName({ Id: hex(7), AlbumId: hex(1000) }), `jellyfin:${hex(1000)}/${hex(7)}`);
  assert.match(songName({ Id: hex(7) })!, new RegExp(`^jellyfin:loose-${hex(7)}/${hex(7)}$`));
  assert.equal(songName({ Id: "not an id" }), null);
  const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));
  assert.equal(folderOf(songName({ Id: hex(1), AlbumId: hex(1000) })!), folderOf(songName({ Id: hex(2), AlbumId: hex(1000) })!));
  assert.notEqual(folderOf(songName({ Id: hex(1) })!), folderOf(songName({ Id: hex(2) })!), "loose songs do not pile into one album");
});

test("a song's name gives the ids the server needs", () => {
  assert.deepEqual(partsOf(`jellyfin:${hex(1000)}/${hex(7)}`), { song: hex(7), picture: hex(1000) });
  assert.deepEqual(partsOf(`jellyfin:loose-${hex(7)}/${hex(7)}`), { song: hex(7), picture: hex(7) });
  assert.equal(partsOf("C:\\Music\\a.mp3"), null);
  assert.equal(partsOf(`jellyfin:${hex(1000)}/zz`), null);
});

test("the server's facts become the library's columns", () => {
  const track = trackOf(song(3))!;
  assert.deepEqual(
    { title: track.title, artist: track.artist, album: track.album, album_artist: track.album_artist, genre: track.genre, year: track.release_year, number: track.track_number, disc: track.disc_number, ms: track.length_ms, added: track.added_secs },
    { title: "Song 3", artist: "Band", album: "Record", album_artist: "Band", genre: "Rock", year: 1999, number: 3, disc: 1, ms: 245_000, added: Date.parse("2026-01-02T03:04:05Z") / 1000 },
  );
  const bare = trackOf({ Id: hex(9) })!;
  assert.deepEqual([bare.title, bare.artist, bare.album, bare.length_ms, bare.added_secs], ["Unknown title", null, null, null, null]);
  assert.equal(trackOf({ Id: "x" }), null);
});

test("every song is read, a page at a time, with the progress told", async () => {
  const { client, requests } = fakeServer(Array.from({ length: 2500 }, (_, i) => song(i + 1)));
  const progress: Array<[number, number]> = [];
  const tracks = await loadServerTracks(client, SESSION, (read, total) => progress.push([read, total]));
  assert.equal(tracks.length, 2500);
  assert.equal(new Set(tracks.map((t) => t.source_uri)).size, 2500);
  assert.deepEqual(progress, [[1000, 2500], [2000, 2500], [2500, 2500]]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.headers?.Authorization.includes('Token="tok"'), true);
  const empty = fakeServer([]);
  assert.deepEqual(await loadServerTracks(empty.client, SESSION), []);
});

test("lyrics from the server become timed lines, or plain words, or nothing", () => {
  assert.deepEqual(lyricsReply(null), { plain: null, synced: false, lines: [], source: null });
  assert.deepEqual(lyricsReply({ Lyrics: [{ Text: "one", Start: 10_000_000 }, { Text: "", Start: 20_000_000 }, { Text: "two", Start: 30_000_000 }] }), { plain: "one\ntwo", synced: true, lines: [{ ms: 1000, text: "one" }, { ms: 3000, text: "two" }], source: "server" });
  assert.deepEqual(lyricsReply({ Lyrics: [{ Text: "one" }, { Text: "two" }] }), { plain: "one\ntwo", synced: false, lines: [], source: "server" });
});

test("the commands that read the folder are answered from the server, and the list is read once", async () => {
  const songs = [song(1), song(2, { DateCreated: "2026-05-05T00:00:00Z" }), song(3, { DateCreated: "2026-03-03T00:00:00Z" })];
  const { client, requests } = fakeServer(songs, { pictures: { [hex(1000)]: "AAAA" }, lyrics: { [hex(1)]: { Lyrics: [{ Text: "la", Start: 10_000_000 }] } } });
  const { handlers } = serverLibraryHandlers(client, SESSION);
  const snapshot = (await handlers.library_snapshot!({})) as { tracks: unknown[] };
  assert.equal(snapshot.tracks.length, 3);
  await handlers.library_snapshot!({});
  assert.equal(requests.filter((r) => r.url.includes("/Users/u1/Items")).length, 1, "read once");
  await handlers.rescan_collection!({});
  assert.equal(requests.filter((r) => r.url.includes("/Users/u1/Items")).length, 2, "read again when asked");

  assert.deepEqual(await handlers.collection_status!({}), { root: "Jellyfin server: Home" });
  const recent = (await handlers.recent_files!({ limit: 2 })) as { files: Array<{ path: string }> };
  assert.deepEqual(recent.files.map((f) => f.path), [`jellyfin:${hex(1000)}/${hex(2)}`, `jellyfin:${hex(1000)}/${hex(3)}`], "newest first");

  assert.deepEqual(await handlers.track_cover!({ path: `jellyfin:${hex(1000)}/${hex(1)}` }), { mime: "image/jpeg", data_base64: "AAAA", from: "server" });
  assert.equal(await handlers.track_cover!({ path: `jellyfin:loose-${hex(5)}/${hex(5)}` }), null, "a song with no picture shows none");
  assert.equal(await handlers.track_cover!({ path: "C:\\Music\\a.mp3" }), null);
  assert.equal(await handlers.track_artist_photo!({ path: `jellyfin:${hex(1000)}/${hex(1)}` }), null);
  assert.equal(((await handlers.track_lyrics!({ path: `jellyfin:${hex(1000)}/${hex(1)}` })) as { synced: boolean }).synced, true);
  assert.equal(((await handlers.track_lyrics!({ path: `jellyfin:${hex(1000)}/${hex(2)}` })) as { source: unknown }).source, null, "no lyrics is not an error");
});

test("a server that cannot be reached is said plainly and asked again next time", async () => {
  let up = false;
  const http = async () => (up ? { status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) } : { status: -1, body: "down" });
  const { handlers } = serverLibraryHandlers(new Jellyfin(http, "d", "Computer"), SESSION);
  await assert.rejects(() => handlers.library_snapshot!({}), (thrown: { code: string; message: string }) => thrown.code === "jellyfin_unreachable" && /did not answer/.test(thrown.message));
  up = true;
  assert.deepEqual(await handlers.library_snapshot!({}), { tracks: [] });
  const refused = async () => ({ status: 401, body: "" });
  const signedOut = serverLibraryHandlers(new Jellyfin(refused, "d", "Computer"), SESSION).handlers;
  await assert.rejects(() => signedOut.library_snapshot!({}), (thrown: { code: string }) => thrown.code === "jellyfin_signed_out");
});

test("with no sign-in the library is empty and says what to do", async () => {
  const handlers = signedOutHandlers();
  await assert.rejects(() => handlers.library_snapshot!({}), (thrown: { message: string }) => /Settings > Jellyfin/.test(thrown.message));
  assert.deepEqual(await handlers.recent_files!({}), { files: [] });
});
