import assert from "node:assert/strict";
import test from "node:test";
import { syncFlags } from "./flag-sync.ts";
import { addFlag, type Flag } from "./flags.ts";
import type { Session } from "./jellyfin-phone.ts";

const session: Session = { base: "http://x", name: "x", serverId: "s", userId: "u", token: "t" };
type S = { id: string; title: string; artist: string; album: string; artists: string[]; durationMs: number };
const server = (id: string, title: string, artist = "AFI"): S => ({ id, title, artist, album: "Album", artists: [artist], durationMs: 200_000 });

/** A pretend server: a library to search and playlists that can be created and read. */
function fake(library: S[], lists: Array<{ id: string; name: string; songs: S[] }> = []) {
  const created: Array<{ name: string; ids: string[] }> = [];
  return {
    created,
    client: {
      searchSongs: async (_s: Session, term: string) => library.filter((song) => song.title.toLowerCase().includes(term.toLowerCase())),
      playlists: async () => [...lists.map(({ id, name }) => ({ id, name })), ...created.map((c, i) => ({ id: `new${i}`, name: c.name }))],
      playlistSongs: async (_s: Session, id: string) => lists.find((l) => l.id === id)?.songs ?? created[Number(id.slice(3))].ids.map((songId) => library.find((s) => s.id === songId)!),
      createPlaylist: async (_s: Session, name: string, ids: string[]) => { created.push({ name, ids }); return `new${created.length - 1}`; },
    },
  };
}

const flagged = (...titles: string[]): Flag[] => titles.reduce<Flag[]>((all, t, i) => addFlag(all, { id: String(i + 1), title: t, artist: "AFI", album: "Album", durationMs: 200_000 }, 1), []);
const now = new Date(2026, 10, 14, 19, 40);

test("new flags are uploaded as one inbox playlist and marked sent", async () => {
  const { client, created } = fake([server("a", "Girl's Not Grey"), server("b", "Miseria Cantare")]);
  const report = await syncFlags(client, session, flagged("Girl's Not Grey", "Miseria Cantare"), [], "Pixel", now);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, "Problem Playlist 2026-11-14 19:40 (Pixel)");
  assert.deepEqual(created[0].ids, ["a", "b"]);
  assert.equal(report.uploaded, 2);
  assert.ok(report.flags.every((f) => f.sent === now.getTime()));
  assert.equal(report.cleared, 0);
});

test("a flag the server has no song for stays pending and is not uploaded or cleared", async () => {
  const { client, created } = fake([server("a", "Known")]);
  const report = await syncFlags(client, session, flagged("Known", "Unknown to the server"), [], "Pixel", now);
  assert.deepEqual(created[0].ids, ["a"]);
  assert.equal(report.notOnServer, 1);
  assert.equal(report.flags.find((f) => f.title === "Unknown to the server")?.sent, null);
});

test("with nothing new, nothing is created", async () => {
  const { client, created } = fake([]);
  const report = await syncFlags(client, session, [], [], "Pixel", now);
  assert.equal(created.length, 0);
  assert.equal(report.uploaded, 0);
});

test("a flag the computer cleared is dropped; one still in the master list or an inbox stays", async () => {
  const library = [server("a", "Cleared"), server("b", "Still bad"), server("c", "Not merged yet")];
  const { client } = fake(library, [
    { id: "m", name: "Problem tracks", songs: [library[1]] },
    { id: "i", name: "Problem Playlist 2026-11-13 08:00 (TV)", songs: [library[2]] },
  ]);
  const sent = flagged("Cleared", "Still bad", "Not merged yet").map((f) => ({ ...f, sent: 5 }));
  const report = await syncFlags(client, session, sent, [], "Pixel", now);
  assert.deepEqual(report.flags.map((f) => f.title), ["Still bad", "Not merged yet"]);
  assert.equal(report.cleared, 1);
});

test("a song the computer flagged that the phone has is adopted as an already-sent flag", async () => {
  const library = [server("a", "From the PC")];
  const { client } = fake(library, [{ id: "m", name: "Problem tracks", songs: [library[0]] }]);
  const phone = [{ id: "77", title: "From the PC", artist: "AFI", album: "Album" }];
  const report = await syncFlags(client, session, [], phone, "Pixel", now);
  assert.equal(report.adopted, 1);
  assert.equal(report.flags[0].id, "77");
  assert.equal(report.flags[0].sent, now.getTime());
});

test("other playlists on the server are ignored", async () => {
  const library = [server("a", "Song")];
  const { client } = fake(library, [{ id: "p", name: "Road trip", songs: [library[0]] }]);
  const sent = flagged("Song").map((f) => ({ ...f, sent: 5 }));
  const report = await syncFlags(client, session, sent, [], "Pixel", now);
  assert.equal(report.cleared, 1); // "Road trip" does not keep a flag alive
});
