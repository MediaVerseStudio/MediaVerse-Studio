// The music-reactive glow along the bottom of the window (D32, after Zune's Quickplay and Winamp): an
// AnalyserNode on the player's own <audio> element, read on each animation frame while music plays. It sets
// two CSS custom properties on <html>, --glow (0..1, mostly bass and loudness) and --glow-warm (0..1, how much
// treble), which the `.music-glow` layers use. When the music pauses the glow fades out, as in Zune. Nothing
// leaves the computer, and nothing runs while nothing plays or when motion is "still".

import type { PlaybackSignal } from "./player";
import { graph } from "./sound";
import { type GlowState, glowLevel, nextGlow } from "./visualizer-math";

export function initVisualizer(audio: PlaybackSignal, motion: () => "full" | "gentle" | "still"): void {
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let bins: Uint8Array<ArrayBuffer> | null = null;
  let frame = 0;
  let state: GlowState = { average: 0, out: 0 };
  let warm = 0;

  function connect(): void {
    if (analyser) return;
    // The analyser belongs to the shared audio graph (sound.ts), which carries both of the player's audio elements.
    graph.wake();
    analyser = graph.analyser();
    context = analyser?.context instanceof AudioContext ? analyser.context : null;
    if (analyser) bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }
  // PC pass (2026-11-17): at most 30 readings a second (it ran on every screen refresh, 144 a second on a fast monitor), and
  // a custom property on the root is written only when its value changed: each write restyles every element that inherits
  // it, which on a page with a long library list is the costly part.
  const FRAME_MS = 32;
  // Written on the glow layers themselves, not on the document root: a custom property set on the root restyles every
  // element of the page that could inherit it.
  const glows = [...document.querySelectorAll<HTMLElement>(".music-glow")];
  const setOnGlows = (name: string, value: string): void => {
    for (const glow of glows) glow.style.setProperty(name, value);
  };
  let lastAt = 0;
  let shownGlow = "";
  let shownWarm = "";

  function tick(now: number = performance.now()): void {
    frame = 0;
    if (!analyser || !bins || audio.paused || document.hidden) return settle();
    const level = motion();
    if (level === "still") return settle();
    if (now - lastAt < FRAME_MS) {
      frame = requestAnimationFrame(tick);
      return;
    }
    lastAt = now;
    analyser.getByteFrequencyData(bins);
    const reading = glowLevel(bins, context?.sampleRate ?? 44_100);
    state = nextGlow(state, reading.level);
    warm += (reading.warm - warm) * 0.05;
    const scale = level === "gentle" ? 0.55 : 1;
    const glow = (state.out * scale).toFixed(3);
    const warmText = warm.toFixed(3);
    if (glow !== shownGlow) setOnGlows("--glow", (shownGlow = glow));
    if (warmText !== shownWarm) setOnGlows("--glow-warm", (shownWarm = warmText));
    frame = requestAnimationFrame(tick);
  }

  /** Paused or stopped: let the glow fade out (the stylesheet animates the change). */
  function settle(): void {
    state = { average: state.average, out: 0 };
    shownGlow = "";
    setOnGlows("--glow", "0");
  }

  function start(): void {
    connect();
    void context?.resume();
    if (!frame) frame = requestAnimationFrame(tick);
  }

  audio.addEventListener("play", start);
  audio.addEventListener("playing", start);
  audio.addEventListener("pause", settle);
  audio.addEventListener("ended", settle);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !audio.paused) start();
  });
  settle();
}
