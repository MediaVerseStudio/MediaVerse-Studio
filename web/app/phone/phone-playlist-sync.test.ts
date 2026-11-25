import assert from "node:assert/strict";
import { test } from "node:test";
import { JellyfinProblem, type ServerSong, type Session } from "./jellyfin-phone.ts";
import { type Manifest } from "./home-sync.ts";
import { entryOf, type PhonePlaylist } from "./phone-playlists.ts";
import { describePlaylistReport, syncPhonePlaylists, type PhonePlaylistIo, type PhonePlaylistState } from "./phone-playlist-sync.ts";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const SESSION: Session = { base: "http://192.168.68.13:8096", name: "Home", serverId: "s", userId: "u", token: "t" };

type Song = { id: string; title: string; artist: string; album: string; album_artist: string; duration_ms: number };
/** A song with a phone id (p<n>) and, if the server has it, a server id (hex n). */
const phoneSong = (n: number): Song => ({ id: `p${n}`, title: `Song ${n}`, artist: "Band", album: "Record", album_artist: "Band", duration_ms: 200_000 });
const serverSong = (n: number, entry?: string): ServerSong & { artists: string[] } => ({ id: hex(n), title: `Song ${n}`, artist: "Band", album: "Record", artists: ["Band"], durationMs: 200_000, entryId: entry });

/** A fake server holding playlists of server songs. */
function server(initial: Record<string, number[]> = {}) {
  const lists = new Map<string, { id: string; name: string; songs: number[] }>();
  let counter = 0;
  for (const [name, songs] of Object.entries(initial)) lists.set(`pl${++counter}`, { id: `pl${counter}`, name, songs });
  const calls: string[] = [];
  const knownSongs = new Set<number>();
  const client: PhonePlaylistIo["client"] = {
    playlists: async () => [...lists.values()].map((l) => ({ id: l.id, name: l.name })),
    playlistSongs: async (_s, id) => lists.get(id)!.songs.map((n, i) => serverSong(n, `e${id}-${i}`)),
    createPlaylist: async (_s, name, ids) => {
      const id = `pl${++counter}`;
      lists.set(id, { id, name, songs: ids.map((i) => Number.parseInt(i, 16)) });
      calls.push(`create ${name}`);
      return id;
    },
    addToPlaylist: async (_s, id, ids) => {
      lists.get(id)!.songs.push(...ids.map((i) => Number.parseInt(i, 16)));
      calls.push(`add ${ids.length}`);
    },
    removeFromPlaylist: async (_s, id, entries) => {
      const list = lists.get(id)!;
      const drop = new Set(entries.map((e) => Number(e.split("-")[1])));
      list.songs = list.songs.filter((_, i) => !drop.has(i));
      calls.push(`remove ${entries.length}`);
    },
    deletePlaylist: async (_s, id) => {
      lists.delete(id);
      calls.push("delete");
    },
    searchSongs: async (_s, term) => [...knownSongs].map((n) => serverSong(n)).filter((s) => (s.title ?? '').toLowerCase().includes(term.toLowerCase())),
  };
  const named = (name: string) => [...lists.values()].find((l) => l.name === name);
  return { client, lists, calls, named, knownSongs };
}

/** The phone's record of songs fetched from the server: server song n is phone song p<n>. */
const manifestFor = (...ns: number[]): Manifest => ({ files: Object.fromEntries(ns.map((n) => [hex(n), { id: hex(n), mediaId: `p${n}`, path: "x", size: 1, etag: null, at: 1, via: ["all"], title: `Song ${n}`, artist: "Band", album: "Record" }])) });
const playlistOf = (name: string, ...ns: number[]): PhonePlaylist => ({ id: `id-${name}`, name, entries: ns.map((n) => entryOf(phoneSong(n))), updated: 1 });
const idsOf = (p: PhonePlaylist | undefined): string[] => (p?.entries ?? []).map((e) => e.id);

