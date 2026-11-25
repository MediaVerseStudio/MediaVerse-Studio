// The tinted wall of the library's own album covers behind every main page (decision D32), in the Zune
// style: covers of mixed sizes, shown in grey and coloured by one slowly drifting tint (the "northern
// lights" layer in the stylesheet), with a cover now and then flipping over to show a different one.
// Decoration only: aria-hidden, never carries information, and still when the person asks for reduced
// motion. The wall also changes slowly on its own (flips, and a fresh layout every so often), so no cover
// sits in one place for hours on an OLED screen.

import { planWall, rankCollage } from "./collage";
import { coverUrl, onCoversForgotten } from "./cover-art";
import { folderOf } from "./cover-util";
import { el } from "./dom";
import { flipChoice, type Cover } from "./backdrop-plan";

type Track = { title: string; artist: string | null; album?: string | null; source_uri: string };

/** One grid cell in pixels (matches `.backdrop-wall` in the stylesheet). */
const CELL = 96;
const GAP = 2;
/** Albums asked for a cover. More only cost start-up time; flips draw from these. */
const MAX_ALBUMS = 160;
const FLIP_EVERY_MS = [5_000, 11_000] as const;
const RELAYOUT_EVERY_MS = 20 * 60_000;

export function initBackdrop(
  root: HTMLElement,
  libraryTracks: () => Track[],
  /** Gaps between flips for the current motion level, or null for no flips (see display-prefs.ts). */
  flips: () => readonly [number, number] | null = () => FLIP_EVERY_MS,
): { refresh: () => void; setPaused: (paused: boolean) => void } {
  const wall = root.querySelector<HTMLElement>(".backdrop-wall")!;
  let covers: Cover[] = [];
  let builtFor = "";
  let round = 0; // changes the layout each time it is rebuilt on a timer
  let flipTimer: number | undefined;
  let paused = false;
  let building: Promise<void> | null = null;

  async function loadCovers(tracks: Track[]): Promise<Cover[]> {
    const ranked = rankCollage(tracks, [], null, MAX_ALBUMS, folderOf);
    const found: Cover[] = [];
    // A few at a time, so a large library does not queue a hundred requests at once.
    for (let i = 0; i < ranked.length; i += 8) {
      const slice = ranked.slice(i, i + 8);
      const urls = await Promise.all(slice.map((item) => coverUrl(item.track.source_uri)));
      slice.forEach((item, n) => {
        const url = urls[n];
        if (url) found.push({ folder: folderOf(item.track.source_uri), url, track: item.track });
      });
    }
    return found;
  }

  function layout(): void {
    wall.replaceChildren();
    if (covers.length === 0) return;
    const width = Math.max(window.innerWidth, 800);
    const height = Math.max(window.innerHeight, 600);
    const cells = Math.ceil(width / (CELL + GAP)) * Math.ceil(height / (CELL + GAP));
    // Rotate the starting album each round so the big tiles land on different covers over an evening.
    const start = (round * 7) % covers.length;
    const ordered = [...covers.slice(start), ...covers.slice(0, start)];
    const plan = planWall(
      ordered.map((c) => ({ track: c.track, tier: "library" as const })),
      cells,
      (path) => `${folderOf(path)}#${round}`,
    );
    const urlOf = new Map(covers.map((c) => [c.folder, c.url]));
    for (const tile of plan) {
      const url = urlOf.get(folderOf(tile.track.source_uri));
      if (!url) continue;
      const img = el("img", "backdrop-tile");
      img.src = url;
      img.alt = "";
      img.decoding = "async";
      img.dataset.folder = folderOf(tile.track.source_uri);
      img.style.gridColumn = `span ${tile.size}`;
      img.style.gridRow = `span ${tile.size}`;
      wall.append(img);
    }
  }

  function flipOne(): void {
    if (paused || flips() === null || document.hidden) return;
    const tiles = [...wall.querySelectorAll<HTMLImageElement>(".backdrop-tile")];
    const choice = flipChoice(tiles.map((t) => t.dataset.folder ?? ""), covers, Math.random);
    if (!choice) return;
    const tile = tiles[choice.tile];
    tile.classList.add("is-flipping");
    window.setTimeout(() => {
      tile.src = choice.cover.url;
      tile.dataset.folder = choice.cover.folder;
      tile.classList.remove("is-flipping");
    }, 450); // half of the flip in the stylesheet: the cover changes while the tile is edge-on
  }

  function scheduleFlip(): void {
    window.clearTimeout(flipTimer);
    const [low, high] = flips() ?? FLIP_EVERY_MS; // when flips are off, keep checking at the usual pace
    flipTimer = window.setTimeout(() => {
      flipOne();
      scheduleFlip();
    }, low + Math.random() * (high - low));
  }

  async function build(): Promise<void> {
    const tracks = libraryTracks();
    const signature = `${tracks.length}:${tracks[0]?.source_uri ?? ""}:${tracks.at(-1)?.source_uri ?? ""}`;
    if (signature === builtFor) return;
    builtFor = signature;
    covers = await loadCovers(tracks);
    layout();
  }

  // Forgotten covers have revoked URLs: drop the wall now (no broken pictures) and load the covers again.
  let reloadTimer: number | undefined;
  onCoversForgotten(() => {
    covers = [];
    builtFor = "";
    wall.replaceChildren();
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      building ??= build().finally(() => {
        building = null;
      });
    }, 500);
  });

  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 300);
  });
  // The new layout fades in rather than replacing the wall at once, which showed as a flash (owner, 2026-11-06).
  window.setInterval(() => {
    if (paused || document.hidden) return;
    round += 1;
    wall.classList.add("is-fading");
    window.setTimeout(() => {
      layout();
      wall.classList.remove("is-fading");
    }, 1600);
  }, RELAYOUT_EVERY_MS);
  scheduleFlip();

  return {
    refresh: () => {
      building ??= build().finally(() => {
        building = null;
      });
    },
    /** Now Playing has its own wall; the page backdrop rests while it is open. */
    setPaused: (value) => {
      paused = value;
      root.classList.toggle("is-paused", value);
    },
  };
}
