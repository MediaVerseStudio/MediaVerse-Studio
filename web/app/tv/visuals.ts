// The TV visualizer's looks (D43): colours taken from the playing album's cover, and several styles that take
// turns (bars, mirrored bars, a ring, a wave) so the picture keeps changing on an OLED screen. Drawing only;
// the levels come from tv/spectrum.ts through main.ts.

export type Rgb = [number, number, number];
export type Palette = { hi: Rgb; mid: Rgb; lo: Rgb };

/** The app's own orange, for covers with no strong colour (black and white, grey) or none at all. */
export const DEFAULT_PALETTE: Palette = { hi: [255, 209, 168], mid: [232, 134, 71], lo: [138, 61, 28] };

export const STYLES = ["bars", "mirror", "ring", "wave"] as const;
export type Style = (typeof STYLES)[number];

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Silver shades for black-and-white and grey covers (owner, 2026-11-06: the colours should come from the cover,
 * not fall back to the app's orange). */
export const NEUTRAL_PALETTE: Palette = { hi: [236, 238, 242], mid: [178, 184, 194], lo: [86, 90, 100] };

/**
 * The cover's most striking colour family (RGBA pixels, e.g. a 32 x 32 copy of the cover), as a light, middle
 * and dark shade that read well on the dark screen. Pixels are grouped by hue and weighted by how colourful
 * they are (to the fourth power, so a vivid accent beats a large muted area: 1876's red logo on a sepia photo),
 * so a small red logo on a grey cover still wins over the grey. Muted browns and tans (skin, wood, old paper) count for less: on the owner's library they made
 * nearly half the covers come out orange-ish (2026-11-06). A cover with almost no colour gives silver.
 */
export function paletteFromPixels(pixels: ArrayLike<number>): Palette {
  const buckets = Array.from({ length: 12 }, () => ({ weight: 0, x: 0, y: 0, s: 0 }));
  let seen = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    seen += 1;
    const [h, s, l] = rgbToHsl([pixels[i], pixels[i + 1], pixels[i + 2]]);
    if (s < 0.18 || l < 0.1 || l > 0.94) continue;
    let weight = s ** 4 * (1 - Math.abs(l - 0.5) * 1.4);
    if (h >= 10 && h <= 50 && s < 0.5) weight *= 0.35; // muted browns and tans
    const bucket = buckets[Math.floor(h / 30) % 12];
    bucket.weight += weight;
    bucket.x += Math.cos((h * Math.PI) / 180) * weight; // hues averaged on the circle
    bucket.y += Math.sin((h * Math.PI) / 180) * weight;
    bucket.s += s * weight;
  }
  if (!seen) return DEFAULT_PALETTE; // nothing to read
  const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (best.weight <= 0 || best.weight < seen * 0.001) return NEUTRAL_PALETTE; // hardly any colour
  const hue = ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360;
  const saturation = Math.min(0.9, Math.max(0.55, best.s / best.weight));
  return { hi: hslToRgb(hue, saturation * 0.85, 0.82), mid: hslToRgb(hue, saturation, 0.58), lo: hslToRgb(hue, saturation, 0.3) };
}

/** A step of `t` (0..1) from one palette towards another, for slow colour changes between songs. */
export function mixPalette(from: Palette, to: Palette, t: number): Palette {
  const mix = (a: Rgb, b: Rgb): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return { hi: mix(from.hi, to.hi), mid: mix(from.mid, to.mid), lo: mix(from.lo, to.lo) };
}

export const css = ([r, g, b]: Rgb, alpha = 1): string => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;

/**
 * What can be made once per palette and canvas size and reused frame after frame: the gradients and colour
 * strings. Building them 60 times a second made work (and garbage) for the TV's small processor.
 */
type Kit = {
  palette: Palette;
  width: number;
  height: number;
  barsGradient?: CanvasGradient;
  mirrorGradient?: CanvasGradient;
  hi: string;
  /** Ring spoke colours by shade (lo, mid, hi) and opacity step (0..10). */
  spokes: string[][];
  layers: string[];
};
let kit: Kit | null = null;

function kitFor(pen: CanvasRenderingContext2D, palette: Palette): Kit {
  const { width, height } = pen.canvas;
  if (kit && kit.palette === palette && kit.width === width && kit.height === height) return kit;
  const shades = [palette.lo, palette.mid, palette.hi];
  kit = {
    palette,
    width,
    height,
    hi: css(palette.hi),
    spokes: shades.map((shade) => Array.from({ length: 11 }, (_, step) => css(shade, 0.5 + step * 0.05))),
    layers: shades.map((shade) => css(shade)),
  };
  return kit;
}

/** Drawings a second are limited (owner, 2026-11-17: nothing gains from going above 60; the song analysis has 25 frames a
 * second and the bars are smoothed in time, so 30 looks the same): at most one drawing per 32 ms on the TV and the phone,
 * one per 48 ms while the TV's controls are faded. */
export const VIS_FRAME_MS = 32;
export const VIS_IDLE_FRAME_MS = 48;

/** How many of the lowest bands are the bass, and where the body of the sound ends, for any number of bands (the first
 * 10 and up to 30 of 48 before the number of bands was lowered). */
export const bassBands = (bands: number): number => Math.max(1, Math.round(bands * 0.2));
export const bodyEnd = (bands: number): number => Math.max(2, Math.round(bands * 0.62));

