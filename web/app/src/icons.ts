// Small stroke icons used across the app (owner, 2026-11-04: flag, favorite, shuffle and repeat are icons only,
// named by a tooltip). Drawn as inline SVG in the text colour, so they follow the theme.

export type IconName = "heart" | "flag" | "lyrics" | "search" | "add" | "remove" | "play-next" | "shuffle" | "repeat" | "repeat-one" | "play" | "pause" | "previous" | "next" | "back" | "columns" | "edit" | "picture" | "scan" | "pin" | "tv" | "volume" | "mute" | "mini";

const PATHS: Record<IconName, string[]> = {
  // A rounder, evenly weighted heart and a waving flag on a pole (the earlier shapes looked slightly off).
  heart: ["M12 20.3l-1.2-1.1C6.2 15.1 3.2 12.3 3.2 8.9 3.2 6.2 5.3 4.1 8 4.1c1.5 0 3 .7 4 1.9 1-1.2 2.5-1.9 4-1.9 2.7 0 4.8 2.1 4.8 4.8 0 3.4-3 6.2-7.6 10.3z"],
  flag: ["M5.5 21V3.5", "M5.5 4.5c2.2-1.2 4.4-1.2 6.5 0s4.3 1.2 6.5 0v8.5c-2.2 1.2-4.4 1.2-6.5 0s-4.3-1.2-6.5 0"],
  lyrics: ["M4 6.5h16", "M4 11h12", "M4 15.5h16", "M4 20h9"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M20 20l-4.6-4.6"],
  add: ["M12 5v14", "M5 12h14"],
  remove: ["M5 12h14"],
  mini: ["M3.5 5.5h17v13h-17z", "M12 12h6.5v5H12z"],
  "play-next": ["M4 6h10", "M4 11h10", "M4 16h6", "M15 13.5v7l5.5-3.5z"],
  shuffle: ["M3 7h3.5c2.3 0 3.7 1 5 3l1 1.5c1.3 2 2.7 3 5 3H21", "M3 17h3.5c1.8 0 3-.6 4-1.8", "M14 8.8c1-1.2 2.2-1.8 3.5-1.8H21", "M18 4l3 3-3 3", "M18 14l3 3-3 3"],
  repeat: ["M4 11V9a3 3 0 0 1 3-3h12", "M16 3l3 3-3 3", "M20 13v2a3 3 0 0 1-3 3H5", "M8 21l-3-3 3-3"],
  "repeat-one": ["M4 11V9a3 3 0 0 1 3-3h12", "M16 3l3 3-3 3", "M20 13v2a3 3 0 0 1-3 3H5", "M8 21l-3-3 3-3", "M11.5 10.5l1.5-1v5"],
  play: ["M7 4.5v15l12-7.5z"],
  pause: ["M7 5h3.5v14H7z", "M13.5 5H17v14h-3.5z"],
  previous: ["M6 5v14", "M19 5v14L9 12z"],
  next: ["M18 5v14", "M5 5v14l10-7z"],
  back: ["M15 18l-6-6 6-6"],
  columns: ["M4 5h16v14H4z", "M10 5v14", "M15 5v14"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  picture: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15 9.5h.01"],
  scan: ["M3 12h3l2-6 4 12 2-6h7"],
  pin: ["M12 17v5", "M8 3h8l-1 6 3 3v2H6v-2l3-3z"],
  tv: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"],
  volume: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M15.5 9a4 4 0 0 1 0 6", "M18 6.5a8 8 0 0 1 0 11"],
  mute: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M16 9.5l5 5", "M21 9.5l-5 5"],
};

const SVG = "http://www.w3.org/2000/svg";

/** An icon as an SVG element; `filled` fills the shape (a favorite that is on, the play triangle). */
export function icon(name: IconName, options: { size?: number; filled?: boolean } = {}): SVGSVGElement {
  const size = options.size ?? 18;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", options.filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon", `icon-${name}`);
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Gives an icon-only button its icon and its name (spoken by screen readers, shown as a tooltip on hover). */
export function setIconButton(button: HTMLButtonElement, name: IconName, label: string, filled = false): void {
  button.replaceChildren(icon(name, { filled }));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.classList.add("icon-button");
}
