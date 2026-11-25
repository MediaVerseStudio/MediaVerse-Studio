import assert from "node:assert/strict";
import { test } from "node:test";
import { type Choice, type KeptFile, type Manifest, type SyncIo, type SyncSong, useServerVersions, changedOnServer, choiceKey, choiceLabel, cleanManifest, describeOutcome, emptyManifest, goneLimit, planSync, relativePath, runHomeSync, safeName, sizeText, uniquePaths, wantedFrom } from "./home-sync.ts";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const song = (n: number, extra: Partial<SyncSong> = {}): SyncSong => ({ id: hex(n), title: `Song ${n}`, artist: "Band", albumArtist: "Band", album: "Record", albumId: hex(900), track: n, disc: null, year: 1999, container: "mp3", size: 1000 + n, etag: `e${n}`, durationMs: 200_000, ...extra });
const artist: Choice = { kind: "artist", id: hex(500), name: "Band" };
const album: Choice = { kind: "album", id: hex(900), name: "Record", artist: "Band" };
const kept = (n: number, via: string[], extra: Partial<KeptFile> = {}): KeptFile => ({ id: hex(n), mediaId: String(100 + n), path: `Band/Record/0${n} - Song ${n}.mp3`, size: 1000 + n, etag: `e${n}`, at: 1, via, title: `Song ${n}`, artist: "Band", album: "Record", ...extra });
const manifestOf = (...files: KeptFile[]): Manifest => ({ files: Object.fromEntries(files.map((f) => [f.id, f])) });

test("a song goes under Artist/Album with its number, and nothing in the names breaks a path", () => {
  assert.equal(relativePath(song(3)), "Band/Record/03 - Song 3.mp3");
  assert.equal(relativePath(song(2, { disc: 2, container: "flac" })), "Band/Record/2-02 - Song 2.flac");
  assert.equal(relativePath(song(1, { title: 'What/Why? "Now": <ok>', album: "AC/DC: Live", albumArtist: "AC/DC", track: null })), "AC_DC/AC_DC_ Live/What_Why_ _Now__ _ok_.mp3");
  assert.equal(relativePath(song(1, { albumArtist: "", artist: "", album: "", title: "", container: "weird" })), "Unknown artist/Unknown album/01 - Unknown title.mp3");
  assert.equal(safeName("..hidden. "), "hidden");
  assert.equal(safeName("x".repeat(200)).length, 80);
});

test("two songs that would share a file name do not", () => {
  const twins = [song(1, { track: 1, title: "Intro" }), song(2, { track: 1, title: "Intro" })];
  const paths = uniquePaths(twins);
  assert.equal(paths.get(hex(1)), "Band/Record/01 - Intro.mp3");
  assert.equal(paths.get(hex(2)), "Band/Record/01 - Intro (2).mp3");
  assert.equal(uniquePaths([song(1, { track: 1, title: "Intro" })], new Set(["band/record/01 - intro.mp3"])).get(hex(1)), "Band/Record/01 - Intro (2).mp3");
});

test("an edit on the server is told by the ETag, or by the size when there is none", () => {
  assert.equal(changedOnServer(kept(1, []), song(1)), false);
  assert.equal(changedOnServer(kept(1, []), song(1, { etag: "other" })), true);
  assert.equal(changedOnServer(kept(1, [], { etag: null }), song(1, { etag: null })), false);
  assert.equal(changedOnServer(kept(1, [], { etag: null }), song(1, { etag: null, size: 5555 })), true);
  assert.equal(changedOnServer(kept(1, [], { etag: null, size: 0 }), song(1, { etag: null, size: 0 })), false, "nothing to compare: not changed");
});