/** Draws one frame. `levels` and `peaks` are 0..1 per band (low to high); `time` in seconds turns the ring. */
export function drawStyle(pen: CanvasRenderingContext2D, style: Style, levels: Float32Array, peaks: Float32Array, palette: Palette, time: number): void {
  const { width, height } = pen.canvas;
  const parts = kitFor(pen, palette);
  pen.clearRect(0, 0, width, height);
  const bands = levels.length;
  if (style === "bars") {
    const base = height * 0.68;
    const gap = 4;
    const bar = (width - gap * (bands - 1)) / bands;
    const tall = height * 0.62;
    if (!parts.barsGradient) {
      parts.barsGradient = pen.createLinearGradient(0, base - tall, 0, base);
      parts.barsGradient.addColorStop(0, css(palette.hi));
      parts.barsGradient.addColorStop(0.45, css(palette.mid));
      parts.barsGradient.addColorStop(1, css(palette.lo));
    }
    // Drawn in three passes (bars, reflections, peaks) so the colour and opacity change three times a frame,
    // not three times a bar.
    pen.fillStyle = parts.barsGradient;
    pen.globalAlpha = 0.95;
    for (let b = 0; b < bands; b++) {
      const h = Math.max(2, levels[b] * tall);
      pen.fillRect(b * (bar + gap), base - h, bar, h);
    }
    pen.globalAlpha = 0.18; // reflection
    for (let b = 0; b < bands; b++) pen.fillRect(b * (bar + gap), base + 6, bar, Math.max(2, levels[b] * tall) * 0.45);
    pen.globalAlpha = 0.9;
    pen.fillStyle = parts.hi;
    for (let b = 0; b < bands; b++) pen.fillRect(b * (bar + gap), base - Math.max(2, peaks[b] * tall) - 8, bar, 4);
  } else if (style === "mirror") {
    // Low notes in the middle, spreading out to both sides; bars grow up and down from the centre line.
    const middle = height / 2;
    const count = bands * 2;
    const gap = 3;
    const bar = (width - gap * (count - 1)) / count;
    const tall = height * 0.42;
    if (!parts.mirrorGradient) {
      parts.mirrorGradient = pen.createLinearGradient(0, middle - tall, 0, middle + tall);
      parts.mirrorGradient.addColorStop(0, css(palette.lo, 0.6));
      parts.mirrorGradient.addColorStop(0.35, css(palette.mid));
      parts.mirrorGradient.addColorStop(0.5, css(palette.hi));
      parts.mirrorGradient.addColorStop(0.65, css(palette.mid));
      parts.mirrorGradient.addColorStop(1, css(palette.lo, 0.6));
    }
    pen.fillStyle = parts.mirrorGradient;
    pen.globalAlpha = 0.92;
    for (let i = 0; i < count; i++) {
      const band = Math.abs(i - (count - 1) / 2) | 0;
      const h = Math.max(2, levels[Math.min(bands - 1, band)] * tall);
      pen.fillRect(i * (bar + gap), middle - h, bar, h * 2);
    }
  } else if (style === "ring") {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.2;
    const reach = Math.min(width, height) * 0.28;
    const spokes = bands * 2;
    const turn = time * 0.06;
    pen.lineCap = "round";
    pen.lineWidth = ((2 * Math.PI * radius) / spokes) * 0.6;
    for (let i = 0; i < spokes; i++) {
      const band = i < bands ? i : spokes - 1 - i; // mirrored, so the ring has no seam
      const level = levels[band];
      const angle = turn + (i / spokes) * Math.PI * 2;
      const inner = radius;
      const outer = radius + 6 + level * reach;
      pen.strokeStyle = parts.spokes[level > 0.66 ? 2 : level > 0.33 ? 1 : 0][Math.min(10, Math.round(level * 10))];
      pen.beginPath();
      pen.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      pen.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      pen.stroke();
    }
    let bass = 0;
    const low = bassBands(bands);
    for (let b = 0; b < low; b++) bass += levels[b] / low;
    const glow = pen.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.95);
    glow.addColorStop(0, css(palette.mid, 0.15 + bass * 0.45));
    glow.addColorStop(1, css(palette.lo, 0));
    pen.fillStyle = glow;
    pen.beginPath();
    pen.arc(cx, cy, radius * 0.95, 0, Math.PI * 2);
    pen.fill();
  } else {
    // Wave: three soft layers drawn through the band levels, the brightest in front.
    const base = height * 0.7;
    const layers: Array<[number, string, number]> = [
      [1, parts.layers[0], 0.55],
      [0.75, parts.layers[1], 0.7],
      [0.5, parts.layers[2], 0.85],
    ];
    for (const [scale, colour, alpha] of layers) {
      // A path keeps the position it was traced at, so the reflection is traced again under its own transform.
      const trace = (): void => {
        pen.beginPath();
        pen.moveTo(0, base);
        for (let b = 0; b <= bands; b++) {
          const x = (b / bands) * width;
          const y = base - (levels[Math.min(bands - 1, b)] ?? 0) * height * 0.6 * scale;
          const px = ((b - 0.5) / bands) * width;
          const py = base - (levels[Math.max(0, b - 1)] ?? 0) * height * 0.6 * scale;
          pen.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        }
        pen.lineTo(width, base);
        pen.closePath();
      };
      pen.fillStyle = colour;
      pen.globalAlpha = alpha;
      trace();
      pen.fill();
      pen.save();
      pen.translate(0, base * 1.4 + 8); // mirrored about the base line, squashed to 40%
      pen.scale(1, -0.4);
      pen.globalAlpha = alpha * 0.2;
      trace();
      pen.fill();
      pen.restore();
    }
  }  pen.globalAlpha = 1;
}
