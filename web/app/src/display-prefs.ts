// Display preferences (D32): how much the picture moves, and how the screen is protected when left alone.
// They belong to this computer's screen, so they are kept in the page's local storage (with defaults when
// storage is unavailable). Pure apart from `loadDisplayPrefs`/`saveDisplayPrefs`, so the rules are unit tested.

import { accentChoice } from "../tv/accent-choices.ts";

export type Motion = "full" | "gentle" | "still";

export type DisplayPrefs = {
  /** full: tint drift, tile flips and the music glow; gentle: slower and softer; still: no flips or glow. */
  motion: Motion;
  /** Minutes with nothing playing and no input before the screen fades to black (0 = never). */
  sleepMinutes: number;
  /** Minutes of no input while music plays before Now Playing opens by itself (0 = never). */
  nowPlayingIdleMinutes: number;
  /** The highlight colour outside Now Playing, one of ACCENT_CHOICES (D72; Now Playing takes it from the cover). */
  accent: string;
  /** How large the lyrics are in Now Playing: -3 (smallest) to 3 (largest) steps from the standard size at 0 (2026-11-17). */
  lyricsSize: number;
  /** Do not let Windows' reduce-motion setting stop the motion: a virtual machine turns Windows' animation effects off, and then nothing would ever move (2026-11-24). */
  ignoreSystemMotion: boolean;
};

export const DEFAULT_DISPLAY: DisplayPrefs = { motion: "full", sleepMinutes: 30, nowPlayingIdleMinutes: 5, accent: "#e88647", lyricsSize: 0, ignoreSystemMotion: false };
export const LYRICS_SIZE_STEPS = 3;
/** The factor for a lyrics size step: 10% smaller per step down (to 70%), 14% larger per step up (to 142%). */
export function lyricsScale(step: number): number {
  return step < 0 ? 1 + step * 0.1 : 1 + step * 0.14;
}
export const SLEEP_CHOICES = [0, 5, 10, 30, 60] as const;
export const NOW_PLAYING_CHOICES = [0, 2, 5, 10] as const;
/** The highlight colours (D72/D75), shared with the TV and phone apps. */
export { ACCENT_CHOICES } from "../tv/accent-choices.ts";
const KEY = "mediaverse.display";

/** Reads stored preferences, keeping only valid values and filling the rest with defaults. */
export function parseDisplayPrefs(raw: unknown): DisplayPrefs {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const motion = value.motion === "full" || value.motion === "gentle" || value.motion === "still" ? value.motion : DEFAULT_DISPLAY.motion;
  const pick = (n: unknown, choices: readonly number[], fallback: number) => (typeof n === "number" && choices.includes(n) ? n : fallback);
  return {
    motion,
    sleepMinutes: pick(value.sleepMinutes, SLEEP_CHOICES, DEFAULT_DISPLAY.sleepMinutes),
    nowPlayingIdleMinutes: pick(value.nowPlayingIdleMinutes, NOW_PLAYING_CHOICES, DEFAULT_DISPLAY.nowPlayingIdleMinutes),
    accent: accentChoice(value.accent),
    lyricsSize: typeof value.lyricsSize === "number" && Number.isInteger(value.lyricsSize) && Math.abs(value.lyricsSize) <= LYRICS_SIZE_STEPS ? value.lyricsSize : 0,
    ignoreSystemMotion: value.ignoreSystemMotion === true,
  };
}

/** The motion actually used: the system's reduced-motion setting wins over "full" or "gentle", unless the person chose to ignore it (`ignoreSystemMotion`). */
export function effectiveMotion(prefs: DisplayPrefs, systemReduced: boolean): Motion {
  return systemReduced && !prefs.ignoreSystemMotion ? "still" : prefs.motion;
}

/** Whether Windows' reduce-motion setting is holding motion back right now (never, when the person chose to ignore it). */
export function systemMotionHeldBack(prefs: DisplayPrefs): boolean {
  return !prefs.ignoreSystemMotion && typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Gaps between tile flips, in milliseconds, for a motion level (null = no flips). */
export function flipInterval(motion: Motion): readonly [number, number] | null {
  if (motion === "still") return null;
  return motion === "gentle" ? [12_000, 25_000] : [5_000, 11_000];
}

/** What idle time means right now: fade to black, open Now Playing, or nothing. */
export function idleAction(prefs: DisplayPrefs, idleMs: number, playing: boolean): "sleep" | "now-playing" | null {
  if (!playing && prefs.sleepMinutes > 0 && idleMs >= prefs.sleepMinutes * 60_000) return "sleep";
  if (playing && prefs.nowPlayingIdleMinutes > 0 && idleMs >= prefs.nowPlayingIdleMinutes * 60_000) return "now-playing";
  return null;
}

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    return parseDisplayPrefs(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
