import assert from "node:assert/strict";
import { test } from "node:test";
import { NEEDS_FOLDER, namesServerSong, routeServerCommand } from "./server-routing.ts";

const ID = "0123456789abcdef0123456789abcdef";
const SONG = `jellyfin:${ID}/${ID}`;

test("a command the server library answers is answered with the arguments", async () => {
  const seen: unknown[] = [];
  const handlers = { track_cover: async (args: Record<string, unknown>) => (seen.push(args), { mime: "image/jpeg" }) };
  assert.deepEqual(await routeServerCommand(handlers, "track_cover", { path: SONG }), { answer: { mime: "image/jpeg" } });
  assert.deepEqual(seen, [{ path: SONG }]);
});

test("nothing changes in the folder mode", async () => {
  assert.equal(await routeServerCommand(null, "track_cover", { path: SONG }), null);
  assert.equal(await routeServerCommand(null, "write_track_tags", { paths: [SONG] }), null);
});

test("a command that needs a file and names a song of the server is refused with a plain message", async () => {
  await assert.rejects(() => routeServerCommand({}, "update_track_media", { paths: [SONG], lyrics: { text: "x" } }), (thrown) => thrown === NEEDS_FOLDER);
  await assert.rejects(() => routeServerCommand({}, "lyric_ai_time", { paths: ["C:\\Music\\a.mp3", SONG] }), (thrown) => thrown === NEEDS_FOLDER);
  assert.match(NEEDS_FOLDER.message, /plays and casts/);
});

test("favorites, playlists, flags and history go on holding songs of the server", async () => {
  for (const command of ["record_play", "set_favorite", "set_flag", "save_playlist"]) assert.equal(await routeServerCommand({}, command, { path: SONG }), null, command);
});

test("a command that names a file, or no song at all, goes to the program", async () => {
  assert.equal(await routeServerCommand({}, "track_cover", { path: "C:\\Music\\a.mp3" }), null);
  assert.equal(await routeServerCommand({}, "list_flags", {}), null);
  assert.equal(await routeServerCommand({}, "list_flags", undefined), null);
  assert.equal(namesServerSong({ path: 5, paths: "x" }), false);
});

test("a command named like an object property is not mistaken for a handler", async () => {
  assert.equal(await routeServerCommand({}, "constructor", {}), null);
  assert.equal(await routeServerCommand({}, "toString", {}), null);
});
