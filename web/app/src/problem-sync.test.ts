import assert from "node:assert/strict";
import test from "node:test";
import { songKey } from "../phone/flags.ts";
import type { Session } from "../phone/jellyfin-phone.ts";
import { describeProblemSync, syncProblemTracks, type FlagLike, type SongLike } from "./problem-sync.ts";

const session: Session = { base: "http://x", name: "x", serverId: "s", userId: "u", token: "t" };
type S = { id: string; title: string; artist: string; album: string; artists: string[]; durationMs: number };
const song = (id: string, title: string, artist = "AFI"): S => ({ id, title, artist, album: "Album", artists: [artist], durationMs: 200_000 });

/** A pretend Jellyfin that keeps its playlists, so what a round leaves behind can be checked. */
function fake(library: S[], lists: Array<{ id: string; name: string; songs: S[] }>) {
  let next = 0;
  const entry = (listId: string, s: S) => ({ ...s, entryId: `${listId}:${s.id}` });
  return {
    lists,
    client: {
      searchSongs: async (_s: Session, term: string) => library.filter((x) => x.title.toLowerCase().includes(term.toLowerCase())),
      playlists: async () => lists.map(({ id, name }) => ({ id, name })),
      playlistSongs: async (_s: Session, id: string) => lists.find((l) => l.id === id)!.songs.map((x) => entry(id, x)),
      createPlaylist: async (_s: Session, name: string, ids: string[]) => {
        const id = `n${next++}`;
        lists.push({ id, name, songs: ids.map((i) => library.find((x) => x.id === i)!) });
        return id;
      },
      addToPlaylist: async (_s: Session, id: string, ids: string[]) => { lists.find((l) => l.id === id)!.songs.push(...ids.map((i) => library.find((x) => x.id === i)!)); },
      removeFromPlaylist: async (_s: Session, id: string, entries: string[]) => {
        const list = lists.find((l) => l.id === id)!;
        list.songs = list.songs.filter((x) => !entries.includes(`${id}:${x.id}`));
      },
      deletePlaylist: async (_s: Session, id: string) => { lists.splice(lists.findIndex((l) => l.id === id), 1); },
    },
  };
}
const lib = (title: string, artist = "AFI"): SongLike => ({ title, artist, album: "Album", album_artist: artist, source_uri: `C:/Music/${title}.mp3` });
const names = (f: ReturnType<typeof fake>): string[] => f.lists.map((l) => l.name);
const titles = (f: ReturnType<typeof fake>, name: string): string[] => f.lists.find((l) => l.name === name)?.songs.map((s) => s.title) ?? [];

const A = song("a", "Girl's Not Grey");
const B = song("b", "Miseria Cantare");
const C = song("c", "Summer Shudder");

test("inbox songs are merged into a new master list, the inbox is deleted, and the computer's songs get flags", async () => {
  const f = fake([A, B], [{ id: "i1", name: "Problem Playlist 2026-11-14 19:40 (Pixel)", songs: [A, B] }]);
  const report = await syncProblemTracks(f.client, session, { flags: [], library: [lib("Girl's Not Grey"), lib("Other song")], done: [] });
  assert.deepEqual(names(f), ["Problem tracks"]);
  assert.deepEqual(titles(f, "Problem tracks"), ["Girl's Not Grey", "Miseria Cantare"]);
  assert.equal(report.fromDevices, 2);
  assert.equal(report.inboxesRemoved, 1);
  assert.deepEqual(report.newFlags.map((s) => s.title), ["Girl's Not Grey"]);
  assert.equal(report.notInLibrary, 1); // Miseria Cantare is not in this library
});

test("a song already on the master list is not added twice, and several inboxes merge", async () => {
  const f = fake([A, B, C], [
    { id: "m", name: "Problem tracks", songs: [A] },
    { id: "i1", name: "Problem Playlist 2026-11-14 19:40 (Pixel)", songs: [A, B] },
    { id: "i2", name: "Problem Playlist 2026-11-14 20:10 (TV)", songs: [B, C] },
  ]);
  const report = await syncProblemTracks(f.client, session, { flags: [], library: [], done: [] });
  assert.deepEqual(titles(f, "Problem tracks"), ["Girl's Not Grey", "Miseria Cantare", "Summer Shudder"]);
  assert.equal(report.fromDevices, 2);
  assert.deepEqual(names(f), ["Problem tracks"]);
});

test("flags made on this computer go onto the master list; a flag the server has no song for is reported", async () => {
  const f = fake([A], [{ id: "m", name: "Problem tracks", songs: [] }]);
  const flags: FlagLike[] = [{ path: "C:/Music/x.mp3", title: "Girl's Not Grey", artist: "AFI", album: "Album" }, { path: "C:/Music/y.mp3", title: "Nowhere", artist: "Nobody", album: "" }];
  const report = await syncProblemTracks(f.client, session, { flags, library: [], done: [] });
  assert.deepEqual(titles(f, "Problem tracks"), ["Girl's Not Grey"]);
  assert.equal(report.fromComputer, 1);
  assert.equal(report.notOnServer, 1);
  assert.equal(report.newFlags.length, 0); // already flagged here
});

test("a song marked Done here leaves the master list and is not brought back from an inbox", async () => {
  const f = fake([A, B], [
    { id: "m", name: "Problem tracks", songs: [A, B] },
    { id: "i1", name: "Problem Playlist 2026-11-14 19:40 (Pixel)", songs: [A] },
  ]);
  const report = await syncProblemTracks(f.client, session, { flags: [], library: [lib("Girl's Not Grey"), lib("Miseria Cantare")], done: [songKey({ artist: "AFI", title: "Girl's Not Grey" })] });
  assert.deepEqual(titles(f, "Problem tracks"), ["Miseria Cantare"]);
  assert.equal(report.doneRemoved, 1);
  assert.equal(report.fromDevices, 0);
  assert.deepEqual(report.newFlags.map((s) => s.title), ["Miseria Cantare"]); // Girl's Not Grey is not flagged again
});

test("a song flagged here is not re-added after Done, even if the old flag file still lists it", async () => {
  const f = fake([A], [{ id: "m", name: "Problem tracks", songs: [] }]);
  const report = await syncProblemTracks(f.client, session, { flags: [{ path: "C:/Music/x.mp3", title: "Girl's Not Grey", artist: "AFI", album: "Album" }], library: [], done: [songKey({ artist: "AFI", title: "Girl's Not Grey" })] });
  assert.deepEqual(titles(f, "Problem tracks"), []);
  assert.equal(report.fromComputer, 0);
});

test("nothing to do changes nothing and says so", async () => {
  const f = fake([A], [{ id: "m", name: "Problem tracks", songs: [A] }, { id: "other", name: "Road trip", songs: [B] }]);
  const report = await syncProblemTracks(f.client, session, { flags: [{ path: "C:/Music/x.mp3", title: "Girl's Not Grey", artist: "AFI", album: "Album" }], library: [lib("Girl's Not Grey")], done: [] });
  assert.deepEqual(names(f), ["Problem tracks", "Road trip"]);
  assert.equal(describeProblemSync(report), "Synced: nothing new.");
});

test("the message lists what happened", () => {
  const text = describeProblemSync({ fromDevices: 2, fromComputer: 0, doneRemoved: 1, inboxesRemoved: 1, newFlags: [lib("x")], notInLibrary: 1, notOnServer: 0 });
  assert.equal(text, "Synced: 2 songs added from phones and TVs; 1 song flagged for review here; 1 song cleared from the shared list; 1 song on the list is not in this computer's library.");
});
