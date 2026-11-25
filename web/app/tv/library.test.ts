import assert from "node:assert/strict";
import { test } from "node:test";
import { allSongs, buildAlbums, buildArtists, buildGuestArtists, clock, indexLetter, shuffledOrder, sortKey, withoutFeatured, type ServerTrack } from "./library.ts";

function track(id: string, over: Partial<ServerTrack>): ServerTrack {
  return { id, title: id, artist: null, album: null, album_artist: null, genre: null, year: null, track_number: null, cover_key: "f1", ...over };
}

test("albums group by folder and name, in track order, sorted by artist", () => {
  const albums = buildAlbums([
    track("b2", { album: "Blue", artist: "The Zeds", track_number: 2, cover_key: "z" }),
    track("b1", { album: "Blue", artist: "The Zeds", track_number: 1, cover_key: "z" }),
    track("a1", { album: "Red", artist: "Abba", cover_key: "a", year: 1976 }),
    track("x", { album: "Red", artist: "Other", cover_key: "other-folder" }),
  ]);
  assert.deepEqual(albums.map((a) => `${a.artist}/${a.title}`), ["Abba/Red", "Other/Red", "The Zeds/Blue"]);
  assert.deepEqual(albums[2].tracks.map((t) => t.id), ["b1", "b2"]);
  assert.equal(albums[0].year, 1976);
});

test("a compilation tagged with each song's original album stays one album, named after its folder", () => {
  const albums = buildAlbums([
    track("1", { album: "The Dom Years", artist: "88 Fingers Louie", cover_key: "fat", folder: "Fat Music Vol. 2", track_number: 1 }),
    track("2", { album: "Mass Nerder", artist: "ALL", cover_key: "fat", folder: "Fat Music Vol. 2", track_number: 2 }),
    track("3", { album: "Duh", artist: "Lagwagon", cover_key: "fat", folder: "Fat Music Vol. 2", track_number: 3 }),
  ]);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].title, "Fat Music Vol. 2");
  assert.equal(albums[0].artist, "Various artists");
  // Its artists are still listed, each with the compilation and only their own song.
  const artists = buildArtists(albums);
  assert.deepEqual(artists.map((a) => a.name), ["88 Fingers Louie", "ALL", "Lagwagon"]);
  assert.deepEqual(artists[2].tracks.map((t) => t.id), ["3"]);
  assert.equal(artists[2].albums[0].title, "Fat Music Vol. 2");
});

test("a folder holding several whole albums is split by album name", () => {
  const songs = ["A", "A", "A", "B", "B", "B"].map((album, i) => track(String(i), { album, artist: "X", cover_key: "dump", folder: "Music" }));
  assert.deepEqual(buildAlbums(songs).map((a) => `${a.title}:${a.tracks.length}`), ["A:3", "B:3"]);
});

test("album artist wins; mixed artists become Various artists; missing names get defaults", () => {
  const [compilation] = buildAlbums([track("1", { album: "Mix", artist: "A" }), track("2", { album: "Mix", artist: "B" })]);
  assert.equal(compilation.artist, "Various artists");
  const [tagged] = buildAlbums([track("1", { album: "Mix", artist: "A", album_artist: "DJ" }), track("2", { album: "Mix", artist: "B" })]);
  assert.equal(tagged.artist, "DJ");
  const [bare] = buildAlbums([track("1", {})]);
  assert.equal(bare.title, "Unknown album");
  assert.equal(bare.artist, "Unknown artist");
});

test("artists collect their albums; songs follow album order", () => {
  const albums = buildAlbums([
    track("1", { album: "One", artist: "Abba", cover_key: "a1", year: 1975 }),
    track("2", { album: "Two", artist: "ABBA", cover_key: "a2", year: 1974 }),
    track("3", { album: "Three", artist: "Cher", cover_key: "c" }),
  ]);
  const artists = buildArtists(albums);
  // "Abba" and "ABBA" are one artist, named as on the first album.
  assert.deepEqual(artists.map((a) => a.name.toLowerCase()), ["abba", "cher"]);
  assert.deepEqual(artists[0].albums.map((a) => a.title), ["Two", "One"]);
  assert.deepEqual(artists[0].tracks.map((t) => t.id), ["2", "1"]);
  assert.deepEqual(allSongs(albums).map((t) => t.id), ["2", "1", "3"]);
});

test("sorting and index letters ignore case, accents and a leading The", () => {
  assert.equal(sortKey("The Beatles"), "beatles");
  assert.equal(sortKey("Édith Piaf"), "edith piaf");
  assert.equal(indexLetter("The Who"), "W");
  assert.equal(indexLetter("10cc"), "#");
});

test("clock", () => {
  assert.equal(clock(187), "3:07");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(Number.NaN), "");
});

test("shuffle keeps every index once and starts with the chosen one", () => {
  const order = shuffledOrder(10, 4, () => 0.3);
  assert.equal(order[0], 4);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(shuffledOrder(3, null, () => 0).sort(), [0, 1, 2]);
});

