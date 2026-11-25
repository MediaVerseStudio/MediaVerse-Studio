// The TV remembers what it was playing (owner, 2026-11-24): the queue, its order, the song it was on and how far in, shuffle and repeat. When the app starts
// again and the same music source is back, the queue is there, paused, ready for Play. These functions are pure (the page does the reading and writing of
// storage), so the rules are tested without a TV.

export type RepeatChoice = "off" | "all" | "one";

export type SavedQueue = {
  v: 1;
  /** The music source the songs belong to (a Jellyfin server, a computer, a USB drive): song ids mean nothing in another one. */
  source: string;
  /** The queue as built (the order the songs were put in), by song id. */
  ids: string[];
  /** The play order: slots of `ids`. Shuffle makes it differ from 0, 1, 2... */
  order: number[];
  /** Where in `order` the playing song is. */
  position: number;
  shuffle: boolean;
  repeat: RepeatChoice;
};

/** How far into a song it was, saved on its own every few seconds (the queue itself only when it changes). */
export type SavedPosition = { source: string; id: string; seconds: number };

/** Largest queue kept (a whole library on shuffle is about this long); more would only be a slow write on the TV. */
export const LONGEST_QUEUE = 20_000;

export function snapshotQueue(source: string, queue: { id: string }[], order: number[], position: number, shuffle: boolean, repeat: RepeatChoice): SavedQueue | null {
  if (!source || !queue.length || !order.length || position < 0 || position >= order.length || queue.length > LONGEST_QUEUE) return null;
  return { v: 1, source, ids: queue.map((t) => t.id), order: [...order], position, shuffle, repeat };
}

const isRepeat = (value: unknown): value is RepeatChoice => value === "off" || value === "all" || value === "one";

/** A saved queue read back from storage text, or null when it is missing, damaged or of another version. */
export function readSavedQueue(text: string | null): SavedQueue | null {
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const saved = data as Record<string, unknown>;
  if (saved.v !== 1 || typeof saved.source !== "string" || !saved.source) return null;
  if (!Array.isArray(saved.ids) || !saved.ids.length || !saved.ids.every((id) => typeof id === "string")) return null;
  if (!Array.isArray(saved.order) || !saved.order.length) return null;
  const count = saved.ids.length;
  if (!saved.order.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < count)) return null;
  if (typeof saved.position !== "number" || !Number.isInteger(saved.position) || saved.position < 0 || saved.position >= saved.order.length) return null;
  return { v: 1, source: saved.source, ids: saved.ids as string[], order: saved.order as number[], position: saved.position, shuffle: saved.shuffle === true, repeat: isRepeat(saved.repeat) ? saved.repeat : "off" };
}

export function readSavedPosition(text: string | null): SavedPosition | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data?.source === "string" && typeof data.id === "string" && typeof data.seconds === "number" && Number.isFinite(data.seconds) && data.seconds >= 0) {
      return { source: data.source, id: data.id, seconds: data.seconds };
    }
  } catch {
    // damaged: no position
  }
  return null;
}

export type RestoredQueue<T> = {
  queue: T[];
  order: number[];
  position: number;
  /** Songs that were in the queue and are no longer in the library. */
  missing: number;
  /** Where to start in the playing song: the saved place when it is the same song, else 0. */
  seconds: number;
};

/**
 * The saved queue made of the songs the library has now. A song that is gone is left out (the play order closes up); if the song that was playing is
 * gone, the next one that is still there is the place to resume. Null when none of the songs is in the library (yet).
 */
export function restoreQueue<T extends { id: string }>(saved: SavedQueue, byId: ReadonlyMap<string, T>, place: SavedPosition | null): RestoredQueue<T> | null {
  const queue: T[] = [];
  const newSlot = new Map<number, number>();
  saved.ids.forEach((id, slot) => {
    const track = byId.get(id);
    if (track) {
      newSlot.set(slot, queue.length);
      queue.push(track);
    }
  });
  if (!queue.length) return null;
  const order: number[] = [];
  let position = -1;
  saved.order.forEach((slot, at) => {
    const now = newSlot.get(slot);
    if (now === undefined) return;
    if (position < 0 && at >= saved.position) position = order.length; // the playing song, or the next one still there
    order.push(now);
  });
  if (position < 0) position = order.length - 1; // everything from the playing song on is gone: the last song left
  const playingId = queue[order[position]].id;
  const sameSong = place !== null && place.source === saved.source && place.id === playingId && saved.ids[saved.order[saved.position]] === playingId;
  return { queue, order, position, missing: saved.ids.length - queue.length, seconds: sameSong ? place.seconds : 0 };
}
