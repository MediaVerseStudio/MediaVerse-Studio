/** The phone's automatic lists (from Musicolet's Not Played and Poweramp's Recently Added). Pure, tested. Most played was removed 2026-11-16 (owner; D119). */
import type { PhoneTrack, PlayStats } from "./native.ts";

export type SmartId = "recent" | "added" | "never";

export const SMART_LISTS: { id: SmartId; name: string; hint: string }[] = [
  { id: "recent", name: "Recently played", hint: "The last 100 songs you played" },
  { id: "added", name: "Recently added", hint: "The newest 100 songs on the phone" },
  { id: "never", name: "Not played yet", hint: "Songs you have not listened to" },
];

export function smartList(id: SmartId, tracks: PhoneTrack[], stats: PlayStats, limit = 100): PhoneTrack[] {
  const played = (t: PhoneTrack): [number, number] | undefined => stats[t.id];
  switch (id) {
    case "recent":
      return tracks
        .filter((t) => played(t))
        .sort((a, b) => played(b)![1] - played(a)![1])
        .slice(0, limit);
    case "added":
      return tracks
        .filter((t) => (t.added ?? 0) > 0)
        .sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
        .slice(0, limit);
    case "never":
      return tracks.filter((t) => !played(t));
  }
}

/** "12:05" for 725000 ms: the sleep timer's countdown. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
