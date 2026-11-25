// The sound settings this computer remembers (levelling is kept by the program itself, in its data folder): gapless and crossfade, and the equalizer. One
// shared audio graph carries the player's sound (audio-graph.ts), so the player, the glow and the settings page all talk to the same one.

import { cleanEq, createAudioGraph, type EqSetting } from "./audio-graph";
import { invoke } from "./desktop-bridge";
import { NativeDeck, type NativePrefs, cleanNativePrefs } from "./native-output";
import { cleanSoundPrefs, type SoundPrefs } from "./sound-handover";

const PREFS_KEY = "mediaverse.sound-prefs.v1";
const EQ_KEY = "mediaverse.eq.v1";
const NATIVE_KEY = "mediaverse.native-output.v1";

export const graph = createAudioGraph();

function read(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept until the window closes
  }
}

let prefs: SoundPrefs = cleanSoundPrefs(read(PREFS_KEY));
let eq: EqSetting = cleanEq(read(EQ_KEY));
graph.setEq(eq);

export const soundPrefs = (): SoundPrefs => prefs;
export function saveSoundPrefs(next: SoundPrefs): void {
  prefs = cleanSoundPrefs(next);
  write(PREFS_KEY, prefs);
}

export const eqSetting = (): EqSetting => eq;
export function saveEq(next: EqSetting): void {
  eq = cleanEq(next);
  write(EQ_KEY, eq);
  graph.setEq(eq);
}

// Exclusive (WASAPI) output (D186): the switch and the chosen sound card are remembered on this computer; the deck is what the player plays through when it is on.
let native: NativePrefs = cleanNativePrefs(read(NATIVE_KEY));
const nativeListeners: (() => void)[] = [];
export const nativePrefs = (): NativePrefs => native;
export function saveNativePrefs(next: NativePrefs): void {
  native = cleanNativePrefs(next);
  write(NATIVE_KEY, native);
  for (const listener of nativeListeners) listener();
}
/** Called when exclusive output is switched on or off, or another sound card is chosen. */
export function onNativePrefs(listener: () => void): void {
  nativeListeners.push(listener);
}
export const nativeDeck = new NativeDeck(
  (command, args) => invoke(command, args),
  () => performance.now(),
  () => native.device,
);
/// The levelling gain of songs, asked of the program ahead of time (the songs about to play) so it is known before a song starts: a gain that arrived a few
/// seconds into a song was heard as a sudden change in volume. Remembered for a few minutes only, because the program works gains out from what it has measured.
const LEVEL_LIFETIME_MS = 5 * 60_000;
const levels = new Map<string, { db: number; at: number }>();
export const levelKnown = (path: string): number | undefined => {
  const found = levels.get(path);
  return found && Date.now() - found.at < LEVEL_LIFETIME_MS ? found.db : undefined;
};
export const forgetLevels = (): void => levels.clear();
/** Asks for the gain of every song not already known (one request); songs that are not measured get 0. */
export async function fetchLevels(paths: string[]): Promise<void> {
  const missing = [...new Set(paths)].filter((p) => levelKnown(p) === undefined);
  if (!missing.length) return;
  try {
    const reply = await invoke<{ gains: Record<string, { gain_db: number }> }>("loudness_gains", { paths: missing });
    for (const path of missing) {
      const gain = reply.gains[path]?.gain_db;
      levels.set(path, { db: typeof gain === "number" && Number.isFinite(gain) ? Math.max(0, Math.min(24, gain)) : 0, at: Date.now() });
    }
  } catch {
    // not measured yet, or not a library file: the songs play as they are (asked again next time)
  }
}