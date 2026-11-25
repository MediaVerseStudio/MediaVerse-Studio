import assert from "node:assert/strict";
import test from "node:test";
import { describePlaylistSync, mergeSongs, syncPlaylists, tailKey, type PcPlaylist, type PlaylistSyncState } from "./playlist-sync.ts";
import type { Session } from "../phone/jellyfin-phone.ts";

const session: Session = { base: "http://jf:8096", name: "Home", serverId: "s", userId: "u", token: "t" };

test("the share seen from the computer and from the server gives the same key", () => {
  assert.equal(tailKey("M:\\Saves the Day\\Stay What You Are\\01 At Your Funeral.mp3"), tailKey("/mnt/media/music/Saves the Day/Stay What You Are/01 at your funeral.MP3"));
  assert.notEqual(tailKey("M:\\A\\B\\1.mp3"), tailKey("M:\\A\\C\\1.mp3"));
});

test("merge: additions on either side are kept, removals on either side win, the first time nothing is removed", () => {
  assert.deepEqual(mergeSongs(["a", "b", "c"], ["a", "b", "c", "d"], ["a", "b", "c", "e"]), ["a", "b", "c", "e", "d"], "d added here, e added there");
  assert.deepEqual(mergeSongs(["a", "b", "c"], ["a", "c"], ["a", "b", "c"]), ["a", "c"], "b taken out here");
  assert.deepEqual(mergeSongs(["a", "b", "c"], ["a", "b", "c"], ["b", "c"]), ["b", "c"], "a taken out there");
  assert.deepEqual(mergeSongs(null, ["a"], ["b"]), ["b", "a"], "no last round: both are kept");
});

const songs: Record<string, string> = { "/music/A/X/1.mp3": "s1", "/music/A/X/2.mp3": "s2", "/music/B/Y/3.mp3": "s3", "/music/C/Z/4.mp3": "s4" };
const library = ["M:\\A\\X\\1.mp3", "M:\\A\\X\\2.mp3", "M:\\B\\Y\\3.mp3"]; // this computer does not have s4

/** A tiny server and a tiny computer. */
function world(remoteLists: Record<string, string[]>, pc: PcPlaylist[], libraryPaths = library, failing: string[] = [], latest: (id: string) => PcPlaylist | undefined = (id) => pc.find((p) => p.id === id)) {
  const log: string[] = [];
  const names = Object.keys(remoteLists);
  const idOf = (name: string): string => `pl-${name}`;
  const client = {
    serverSongs: async () => Object.entries(songs).map(([path, id]) => ({ path, id })),
    playlists: async () => Object.keys(remoteLists).map((name) => ({ id: idOf(name), name })),
    playlistSongs: async (_: Session, id: string) => remoteLists[id.slice(3)].map((song, i) => ({ id: song, entryId: `${id}#${i}`, title: "", artist: "", album: "", durationMs: 0, artists: [] })),
    createPlaylist: async (_: Session, name: string, ids: string[]) => (log.push(`server: create ${name} [${ids}]`), "new"),
    addToPlaylist: async (_: Session, id: string, ids: string[]) => void log.push(`server: add ${id.slice(3)} [${ids}]`),
    removeFromPlaylist: async (_: Session, id: string, entries: string[]) => void log.push(`server: remove ${id.slice(3)} [${entries}]`),
    deletePlaylist: async (_: Session, id: string) => void log.push(`server: delete ${id.slice(3)}`),
  };
  let next = 100;
  const run = (before: PlaylistSyncState = {}) =>
    syncPlaylists(
      {
        client,
        session,
        playlists: pc,
        libraryPaths,
        latest,
        savePlaylist: async (playlist) => {
          if (failing.includes(playlist.name)) throw new Error("refused");
          log.push(`here: save ${playlist.name} [${playlist.paths}]`);
          return playlist.id ?? `p${next++}`;
        },
      },
      before,
    );
  void names;
  return { run, log };
}