function io(over: Partial<PhonePlaylistIo> & { client: PhonePlaylistIo["client"] }): PhonePlaylistIo {
  return { session: SESSION, playlists: [], library: [1, 2, 3, 4].map(phoneSong), manifest: manifestFor(1, 2, 3, 4), state: {}, now: 7, newId: (() => { let n = 0; return () => `new${++n}`; })(), ...over };
}

test("a playlist made on the phone is made on the server, with the songs the server knows", async () => {
  const s = server();
  const result = await syncPhonePlaylists(io({ client: s.client, playlists: [playlistOf("Road trip", 1, 3)] }));
  assert.deepEqual(s.named("Road trip")!.songs, [1, 3]);
  assert.equal(result.report.madeOnServer, 1);
  assert.deepEqual(result.state["road trip"], { name: "Road trip", ids: [hex(1), hex(3)] });
  assert.match(describePlaylistReport(result.report), /1 playlist sent to the server/);
});

test("a playlist from the server comes to the phone with the songs the phone has", async () => {
  const s = server({ "Chill": [2, 4, 9] }); // the phone has no song 9
  const result = await syncPhonePlaylists(io({ client: s.client }));
  const made = result.playlists.find((p) => p.name === "Chill")!;
  assert.deepEqual(idsOf(made), ["p2", "p4"]);
  assert.equal(result.report.madeHere, 1);
  assert.equal(result.report.notHere, 1);
  assert.equal(s.named("Chill")!.songs.length, 3, "the server's list is not shortened");
  assert.deepEqual(result.state["chill"]!.ids, [hex(2), hex(4), hex(9)]);
});

test("a song with no record is found on the server by its title", async () => {
  const s = server();
  s.knownSongs.add(7);
  const odd = { ...phoneSong(7), id: "px" }; // a song the phone has that it did not fetch from the server
  const result = await syncPhonePlaylists(io({ client: s.client, library: [phoneSong(1), odd], manifest: manifestFor(1), playlists: [{ id: "a", name: "Mix", entries: [entryOf(phoneSong(1)), entryOf(odd)], updated: 1 }] }));
  assert.deepEqual(s.named("Mix")!.songs, [1, 7]);
  assert.equal(result.report.notOnServer, 0);
});

test("a song the server does not have stays in the phone's playlist and is not sent", async () => {
  const s = server();
  const unknown = { ...phoneSong(8), id: "p8" };
  const result = await syncPhonePlaylists(io({ client: s.client, library: [phoneSong(1), unknown], manifest: manifestFor(1), playlists: [{ id: "a", name: "Mix", entries: [entryOf(phoneSong(1)), entryOf(unknown)], updated: 1 }] }));
  assert.deepEqual(s.named("Mix")!.songs, [1]);
  assert.equal(result.report.notOnServer, 1);
  assert.deepEqual(idsOf(result.playlists.find((p) => p.name === "Mix")), ["p1", "p8"]);
});

test("changes on both sides are merged: an addition on either side stays, a removal on either side wins", async () => {
  const s = server({ Mix: [1, 2, 3, 5] }); // the server added 5 and kept 1, 2, 3
  s.lists.get("pl1")!.songs = [1, 2, 5]; // ...and someone took 3 off
  const state: PhonePlaylistState = { mix: { name: "Mix", ids: [hex(1), hex(2), hex(3)] } };
  // The phone took 2 off and added 4.
  const result = await syncPhonePlaylists(io({ client: s.client, state, playlists: [playlistOf("Mix", 1, 3, 4)], library: [1, 2, 3, 4, 5].map(phoneSong), manifest: manifestFor(1, 2, 3, 4, 5) }));
  assert.deepEqual(s.named("Mix")!.songs.sort(), [1, 4, 5]);
  assert.deepEqual(idsOf(result.playlists.find((p) => p.name === "Mix")).sort(), ["p1", "p4", "p5"]);
  assert.deepEqual(result.state["mix"]!.ids.sort(), [hex(1), hex(4), hex(5)].sort());
});

