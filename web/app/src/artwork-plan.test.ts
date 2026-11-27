import assert from "node:assert/strict";
import { test } from "node:test";
import { fillAlbum, type FillIo } from "./artwork-fill.ts";
import { type FolderArt, LEAVE, type Pic, albumsLackingFront, choiceKey, planArtwork, planResize, pngFolderPictures, songsToWrite, writeGroups } from "./artwork-plan.ts";
import type { GapFile, GapTrack } from "./review-data.ts";

const pic = (hash: string, side = 600, ok = true): Pic => ({ hash, width: side, height: side, ok });
type Art = { front?: Pic; back?: Pic; artist?: Pic };
const song = (path: string, art: Art = {}): GapFile => ({ path, mp3: true, lyrics: false, cover: !!art.front, art: { front: art.front ?? null, back: art.back ?? null, artist: art.artist ?? null } });
const track = (path: string, album = "LP", artist = "Band", albumArtist: string | null = null): GapTrack => ({ source_uri: path, title: path, album, artist, album_artist: albumArtist });
const folder = (art: { front?: Pic; back?: Pic; artist?: Pic }, up = false): FolderArt => ({
  front: art.front ? { ...art.front, file: "Folder.jpg" } : null,
  back: art.back ? { ...art.back, file: "back.jpg" } : null,
  artist: art.artist ? { ...art.artist, file: "artist.jpg", up } : null,
});
const plan = (files: GapFile[], folders: Record<string, FolderArt> = {}, picks = {}, tracks?: GapTrack[]) => planArtwork(files, tracks ?? files.map((f) => track(f.path)), folders, picks);

test("an album with only a folder picture needs it in every song (it does not count as covered)", () => {
  const found = plan([song("m/LP/1.mp3"), song("m/LP/2.mp3")], { "m/LP": folder({ front: pic("f"), back: pic("b") }) });
  assert.equal(found.have.front, 0);
  assert.equal(albumsLackingFront(found), 1);
  assert.deepEqual(found.albums[0].kinds.map((k) => [k.kind, k.target.source.file, k.paths.length]), [["front", "Folder.jpg", 2], ["back", "back.jpg", 2]]);
  assert.equal(songsToWrite(found.albums), 2);
});

test("a picture some songs have goes to the others, and only to them", () => {
  const found = plan([song("m/LP/1.mp3", { front: pic("a"), back: pic("b") }), song("m/LP/2.mp3")], { "m/LP": folder({ front: pic("other", 900) }) });
  assert.deepEqual(found.albums[0].kinds.map((k) => [k.kind, k.target.hash, k.paths]), [["front", "a", ["m/LP/2.mp3"]], ["back", "b", ["m/LP/2.mp3"]]]);
});

test("a complete album is left alone", () => {
  const all = { front: pic("a"), back: pic("b"), artist: pic("c") };
  const found = plan([song("m/LP/1.mp3", all), song("m/LP/2.mp3", all)], { "m/LP": folder({ front: pic("z", 2000, false) }) });
  assert.deepEqual([found.albums, found.choices, found.none.front], [[], [], []]);
});

test("different pictures in one album are a choice; the answer makes them alike, or leaves them", () => {
  const files = [song("m/LP/1.mp3", { front: pic("a") }), song("m/LP/2.mp3", { front: pic("a") }), song("m/LP/3.mp3", { front: pic("b") })];
  const asked = plan(files);
  assert.equal(asked.albums.length, 0);
  assert.deepEqual(asked.choices[0].options.map((o) => [o.hash, o.songs]), [["a", 2], ["b", 1]]);
  const key = choiceKey("m/LP|lp", "front");
  assert.equal(asked.choices[0].key, key);
  assert.deepEqual(plan(files, {}, { [key]: "b" }).albums[0].kinds[0].paths, ["m/LP/1.mp3", "m/LP/2.mp3"]);
  const left = plan(files, {}, { [key]: LEAVE });
  assert.deepEqual([left.albums, left.choices], [[], []]);
});

test("a folder picture is not handed to a folder holding several albums without asking", () => {
  const files = [song("m/Mix/1.mp3"), song("m/Mix/2.mp3")];
  const tracks = [track("m/Mix/1.mp3", "One"), track("m/Mix/2.mp3", "Two")];
  const found = plan(files, { "m/Mix": folder({ front: pic("f") }) }, {}, tracks);
  assert.equal(found.albums.length, 0);
  assert.equal(found.choices.length, 2);
});

test("a tiny picture in the songs is not spread when the folder has a larger one", () => {
  const found = plan([song("m/LP/1.mp3", { front: pic("tiny", 75) }), song("m/LP/2.mp3")], { "m/LP": folder({ front: pic("big", 600) }) });
  assert.deepEqual(found.choices[0].options.map((o) => o.hash), ["tiny", "big"]);
});

test("a picture that must be made smaller goes to every song, keeping its full size if the folder has none", () => {
  const found = plan([song("m/LP/1.mp3", { front: pic("huge", 1400, false) }), song("m/LP/2.mp3")]);
  assert.deepEqual([found.albums[0].kinds[0].paths.length, found.albums[0].kinds[0].keepFullSize], [2, true]);
});