test("the plan: new songs are fetched, edited and missing ones fetched again, the rest left", () => {
  const wanted = wantedFrom([{ choice: album, songs: [song(1), song(2, { etag: "edited" }), song(3), song(4)] }]);
  const manifest = manifestOf(kept(1, [choiceKey(album)]), kept(2, [choiceKey(album)]), kept(3, [choiceKey(album)]));
  const plan = planSync(wanted, manifest, new Set(["101", "102"]), [album]); // song 3's copy is not on the phone any more
  assert.deepEqual(plan.download.map((d) => d.song.id), [hex(4)]);
  assert.deepEqual(plan.update.map((u) => [u.song.id, u.why]), [[hex(2), "edited"], [hex(3), "missing"]]);
  assert.equal(plan.same, 1);
  assert.equal(plan.bytes, 1004 + 1002 + 1003);
  assert.deepEqual([plan.remove.length, plan.gone.length], [0, 0]);
  // With the phone's library not read yet nothing is called missing.
  assert.equal(planSync(wanted, manifest, null, [album]).update.length, 1);
});

test("a song that two choices name is kept while either is chosen, and goes when neither is", () => {
  const manifest = manifestOf(kept(1, [choiceKey(artist), choiceKey(album)]), kept(2, [choiceKey(artist)]));
  const wantedNow = wantedFrom([{ choice: album, songs: [song(1)] }]); // the artist choice was taken away
  const plan = planSync(wantedNow, manifest, new Set(["101", "102"]), [album]);
  assert.deepEqual(plan.remove.map((f) => f.id), [hex(2)], "only the song nothing chosen names");
  assert.equal(plan.gone.length, 0);
});

test("a song the server no longer lists is taken off, unless so many vanish at once that it looks like a fault", () => {
  const few = manifestOf(kept(1, [choiceKey(album)]), kept(2, [choiceKey(album)]));
  const planFew = planSync(wantedFrom([{ choice: album, songs: [song(1)] }]), few, null, [album]);
  assert.deepEqual(planFew.gone.map((f) => f.id), [hex(2)]);
  const many = manifestOf(...Array.from({ length: 60 }, (_, i) => kept(i + 1, [choiceKey(album)])));
  const planMany = planSync(wantedFrom([{ choice: album, songs: [] }]), many, null, [album]);
  assert.equal(planMany.gone.length, 0, "an empty answer for 60 kept songs is not believed");
  assert.equal(planMany.heldBack, 60);
  assert.equal(goneLimit(10), 25);
  assert.equal(goneLimit(500), 100);
});

/** A phone and a server in memory. */
function world(options: { failing?: Set<string>; deleteRefused?: Set<string>; serverSongs?: Record<string, SyncSong[]> } = {}) {
  const phone = new Map<string, string>(); // media id -> path
  const log: string[] = [];
  let counter = 1000;
  let saved: Manifest | null = null;
  const manifest = emptyManifest();
  const io: SyncIo = {
    fetchSongs: async (choice) => options.serverSongs?.[choiceKey(choice)] ?? [],
    manifest,
    saveManifest: (m) => (saved = JSON.parse(JSON.stringify(m))),
    present: () => new Set(phone.keys()),
    download: async (s, path, replace, inPlace) => {
      if (options.failing?.has(s.id)) throw new Error("the server stopped");
      if (inPlace && replace) {
        phone.set(replace, path); // written over where it is: same id
        log.push(`get ${s.title} (in place)`);
        return { mediaId: replace, bytes: s.size };
      }
      if (replace) phone.delete(replace);
      const mediaId = String(++counter);
      phone.set(mediaId, path);
      log.push(`get ${s.title}${replace ? " (again)" : ""}`);
      return { mediaId, bytes: s.size };
    },
    removeLocal: async (ids) => {
      const done = ids.filter((id) => !options.deleteRefused?.has(id));
      for (const id of done) phone.delete(id);
      log.push(`remove ${done.length}`);
      return done;
    },
    progress: () => undefined,
    cancelled: () => false,
    now: () => 5,
  };
  return { io, phone, log, manifest, saved: () => saved };
}

