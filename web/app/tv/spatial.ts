// Moving the highlight with a TV remote's arrow keys: from the highlighted item, pick the nearest item in the
// pressed direction. Pure geometry, so it is unit tested; the page passes in on-screen rectangles.

export type Direction = "up" | "down" | "left" | "right";
export type Box = { left: number; top: number; width: number; height: number };

/**
 * Index in `candidates` of the best item to move to from `from`, or -1 if there is none that way.
 * An item counts when it lies beyond the current item's edge in that direction. Items that overlap the current
 * one across the movement (same row for left/right, same column for up/down) win over nearer diagonal ones, so
 * grids and lists move the way people expect.
 */
export function nextInDirection(from: Box, candidates: Box[], direction: Direction): number {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const fromStart = horizontal ? from.left : from.top;
  const fromEnd = fromStart + (horizontal ? from.width : from.height);
  const fromCrossStart = horizontal ? from.top : from.left;
  const fromCrossEnd = fromCrossStart + (horizontal ? from.height : from.width);
  const fromCrossMid = (fromCrossStart + fromCrossEnd) / 2;

  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((box, index) => {
    if (box.width <= 0 || box.height <= 0) return;
    const start = horizontal ? box.left : box.top;
    const end = start + (horizontal ? box.width : box.height);
    // Must be beyond the current item (a pixel of slack for rounding).
    const gap = sign > 0 ? start - fromEnd : fromStart - end;
    if (gap < -1) return;
    const crossStart = horizontal ? box.top : box.left;
    const crossEnd = crossStart + (horizontal ? box.height : box.width);
    const overlaps = crossStart < fromCrossEnd - 1 && crossEnd > fromCrossStart + 1;
    const crossOffset = overlaps ? 0 : Math.abs((crossStart + crossEnd) / 2 - fromCrossMid);
    // Aligned items first; then nearest along the movement, then least sideways.
    const score = (overlaps ? 0 : 1e6) + Math.max(0, gap) + crossOffset * 3 + (overlaps ? Math.abs((crossStart + crossEnd) / 2 - fromCrossMid) * 0.01 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** The arrow a key press means, from KeyboardEvent.key or a Tizen remote's keyCode. */
export function directionOf(event: { key?: string; keyCode?: number }): Direction | null {
  switch (event.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
  }
  switch (event.keyCode) {
    case 38:
      return "up";
    case 40:
      return "down";
    case 37:
      return "left";
    case 39:
      return "right";
  }
  return null;
}

/** Remote buttons other than arrows, by Tizen keyCode (with keyboard equivalents for testing on a PC). */
export type Command = "ok" | "back" | "playPause" | "play" | "pause" | "stop" | "next" | "previous" | "forward" | "rewind";

export function commandOf(event: { key?: string; keyCode?: number }): Command | null {
  switch (event.keyCode) {
    case 13:
      return "ok";
    case 10009: // Return on Samsung remotes
    case 27: // Escape on a keyboard
    case 8: // Backspace on a keyboard
      return "back";
    case 10252:
      return "playPause";
    case 415:
      return "play";
    case 19:
      return "pause";
    case 413:
      return "stop";
    case 10233:
      return "next";
    case 10232:
      return "previous";
    case 417:
      return "forward";
    case 412:
      return "rewind";
  }
  switch (event.key) {
    case "Enter":
      return "ok";
    case "Escape":
    case "Backspace":
    case "GoBack":
      return "back";
    case "MediaPlayPause":
    case " ":
      return "playPause";
    case "MediaPlay":
      return "play";
    case "MediaPause":
      return "pause";
    case "MediaStop":
      return "stop";
    case "MediaTrackNext":
      return "next";
    case "MediaTrackPrevious":
      return "previous";
    case "MediaFastForward":
      return "forward";
    case "MediaRewind":
      return "rewind";
  }
  return null;
}
