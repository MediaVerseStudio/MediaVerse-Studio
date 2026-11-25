/** Equalizer presets for however many bands the phone's effect has (usually 5). Levels are in millibels (100 = 1 dB). */
export const EQ_PRESETS = ["Flat", "Bass boost", "Treble boost", "Vocal"] as const;
export type EqPreset = (typeof EQ_PRESETS)[number];

export function presetLevels(preset: EqPreset, bands: number, min: number, max: number): number[] {
  const at = (i: number): number => (bands <= 1 ? 0 : i / (bands - 1)); // 0 at the lowest band, 1 at the highest
  const levels = Array.from({ length: bands }, (_, i) => {
    switch (preset) {
      case "Bass boost":
        return Math.round(max * 0.6 * (1 - at(i)) ** 2);
      case "Treble boost":
        return Math.round(max * 0.6 * at(i) ** 2);
      case "Vocal":
        return Math.round(max * 0.5 * Math.max(0, 1 - Math.abs(at(i) - 0.55) * 3));
      default:
        return 0;
    }
  });
  return levels.map((v) => Math.min(max, Math.max(min, v)));
}

/** "+3.5 dB" for 350 millibels. */
export function decibels(millibels: number): string {
  const db = millibels / 100;
  return `${db > 0 ? "+" : ""}${db.toFixed(1).replace(/\.0$/, "")} dB`;
}

/** "60 Hz", "3.6 kHz" for a centre frequency in Hz. */
export function hertz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : `${Math.round(hz)} Hz`;
}
