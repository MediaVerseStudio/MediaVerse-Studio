const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cleanCommand, cleanState, nowPlayingText, registerMediaKeys, thumbarSpec } = require("./media-controls.js");

test("what the page says about the player is cleaned: long text is cut, numbers are bounded, a cover must be a small image", () => {
  const state = cleanState({ title: "x".repeat(900), artist: 5, playing: "yes", hasTrack: true, canNext: true, position: -4, duration: 1e9, volume: 3, accent: "#e2793a", cover: "data:image/jpeg;base64,AAAA" });
  assert.equal(state.title.length, 300);
  assert.equal(state.artist, "");
  assert.equal(state.playing, false);
  assert.equal(state.position, 0);
  assert.equal(state.duration, 100_000);
  assert.equal(state.volume, 1);
  assert.equal(state.accent, "#e2793a");
  assert.equal(state.cover, "data:image/jpeg;base64,AAAA");
  assert.equal(cleanState({ cover: "https://example.com/x.jpg", accent: "red" }).cover, null);
  assert.equal(cleanState({ accent: "red" }).accent, null);
  assert.equal(cleanState(null).hasTrack, false);
});

test("commands are limited to the known actions, with a value only where one belongs", () => {
  assert.deepEqual(cleanCommand({ action: "next" }), { action: "next" });
  assert.deepEqual(cleanCommand({ action: "volume", value: 7 }), { action: "volume", value: 1 });
  assert.deepEqual(cleanCommand({ action: "seek", value: 83.5 }), { action: "seek", value: 83.5 });
  assert.equal(cleanCommand({ action: "format-disk" }), null);
  assert.equal(cleanCommand("next"), null);
});

test("the taskbar buttons follow what is playing", () => {
  const idle = cleanState({});
  assert.ok(thumbarSpec(idle).every((b) => !b.enabled));
  const playing = cleanState({ hasTrack: true, playing: true, canPrevious: false, canNext: true });
  const [previous, middle, next] = thumbarSpec(playing);
  assert.equal(previous.enabled, false);
  assert.deepEqual([middle.icon, middle.action, middle.enabled], ["pause", "toggle", true]);
  assert.equal(next.enabled, true);
  assert.equal(thumbarSpec(cleanState({ hasTrack: true })).at(1).icon, "play");
});

test("the title text names the song and the artist, or the program", () => {
  assert.equal(nowPlayingText(cleanState({})), "MediaVerse Studio");
  assert.equal(nowPlayingText(cleanState({ hasTrack: true, title: "Night Ferry", artist: "Copper Lantern" })), "Night Ferry · Copper Lantern");
  assert.equal(nowPlayingText(cleanState({ hasTrack: true })), "MediaVerse Studio");
});

test("the four media keys are registered and let go again; a key another program holds is skipped", () => {
  const taken = new Set();
  const calls = [];
  const fake = { register: (key, handler) => (key === "MediaStop" ? false : (taken.add(key), (calls[key] = handler), true)), unregister: (key) => taken.delete(key) };
  const sent = [];
  const release = registerMediaKeys(fake, (c) => sent.push(c));
  assert.deepEqual([...taken].sort(), ["MediaNextTrack", "MediaPlayPause", "MediaPreviousTrack"]);
  calls.MediaPlayPause();
  calls.MediaNextTrack();
  assert.deepEqual(sent, [{ action: "toggle" }, { action: "next" }]);
  release();
  assert.equal(taken.size, 0);
});