test("a round fetches what is chosen, and the record says where each song went", async () => {
  const w = world({ serverSongs: { [choiceKey(album)]: [song(1), song(2)] } });
  const outcome = await runHomeSync([album], w.io);
  assert.deepEqual({ d: outcome.downloaded, u: outcome.updated, r: outcome.removed, f: outcome.failed }, { d: 2, u: 0, r: 0, f: [] });
  assert.deepEqual([...w.phone.values()].sort(), ["Band/Record/01 - Song 1.mp3", "Band/Record/02 - Song 2.mp3"]);
  assert.equal(w.manifest.files[hex(1)]!.etag, "e1");
  assert.deepEqual(w.manifest.files[hex(1)]!.via, [choiceKey(album)]);
  assert.ok(w.saved());
  // The next round has nothing to do.
  const again = await runHomeSync([album], w.io);
  assert.deepEqual([again.downloaded, again.updated, again.removed], [0, 0, 0]);
  assert.equal(describeOutcome(again), "Everything chosen is already on the phone.");
});

test("an edited song is fetched again into the same place and the old copy goes", async () => {
  const server = { [choiceKey(album)]: [song(1)] };
  const w = world({ serverSongs: server });
  await runHomeSync([album], w.io);
  const first = w.manifest.files[hex(1)]!.mediaId!;
  server[choiceKey(album)] = [song(1, { etag: "tag-edited", size: 4321 })];
  const outcome = await runHomeSync([album], w.io);
  assert.equal(outcome.updated, 1);
  assert.equal(w.phone.has(first), false);
  assert.equal(w.phone.size, 1);
  assert.equal(w.manifest.files[hex(1)]!.etag, "tag-edited");
  assert.equal(w.manifest.files[hex(1)]!.path, "Band/Record/01 - Song 1.mp3");
});

test("taking a choice away takes its songs off the phone; a removal that fails is reported and stays on record", async () => {
  const server = { [choiceKey(album)]: [song(1), song(2)] };
  const w = world({ serverSongs: server, deleteRefused: new Set(["1002"]) }); // the second song's copy cannot be deleted
  await runHomeSync([album], w.io);
  assert.equal(w.manifest.files[hex(2)]!.mediaId, "1002");
  const outcome = await runHomeSync([], w.io);
  assert.equal(outcome.removed, 1);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0]!, /could not be taken off the phone/);
  assert.deepEqual(Object.keys(w.manifest.files), [hex(2)], "the one that stayed is still on record");
  assert.deepEqual([...w.phone.keys()], ["1002"]);
});

test("nothing is taken off the phone when the server could not be read", async () => {
  const w = world({ serverSongs: { [choiceKey(album)]: [song(1)] } });
  await runHomeSync([album], w.io);
  w.io.fetchSongs = async () => {
    throw new Error("The Jellyfin server did not answer.");
  };
  await assert.rejects(() => runHomeSync([album], w.io), /did not answer/);
  assert.equal(w.phone.size, 1);
  assert.equal(Object.keys(w.manifest.files).length, 1);
});

test("a download that fails is reported and the others go on; three failures in a row stop the round", async () => {
  const songs = [song(1), song(2), song(3), song(4), song(5)];
  const one = world({ serverSongs: { [choiceKey(album)]: songs }, failing: new Set([hex(2)]) });
  const outcome = await runHomeSync([album], one.io);
  assert.equal(outcome.downloaded, 4);
  assert.equal(outcome.failed.length, 1);
  const away = world({ serverSongs: { [choiceKey(album)]: songs }, failing: new Set(songs.map((s) => s.id)) });
  const stopped = await runHomeSync([album], away.io);
  assert.equal(stopped.downloaded, 0);
  assert.match(stopped.failed.at(-1)!, /Stopped after several failures/);
  assert.equal(stopped.failed.length, 4, "three songs and the stop note");
});

test("stopping a round keeps what was fetched and takes nothing off", async () => {
  const w = world({ serverSongs: { [choiceKey(album)]: [song(1), song(2), song(3)] } });
  let stopAfter = 1;
  w.io.cancelled = () => w.log.length >= stopAfter;
  const outcome = await runHomeSync([album], w.io);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.downloaded, 1);
  assert.equal(w.log.filter((l) => l.startsWith("remove")).length, 0);
  assert.match(describeOutcome(outcome), /^Stopped\. 1 song downloaded/);
  stopAfter = 99;
});

