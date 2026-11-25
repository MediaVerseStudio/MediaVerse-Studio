// The colour mask over the wall of album covers (owner, 2026-11-11), shared by the desktop, TV and phone apps.
// On: the covers are washed with one colour, the Zune look the desktop has always had. Off: the covers show in their
// own colours, as on the TV. The colour is "drifting" (the apps' own northern-lights blend; slowly changing on the
// desktop, still on the TV and phone to keep them light) or one of the highlight colours. Each app keeps its own
// choice on its own device; what each starts with is the look it already had.

import { ACCENT_CHOICES } from "./accent-choices.ts";

export type MaskPrefs = {
  on: boolean;
  /** One of ACCENT_CHOICES, or null for the drifting blend. */
  hex: string | null;
};

/** The swatch that stands for the drifting blend (a hue wheel). */
export const DRIFT_SWATCH = "conic-gradient(#ff3b3b, #f2b630, #39ff14, #00e5ff, #8f6bff, #ff2bd6, #ff3b3b)";

/** Valid stored values; anything else becomes the app's starting look. */
export function parseMask(raw: unknown, defaultOn: boolean): MaskPrefs {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hex = typeof value.hex === "string" ? value.hex.toLowerCase() : "";
  return {
    on: typeof value.on === "boolean" ? value.on : defaultOn,
    hex: ACCENT_CHOICES.some((c) => c.hex === hex) ? hex : null,
  };
}

export function loadMask(key: string, defaultOn: boolean): MaskPrefs {
  try {
    return parseMask(JSON.parse(localStorage.getItem(key) ?? "null"), defaultOn);
  } catch {
    return { on: defaultOn, hex: null };
  }
}

export function saveMask(key: string, prefs: MaskPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // kept until the app closes
  }
}

/** Sets data-mask="on|off" (and data-mask-fixed with --mask when a colour is chosen) on `root`, for the stylesheet. */
export function applyMask(root: HTMLElement, prefs: MaskPrefs): void {
  root.dataset.mask = prefs.on ? "on" : "off";
  if (prefs.on && prefs.hex) {
    root.dataset.maskFixed = "";
    root.style.setProperty("--mask", prefs.hex);
  } else {
    delete root.dataset.maskFixed;
    root.style.removeProperty("--mask");
  }
}
