import assert from "node:assert/strict";
import { test } from "node:test";
import { PlayQueue, mediaUrl, readSavedPlayer } from "./play-queue.ts";

const track = (title: string) => ({ title, artist: null, source_uri: `C:\\Music\\${title}.mp3` });
const abc = [track("a"), track("b"), track("c")];
const titles = (queue: PlayQueue, count: number) => {
  const out: string[] = [queue.current()!.title];
  for (let i = 1; i < count; i += 1) out.push(queue.next()!.title);
  return out;
};

test("the queue moves forward and back and stops at the ends", () => {
  const queue = new PlayQueue();
  assert.equal(queue.current(), null);
  assert.equal(queue.start(abc, 1)?.title, "b");
  assert.equal(queue.next()?.title, "c");
  assert.equal(queue.next(), null, "no track after the last");
  assert.equal(queue.current()?.title, "c");
  assert.equal(queue.previous()?.title, "b");
  assert.equal(queue.previous()?.title, "a");
  assert.equal(queue.previous(), null, "no track before the first");
  assert.equal(queue.hasPrevious, false);
});

test("an empty list or an out-of-range start is handled", () => {
  const queue = new PlayQueue();
  assert.equal(queue.start([]), null);
  assert.equal(queue.next(), null);
  assert.equal(queue.start([track("a"), track("b")], 99)?.title, "b");
  assert.equal(queue.start([track("a"), track("b")], -5)?.title, "a");
});

test("repeat all wraps round, repeat one only repeats when a track ends by itself", () => {
  const queue = new PlayQueue();
  queue.setRepeat("all");
  queue.start(abc, 2);
  assert.equal(queue.next()?.title, "a", "wraps to the start");
  assert.equal(queue.previous()?.title, "c", "and back to the end");
  queue.setRepeat("one");
  assert.equal(queue.next(true)?.title, "c", "ended by itself: same track again");
  queue.setRepeat("off");
  assert.equal(queue.next(true), null);
});

test("shuffle plays every track once, starting with the chosen one, and a new round avoids repeating the last", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const many = Array.from({ length: 8 }, (_, i) => track(`t${i}`));
  const queue = new PlayQueue(random);
  queue.setShuffle(true);
  queue.start(many, 3);
  assert.equal(queue.current()?.title, "t3");
  const round = titles(queue, 8);
  assert.deepEqual([...round].sort(), many.map((t) => t.title).sort(), "each track once");
  assert.equal(queue.next(), null, "the round ends when repeat is off");
  queue.setRepeat("all");
  const last = queue.current()!.title;
  assert.notEqual(queue.next()?.title, last, "a new round does not start with the track just played");
});

test("turning shuffle off keeps the current track and restores the order", () => {
  const queue = new PlayQueue(() => 0.1);
  queue.start(abc, 1);
  queue.setShuffle(true);
  assert.equal(queue.current()?.title, "b");
  queue.setShuffle(false);
  assert.equal(queue.current()?.title, "b");
  assert.equal(queue.next()?.title, "c");
});

test("the queue can be listed in play order and jumped into", () => {
  const queue = new PlayQueue(() => 0);
  queue.start(abc, 1);
  assert.deepEqual(queue.view().tracks.map((t) => t.title), ["a", "b", "c"]);
  assert.equal(queue.view().current, 1);
  assert.equal(queue.jump(2)?.title, "c");
  assert.equal(queue.jump(9), null);
  assert.equal(queue.current()?.title, "c");
});

test("saved state survives a round trip and bad data is dropped", () => {
  const queue = new PlayQueue();
  queue.setRepeat("all");
  queue.start(abc, 2);
  const saved = queue.snapshot(42.5)!;
  const restored = new PlayQueue();
  assert.equal(restored.restore(readSavedPlayer(JSON.parse(JSON.stringify(saved)))!)?.title, "c");
  assert.equal(restored.repeat, "all");
  assert.equal(readSavedPlayer(null), null);
  assert.equal(readSavedPlayer({ items: [] }), null);
  assert.equal(readSavedPlayer({ items: [{ title: 5 }] }), null);
  const odd = readSavedPlayer({ items: abc, index: 99, seconds: -3, repeat: "sideways", shuffle: "yes" })!;
  assert.deepEqual([odd.index, odd.seconds, odd.repeat, odd.shuffle], [0, 0, "off", false]);
});