test("a computer playlist the server does not have is made there, and songs the server lacks are kept here and counted", async () => {
  const w = world({}, [{ id: "p1", name: "Road trip", paths: ["M:\\A\\X\\1.mp3", "M:\\B\\Y\\3.mp3", "M:\\Z\\Q\\gone.mp3"] }]);
  const { report, state } = await w.run();
  assert.deepEqual(w.log, ["server: create Road trip [s1,s3]"]);
  assert.equal(report.madeOnServer, 1);
  assert.equal(report.notOnServer, 1);
  assert.deepEqual(state, { p1: { name: "Road trip", ids: ["s1", "s3"] } });
  assert.match(describePlaylistSync(report), /1 playlist made on the server.*1 song in playlists here is not on the server/);
});

test("a playlist made on the server is brought in with the songs this library has", async () => {
  const w = world({ "From Jellyfin": ["s2", "s4", "s3"] }, []);
  const { report, state } = await w.run();
  assert.deepEqual(w.log, ["here: save From Jellyfin [M:\\A\\X\\2.mp3,M:\\B\\Y\\3.mp3]"]);
  assert.equal(report.madeHere, 1);
  assert.equal(report.notHere, 1, "s4 is not in this library");
  assert.deepEqual(state, { p100: { name: "From Jellyfin", ids: ["s2", "s4", "s3"] } }, "s4 stays on the server's list");
});

