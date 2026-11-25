// Pure arithmetic for the music glow (no DOM or Web Audio), so it can be unit tested.

/**
 * Turns one frame of analyser frequency data (bytes 0..255 per bin, bins spread evenly up to half the
 * sample rate) into a glow `level` (0..1: mostly the bass, some overall loudness) and `warm` (0..1: the
 * share of treble, used to shift the glow's colour a little).
 */
export function glowLevel(bins: ArrayLike<number>, sampleRate: number): { level: number; warm: number } {
  const count = bins.length;
  if (count === 0) return { level: 0, warm: 0 };
  const hzPerBin = sampleRate / 2 / count;
  const band = (lowHz: number, highHz: number): number => {
    const from = Math.max(0, Math.floor(lowHz / hzPerBin));
    const to = Math.min(count, Math.max(from + 1, Math.ceil(highHz / hzPerBin)));
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += bins[i];
    return sum / (to - from) / 255;
  };
  const bass = band(30, 180);
  const body = band(180, 2_000);
  const treble = band(2_000, 10_000);
  const level = Math.min(1, 0.85 * bass + 0.15 * body); // the kick drum and bass carry the beat
  const all = bass + body + treble;
  const warm = all > 0 ? Math.min(1, (treble / all) * 1.5) : 0;
  return { level, warm };
}

export type GlowState = { average: number; out: number };

/**
 * One animation frame of the glow. Loud music would keep a plain level near the top all the time, so the glow
 * follows the music against its own recent average: a calm base from the average, plus a pulse on each beat
 * (the amount the level rises above the average). It rises quickly and falls slowly, so it breathes rather
 * than flickers, and it can never flash on and off.
 */
export function nextGlow(state: GlowState, level: number): GlowState {
  const average = state.average + (level - state.average) * 0.02; // about two seconds of memory
  const pulse = Math.max(0, level - average);
  const target = Math.min(1, 0.3 * average + 4 * pulse);
  const out = target > state.out ? state.out + (target - state.out) * 0.4 : state.out + (target - state.out) * 0.07;
  return { average, out };
}