test("an artist photo comes from the folder above or the artist's other albums, never onto a compilation", () => {
  const files = [song("m/Band/A/1.mp3", { front: pic("a"), artist: pic("face") }), song("m/Band/B/1.mp3", { front: pic("b") }), song("m/VA/C/1.mp3", { front: pic("c") }), song("m/VA/C/2.mp3", { front: pic("c") })];
  const tracks = [track(files[0].path, "A"), track(files[1].path, "B"), track(files[2].path, "C", "X"), track(files[3].path, "C", "Y")];
  const found = plan(files, {}, {}, tracks);
  assert.deepEqual(found.albums.map((a) => [a.gap.album, a.kinds[0].kind, a.kinds[0].target.hash, a.kinds[0].target.source.path]), [["B", "artist", "face", "m/Band/A/1.mp3"]]);
  assert.equal(found.none.artist.length, 0);
  const above = plan([song("m/Solo/A/1.mp3", { front: pic("a") })], { "m/Solo/A": folder({ artist: pic("p") }, true) });
  assert.deepEqual(above.albums[0].kinds[0].target.source, { path: "m/Solo/A/1.mp3", file: "artist.jpg", up: true });
});

test("an album with no picture anywhere is listed as having none", () => {
  const found = plan([song("m/LP/1.mp3")]);
  assert.deepEqual([found.none.front.length, found.none.back.length, found.none.artist.length], [1, 1, 1]);
});

test("an oversize picture every song already has is still made to fit, in In every song too", () => {
  const huge = pic("huge", 3000, false);
  const files = [song("m/LP/1.mp3", { front: huge, back: pic("b"), artist: pic("c") }), song("m/LP/2.mp3", { front: huge, back: pic("b"), artist: pic("c") })];
  const found = plan(files, { "m/LP": folder({ front: pic("small", 600) }) });
  assert.deepEqual(found.albums[0].kinds.map((k) => [k.kind, k.target.hash, k.paths.length, k.keepFullSize]), [["front", "huge", 2, true]]);
});

test("a wrong label alone is written again, only in the songs that have it, without changing the picture", () => {
  const files = [song("m/LP/1.mp3", { front: { ...pic("a"), relabel: true } }), song("m/LP/2.mp3", { front: pic("a") })];
  for (const albums of [plan(files).albums, planResize(files, files.map((f) => track(f.path)), {})]) {
    assert.deepEqual(albums[0].kinds.map((k) => [k.target.ok, k.paths, k.keepFullSize]), [[true, ["m/LP/1.mp3"], false]]);
  }
});

test("fixing gives each song its own picture made to fit, never another song's", () => {
  const files = [song("m/LP/1.mp3", { front: pic("one", 3000, false), back: pic("rear", 2000, false) }), song("m/LP/2.mp3", { front: pic("two", 1400, false) }), song("m/LP/3.mp3", { front: pic("fine") })];
  const [album] = planResize(files, files.map((f) => track(f.path)), {});
  assert.deepEqual(album.kinds.map((k) => [k.kind, k.target.hash, k.paths, k.keepFullSize]), [["front", "one", ["m/LP/1.mp3"], true], ["front", "two", ["m/LP/2.mp3"], false], ["back", "rear", ["m/LP/1.mp3"], true]]);
  assert.deepEqual(writeGroups(album).map((g) => [g.paths, g.kinds.map((k) => k.target.hash)]), [[["m/LP/1.mp3"], ["one", "rear"]], [["m/LP/2.mp3"], ["two"]]]);
  assert.equal(songsToWrite([album]), 2);
  assert.deepEqual(planResize([files[2]], [track(files[2].path)], {}), []);
});

test("PNG picture files in album folders are listed with the picture to keep", () => {
  const art = { ...folder({ front: pic("f", 3000, false) }), png: [{ kind: "front" as const, file: "cover.png" }, { kind: "front" as const, file: "front.png" }] };
  assert.deepEqual(pngFolderPictures([song("m/LP/1.mp3")], { "m/LP": art, "m/Empty": art }), [{ folder: "m/LP", kind: "front", file: "Folder.jpg", path: "m/LP/1.mp3" }]);
});
test("filling writes each song once, reports the ones that fail and carries on", async () => {
  const files = Array.from({ length: 12 }, (_, i) => song(`m/LP/${i}.mp3`, i === 0 ? { back: pic("b") } : {}));
  const found = plan(files, { "m/LP": folder({ front: pic("f", 1400, false) }) });
  const requests: { paths: string[]; pictures: { kind: string; data_base64: string }[]; batch: string }[] = [];
  const io: FillIo = {
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "art_source") return { mime: "image/jpeg", data_base64: `raw-${args.kind}` } as T;
      const request = args as unknown as (typeof requests)[number];
      requests.push(request);
      return { results: request.paths.map((path) => ({ path, ok: path !== "m/LP/5.mp3", error: "damaged tag" })) } as T;
    },
    prepare: async (p) => `small-${p.data_base64}`,
    fullSize: async (p) => p.data_base64,
  };
  let progress = 0;
  const done = await fillAlbum(found.albums[0], "fill-1", io, (n) => (progress += n));
  assert.equal(done.songs, 11);
  assert.deepEqual(done.problems, [{ path: "m/LP/5.mp3", message: "damaged tag" }]);
  assert.equal(progress, 12);
  const touched = requests.flatMap((r) => r.paths);
  assert.equal(new Set(touched).size, touched.length, "no song is rewritten twice");
  const other = requests.find((r) => r.paths.includes("m/LP/1.mp3"))!;
  assert.deepEqual(other.pictures.map((p) => [p.kind, p.data_base64]), [["front_cover", "small-raw-front"], ["back_cover", "raw-back"]]);
  assert.ok(requests.every((r) => r.batch === "fill-1"));
});