test("songs the phone does not have are not lost from the server's list by a sync", async () => {
  const s = server({ Mix: [1, 9] });
  const state: PhonePlaylistState = { mix: { name: "Mix", ids: [hex(1), hex(9)] } };
  await syncPhonePlaylists(io({ client: s.client, state, playlists: [playlistOf("Mix", 1)] }));
  assert.deepEqual(s.named("Mix")!.songs.sort(), [1, 9]);
});

test("a playlist deleted on the phone is deleted on the server, and one deleted on the server (and unchanged here) goes from the phone", async () => {
  const s = server({ Gone: [1, 2], Stay: [3] });
  const state: PhonePlaylistState = { gone: { name: "Gone", ids: [hex(1), hex(2)] }, stay: { name: "Stay", ids: [hex(3)] }, old: { name: "Old", ids: [hex(4)] } };
  const result = await syncPhonePlaylists(io({ client: s.client, state, playlists: [playlistOf("Stay", 3), playlistOf("Old", 4)] }));
  assert.equal(s.named("Gone"), undefined, "deleted on the phone, so deleted on the server");
  assert.deepEqual(result.playlists.map((p) => p.name), ["Stay"], "'Old' was deleted on the server and not changed here");
  assert.equal(result.report.deletedOnServer, 1);
  assert.equal(result.report.deletedHere, 1);
  assert.equal(result.state["old"], undefined);
});

test("a playlist deleted on the server but changed on the phone is made on the server again", async () => {
  const s = server();
  const state: PhonePlaylistState = { old: { name: "Old", ids: [hex(4)] } };
  const result = await syncPhonePlaylists(io({ client: s.client, state, playlists: [playlistOf("Old", 4, 2)] }));
  assert.deepEqual(s.named("Old")!.songs, [4, 2]);
  assert.deepEqual(result.playlists.map((p) => p.name), ["Old"]);
});

test("the flag lists belong to the flag sync and are left alone", async () => {
  const s = server({ "Problem tracks": [1], "Problem Playlist 2026-11-14 19:40 (Pixel)": [2] });
  const result = await syncPhonePlaylists(io({ client: s.client, playlists: [playlistOf("Problem tracks", 3)] }));
  assert.deepEqual(result.playlists.map((p) => p.name), ["Problem tracks"]);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.named("Problem tracks")!.songs, [1]);
});

test("the server being away ends the round; one playlist failing does not stop the others", async () => {
  const s = server();
  const away: PhonePlaylistIo["client"] = { ...s.client, playlists: async () => { throw new JellyfinProblem("The Jellyfin server did not answer.", "unreachable"); } };
  await assert.rejects(() => syncPhonePlaylists(io({ client: away })), /did not answer/);
  const flaky: PhonePlaylistIo["client"] = { ...s.client, createPlaylist: async (sess, name, ids) => { if (name === "Bad") throw new Error("name refused"); return s.client.createPlaylist(sess, name, ids); } };
  const result = await syncPhonePlaylists(io({ client: flaky, playlists: [playlistOf("Bad", 1), playlistOf("Good", 2)] }));
  assert.equal(result.report.failed.length, 1);
  assert.match(result.report.failed[0]!, /Bad: name refused/);
  assert.ok(s.named("Good"));
  assert.deepEqual(result.playlists.map((p) => p.name).sort(), ["Bad", "Good"], "the phone's own playlist is kept");
});

test("a second round with nothing changed changes nothing", async () => {
  const s = server();
  const first = await syncPhonePlaylists(io({ client: s.client, playlists: [playlistOf("Mix", 1, 2)] }));
  s.calls.length = 0;
  const second = await syncPhonePlaylists(io({ client: s.client, playlists: first.playlists, state: first.state }));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(second.playlists, first.playlists);
  assert.equal(describePlaylistReport(second.report), "");
});