test("a stored record is cleaned: odd entries go, good ones stay", () => {
  const good = kept(1, ["all"]);
  const clean = cleanManifest({ files: { [hex(1)]: good, bad: { path: "x" }, [hex(2)]: { mediaId: 5 }, [hex(3)]: { path: "A/B.mp3", via: ["a", 3] } } });
  assert.deepEqual(Object.keys(clean.files).sort(), [hex(1), hex(3)].sort());
  assert.deepEqual(clean.files[hex(3)]!.via, ["a"]);
  assert.deepEqual(cleanManifest(null), { files: {} });
  assert.deepEqual(cleanManifest("nonsense"), { files: {} });
});

test("sizes read plainly", () => {
  assert.equal(sizeText(400), "1 KB");
  assert.equal(sizeText(5_400_000), "5.4 MB");
  assert.equal(sizeText(123_000_000), "123 MB");
  assert.equal(sizeText(2_300_000_000), "2.3 GB");
});

test("a song fetched again gets a new id on the phone, and the round says which old id became which", async () => {
  const server = { [choiceKey(album)]: [song(1)] };
  const w = world({ serverSongs: server });
  await runHomeSync([album], w.io);
  const first = w.manifest.files[hex(1)]!.mediaId!;
  server[choiceKey(album)] = [song(1, { etag: "edited" })];
  const outcome = await runHomeSync([album], w.io);
  assert.deepEqual(outcome.moved, { [first]: w.manifest.files[hex(1)]!.mediaId });
});

// ---- songs that were already on the phone (D178)

type Mine = { id: string; folder: string; file: string; size: number };
const mine = (n: number, size = 1000 + n): Mine => ({ id: `${500 + n}`, folder: "Music/Band/Record/", file: `0${n} - Song ${n}.mp3`, size });

test("songs already on the phone are recognised and marked as kept, not fetched again", async () => {
  const w = world({ serverSongs: { [choiceKey(album)]: [song(1), song(2), song(3)] } });
  const phone = new Map<string, Mine>([[String(500 + 1), mine(1)], [String(500 + 2), mine(2)]]);
  for (const id of phone.keys()) w.phone.set(id, "own file");
  w.io.adopt = async (songs) => songs.flatMap((s) => { const n = Number(s.title.slice(5)); const m = phone.get(String(500 + n)); return m ? [{ song: s, local: m, level: "exact" as const }] : []; });
  const outcome = await runHomeSync([album], w.io);
  assert.deepEqual({ adopted: outcome.adopted, downloaded: outcome.downloaded }, { adopted: 2, downloaded: 1 });
  assert.deepEqual(w.log, ["get Song 3"], "only the song the phone did not have is fetched");
  const kept2 = w.manifest.files[hex(2)]!;
  assert.deepEqual([kept2.adopted, kept2.mediaId, kept2.path, kept2.etag, kept2.hold], [true, "502", "Music/Band/Record/02 - Song 2.mp3", "e2", undefined]);
  assert.equal(w.manifest.files[hex(3)]!.adopted, undefined, "a song the program fetched is its own");
  assert.match(describeOutcome(outcome), /2 songs already on the phone recognised/);
});

