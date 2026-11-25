import assert from "node:assert/strict";
import test from "node:test";
import { changes, coverage, describeHeard, editsFromHeard, titlesToWrite, type Heard } from "./audio-check-logic.ts";

const heard: Heard = {
  state: "mixed",
  headline: "x",
  total: 12,
  asked: 3,
  files: [
    { number: 1, path: "a.mp3", name: "01", title: "The Leaving Song", track: 1 },
    { number: 2, path: "b.mp3", name: "02", title: "Girl's Not Grey", track: 2 },
    { number: 3, path: "c.mp3", name: "03", title: "Track 3", track: 3 },
  ],
  tracks: [
    { number: 1, state: "other", title: "Girl's Not Grey", artist: "AFI", sounds_like: 2 },
    { number: 2, state: "agrees", title: "Girl's Not Grey" },
    { number: 3, state: "named", title: "Bleed Black", artist: "AFI" },
  ],
};

test("each song is described in words, naming the title it carries when it is out of order", () => {
  assert.equal(describeHeard(heard.tracks[0], heard.files), "Sounds like “Girl's Not Grey” by AFI (the title of “Girl's Not Grey”)");
  assert.equal(describeHeard(heard.tracks[1], heard.files), "The song its title says");
  assert.equal(describeHeard(heard.tracks[2], heard.files), "Recognised as “Bleed Black” by AFI");
  assert.equal(describeHeard({ number: 9, state: "unknown" }, []), "Not in AcoustID's database");
  assert.equal(describeHeard({ number: 9, state: "failed", problem: "down" }, []), "Could not be checked: down");
});

test("how much was listened to is said plainly", () => {
  assert.equal(coverage({ asked: 12, total: 12 }), "Listened to all 12 songs.");
  assert.equal(coverage(heard), "Listened to 3 of 12 songs (a sample across the album).");
});

test("only a different song or an untitled one has a title to change", () => {
  assert.deepEqual(changes(heard).map((c) => c.track.number), [1, 3]);
  assert.deepEqual(titlesToWrite(heard, new Set([3])), [{ path: "c.mp3", title: "Bleed Black" }]);
  assert.deepEqual(titlesToWrite(heard, new Set()), []);
});

test("Fix tags gets the titles, and an artist only where the song has none", () => {
  const edits = editsFromHeard(heard, (path) => (path === "a.mp3" ? "Some Band" : ""));
  assert.deepEqual(edits, { "a.mp3": { title: "Girl's Not Grey" }, "c.mp3": { title: "Bleed Black", artist: "AFI" } });
});
