import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_NATIVE_PREFS, NativeDeck, type NativeInfo, type NativeStatus, cleanNativePrefs, describeInfo, nativeEligible } from "./native-output.ts";

type Sent = { command: string; args: Record<string, unknown> | undefined };

/** A deck wired to a pretend program: it records what the page asks and answers `status` with whatever the test sets. */
function setup(options: { openFails?: string } = {}) {
  let now = 0;
  const sent: Sent[] = [];
  const state: { status: NativeStatus; info: NativeInfo } = {
    info: { rate: 44_100, bits: 16, container_bits: 16, valid_bits: 16, channels: 2, device: "Speakers", bit_perfect: true, duration_ms: 200_000 },
    status: { state: "playing", token: 1, position_ms: 0, age_ms: 0, error: null, duration_ms: 200_000 },
  };
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    sent.push({ command, args });
    if (command === "native_audio_open") {
      if (options.openFails) throw { code: "native_audio_unavailable", message: options.openFails };
      return state.info as T;
    }
    if (command === "native_audio_status") return state.status as T;
    return null as T;
  };
  const deck = new NativeDeck(call, () => now, () => "device-1", 120);
  const events: string[] = [];
  for (const name of ["play", "pause", "ended", "advanced", "fallback", "seeked", "timeupdate", "volumechange", "loadedmetadata"]) deck.addEventListener(name, () => events.push(name));
  return { deck, sent, state, events, advance: (ms: number) => (now += ms) };
}

test("the setting is off until it is switched on, and a damaged saved value is ignored", () => {
  assert.deepEqual(cleanNativePrefs(null), DEFAULT_NATIVE_PREFS);
  assert.deepEqual(cleanNativePrefs({ exclusive: true, device: "abc" }), { exclusive: true, device: "abc" });
  assert.deepEqual(cleanNativePrefs({ exclusive: "yes", device: 5 }), DEFAULT_NATIVE_PREFS);
});

test("only local FLAC, MP3 and WAV files are offered to the exclusive output", () => {
  assert.equal(nativeEligible("M:\\Music\\A\\01 Song.flac"), true);
  assert.equal(nativeEligible("M:\\Music\\A\\01 Song.MP3"), true);
  assert.equal(nativeEligible("M:\\Music\\A\\01 Song.m4a"), false);
  assert.equal(nativeEligible("https://server/Audio/1/stream.mp3"), false);
  assert.equal(nativeEligible(""), false);
  assert.equal(nativeEligible("noextension"), false);
});

test("a song is opened with its place, whether to play, and the chosen sound card", async () => {
  const { deck, sent } = setup();
  const info = await deck.open("M:\\a.flac", 12.5, true);
  assert.equal(info?.rate, 44_100);
  const open = sent.find((s) => s.command === "native_audio_open")!;
  assert.equal(open.args?.path, "M:\\a.flac");
  assert.equal(open.args?.start_ms, 12_500);
  assert.equal(open.args?.play, true);
  assert.equal(open.args?.device, "device-1");
  assert.equal(deck.paused, false);
  assert.equal(deck.duration, 200);
  assert.equal(deck.loaded, true);
  assert.equal(deck.owns("M:\\a.flac"), true);
  deck.stop();
});

test("a song the program cannot open is reported, so the page plays it the ordinary way", async () => {
  const { deck } = setup({ openFails: "The sound card is in use by another program in exclusive mode." });
  assert.equal(await deck.open("M:\\a.flac", 0, true), null);
  assert.match(deck.lastProblem ?? "", /in use by another program/);
  assert.equal(deck.loaded, false);
});

test("the clock runs smoothly between readings, stops on pause and jumps on a seek", async () => {
  const { deck, sent, advance, events } = setup();
  await deck.open("M:\\a.flac", 10, true);
  advance(1500);
  assert.ok(Math.abs(deck.currentTime - 11.5) < 0.001);
  deck.pause();
  advance(3000);
  assert.ok(Math.abs(deck.currentTime - 11.5) < 0.001, "a paused song stays where it is");
  assert.equal(deck.paused, true);
  deck.currentTime = 60;
  assert.ok(Math.abs(deck.currentTime - 60) < 0.001);
  assert.deepEqual(sent.filter((s) => s.command === "native_audio_control").map((s) => s.args?.action), ["volume", "pause", "seek"]);
  assert.ok(events.includes("seeked") && events.includes("pause"));
  await deck.play();
  advance(2000);
  assert.ok(Math.abs(deck.currentTime - 62) < 0.001);
  deck.stop();
});