test("songs added on the server come here, and songs added here go there, at the same round", async () => {
  const w = world({ Mix: ["s1", "s2"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3", "M:\\B\\Y\\3.mp3"] }]);
  const { report, state } = await w.run({ p1: { name: "Mix", ids: ["s1"] } });
  assert.deepEqual(w.log, ["server: add Mix [s3]", "here: save Mix [M:\\A\\X\\1.mp3,M:\\A\\X\\2.mp3,M:\\B\\Y\\3.mp3]"]);
  assert.deepEqual([report.addedOnServer, report.addedHere], [1, 1]);
  assert.deepEqual(state.p1.ids, ["s1", "s2", "s3"]);
});

test("a song taken out on one side is taken out on the other", async () => {
  const there = world({ Mix: ["s1", "s2", "s3"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3", "M:\\A\\X\\2.mp3"] }]);
  await there.run({ p1: { name: "Mix", ids: ["s1", "s2", "s3"] } });
  assert.deepEqual(there.log, ["server: remove Mix [pl-Mix#2]"], "s3 was taken out here");
  const here = world({ Mix: ["s1"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3", "M:\\A\\X\\2.mp3"] }]);
  const { report } = await here.run({ p1: { name: "Mix", ids: ["s1", "s2"] } });
  assert.deepEqual(here.log, ["here: save Mix [M:\\A\\X\\1.mp3]"], "s2 was taken out on the server");
  assert.equal(report.removedHere, 1);
});

test("a server song this library cannot hold is never mistaken for one taken out here", async () => {
  const w = world({ Mix: ["s1", "s4"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3"] }]);
  await w.run({ p1: { name: "Mix", ids: ["s1", "s4"] } });
  assert.deepEqual(w.log, [], "s4 stays on the server and nothing is written here");
});

test("nothing changing means nothing is written, and a different order alone is not a change", async () => {
  const w = world({ Mix: ["s3", "s1"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3", "M:\\B\\Y\\3.mp3"] }]);
  const { report } = await w.run({ p1: { name: "Mix", ids: ["s1", "s3"] } });
  assert.deepEqual(w.log, []);
  assert.equal(describePlaylistSync(report), "");
});

test("deleting or renaming a synced playlist here deletes its server copy (the playlist only); a playlist deleted on the server is made there again", async () => {
  const deleted = world({ Old: ["s1"], Other: ["s2"] }, [{ id: "p2", name: "Other", paths: ["M:\\A\\X\\2.mp3"] }]);
  const { report } = await deleted.run({ p1: { name: "Old", ids: ["s1"] }, p2: { name: "Other", ids: ["s2"] } });
  assert.deepEqual(deleted.log, ["server: delete Old"]);
  assert.equal(report.deletedOnServer, 1);
  const renamed = world({ Old: ["s1"] }, [{ id: "p1", name: "New", paths: ["M:\\A\\X\\1.mp3"] }]);
  await renamed.run({ p1: { name: "Old", ids: ["s1"] } });
  assert.deepEqual(renamed.log, ["server: delete Old", "server: create New [s1]"]);
  const gone = world({}, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3"] }]);
  await gone.run({ p1: { name: "Mix", ids: ["s1"] } });
  assert.deepEqual(gone.log, ["server: create Mix [s1]"], "this computer's list is never deleted because the server lost one");
});

test("a computer whose playlists are not read yet (none at all) deletes nothing on the server", async () => {
  const w = world({ Old: ["s1"] }, []);
  await w.run({ p1: { name: "Old", ids: ["s1"] } });
  assert.deepEqual(w.log, ["here: save Old [M:\\A\\X\\1.mp3]"], "it is brought in instead; nothing is deleted");
});

test("the shared flag lists are never touched, in either direction", async () => {
  const w = world({ "Problem tracks": ["s1"], "Problem Playlist 2026-11-22 20:00 (TV)": ["s2"] }, [{ id: "p9", name: "Problem tracks", paths: ["M:\\A\\X\\2.mp3"] }]);
  await w.run();
  assert.deepEqual(w.log, []);
});

test("with the library not read yet nothing is written, and the last round's state is kept", async () => {
  const before: PlaylistSyncState = { p1: { name: "Mix", ids: ["s1"] } };
  const w = world({ Mix: ["s1", "s2"] }, [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3"] }], []);
  const { state } = await w.run(before);
  assert.deepEqual(w.log, []);
  assert.equal(state, before);
});

test("server playlists whose names differ only by capitals are not brought in over this computer's own", async () => {
  const w = world({ "road trip": ["s1"] }, [{ id: "p1", name: "Road Trip", paths: ["M:\\A\\X\\2.mp3"] }]);
  await w.run();
  assert.ok(!w.log.some((line) => line.startsWith("here: save road trip")));
});

test("a playlist changed here while the round waited is left for the next round, not overwritten", async () => {
  const pc: PcPlaylist[] = [{ id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3"] }];
  const edited: PcPlaylist = { id: "p1", name: "Mix", paths: ["M:\\A\\X\\1.mp3", "M:\\B\\Y\\3.mp3"] }; // s3 added meanwhile
  const w = world({ Mix: ["s1", "s2"] }, pc, library, [], () => edited);
  const before: PlaylistSyncState = { p1: { name: "Mix", ids: ["s1"] } };
  const { report, state } = await w.run(before);
  assert.deepEqual(w.log, []);
  assert.equal(report.postponed, 1);
  assert.equal(state.p1, before.p1, "the last round's state is kept");
});

test("one playlist failing does not stop the others", async () => {
  const w = world({ Bad: ["s1"], Good: ["s2"] }, [], library, ["Bad"]);
  const { report, state } = await w.run();
  assert.deepEqual(w.log, ["here: save Good [M:\\A\\X\\2.mp3]"]);
  assert.equal(report.failed.length, 1);
  assert.match(describePlaylistSync(report), /1 playlist could not be synced \(Bad: refused\)/);
  assert.deepEqual(Object.values(state).map((s) => s.name), ["Good"]);
});

test("two songs whose paths end the same way are never taken for one another", async () => {
  const twins = { "/music/A/Greatest Hits/CD1/01 Intro.mp3": "t1", "/music/B/Greatest Hits/CD1/01 Intro.mp3": "t2" };
  const log: string[] = [];
  const client = {
    serverSongs: async () => Object.entries(twins).map(([path, id]) => ({ path, id })),
    playlists: async () => [],
    playlistSongs: async () => [],
    createPlaylist: async (_: Session, name: string, ids: string[]) => (log.push(`create ${name} [${ids}]`), "n"),
    addToPlaylist: async () => undefined,
    removeFromPlaylist: async () => undefined,
    deletePlaylist: async () => undefined,
  };
  const pc: PcPlaylist[] = [{ id: "p1", name: "Intros", paths: ["M:\\A\\Greatest Hits\\CD1\\01 Intro.mp3", "M:\\B\\Greatest Hits\\CD1\\01 Intro.mp3"] }];
  const { report } = await syncPlaylists({ client, session, playlists: pc, libraryPaths: pc[0].paths, latest: () => undefined, savePlaylist: async () => "x" }, {});
  assert.deepEqual(log, [], "ambiguous: neither is put on the server's list");
  assert.equal(report.notOnServer, 2);
});