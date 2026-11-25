import assert from "node:assert/strict";
import { test } from "node:test";
import { askAgain, sureInstrumental, type LyricsAnswer } from "./lyrics-instrumental.ts";

const answer = (via: LyricsAnswer["via"], ...results: LyricsAnswer["results"]): LyricsAnswer => ({ via, results });

test("an instrumental exact match, or the artist's own recording of the same length, is sure", () => {
  assert.equal(sureInstrumental(answer("exact", { instrumental: true })), true);
  assert.equal(sureInstrumental(answer("search", { instrumental: true })), true);
});

test("anything that does not speak for this recording is not enough", () => {
  assert.equal(sureInstrumental(answer("search", { instrumental: true, other_version: true })), false, "another version");
  assert.equal(sureInstrumental(answer("search", { instrumental: true, length_unknown: true })), false, "length not compared");
  assert.equal(sureInstrumental(answer("other_artists", { instrumental: true, other_artist: true })), false);
  assert.equal(sureInstrumental(answer("exact", { instrumental: false })), false, "it has words");
  assert.equal(sureInstrumental(answer("exact")), false, "nothing found");
});

test("songs asked about before the change are asked again, unless likely lyrics are already kept for them", () => {
  assert.equal(askAgain(100, 200, false), true);
  assert.equal(askAgain(300, 200, false), false, "asked since");
  assert.equal(askAgain(100, 200, true), false, "already in To review");
  assert.equal(askAgain(undefined, 200, false), false, "never asked: handled as new");
});