test("the clock follows the program's reading once it is trusted", async () => {
  const { deck, state, advance } = setup();
  await deck.open("M:\\a.flac", 0, true);
  advance(1000); // past the moment just after opening when readings are not yet trusted
  state.status = { ...state.status, position_ms: 900, age_ms: 20 };
  await deck.poll();
  assert.ok(Math.abs(deck.currentTime - 0.92) < 0.001, `was ${deck.currentTime}`);
  deck.stop();
});

test("the volume bar reaches the program, and full volume is what makes the sound bit-perfect", async () => {
  const { deck, sent } = setup();
  await deck.open("M:\\a.flac", 0, true);
  deck.setLevel(0.4, false);
  const last = sent.filter((s) => s.command === "native_audio_control").at(-1)!;
  assert.deepEqual(last.args, { action: "volume", volume: 0.4, muted: false });
  deck.stop();
});

test("the end of the last song is reported once", async () => {
  const { deck, state, events, advance } = setup();
  await deck.open("M:\\a.flac", 0, true);
  advance(1000);
  state.status = { ...state.status, state: "ended", position_ms: 0, age_ms: 5 };
  await deck.poll();
  await deck.poll();
  assert.equal(events.filter((e) => e === "ended").length, 1);
  assert.equal(deck.paused, true);
  deck.stop();
});

test("when the next song starts by itself the deck says so and carries on with it", async () => {
  const { deck, state, events, advance, sent } = setup();
  await deck.open("M:\\a.flac", 0, true);
  await deck.queueNext("M:\\b.flac");
  const next = sent.find((s) => s.command === "native_audio_next")!;
  assert.equal(next.args?.path, "M:\\b.flac");
  const token = next.args?.token as number;
  advance(1000);
  state.status = { state: "playing", token, position_ms: 30, age_ms: 10, error: null, duration_ms: 180_000 };
  await deck.poll();
  assert.ok(events.includes("advanced"));
  assert.equal(deck.owns("M:\\b.flac"), true);
  assert.equal(deck.duration, 180);
  assert.ok(Math.abs(deck.currentTime - 0.04) < 0.001, `was ${deck.currentTime}`);
  deck.stop();
});

test("trouble in the program hands the song back, with the place it had reached", async () => {
  const { deck, state, advance } = setup();
  let detail: { seconds: number; reason: string } | null = null;
  deck.addEventListener("fallback", (event) => (detail = (event as CustomEvent).detail));
  await deck.open("M:\\a.flac", 5, true);
  advance(2000);
  state.status = { ...state.status, state: "error", error: "The sound card stopped answering.", position_ms: 7000, age_ms: 0 };
  await deck.poll();
  assert.ok(detail);
  assert.match((detail as { reason: string }).reason, /stopped answering/);
  assert.ok(Math.abs((detail as { seconds: number }).seconds - 7) < 0.01);
  assert.equal(deck.loaded, false);
});

test("the line under the switch says what the last song was played as", () => {
  const info: NativeInfo = { rate: 96_000, bits: 24, container_bits: 32, valid_bits: 24, channels: 2, device: "Speakers (Realtek)", bit_perfect: true, duration_ms: 1000 };
  assert.match(describeInfo(info, null), /96 kHz, 24-bit through Speakers \(Realtek\)\. Bit-perfect/);
  assert.match(describeInfo({ ...info, bit_perfect: false }, null), /volume is below full/);
  assert.match(describeInfo({ ...info, bit_perfect: false, valid_bits: 16 }, null), /only takes 16 bits/);
  assert.equal(describeInfo(null, "The sound card is in use by another program in exclusive mode."), "The sound card is in use by another program in exclusive mode.");
  assert.match(describeInfo(null, null), /No song has been played/);
});
