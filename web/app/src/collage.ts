// Pure logic for the Now Playing collage: which albums to show and how big each tile is.

/** One representative track per album folder (`folderOf` says which folder a path is in), in a stable but
 * varied order, at most `max` of them. */
export function pickCollage<T extends { source_uri: string }>(tracks: T[], max: number, folderOf: (path: string) => string): T[] {
  const seen = new Set<string>();
  const albums: T[] = [];
  for (const track of tracks) {
    const folder = folderOf(track.source_uri);
    if (!seen.has(folder)) {
      seen.add(folder);
      albums.push(track);
    }
  }
  // A fixed interleave (every 7th, then every 5th ...) so neighbours are not always the same artist.
  const varied = [...albums.filter((_, i) => i % 2 === 0), ...albums.filter((_, i) => i % 2 === 1)];
  return varied.slice(0, max);
}

/** How many grid cells wide and tall tile `index` is: mostly small, some medium, a few large. */
export function tileSpan(index: number): 1 | 2 | 3 {
  if (index % 13 === 2) return 3;
  if (index % 5 === 0) return 2;
  return 1;
}

/** Repeat covers so a small library still fills the wall (never more than `count`). */
export function fillTo<T>(items: T[], count: number): T[] {
  if (items.length === 0) return [];
  return Array.from({ length: count }, (_, i) => items[i % items.length]);
}

export type Tier = "current" | "queue" | "artist" | "library";

/**
 * Which covers to show and how much to emphasise each: the playing album first and biggest, then the
 * albums in the play queue (in queue order), then other albums by the playing artist, then the rest of
 * the library. At most `max` albums; one per folder.
 */
export function rankCollage<T extends { source_uri: string; artist: string | null }>(
  library: T[],
  queue: T[],
  current: T | null,
  max: number,
  folderOf: (path: string) => string,
): { track: T; tier: Tier }[] {
  const ranked: { track: T; tier: Tier }[] = [];
  const used = new Set<string>();
  const add = (track: T, tier: Tier): void => {
    const folder = folderOf(track.source_uri);
    if (!used.has(folder) && ranked.length < max) {
      used.add(folder);
      ranked.push({ track, tier });
    }
  };
  if (current) add(current, "current");
  for (const track of queue) add(track, "queue");
  const artist = current?.artist?.toLocaleLowerCase();
  if (artist) {
    for (const track of library) {
      if (track.artist?.toLocaleLowerCase() === artist) add(track, "artist");
    }
  }
  const rest = pickCollage(library, library.length, folderOf);
  for (const track of rest) add(track, "library");
  return ranked;
}

/** Grid cells (square) for a tile: emphasised covers are bigger. */
export function tileSize(tier: Tier, index: number): 1 | 2 | 3 {
  if (tier === "current") return 3;
  if (tier === "queue" || tier === "artist") return 2;
  return index % 11 === 0 ? 2 : 1;
}

/** A small, stable hash of a string (FNV-1a), so each album always gets the same size. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Sizes of ordinary tiles, in cells per side: many small, some medium, a few large, very few huge. */
export function varietySize(hash: number): 1 | 2 | 3 | 4 {
  const roll = hash % 100;
  if (roll < 50) return 1;
  if (roll < 78) return 2;
  if (roll < 93) return 3;
  return 4;
}

export type WallTile<T> = { track: T; tier: Tier; size: number };

/**
 * Plans the cover wall like Zune's: the playing album is the biggest tile; queue and same-artist albums
 * are large or medium; the rest of the library varies from small to large by a stable hash. Emphasis
 * is carried by size first (brightness only helps). The plan covers `cells` grid cells (it repeats
 * covers of a small library at varied sizes), and large tiles are spread among small ones so they do
 * not clump in one corner.
 */
export function planWall<T extends { source_uri: string }>(ranked: { track: T; tier: Tier }[], cells: number, folderOf: (path: string) => string, maxTiles = 400): WallTile<T>[] {
  if (ranked.length === 0) return [];
  const tiles: WallTile<T>[] = [];
  let hugeLeft = 4; // the plan never has more than a handful of the very large library tiles
  const counters: Record<Tier, number> = { current: 0, queue: 0, artist: 0, library: 0 };
  const sizeFor = (tier: Tier, folder: string, salt: string): number => {
    const index = counters[tier]++;
    if (tier === "current") return 5;
    if (tier === "queue") return index === 0 ? 4 : index <= 3 ? 3 : 2;
    if (tier === "artist") return index <= 1 ? 3 : 2;
    const size = varietySize(hashText(folder + salt));
    if (size === 4) {
      if (hugeLeft === 0) return 3;
      hugeLeft -= 1;
    }
    return size;
  };
  for (const item of ranked) {
    tiles.push({ track: item.track, tier: item.tier, size: sizeFor(item.tier, folderOf(item.track.source_uri), "") });
  }
  // Fill what is left of the wall with varied library tiles, cycling through the covers.
  let area = tiles.reduce((sum, t) => sum + t.size * t.size, 0);
  const pool = ranked.filter((r) => r.tier !== "current").length > 0 ? ranked.filter((r) => r.tier !== "current") : ranked;
  for (let n = 0; area < cells * 1.1 && tiles.length < maxTiles; n += 1) {
    const base = pool[n % pool.length].track;
    const size = sizeFor("library", folderOf(base.source_uri), `#${n}`);
    tiles.push({ track: base, tier: "library", size });
    area += size * size;
  }
  // Spread the large tiles among the small ones.
  const large = tiles.filter((t) => t.size >= 3).sort((a, b) => b.size - a.size);
  const small = tiles.filter((t) => t.size < 3);
  const ordered: WallTile<T>[] = [];
  const gap = Math.max(3, Math.floor(small.length / Math.max(large.length, 1)));
  let s = 0;
  let l = 0;
  while (s < small.length || l < large.length) {
    if (l < large.length && (ordered.length % (gap + 1) === Math.min(2, gap) || s >= small.length)) ordered.push(large[l++]);
    else if (s < small.length) ordered.push(small[s++]);
  }
  return ordered;
}
