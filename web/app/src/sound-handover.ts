// When the player hands over to the next song (owner's list 2026-11-23, issue #5: gapless playback and crossfade). The player keeps two audio elements. A little
// before the song ends it starts the next one on the spare element, which was loaded ahead of time from the in-memory cache; with a crossfade the two overlap
// and fade, without one the next starts as the last one's final moment plays out (the start-up time of an element is measured and allowed for). Pure rules, so
// they are unit tested; the player supplies the readings.

export type SoundPrefs = {
  /** Start the next song without a gap. */
  gapless: boolean;
  /** Seconds of overlap between songs (0 is none). */
  crossfade: number;
};

export const DEFAULT_SOUND_PREFS: SoundPrefs = { gapless: true, crossfade: 0 };
export const MAX_CROSSFADE = 12;

export function cleanSoundPrefs(value: unknown): SoundPrefs {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const fade = typeof v.crossfade === "number" && Number.isFinite(v.crossfade) ? Math.min(MAX_CROSSFADE, Math.max(0, Math.round(v.crossfade))) : DEFAULT_SOUND_PREFS.crossfade;
  return { gapless: typeof v.gapless === "boolean" ? v.gapless : DEFAULT_SOUND_PREFS.gapless, crossfade: fade };
}

/** The time to allow for an audio element to start making sound, from the readings so far (seconds): the middle reading, but at least 0.03. */
export function startLatency(readings: number[]): number {
  const good = readings.filter((r) => Number.isFinite(r) && r >= 0 && r < 1).sort((a, b) => a - b);
  if (!good.length) return 0.03;
  // The element reports that it is playing at once; the time to the first sound out of the speakers is longer than that, so never less than the default.
  return Math.max(0.03, good[Math.floor(good.length / 2)]!);
}

/** The crossfade that fits a song: never longer than half of it, and none for a short sample. */
export function fadeFor(prefs: SoundPrefs, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(prefs.crossfade, duration / 2);
}

export type HandoffInput = {
  prefs: SoundPrefs;
  /** Seconds left in the song playing, and its length. */
  remaining: number;
  duration: number;
  paused: boolean;
  /** A next song is queued, it is loaded in memory, and the repeat mode is not "this song". */
  nextReady: boolean;
  /** A short sample that stops on its own is playing (nothing follows it). */
  sample: boolean;
  /** Seconds the spare element needs to start. */
  latency: number;
  alreadyHandedOver: boolean;
};

/** Whether the next song should be started now. */
export function shouldHandOver(input: HandoffInput): boolean {
  if (input.alreadyHandedOver || input.paused || input.sample || !input.nextReady) return false;
  if (!(input.prefs.gapless || input.prefs.crossfade > 0)) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0 || !Number.isFinite(input.remaining)) return false;
  const lead = Math.max(fadeFor(input.prefs, input.duration), input.latency);
  return input.remaining <= lead && input.remaining > 0;
}
