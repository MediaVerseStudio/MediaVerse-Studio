// The phone's computer client against the computer's real sharing server, over real HTTP (D214): pairing, keeping
// music, hearts, flags and playlists in step.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Computer, computerBase, syncMarks, type MarkState } from "./computer.ts";
import { emptyManifest, runHomeSync, type Choice, type Manifest } from "./home-sync.ts";
import { syncPhonePlaylists, type PhonePlaylistState } from "./phone-playlist-sync.ts";
import { addFlag, type Flag } from "./flags.ts";
import type { Http } from "./jellyfin-phone.ts";
import type { PhonePlaylist } from "./phone-playlists.ts";

const { createLibraryShare } = createRequire(import.meta.url)("../electron/library-share.js");

const http: Http = async (request) => {
  const reply = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: reply.status, body: await reply.text() };
};

test("a typed address becomes the computer's address", () => {
  assert.equal(computerBase(" 192.168.1.20 "), "http://192.168.1.20:47700");
  assert.equal(computerBase("http://192.168.1.20:5000/api"), "http://192.168.1.20:5000");
  assert.equal(computerBase(""), null);
  assert.equal(computerBase("two words"), null);
});

test("phone and computer, end to end", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-phone-pc-"));
  const port = 46500 + Math.floor(Math.random() * 400);
  fs.writeFileSync(path.join(dir, "share.json"), JSON.stringify({ enabled: false, port }));
  const root = path.join(dir, "Music");
  fs.mkdirSync(root);
  const song = (n: number, artist: string, album: string, albumArtist = artist) => {
    const file = path.join(root, `${n}.mp3`);
    fs.writeFileSync(file, `song ${n}`);
    return { id: `track-${n}`, title: `Song ${n}`, artist, album_artist: albumArtist, album, track_number: n, length_ms: 1000, source_uri: file };
  };
  const tracks = [song(1, "Ann", "First"), song(2, "Ann", "First"), song(3, "Ben", "Mixed", "Various Artists"), song(4, "Ben", "Own")];
  const favorites = new Set<string>([tracks[0]!.source_uri]);
  const flags = new Set<string>([tracks[3]!.source_uri]);
  let lists: Array<{ id: string; name: string; paths: string[] }> = [{ id: "p1", name: "Road", paths: [tracks[1]!.source_uri] }];
  const share = createLibraryShare({
    settingsFile: path.join(dir, "share.json"),
    source: {
      snapshot: async () => ({ tracks }),
      root: async () => root,
      cover: async () => null,
      lyrics: async () => null,
      favorites: async () => [...favorites].map((p) => ({ path: p })),
      flags: async () => [...flags].map((p) => ({ path: p })),
      playlists: async () => lists,
      setFavorite: async (p: string, a: { favorite: boolean }) => void (a.favorite ? favorites.add(p) : favorites.delete(p)),
      setFlag: async (p: string, a: { flagged: boolean }) => void (a.flagged ? flags.add(p) : flags.delete(p)),
      savePlaylist: async (p: { id?: string; name: string; paths: string[] }) => {
        const entry = { id: p.id ?? `p${lists.length + 1}`, name: p.name, paths: p.paths };
        lists = p.id ? lists.map((l) => (l.id === p.id ? entry : l)) : [...lists, entry];
        return { playlist: entry };
      },
      deletePlaylist: async (id: string) => void (lists = lists.filter((l) => l.id !== id)),
      incoming: async () => path.join(dir, "Incoming"),
    },
  });
  await share.setEnabled(true);
  try {
    const computer = new Computer(http);
    const base = `http://127.0.0.1:${port}`;
    assert.ok(await computer.hello(base));
    await assert.rejects(computer.startPairing(base, "Pixel"), /Pair a TV or phone|Settings/);
    share.armPairing();
    await computer.startPairing(base, "Pixel");
    const code = share.status().pairing.code as string;
    const session = await computer.confirmPairing(base, "PC", `${code.slice(0, 3)} ${code.slice(3)}`);

    // Choosing what to keep.
    assert.deepEqual((await computer.albumArtists(session)).map((a) => a.name), ["Ann", "Ben", "Various Artists"]);
    const ann = (await computer.albumArtists(session))[0]!;
    assert.deepEqual((await computer.albums(session, ann.id)).map((a) => [a.title, a.songs]), [["First", 2]]);
    assert.deepEqual((await computer.songsFor(session, { kind: "artist", id: ann.id })).map((s) => s.title), ["Song 1", "Song 2"]);
    assert.deepEqual((await computer.guestArtists(session, await computer.albumArtists(session))).map((a) => a.name), []);

    // A round before any music is on the phone (as happens right after pairing).
    const early = await syncMarks({ client: computer, session, favorites: [], flags: [], library: [], manifest: emptyManifest(), state: { favorites: null, flags: null } });

    // The music is fetched.
    const phone = new Map<string, string>(); // phone id -> contents
    let manifest: Manifest = emptyManifest();
    const choices: Choice[] = [{ kind: "artist", id: ann.id, name: "Ann" }, { kind: "playlist", id: "p1", name: "Road" }];
    const round = () =>
      runHomeSync(choices, {
        fetchSongs: (c) => computer.songsFor(session, c.kind === "all" ? { kind: "all" } : { kind: c.kind, id: c.id }),
        manifest,
        saveManifest: (m) => (manifest = m),
        present: () => new Set(phone.keys()),
        download: async (s) => {
          const asked = computer.songRequest(session, s.id);
          const reply = await fetch(asked.url, { headers: asked.headers });
          assert.equal(reply.status, 200);
          const mediaId = String(phone.size + 1);
          const text = await reply.text();
          phone.set(mediaId, text);
          return { mediaId, bytes: text.length };
        },
        removeLocal: async (ids) => ids.filter((id) => phone.delete(id)),
        progress: () => {},
        cancelled: () => false,
        now: () => 1,
      });
    assert.equal((await round()).downloaded, 2);
    assert.deepEqual([...phone.values()].sort(), ["song 1", "song 2"]);
    assert.equal((await round()).downloaded, 0, "nothing twice");

    // Hearts and flags both ways.
    const library = [...phone].map(([id, text]) => ({ id, title: `Song ${text.split(" ")[1]}`, artist: "Ann", album: "First" }));
    const idOf = (title: string) => library.find((s) => s.title === title)!.id;
    let hearts = [idOf("Song 2")];
    let marked: Flag[] = addFlag([], { id: idOf("Song 1"), title: "Song 1", artist: "Ann" }, 1);
    let state: MarkState = early.state;
    const marks = async () => {
      const done = await syncMarks({ client: computer, session, favorites: hearts, flags: marked, library, manifest, state });
      state = done.state;
      hearts = [...hearts.filter((h) => !done.favoritesRemove.includes(h)), ...done.favoritesAdd];
      marked = marked.filter((f) => !done.flagsRemove.includes(f.id));
      return done;
    };
    await marks();
    assert.deepEqual(hearts.sort(), [idOf("Song 1"), idOf("Song 2")].sort(), "the computer's heart arrived");
    assert.equal(favorites.size, 2, "the phone's heart arrived");
    assert.equal(flags.size, 2, "the flag arrived; the flag on a song the phone lacks stays");
    // Cleared on the computer: gone from the phone. Taken off on the phone: gone from the computer.
    flags.delete(tracks[0]!.source_uri);
    hearts = hearts.filter((h) => h !== idOf("Song 1"));
    await marks();
    assert.deepEqual(marked, []);
    assert.equal(favorites.has(tracks[0]!.source_uri), false);
    assert.equal(favorites.has(tracks[1]!.source_uri), true);
    assert.equal(flags.has(tracks[3]!.source_uri), true);

    // Playlists both ways.
    let playlists: PhonePlaylist[] = [{ id: "a", name: "Mine", entries: [{ id: idOf("Song 2"), title: "Song 2", artist: "Ann", album: "First" } as PhonePlaylist["entries"][number]], updated: 1 }];
    let lastState: PhonePlaylistState = {};
    const sync = async () => {
      const done = await syncPhonePlaylists({ client: computer, session, playlists, library, manifest, state: lastState, now: 2, newId: () => `n${playlists.length}` });
      playlists = done.playlists;
      lastState = done.state;
      return done.report;
    };
    assert.deepEqual((await sync()).failed, []);
    assert.deepEqual(lists.map((l) => l.name).sort(), ["Mine", "Road"]);
    assert.deepEqual(playlists.map((p) => p.name).sort(), ["Mine", "Road"]);
    // A song added on the computer to a list both have.
    lists = lists.map((l) => (l.name === "Mine" ? { ...l, paths: [...l.paths, tracks[0]!.source_uri] } : l));
    await sync();
    assert.equal(playlists.find((p) => p.name === "Mine")!.entries.length, 2);
    // Deleted on the phone: gone from the computer.
    playlists = playlists.filter((p) => p.name !== "Mine");
    await sync();
    assert.deepEqual(lists.map((l) => l.name), ["Road"]);

    // A hearted song whose file cannot be read just now keeps its heart on the phone.
    favorites.add(tracks[1]!.source_uri);
    await marks();
    const heartsBefore = [...hearts].sort();
    fs.renameSync(tracks[1]!.source_uri, `${tracks[1]!.source_uri}.away`);
    share.invalidate();
    await marks();
    assert.deepEqual([...hearts].sort(), heartsBefore);
    fs.renameSync(`${tracks[1]!.source_uri}.away`, tracks[1]!.source_uri);
    share.invalidate();
    await marks();
    assert.deepEqual([...hearts].sort(), heartsBefore);
    assert.equal(favorites.has(tracks[1]!.source_uri), true);

    // A chosen playlist deleted on the computer keeps its songs on the phone.
    lists = [];
    await assert.rejects(round(), /no longer on the computer/);
    assert.equal(phone.size, 2);

    // The computer's drive gone: nothing is taken off the phone.
    for (const t of tracks) fs.rmSync(t.source_uri);
    share.invalidate();
    await assert.rejects(computer.list(session, true), /cannot be read/);
    assert.equal(phone.size, 2);

    // Removed on the computer: the phone is told to pair again.
    share.forgetDevice(share.status().devices[0].id);
    await assert.rejects(computer.state(session), (e: Error & { kind?: string }) => e.kind === "signed_out");
  } finally {
    await share.stop();
  }
});
