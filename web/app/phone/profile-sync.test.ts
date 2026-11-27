import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "./jellyfin-phone.ts";
import { sendPlays, syncFavorites, type LocalSong } from "./profile-sync.ts";

const session: Session = { base: "http://x", name: "x", serverId: "s", userId: "u", token: "t" };
const server = [
  { id: "sa", title: "Alpha", artist: "Band", artists: ["Band"], album: "LP", durationMs: 1 },
  { id: "sb", title: "Beta", artist: "Band", artists: ["Band"], album: "LP", durationMs: 1 },
  { id: "sc", title: "Server Only", artist: "Band", artists: ["Band"], album: "LP", durationMs: 1 },
];
const library: LocalSong[] = [
  { id: "1", title: "Alpha", artist: "Band", album: "LP" },
  { id: "2", title: "Beta", artist: "Band", album: "LP" },
  { id: "3", title: "Phone Only", artist: "Band", album: "LP" },
];
const manifest = { files: {} };

function fake(favorites: string[]) {
  const loved = new Set(favorites);
  const played: Array<[string, number]> = [];
  return {
    loved,
    played,
    client: {
      favoriteSongs: async () => server.filter((s) => loved.has(s.id)),
      setFavorite: async (_s: Session, id: string, on: boolean) => void (on ? loved.add(id) : loved.delete(id)),
      searchSongs: async (_s: Session, term: string) => server.filter((s) => s.title === term),
      markPlayed: async (_s: Session, id: string, at?: Date) => void played.push([id, at!.getTime()]),
    },
  };
}

test("the first round joins both sides' hearts and removes nothing", async () => {
  const f = fake(["sb", "sc"]);
  const round = await syncFavorites(f.client, session, ["1", "3"], library, manifest, null);
  assert.deepEqual([...f.loved].sort(), ["sa", "sb", "sc"]);
  assert.deepEqual(round.add, ["2"]);
  assert.deepEqual(round.remove, []);
  assert.deepEqual([...round.state].sort(), ["sa", "sb"], "only hearts both sides hold are remembered");
});

test("a heart taken off on either side comes off both; songs one side lacks are left alone", async () => {
  const base = ["sa", "sb", "sc"];
  const f = fake(["sa", "sc"]); // Beta removed on the server
  const round = await syncFavorites(f.client, session, ["2", "3"], library, manifest, base); // Alpha removed on the phone
  assert.deepEqual([...f.loved], ["sc"]);
  assert.deepEqual(round.remove, ["2"]);
  assert.deepEqual(round.add, []);
  assert.deepEqual(round.state, []);
});

test("a heart on a song that reaches the phone later is put on it, not taken off the server", async () => {
  const f = fake(["sa"]);
  const without = library.filter((s) => s.id !== "1");
  const first = await syncFavorites(f.client, session, [], without, manifest, null);
  const second = await syncFavorites(f.client, session, [], library, manifest, first.state);
  assert.deepEqual([...f.loved], ["sa"]);
  assert.deepEqual(second.add, ["1"]);
});

test("plays since the last round are counted on the server at their own times", async () => {
  const f = fake([]);
  const since = await sendPlays(f.client, session, { "1": [2, 5000], "2": [1, 900], "3": [1, 6000] }, library, manifest, 1000);
  assert.deepEqual(f.played, [["sa", 5000]]);
  assert.equal(since, 6000);
});
