// The highlight colour (--accent) of the desktop app (D72). Outside Now Playing it is the owner's chosen colour
// (Settings > Display, orange by default); while Now Playing is open it follows the playing album's cover, with
// the same rule as the TV and the phone (tv/visuals.ts). Pure apart from `createAccent`, so the rules are tested.

import { DEFAULT_PALETTE, paletteFromPixels, type Rgb } from "../tv/visuals.ts";

import { DEFAULT_ACCENT, inkFor, parseHex } from "../tv/accent-choices.ts";

export { DEFAULT_ACCENT, inkFor, parseHex };

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** The cover's highlight colour (RGBA pixels of a small copy), or null when the cover could not be read. */
export function accentFromPixels(pixels: ArrayLike<number>): Rgb | null {
  const palette = paletteFromPixels(pixels);
  return palette === DEFAULT_PALETTE ? null : palette.mid;
}

/** Sets the page's accent: the cover's colour while one is given, otherwise the chosen default. */
export function createAccent(root: HTMLElement = document.documentElement): { setDefault: (hex: string) => void; setCover: (colour: Rgb | null) => void } {
  let chosen = parseHex(DEFAULT_ACCENT)!;
  let cover: Rgb | null = null;
  const apply = (): void => {
    const colour = cover ?? chosen;
    root.style.setProperty("--accent", toHex(colour));
    root.style.setProperty("--accent-ink", inkFor(colour));
  };
  return {
    setDefault(hex) {
      chosen = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
      apply();
    },
    setCover(colour) {
      cover = colour;
      apply();
    },
  };
}

/** A small copy of a loaded cover image, read for its colour (null if it cannot be read). */
export function coverAccent(image: HTMLImageElement): Rgb | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const pen = canvas.getContext("2d", { willReadFrequently: true });
    if (!pen) return null;
    pen.drawImage(image, 0, 0, 32, 32);
    return accentFromPixels(pen.getImageData(0, 0, 32, 32).data);
  } catch {
    return null;
  }
}