test("a recognised song that differs from the server's copy is left alone until the person chooses the server's", async () => {
  const server = { [choiceKey(album)]: [song(1)] };
  const w = world({ serverSongs: server });
  w.phone.set("501", "own file");
  w.io.adopt = async (songs) => [{ song: songs[0]!, local: mine(1, 777), level: "differs" }];
  const first = await runHomeSync([album], w.io);
  assert.deepEqual({ differs: first.differs, downloaded: first.downloaded, updated: first.updated }, { differs: 1, downloaded: 0, updated: 0 });
  assert.equal(w.manifest.files[hex(1)]!.hold, true);
  assert.deepEqual(w.log, []);
  // Next round: still left alone.
  assert.equal((await runHomeSync([album], w.io)).differs, 1);
  // The person chooses the server's version: it is written over the phone's copy, in place, with Android's permission.
  assert.equal(useServerVersions(w.manifest), 1);
  const asked: string[][] = [];
  w.io.grantWrite = async (ids) => (asked.push(ids), new Set(ids));
  const later = await runHomeSync([album], w.io);
  assert.deepEqual(asked, [["501"]]);
  assert.equal(later.updated, 1);
  assert.equal(w.manifest.files[hex(1)]!.mediaId, "501", "the song keeps its place on the phone");
  assert.equal(w.manifest.files[hex(1)]!.adopted, true);
  assert.equal(w.manifest.files[hex(1)]!.hold, undefined);
  assert.equal(w.manifest.files[hex(1)]!.etag, "e1");
});

test("an edit on the server comes into a song the phone already had, in place, and without permission nothing is touched", async () => {
  const server = { [choiceKey(album)]: [song(1)] };
  const w = world({ serverSongs: server });
  w.phone.set("501", "own file");
  w.io.adopt = async (songs) => [{ song: songs[0]!, local: mine(1), level: "exact" }];
  await runHomeSync([album], w.io);
  server[choiceKey(album)] = [song(1, { etag: "edited" })];
  const refused = await runHomeSync([album], Object.assign(w.io, { grantWrite: async () => new Set<string>() }));
  assert.equal(refused.updated, 0);
  assert.match(refused.failed.join(" "), /could not be updated because Android did not give permission/);
  assert.equal(w.manifest.files[hex(1)]!.etag, "e1", "still the old version on record");
  const granted = await runHomeSync([album], Object.assign(w.io, { grantWrite: async (ids: string[]) => new Set(ids) }));
  assert.equal(granted.updated, 1);
  assert.equal(w.manifest.files[hex(1)]!.etag, "edited");
  assert.deepEqual(granted.moved, {}, "same id: nothing to move");
});

test("songs the person already had are never deleted: stopping to keep them only forgets them", async () => {
  const server = { [choiceKey(album)]: [song(1), song(2)] };
  const w = world({ serverSongs: server });
  w.phone.set("501", "own file");
  w.io.adopt = async (songs) => songs.filter((s) => s.id === hex(1)).map((s) => ({ song: s, local: mine(1), level: "exact" as const }));
  await runHomeSync([album], w.io); // 1 adopted, 2 fetched
  const outcome = await runHomeSync([], w.io);
  assert.deepEqual({ removed: outcome.removed, forgotten: outcome.forgotten }, { removed: 1, forgotten: 1 });
  assert.equal(w.phone.has("501"), true, "the person's own file is still there");
  assert.deepEqual(Object.keys(w.manifest.files), []);
  assert.match(describeOutcome(outcome), /1 you already had are no longer kept in step/);
});

test("a song the person already had and has since deleted is fetched again as the program's own", async () => {
  const w = world({ serverSongs: { [choiceKey(album)]: [song(1)] } });
  w.phone.set("501", "own file");
  w.io.adopt = async (songs) => [{ song: songs[0]!, local: mine(1), level: "exact" }];
  await runHomeSync([album], w.io);
  w.phone.delete("501");
  const outcome = await runHomeSync([album], w.io);
  assert.equal(outcome.updated, 1);
  assert.equal(w.manifest.files[hex(1)]!.adopted, undefined);
  assert.match(w.manifest.files[hex(1)]!.path, /^Band\/Record\/01 - Song 1\.mp3$/);
});

test("an artist who only appears on other artists' albums is a choice of its own, kept and told apart from the artist's own albums", () => {
  const guest: Choice = { kind: "appears", id: hex(501), name: "Guest" };
  assert.equal(choiceKey(guest), `appears:${hex(501)}`);
  assert.notEqual(choiceKey(guest), choiceKey({ kind: "artist", id: hex(501), name: "Guest" }));
  assert.equal(choiceLabel(guest), "Guest (on other albums)");
});