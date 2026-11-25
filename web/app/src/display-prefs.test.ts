import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DISPLAY, effectiveMotion, flipInterval, idleAction, lyricsScale, parseDisplayPrefs } from "./display-prefs.ts";

test("stored display preferences keep valid values and fall back for the rest", () => {
  assert.deepEqual(parseDisplayPrefs(null), DEFAULT_DISPLAY);
  assert.deepEqual(parseDisplayPrefs({ motion: "gentle", sleepMinutes: 10, nowPlayingIdleMinutes: 0, accent: "#FF2E88" }), { motion: "gentle", sleepMinutes: 10, nowPlayingIdleMinutes: 0, accent: "#ff2e88", lyricsSize: 0, ignoreSystemMotion: false });
  assert.equal(parseDisplayPrefs({ lyricsSize: -3 }).lyricsSize, -3);
  assert.equal(parseDisplayPrefs({ lyricsSize: 2 }).lyricsSize, 2);
  assert.equal(parseDisplayPrefs({ lyricsSize: 4 }).lyricsSize, 0, "only three steps each way");
  assert.equal(parseDisplayPrefs({ lyricsSize: 1.5 }).lyricsSize, 0);
  assert.equal(lyricsScale(0), 1, "the standard size is the middle");
  assert.ok(lyricsScale(-3) < lyricsScale(-1) && lyricsScale(-1) < 1 && 1 < lyricsScale(1) && lyricsScale(1) < lyricsScale(3));
  assert.deepEqual(parseDisplayPrefs({ motion: "wild", sleepMinutes: 7, nowPlayingIdleMinutes: "5", accent: "blue" }), DEFAULT_DISPLAY);
  assert.equal(parseDisplayPrefs({ accent: "#123456" }).accent, DEFAULT_DISPLAY.accent, "only the offered colours");
});

test("the system's reduced-motion setting always means still", () => {
  assert.equal(effectiveMotion({ ...DEFAULT_DISPLAY, motion: "full" }, true), "still");
  assert.equal(effectiveMotion({ ...DEFAULT_DISPLAY, motion: "gentle" }, false), "gentle");
  assert.equal(flipInterval("still"), null);
  assert.ok(flipInterval("gentle")![0] > flipInterval("full")![0], "gentle flips less often");
});

test("idle time fades to black only when nothing plays, and opens Now Playing only while music plays", () => {
  const prefs = { ...DEFAULT_DISPLAY, motion: "full" as const, sleepMinutes: 30, nowPlayingIdleMinutes: 5 };
  assert.equal(idleAction(prefs, 29 * 60_000, false), null);
  assert.equal(idleAction(prefs, 30 * 60_000, false), "sleep");
  assert.equal(idleAction(prefs, 60 * 60_000, true), "now-playing", "music playing never sleeps");
  assert.equal(idleAction(prefs, 4 * 60_000, true), null);
  assert.equal(idleAction({ ...prefs, sleepMinutes: 0, nowPlayingIdleMinutes: 0 }, 99 * 60_000, false), null, "0 means never");
});

test("Windows' reduce-motion setting stops motion unless the person chose to ignore it (a virtual machine has it on without anyone choosing)", () => {
  assert.equal(effectiveMotion({ ...DEFAULT_DISPLAY, motion: "full", ignoreSystemMotion: true }, true), "full");
  assert.equal(effectiveMotion({ ...DEFAULT_DISPLAY, motion: "gentle", ignoreSystemMotion: true }, true), "gentle");
  assert.equal(effectiveMotion({ ...DEFAULT_DISPLAY, motion: "full", ignoreSystemMotion: false }, true), "still");
  assert.equal(parseDisplayPrefs({ ignoreSystemMotion: true }).ignoreSystemMotion, true);
  assert.equal(parseDisplayPrefs({ ignoreSystemMotion: "yes" }).ignoreSystemMotion, false);
});
