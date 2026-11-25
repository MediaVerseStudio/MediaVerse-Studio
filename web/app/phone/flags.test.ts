import assert from "node:assert/strict";
import test from "node:test";
import { addFlag, clearedOnServer, inboxName, isInbox, localMatches, markSent, pendingFlags, pickServerSong, removeFlag, songKey, type Flag } from "./flags.ts";

const song = (id: string, title: string, artist = "AFI", album = "Sing the Sorrow") => ({ id, title, artist, album, durationMs: 200_000 });

test("flagging a song twice keeps one flag and its first time", () => {
  const once = addFlag([], song("1", "Girl's Not Grey"), 1000);
  const twice = addFlag(once, song("1", "Girl's Not Grey"), 2000);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].at, 1000);
  assert.equal(twice[0].sent, null);
});

test("only flags not yet uploaded are pending; uploading marks them", () => {
  let flags = addFlag(addFlag([], song("1", "A"), 1), song("2", "B"), 2);
  assert.deepEqual(pendingFlags(flags).map((f) => f.id), ["1", "2"]);
  flags = markSent(flags, ["1"], 50);
  assert.deepEqual(pendingFlags(flags).map((f) => f.id), ["2"]);
  assert.equal(flags[0].sent, 50);
  assert.deepEqual(removeFlag(flags, "1").map((f) => f.id), ["2"]);
});

test("the inbox playlist name sorts by time and names the device", () => {
  const name = inboxName(new Date(2026, 10, 14, 19, 40), "Pixel");
  assert.equal(name, "Problem Playlist 2026-11-14 19:40 (Pixel)");
  assert.ok(isInbox(name));
  assert.ok(!isInbox("Problem tracks"));
  assert.equal(inboxName(new Date(2026, 0, 5, 7, 5), ""), "Problem Playlist 2026-01-05 07:05");
  assert.ok(inboxName(new Date(2026, 10, 14, 9, 0), "x") < inboxName(new Date(2026, 10, 14, 19, 0), "x"));
});

test("songs match across devices ignoring case, accents and (feat.) notes", () => {
  assert.equal(songKey({ artist: "Beyoncé", title: "Halo (Remastered)" }), songKey({ artist: "BEYONCE", title: "halo" }));
  assert.notEqual(songKey({ artist: "A", title: "x" }), songKey({ artist: "B", title: "x" }));
});

test("a flag is cleared only when uploaded and absent from the master list and every inbox", () => {
  const uploaded: Flag = { ...addFlag([], song("1", "Gone"), 1)[0], sent: 5 };
  const waiting: Flag = { ...addFlag([], song("2", "Unsent"), 1)[0] };
  const inInbox: Flag = { ...addFlag([], song("3", "Waiting for the PC"), 1)[0], sent: 5 };
  const inMaster: Flag = { ...addFlag([], song("4", "Still bad"), 1)[0], sent: 5 };
  const cleared = clearedOnServer([uploaded, waiting, inInbox, inMaster], [{ artist: "AFI", title: "Still bad" }], [{ artist: "AFI", title: "Waiting for the PC" }]);
  assert.deepEqual(cleared.map((f) => f.id), ["1"]);
});

test("songs the master list names are found in the local library, skipping ones already flagged", () => {
  const library = [song("1", "A"), song("2", "B"), song("3", "C")];
  const flags = addFlag([], song("2", "B"), 1);
  const found = localMatches([{ artist: "AFI", title: "B" }, { artist: "AFI", title: "C" }], library, flags);
  assert.deepEqual(found.map((s) => s.id), ["3"]);
});

test("the server's song is the same song, preferring the same album then the nearest length", () => {
  const flag = addFlag([], song("1", "Halo", "Beyoncé", "I Am... Sasha Fierce"), 1)[0];
  const candidates = [
    { id: "a", title: "Halo", artist: "Beyonce", album: "Greatest Hits", durationMs: 261_000 },
    { id: "b", title: "Halo", artist: "Beyonce", album: "I Am... Sasha Fierce", durationMs: 250_000 },
    { id: "c", title: "Halo", artist: "Beyonce", album: "I Am... Sasha Fierce", durationMs: 200_500 },
    { id: "d", title: "Halo", artist: "Someone Else", album: "I Am... Sasha Fierce", durationMs: 200_000 },
  ];
  assert.equal(pickServerSong(flag, candidates)?.id, "c");
  assert.equal(pickServerSong(flag, [candidates[3]]), null);
});
