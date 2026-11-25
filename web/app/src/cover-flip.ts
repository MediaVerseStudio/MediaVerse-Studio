// The turning cover wall, the same in every MediaVerse Studio app (D46): every 5 seconds one tile slowly
// turns over to show a different album. Tiles are chosen in a shuffled order, so the choice looks random but
// every tile turns before any turns twice; the new album is one not on the wall at the moment where possible,
// again cycling through all albums. Used by the desktop Now Playing wall and the TV's Now Playing wall.

/** Every index from 0 to count - 1 once, in a random order, then again in a new order. */
export function createCycle(count: number, random: () => number = Math.random): { next(): number } {
  let order: number[] = [];
  let last = -1;
  return {
    next() {
      if (count <= 0) return -1;
      if (!order.length) {
        order = Array.from({ length: count }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        // Not the same tile twice in a row across two rounds.
        if (count > 1 && order[order.length - 1] === last) [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
      }
      last = order.pop()!;
      return last;
    },
  };
}

/** How long until the next tile turns: 5 seconds (owner's choice, D46). `random` is kept for callers. */
export function flipDelay(_random: () => number = Math.random): number {
  return 5_000;
}

/** Tile sizes in grid cells per side for a wall of `cells` cells: many small, some medium, a few large. */
export function wallSizes(cells: number, random: () => number = Math.random, maxSize = 3): number[] {
  const sizes: number[] = [];
  let area = 0;
  let large = 0;
  while (area < cells * 1.15 && sizes.length < 500) {
    const roll = random();
    let size = roll < 0.55 ? 1 : roll < 0.85 ? 2 : 3;
    if (size > maxSize) size = maxSize;
    if (size === 3 && large >= Math.max(2, Math.floor(cells / 40))) size = 2; // a handful of large tiles at most
    if (size === 3) large += 1;
    sizes.push(size);
    area += size * size;
  }
  return sizes;
}

/**
 * A tile that can turn over: a card with a front and a back picture (styled by `.flip-*` in each app).
 * At rest a tile is flat, showing only its front: the 3D set-up (perspective, the back face) is switched on
 * with `.is-moving` only while it turns. A wall of 150 tiles each kept in 3D cost the TV a graphics layer
 * per picture on every frame the visualizer drew.
 */
/** `later`: the picture is not loaded yet (kept in data-src); the caller loads it when the time is right. */
export function makeFlipTile(src: string, className = "", later = false): HTMLElement {
  const tile = document.createElement("div");
  tile.className = `flip-tile ${className}`.trim();
  tile.dataset.cover = src;
  const card = document.createElement("div");
  card.className = "flip-card";
  const front = document.createElement("img");
  front.className = "flip-face";
  const back = document.createElement("img");
  back.className = "flip-face flip-back";
  for (const image of [front, back]) {
    image.alt = "";
    image.decoding = "async";
  }
  if (later) front.dataset.src = src;
  else front.src = src;
  card.append(front, back);
  tile.append(card);
  return tile;
}

/** The picture a tile shows now (or is turning to). */
export function shownCover(tile: HTMLElement): string {
  return tile.dataset.cover ?? tile.querySelector<HTMLImageElement>(".flip-face:not(.flip-back)")?.getAttribute("src") ?? "";
}

/** How long a turn takes; matches the `.flip-card` transition in each app's styles. */
const TURN_MS = 2_400;

/**
 * Loads `src` on the back, turns the tile over to it, then quietly puts it on the front and lays the tile flat
 * again, so the tile is in 3D only for the length of the turn.
 */
export function turnTile(tile: HTMLElement, src: string): void {
  const card = tile.querySelector<HTMLElement>(".flip-card");
  const front = tile.querySelector<HTMLImageElement>(".flip-face:not(.flip-back)");
  const back = tile.querySelector<HTMLImageElement>(".flip-back");
  if (!card || !front || !back || tile.classList.contains("is-moving")) return;
  tile.dataset.cover = src;
  back.onload = () => {
    back.onload = null;
    tile.classList.add("is-moving");
    // Turned on the next frames, so the browser has the flat card's position to start the turn from.
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("is-turned")));
    window.setTimeout(() => {
      front.src = src;
      const settle = (): void => {
        card.style.transition = "none";
        card.classList.remove("is-turned");
        tile.classList.remove("is-moving");
        void card.offsetWidth; // apply the jump back without a turn before the transition returns
        card.style.transition = "";
      };
      // The front shows the new picture before the tile lays flat (decode first, so nothing flashes).
      front.decode().then(settle, settle);
    }, TURN_MS + 150);
  };
  back.src = src;
}

/**
 * Turns one tile every 5 seconds while `active()` says the wall is on screen. `tiles()` lists the tiles
 * (the wall may be rebuilt); `covers()` lists every cover address there is to show. Returns a stop function.
 */
export function startTurning(tiles: () => HTMLElement[], covers: () => string[], active: () => boolean, random: () => number = Math.random): () => void {
  let tileCycle = createCycle(0, random);
  let tileCount = -1;
  let coverCycle = createCycle(0, random);
  let coverCount = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = (): void => {
    timer = setTimeout(step, flipDelay(random));
    if (!active()) return;
    const all = tiles();
    const pool = covers();
    if (!all.length || pool.length < 2) return;
    if (all.length !== tileCount) {
      tileCount = all.length;
      tileCycle = createCycle(tileCount, random);
    }
    if (pool.length !== coverCount) {
      coverCount = pool.length;
      coverCycle = createCycle(coverCount, random);
    }
    const tile = all[tileCycle.next()];
    const showing = new Set(all.map(shownCover));
    // The next album in the cycle that is not on the wall (or any but this tile's own, on a small library).
    let pick = "";
    for (let tries = 0; tries < pool.length; tries++) {
      const candidate = pool[coverCycle.next()];
      if (!showing.has(candidate)) {
        pick = candidate;
        break;
      }
      if (!pick && candidate !== shownCover(tile)) pick = candidate;
    }
    if (pick) turnTile(tile, pick);
  };
  timer = setTimeout(step, flipDelay(random));
  return () => clearTimeout(timer);
}