test("file paths are encoded so they cannot change the request", () => {
  const url = mediaUrl("C:\\Music\\A & B\\x?y#z.mp3");
  assert.ok(url.startsWith("mediaverse-media://library/?path="));
  assert.equal(new URL(url).searchParams.get("path"), "C:\\Music\\A & B\\x?y#z.mp3");
});

test("Play next goes straight after the current song, Add to queue at the end, and both survive a restart", () => {
  const queue = new PlayQueue();
  assert.equal(queue.add([track("x")], "next"), true, "an empty queue starts with them");
  queue.start(abc, 0);
  assert.equal(queue.add([track("n1"), track("n2")], "next"), false);
  queue.add([track("z")], "end");
  assert.deepEqual(queue.view().tracks.map((t) => t.title), ["a", "n1", "n2", "b", "c", "z"]);
  assert.equal(queue.next()?.title, "n1");
  const saved = queue.snapshot(12)!;
  const again = new PlayQueue();
  assert.equal(again.restore(saved)?.title, "n1");
  assert.deepEqual(again.view().tracks.map((t) => t.title), ["a", "n1", "n2", "b", "c", "z"]);
});

test("a song can be taken out of the queue, but not the one playing, and the removal survives a restart", () => {
  const queue = new PlayQueue(() => 0.3);
  queue.start([track("a"), track("b"), track("c"), track("d")], 2); // playing c
  assert.equal(queue.remove(2), false, "the song playing stays");
  assert.equal(queue.remove(0), true); // a, before the one playing
  assert.equal(queue.current()?.title, "c");
  assert.equal(queue.remove(2), true); // d, after it
  assert.deepEqual(queue.view().tracks.map((t) => t.title), ["b", "c"]);
  assert.equal(queue.view().current, 1);
  assert.equal(queue.remove(9), false);
  // Shuffled: the order and the saved queue both lose the song.
  const mixed = new PlayQueue(() => 0.3);
  mixed.setShuffle(true);
  mixed.start([track("a"), track("b"), track("c"), track("d")], 0);
  const gone = mixed.view().tracks[2].title;
  assert.equal(mixed.remove(2), true);
  assert.ok(!mixed.view().tracks.some((t) => t.title === gone));
  const again = new PlayQueue();
  again.restore(mixed.snapshot(0)!);
  assert.equal(again.length, 3);
  assert.ok(!again.view().tracks.some((t) => t.title === gone));
});

test("a song of the Jellyfin server is played from the server, by its id", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(mediaUrl(`jellyfin:${id}/${id.toUpperCase()}`), `mediaverse-media://jellyfin/${id}`);
  assert.equal(mediaUrl(`jellyfin:loose-${id}/${id}`), `mediaverse-media://jellyfin/${id}`);
  // Anything that is not a well-formed song of the server is still treated as a file path.
  assert.ok(mediaUrl("jellyfin:abc/def").startsWith("mediaverse-media://library/?path="));
});

test("the songs coming up are listed in play order, wrapping only when everything repeats", () => {
  const queue = new PlayQueue();
  queue.start(abc, 0);
  assert.deepEqual(queue.upcoming(2).map((t) => t.title), ["b", "c"]);
  assert.deepEqual(queue.upcoming(5).map((t) => t.title), ["b", "c"], "the end of the queue is the end");
  queue.next();
  queue.next();
  assert.deepEqual(queue.upcoming(2), []);
  queue.setRepeat("all");
  assert.deepEqual(queue.upcoming(2).map((t) => t.title), ["a", "b"]);
  queue.setRepeat("one");
  assert.deepEqual(queue.upcoming(2), [], "one song repeating has nothing coming up");
  assert.deepEqual(new PlayQueue().upcoming(2), []);
});
