// Pure logic for the phone screen (no DOM), unit tested in phone-logic.test.ts.

import { indexLetter } from "../tv/library.ts";

/** The first row of each letter in a sorted list, for the A to Z strip down the right. */
export function letterStarts(names: string[]): Map<string, number> {
  const starts = new Map<string, number>();
  names.forEach((name, i) => {
    const letter = indexLetter(name);
    if (!starts.has(letter)) starts.set(letter, i);
  });
  return starts;
}

/** The letters of the strip: "#" then A to Z. */
export const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The row a letter jumps to: its own first row, else the next letter that has one, else the last row. */
export function rowForLetter(starts: Map<string, number>, letter: string, count: number): number {
  const at = LETTERS.indexOf(letter);
  for (let i = Math.max(at, 0); i < LETTERS.length; i++) {
    const row = starts.get(LETTERS[i]);
    if (row !== undefined) return row;
  }
  return Math.max(0, count - 1);
}

/** The rows to draw in a long list: the visible ones plus a few either side. */
export function visibleRange(scrollTop: number, viewHeight: number, rowHeight: number, count: number, extra = 8): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - extra);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / rowHeight) + extra);
  return [first, Math.max(first, last)];
}

/** Where the song is now, from the last state the app sent and the time since (the app sends it twice a second). */
export function positionNow(state: { position: number; duration: number; playing: boolean }, receivedAt: number, now: number): number {
  const moved = state.playing ? Math.max(0, now - receivedAt) : 0;
  const position = state.position + moved;
  return state.duration > 0 ? Math.min(position, state.duration) : position;
}

/**
 * Songs to send for "play from here" in a long list: the chosen song and those after it, at most `limit`, so a
 * tap in a list of thirteen thousand songs does not build a thirteen-thousand-song queue at once.
 */
export function playWindow<T>(items: T[], index: number, limit = 1000): { items: T[]; index: number } {
  if (items.length <= limit) return { items, index };
  return { items: items.slice(index, index + limit), index: 0 };
}

/** The queue as it will play: the player's list put in play order, each with its place in that list. */
export function queueInPlayOrder(queue: string[], order: number[] | undefined): { id: string; index: number }[] {
  const indexes = order && order.length === queue.length ? order : queue.map((_, i) => i);
  return indexes.map((index) => ({ id: queue[index], index }));
}

/** "1 song", "12 songs". */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "12 songs, 48 min". */
export function songsAndLength(count: number, totalMs: number): string {
  const minutes = Math.round(totalMs / 60000);
  const time = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return `${count} song${count === 1 ? "" : "s"}, ${time}`;
}
