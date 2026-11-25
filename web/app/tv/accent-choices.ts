// The highlight colours to choose from (D72/D75), shared by the desktop, TV and phone apps: 20 bright and neon
// shades of the 70s, 80s and 90s, all light enough to read as text on the dark screens. The app's orange comes
// first and is the default. Each app keeps its own choice (desktop Settings > Display; TV and phone Settings).
// While a song plays, Now Playing still takes its colours from the album cover; the choice is used elsewhere,
// and when a cover has no colour that can be read.

import type { Palette, Rgb } from "./visuals.ts";

export const DEFAULT_ACCENT = "#e88647";

/** In two rows of ten: warm to green, then blue to red. */
export const ACCENT_CHOICES: readonly { hex: string; name: string }[] = [
  { hex: "#e88647", name: "MediaVerse orange" },
  { hex: "#ff7a1a", name: "Tangerine" },
  { hex: "#ffa071", name: "Peach" },
  { hex: "#f2b630", name: "Harvest gold" },
  { hex: "#ffe81a", name: "Laser lemon" },
  { hex: "#c6ff1a", name: "Electric lime" },
  { hex: "#39ff14", name: "Neon green" },
  { hex: "#6dffb0", name: "Mint" },
  { hex: "#1de9b6", name: "Turquoise" },
  { hex: "#00e5ff", name: "Cyan" },
  { hex: "#6ccfff", name: "Sky blue" },
  { hex: "#3ea0ff", name: "Electric blue" },
  { hex: "#8f6bff", name: "Ultraviolet" },
  { hex: "#c9a0ff", name: "Lavender" },
  { hex: "#d64dff", name: "Electric purple" },
  { hex: "#ff2bd6", name: "Hot magenta" },
  { hex: "#ff8ad8", name: "Bubblegum" },
  { hex: "#ff2e88", name: "Neon pink" },
  { hex: "#ff6f91", name: "Flamingo" },
  { hex: "#ff3b3b", name: "Neon red" },
];

/** "#rrggbb" (any case) as a colour, or null. */
export function parseHex(value: unknown): Rgb | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One of the offered colours (lower case), or the default for anything else. */
export function accentChoice(value: unknown): string {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  return ACCENT_CHOICES.find((c) => c.hex === lower)?.hex ?? DEFAULT_ACCENT;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Text on an accent-coloured button: near-black or near-white, whichever reads better. */
export function inkFor(colour: Rgb): string {
  const l = luminance(colour);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#120a05" : "#fdf8f4";
}

/** How well `colour` reads on the apps' near-black background (the WCAG contrast ratio). */
export function contrastOnDark(colour: Rgb): number {
  return (luminance(colour) + 0.05) / (luminance([5, 4, 4]) + 0.05);
}

/** A visualizer palette made from one chosen colour: lighter, itself, darker. */
export function paletteFromHex(hex: string): Palette {
  const mid = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  const mix = (to: number, t: number): Rgb => [mid[0] + (to - mid[0]) * t, mid[1] + (to - mid[1]) * t, mid[2] + (to - mid[2]) * t];
  return { hi: mix(255, 0.55), mid, lo: mix(0, 0.45) };
}

/** Sets --accent, --accent-ink, --accent-soft and --accent-line on `root` (the TV and phone pages). */
export function applyAccent(root: HTMLElement, hex: string): void {
  const colour = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-ink", inkFor(colour));
  root.style.setProperty("--accent-soft", `rgba(${colour.join(", ")}, 0.16)`);
  root.style.setProperty("--accent-line", `rgba(${colour.join(", ")}, 0.6)`);
}

/** The choice kept on this device under `key` (default when none or unreadable). */
export function loadAccent(key: string): string {
  try {
    return accentChoice(localStorage.getItem(key));
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function saveAccent(key: string, hex: string): void {
  try {
    localStorage.setItem(key, hex);
  } catch {
    // kept until the app closes
  }
}
