/**
 * Two small things kept on the phone (from Musicolet): bookmarks inside songs, and named queues that resume from where
 * they were left. Pure functions here (tested); `main.ts` keeps them in the page's local storage.
 */

export type Bookmark = { ms: number; note: string; at: number };

/** Bookmarks of one song in time order; one within a second of an existing one replaces it. */
export function addBookmark(list: Bookmark[], ms: number, note: string, now = Date.now()): Bookmark[] {
  const kept = list.filter((b) => Math.abs(b.ms - ms) >= 1000);
  return [...kept, { ms: Math.max(0, Math.round(ms)), note: note.trim().slice(0, 120), at: now }].sort((a, b) => a.ms - b.ms);
}

export function removeBookmark(list: Bookmark[], index: number): Bookmark[] {
  return list.filter((_, i) => i !== index);
}

export type SavedQueue = { id: string; name: string; ids: string[]; index: number; position: number; updated: number };

/** Adds or replaces (by id) a queue, newest first. */
export function putQueue(queues: SavedQueue[], queue: SavedQueue): SavedQueue[] {
  return [queue, ...queues.filter((q) => q.id !== queue.id)];
}

export function dropQueue(queues: SavedQueue[], id: string): SavedQueue[] {
  return queues.filter((q) => q.id !== id);
}

/** A queue's name that is not already used ("Road trip", "Road trip 2"). */
export function freeQueueName(wanted: string, queues: SavedQueue[]): string {
  const base = wanted.trim().slice(0, 60) || "Queue";
  const taken = new Set(queues.map((q) => q.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
