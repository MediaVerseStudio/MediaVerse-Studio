// Pure logic for the home page shelves (New, Recently played) and the lucky spin. No DOM or bridge access.

export type LibraryTrack = { title: string; artist: string | null; album: string | null; source_uri: string; track_number?: number | null };
export type HistoryEntry = { path: string; title: string | null; artist: string | null; album: string | null; last_played: number; count: number };
export type RecentFile = { path: string; modified: number };

export type AlbumShelfItem = { key: string; album: string; artist: string; tracks: LibraryTrack[] };

/** Group tracks into albums by folder (one album per folder), keeping track order. */
export function albumsByFolder(tracks: LibraryTrack[], folderOf: (path: string) => string): Map<string, AlbumShelfItem> {
  const albums = new Map<string, AlbumShelfItem>();
  for (const track of tracks) {
    const key = folderOf(track.source_uri);
    const found = albums.get(key) ?? { key, album: track.album ?? "Unknown album", artist: track.artist ?? "Unknown artist", tracks: [] };
    found.tracks.push(track);
    albums.set(key, found);
  }
  for (const album of albums.values()) {
    album.tracks.sort((a, b) => (a.track_number ?? 9999) - (b.track_number ?? 9999) || a.title.localeCompare(b.title));
  }
  return albums;
}

/** Albums whose files are newest, newest first, at most `limit`. */
export function newAlbums(files: RecentFile[], albums: Map<string, AlbumShelfItem>, folderOf: (path: string) => string, limit: number): AlbumShelfItem[] {
  const seen = new Set<string>();
  const out: AlbumShelfItem[] = [];
  for (const file of [...files].sort((a, b) => b.modified - a.modified)) {
    const key = folderOf(file.path);
    const album = albums.get(key);
    if (album && !seen.has(key)) {
      seen.add(key);
      out.push(album);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Albums played most recently, most recent first. Tracks no longer in the library are skipped. */
export function recentlyPlayedAlbums(entries: HistoryEntry[], albums: Map<string, AlbumShelfItem>, folderOf: (path: string) => string, limit: number): AlbumShelfItem[] {
  const seen = new Set<string>();
  const out: AlbumShelfItem[] = [];
  for (const entry of [...entries].sort((a, b) => b.last_played - a.last_played)) {
    const key = folderOf(entry.path);
    const album = albums.get(key);
    if (album && !seen.has(key)) {
      seen.add(key);
      out.push(album);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * The "I'm feeling lucky" spin: the album it lands on and the covers that scroll past on the way, `length` in all.
 * The album is chosen among those not played lately when there are any; it sits `AFTER_WINNER` places from the end so a few
 * covers still scroll on after it. It never appears twice in the strip, and no cover sits next to itself while the library
 * has at least three albums. Returns null for an empty library.
 */
export const AFTER_WINNER = 14;
export function luckySpin<T extends { key: string }>(albums: T[], recentKeys: ReadonlySet<string>, length: number, random: () => number): { strip: T[]; winner: number } | null {
  if (albums.length === 0) return null;
  const pick = <U>(list: U[]): U => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const fresh = albums.filter((album) => !recentKeys.has(album.key));
  const chosen = pick(fresh.length > 0 ? fresh : albums);
  const at = Math.max(0, length - 1 - AFTER_WINNER);
  const strip: T[] = [];
  for (let i = 0; i < length; i++) {
    if (i === at) {
      strip.push(chosen);
      continue;
    }
    const others = albums.filter((album) => album !== chosen && album !== strip[i - 1]);
    const loose = albums.filter((album) => album !== chosen);
    strip.push(pick(others.length > 0 ? others : loose.length > 0 ? loose : albums));
  }
  return { strip, winner: at };
}

/**
 * How the lucky reel comes to rest (owner, 2026-11-23: "randomize the snap at the end so the animation has some variation"). Every spin picks one of four ways to settle and
 * its own sizes and timings, so no two look alike. Distances are fractions of one cover; `over` is how far past the winner the reel slides (negative: past it, positive: it
 * stops short), and `swings` are the offsets it then moves through on its way to rest (the caller adds the final 0).
 *  - overshoot: slides past and wiggles back, each swing smaller (the original);
 *  - short: stops just short and creeps onto the album with a click;
 *  - bounce: slides well past, springs back over the other side, and settles;
 *  - tick: barely overshoots and snaps into place at once.
 */
export type Settle = { kind: "overshoot" | "short" | "bounce" | "tick"; over: number; swings: number[]; settleMs: number; spinMs: number; spinEasing: string; swingEasing: string };

export function luckySettle(random: () => number): Settle {
  const between = (low: number, high: number): number => low + (high - low) * random();
  const kinds = ["overshoot", "short", "bounce", "tick"] as const;
  const kind = kinds[Math.min(kinds.length - 1, Math.floor(random() * kinds.length))]!;
  const spinMs = Math.round(between(4200, 5600));
  const spinEasing = ["cubic-bezier(0.12, 0.6, 0.08, 1)", "cubic-bezier(0.1, 0.55, 0.1, 1)", "cubic-bezier(0.16, 0.65, 0.05, 1)"][Math.min(2, Math.floor(random() * 3))]!;
  const swingEasing = random() < 0.5 ? "ease-in-out" : "ease-out";
  /** Swings that alternate sides and shrink by a factor each time, starting at `first` (its sign is the side). */
  const decaying = (first: number, count: number, factor: number): number[] => Array.from({ length: count }, (_, i) => first * (-factor) ** i);
  switch (kind) {
    case "short":
      return { kind, over: between(0.18, 0.36), swings: [between(0.07, 0.12), between(0.02, 0.04)], settleMs: Math.round(between(500, 800)), spinMs, spinEasing, swingEasing: "ease-out" };
    case "bounce": {
      const over = -between(0.4, 0.55);
      return { kind, over, swings: [between(0.2, 0.3), -between(0.08, 0.12), between(0.03, 0.05)], settleMs: Math.round(between(1000, 1400)), spinMs, spinEasing, swingEasing };
    }
    case "tick":
      return { kind, over: -between(0.05, 0.13), swings: [between(0.015, 0.03)], settleMs: Math.round(between(300, 500)), spinMs, spinEasing, swingEasing: "ease-out" };
    default:
      return { kind: "overshoot", over: -between(0.2, 0.38), swings: decaying(between(0.08, 0.14), Math.round(between(2, 4)), between(0.35, 0.5)), settleMs: Math.round(between(700, 1200)), spinMs, spinEasing, swingEasing };
  }
}

/** Seconds of a track that must play before it counts as played: 30 s, or half of a shorter track. */
export function playedThreshold(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 30;
  return Math.min(30, durationSeconds / 2);
}

export type Pin = { folder: string; album: string | null; artist: string | null; pinned_at: number };

/** Pinned albums that are still in the library, most recently pinned first. */
export function pinnedAlbums(pins: Pin[], albums: Map<string, AlbumShelfItem>): AlbumShelfItem[] {
  return [...pins]
    .sort((a, b) => b.pinned_at - a.pinned_at)
    .flatMap((pin) => {
      const album = albums.get(pin.folder);
      return album ? [album] : [];
    });
}
