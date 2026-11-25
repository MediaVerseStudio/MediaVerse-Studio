// Screen care for a program people leave running (D32): the motion level on <html> (the stylesheet reads
// `data-motion`), idle tracking, Now Playing opening by itself while music plays, the controls dimming in
// Now Playing, and a fade to black when nothing has played or been touched for a while. Any input wakes it.

import type { PlaybackSignal } from "./player";
import { type DisplayPrefs, type Motion, effectiveMotion, idleAction, loadDisplayPrefs, lyricsScale } from "./display-prefs";

/** How long without input before Now Playing dims its controls and hides the pointer. */
const DIM_AFTER_MS = 20_000;

export type Ambient = { motion: () => Motion; prefs: () => DisplayPrefs; setPrefs: (prefs: DisplayPrefs) => void };

export function initAmbient(audio: PlaybackSignal, nowPlaying: HTMLElement, openNowPlaying: () => void): Ambient {
  const html = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cover = document.createElement("div");
  cover.className = "sleep-cover";
  cover.setAttribute("aria-hidden", "true");
  document.body.append(cover);
  let prefs = loadDisplayPrefs();
  let lastInput = Date.now();
  let openedByIdle = false;

  const motion = (): Motion => effectiveMotion(prefs, reduced.matches);
  const applyMotion = (): void => {
    html.dataset.motion = motion();
    // The stylesheet's reduce-motion rules stand down when the person chose to ignore Windows' setting.
    if (prefs.ignoreSystemMotion) html.dataset.ignoreSystemMotion = "1";
    else delete html.dataset.ignoreSystemMotion;
    html.style.setProperty("--np-lyric-scale", String(lyricsScale(prefs.lyricsSize))); // the lyrics size in Now Playing
  };

  function wake(): void {
    lastInput = Date.now();
    html.classList.remove("is-asleep");
    nowPlaying.classList.remove("is-idle");
  }
  for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, wake, { passive: true, capture: true });
  }
  reduced.addEventListener("change", applyMotion);

  window.setInterval(() => {
    const idle = Date.now() - lastInput;
    const playing = !audio.paused;
    if (!nowPlaying.hidden && idle >= DIM_AFTER_MS) nowPlaying.classList.add("is-idle");
    const action = idleAction(prefs, idle, playing);
    if (action === "sleep") html.classList.add("is-asleep");
    if (action === "now-playing" && nowPlaying.hidden && !openedByIdle && !document.querySelector("dialog[open]")) {
      openedByIdle = true; // once per idle spell, so closing it is respected
      openNowPlaying();
    }
    if (idle < 1_000) openedByIdle = false;
  }, 1_000);

  applyMotion();
  return {
    motion,
    prefs: () => prefs,
    setPrefs: (next) => {
      prefs = next;
      applyMotion();
    },
  };
}