test("genres: split, merged across spellings, named as most songs spell them", async () => {
  const { buildAlbums, buildGenres } = await import("./library.ts");
  const t = (id: string, genre: string | null, folder = "A") => ({ id, title: id, artist: "X", album: folder, album_artist: null, genre, year: null, track_number: null, cover_key: folder, folder });
  const genres = buildGenres(buildAlbums([t("1", "Ska Punk; Rock"), t("2", "ska punk"), t("3", "Ska-Punk", "B"), t("4", null, "B"), t("5", "(17)", "B")]));
  assert.equal(genres.length, 2, "bare genre numbers and missing genres are left out");
  assert.deepEqual([genres[0].name, genres[0].tracks.length, genres[0].albums.length], ["Rock", 1, 1]);
  assert.deepEqual([genres[1].tracks.length, genres[1].albums.length], [3, 2]);
  assert.ok(["Ska Punk", "ska punk", "Ska-Punk"].includes(genres[1].name));
});

test("search finds artists, albums and songs by every word, best first", async () => {
  const { buildAlbums, buildArtists, allSongs, searchLibrary } = await import("./library.ts");
  const t = (id: string, title: string, artist: string, album: string) => ({ id, title, artist, album, album_artist: null, genre: null, year: null, track_number: null, cover_key: album, folder: album });
  const albums = buildAlbums([t("1", "Warren's Song", "Bracket", "Novelty Forever"), t("2", "Trailer Park", "Bracket", "4-Wheel Vibe"), t("3", "Brackets Of Love", "Other Band", "Stuff"), t("4", "Café Song", "The Interrupters", "Fight the Good Fight")]);
  const artists = buildArtists(albums);
  const songs = allSongs(albums);
  const found = searchLibrary("brack", artists, albums, songs);
  assert.deepEqual(found.artists.map((a) => a.name), ["Bracket"]);
  assert.equal(found.songs[0].title, "Brackets Of Love", "a title starting with the word comes first");
  assert.deepEqual(found.songs.map((s) => s.title).slice(1).sort(), ["Trailer Park", "Warren's Song"], "then songs by the artist");
  assert.deepEqual(searchLibrary("cafe", artists, albums, songs).songs.map((s) => s.title), ["Café Song"]);
  assert.deepEqual(searchLibrary("interrupters good", artists, albums, songs).albums.map((a) => a.title), ["Fight the Good Fight"]);
  assert.deepEqual(searchLibrary("  ", artists, albums, songs), { artists: [], albums: [], songs: [] });
});

test("guest singers do not become artists of their own; compilation bands are guests, found by search only", () => {
  const albums = buildAlbums([
    track("p1", { album: "Swing", album_artist: "Scott Bradlee’s Postmodern Jukebox", artist: "Scott Bradlee & Postmodern Jukebox Feat. Haley Reinhart", cover_key: "p" }),
    track("p2", { album: "Swing", album_artist: "Scott Bradlee’s Postmodern Jukebox", artist: "Scott Bradlee & Postmodern Jukebox Feat. Morgan James", cover_key: "p" }),
    track("v1", { album: "Fat Music", album_artist: "Various Artists", artist: "Me First & The Gimme Gimmes", cover_key: "v" }),
    track("v2", { album: "Fat Music", album_artist: "Various Artists", artist: "mell-ø ft. Ambulo", cover_key: "v" }),
  ]);
  assert.deepEqual(buildArtists(albums).map((a) => [a.name, a.tracks.length]), [["Scott Bradlee’s Postmodern Jukebox", 2]], "bands only on a compilation are not on the list");
  assert.deepEqual(buildGuestArtists(albums).map((a) => [a.name, a.alsoTracks.length, a.also.map((al) => al.title)]), [
    ["Me First & The Gimme Gimmes", 1, ["Fat Music"]],
    ["mell-ø", 1, ["Fat Music"]],
  ]);
  assert.equal(withoutFeatured("Band (feat. Singer)"), "Band");
  assert.equal(withoutFeatured("Band featuring Singer"), "Band");
  assert.equal(withoutFeatured("Simon & Garfunkel"), "Simon & Garfunkel");
});

test("an artist with albums of their own also appears on compilations that carry their songs", () => {
  const albums = buildAlbums([
    track("n1", { album: "Punk in Drublic", album_artist: "NOFX", artist: "NOFX", cover_key: "n" }),
    track("n2", { album: "Fat Music", album_artist: "Various Artists", artist: "NOFX", cover_key: "v" }),
    track("n3", { album: "Fat Music", album_artist: "Various Artists", artist: "Strung Out feat. A Singer", cover_key: "v" }),
  ]);
  const [nofx, ...rest] = buildArtists(albums);
  assert.equal(rest.length, 0);
  assert.deepEqual([nofx.albums.map((a) => a.title), nofx.tracks.length], [["Punk in Drublic"], 1]);
  assert.deepEqual([nofx.also.map((a) => a.title), nofx.alsoTracks.length], [["Fat Music"], 1]);
  assert.deepEqual(buildGuestArtists(albums).map((a) => a.name), ["Strung Out"], "NOFX has albums of its own, so it is not a guest-only artist");
});