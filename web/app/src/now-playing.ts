// The Now Playing view: a tinted collage of the covers in your library behind the current track and
// the queue. The collage is decoration only; the track, artist and queue are real text. All text is
// set with textContent.

import type { Rgb } from "../tv/visuals.ts";
import { coverAccent } from "./accent";
import { planWall, rankCollage } from "./collage";
import { coverUrl } from "./cover-art";
import { folderOf } from "./cover-util";
import { invoke } from "./desktop-bridge";
import { openMenu, type MenuItem } from "./context-menu";
import type { PlaylistStore } from "./playlists";
import { el } from "./dom";
import { makeFlipTile, startTurning } from "./cover-flip";
import { serverLibrary } from "./library-mode";
import { NO_LYRICS, NO_LYRICS_SERVER, type TrackLyrics, currentLine, plainLines, sortedLines, sourceLabel } from "./lyrics-format";
import type { PlayableTrack } from "./play-queue";
import type { Player } from "./player";

const TILES = 90;
/** One grid cell, in pixels (matches `.np-wall` in the stylesheet). */
const CELL = 80;

export function initNowPlaying(
  root: HTMLElement,
  player: Player,
  libraryTracks: () => PlayableTrack[],
  findLyrics: (track: PlayableTrack) => void,
  /** The playing cover's highlight colour, or null for the default (D72). Called while Now Playing shows. */
  onCoverColour: (colour: Rgb | null) => void = () => {},
  /** Playlists (D74): add a queued song to one, or save the whole queue as one. */
  playlists: PlaylistStore | null = null,
): { open: () => void; reloadLyrics: () => void } {
  const wall = root.querySelector<HTMLElement>("#np-wall")!;
  const cover = root.querySelector<HTMLImageElement>("#np-cover")!;
  const artist = root.querySelector<HTMLElement>("#np-artist")!;
  const album = root.querySelector<HTMLElement>("#np-album")!;
  const title = root.querySelector<HTMLElement>("#np-title")!;
  const queueList = root.querySelector<HTMLOListElement>("#np-queue")!;
  const back = root.querySelector<HTMLButtonElement>("#np-back")!;
  const tabQueue = root.querySelector<HTMLButtonElement>("#np-tab-queue")!;
  const tabLyrics = root.querySelector<HTMLButtonElement>("#np-tab-lyrics")!;
  const lyricsBox = root.querySelector<HTMLElement>("#np-lyrics")!;
  const lyricsNote = root.querySelector<HTMLElement>("#np-lyrics-note")!;
  const lyricsView = root.querySelector<HTMLElement>("#np-lyrics-view")!;
  const lyricsLines = root.querySelector<HTMLElement>("#np-lyrics-lines")!;
  // Which tab the person last chose by hand: with lyrics showing, Now Playing takes the TV's layout (a small cover and the
  // details at the top, the lyrics across the width below); a song with no lyrics keeps the queue layout.
  const TAB_KEY = "mediaverse.np-tab";
  const chosenTab = (): string | null => {
    try {
      return localStorage.getItem(TAB_KEY);
    } catch {
      return null;
    }
  };
  let hasLyrics = false;
  let builtFor = "";
  let shownLyricsFor = "";
  let lines: { ms: number; text: string }[] = [];
  let highlighted = -1;
  // The progress bar, buttons and highlights take the playing cover's colour (owner, 2026-11-06), as on the TV.
  let coverColour: Rgb | null = null;
  cover.addEventListener("load", () => {
    coverColour = coverAccent(cover);
    if (!root.hidden) onCoverColour(coverColour);
  });
  cover.addEventListener("error", () => {
    coverColour = null;
    if (!root.hidden) onCoverColour(null);
  });

  function showTab(which: "queue" | "lyrics"): void {
    const lyrics = which === "lyrics";
    queueList.hidden = lyrics;
    lyricsBox.hidden = !lyrics;
    tabQueue.classList.toggle("is-active", !lyrics);
    tabLyrics.classList.toggle("is-active", lyrics);
    tabQueue.setAttribute("aria-selected", String(!lyrics));
    tabLyrics.setAttribute("aria-selected", String(lyrics));
    root.classList.toggle("lyrics-mode", lyrics);
    if (lyrics) place(Math.max(0, highlighted), false); // before the first line is sung, the first line waits in the middle
  }
  const choose = (which: "queue" | "lyrics"): void => {
    try {
      localStorage.setItem(TAB_KEY, which);
    } catch {
      // not remembered
    }
    showTab(which);
  };
  tabQueue.addEventListener("click", () => choose("queue"));
  tabLyrics.addEventListener("click", () => choose("lyrics"));
  /** The layout for this song: lyrics when it has some (unless the person chose the queue), otherwise the queue. */
  function applyMode(): void {
    const chosen = chosenTab();
    showTab(chosen === "lyrics" || (hasLyrics && chosen !== "queue") ? "lyrics" : "queue");
  }

  /** Loads and shows the lyrics of the current track (once per track). */
  async function loadLyrics(track: PlayableTrack | undefined): Promise<void> {
    const key = track?.source_uri ?? "";
    if (key === shownLyricsFor) return;
    shownLyricsFor = key;
    lines = [];
    highlighted = -1;
    hasLyrics = false;
    lyricsLines.replaceChildren();
    lyricsLines.style.transform = "";
    lyricsView.scrollTop = 0;
    lyricsNote.textContent = track ? "Looking for lyrics…" : "";
    if (!track) return;
    let found: TrackLyrics | null = null;
    try {
      found = await invoke<TrackLyrics>("track_lyrics", { path: track.source_uri });
    } catch {
      found = null;
    }
    if (shownLyricsFor !== key) return; // the song changed while this was loading
    if (!found || (!found.plain && found.lines.length === 0)) {
      lyricsNote.textContent = serverLibrary() ? NO_LYRICS_SERVER : NO_LYRICS;
      lyricsView.classList.add("is-plain");
      if (track && /\.mp3$/i.test(track.source_uri)) {
        const find = el("button", "secondary", "Find lyrics online…");
        find.type = "button";
        find.addEventListener("click", () => findLyrics(track));
        lyricsLines.append(find);
      }
      applyMode();
      return;
    }
    hasLyrics = true;
    lyricsNote.textContent = `${sourceLabel(found.source)}${found.synced ? " (time-stamped: follows the song)" : " (plain: no timing)"}`;
    // Time-stamped lyrics are moved by a transform so the current line sits in the middle (as on the TV); plain lyrics have
    // no timing to follow, so they are an ordinary list that the person scrolls.
    lyricsView.classList.toggle("is-plain", !(found.synced && found.lines.length > 0));
    if (found.synced && found.lines.length > 0) {
      lines = sortedLines(found.lines);
      lines.forEach((line, index) => {
        const row = el("p", "np-lyric-line", line.text === "" ? "♪" : line.text);
        row.dataset.index = String(index);
        row.addEventListener("click", () => player.seek(line.ms / 1000));
        lyricsLines.append(row);
      });
    } else {
      for (const text of plainLines(found.plain ?? "")) lyricsLines.append(el("p", "np-lyric-plain", text === "" ? "\u00a0" : text));
    }
    applyMode();
  }

  /**
   * Puts line `index` in the middle of the lyrics box by moving the whole list (a transform), and fades the lines that are
   * only partly inside the box. Nothing is scrolled: `scrollIntoView` scrolled every ancestor of the line as well, including
   * Now Playing itself, so the page slid up out of reach as a song went on (2026-11-17).
   */
  function place(index: number, animate = true): void {
    const rows = lyricsLines.children;
    const row = rows[index] as HTMLElement | undefined;
    const height = lyricsView.clientHeight;
    if (!row || height === 0 || lyricsView.classList.contains("is-plain")) return;
    lyricsLines.style.transition = animate ? "" : "none";
    // The line goes to the middle of the box wherever it is in the list: the first lines start in the middle too (the list is
    // moved down to put them there) and the last lines end there, as on the TV.
    const offset = Math.round(height / 2 - (row.offsetTop + row.offsetHeight / 2));
    lyricsLines.style.transform = `translateY(${offset}px)`;
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i] as HTMLElement;
      const top = line.offsetTop + offset;
      line.classList.toggle("np-out", top < -2 || top + line.offsetHeight > height + 2);
    }
    if (!animate) void lyricsLines.offsetWidth; // apply the jump before the transition comes back
  }
  window.addEventListener("resize", () => {
    if (!root.hidden) place(highlighted, false);
  });

  /** Highlights the line being sung and keeps it in the middle. */
  function follow(ms: number): void {
    if (lines.length === 0 || root.hidden) return;
    const index = currentLine(lines, ms);
    if (index === highlighted) return;
    lyricsLines.children[highlighted]?.classList.remove("np-lyric-now");
    const first = highlighted < 0;
    highlighted = index;
    if (index < 0) {
      place(0); // sought back to before the first line: it waits in the middle again
      return;
    }
    const row = lyricsLines.children[index];
    if (row) {
      row.classList.add("np-lyric-now");
      place(index, !first);
    }
  }
  player.onTime(follow);

  /** The wall emphasises what is playing: its album, the queue's albums, the artist's other albums. */
  async function buildWall(): Promise<void> {
    const library = libraryTracks();
    const view = player.view();
    const current = view.tracks[view.current] ?? null;
    const signature = [library.length, current ? folderOf(current.source_uri) : "", view.tracks.map((t) => folderOf(t.source_uri)).join("|")].join("#");
    if (builtFor === signature) return;
    builtFor = signature;
    // Only albums that have a cover can be shown; the wall is planned from those.
    const ranked = rankCollage(library, view.tracks, current, TILES, folderOf);
    const withCovers = (await Promise.all(ranked.map(async (item) => ({ item, url: await coverUrl(item.track.source_uri) })))).filter((c) => c.url !== null);
    const urlOf = new Map(withCovers.map((c) => [c.item.track.source_uri, c.url as string]));
    // The grid cells the wall must cover (cells are CELL pixels plus a small gap), with some to spare.
    const bounds = root.getBoundingClientRect();
    const cells = Math.ceil(bounds.width / (CELL + 3)) * Math.ceil(bounds.height / (CELL + 3));
    const plan = planWall(withCovers.map((c) => c.item), cells, folderOf);
    wall.replaceChildren();
    for (const planned of plan) {
      const tile = makeFlipTile(urlOf.get(planned.track.source_uri)!, `np-tile np-tile-${planned.tier}`);
      tile.style.gridColumn = `span ${planned.size}`;
      tile.style.gridRow = `span ${planned.size}`;
      wall.append(tile);
    }
    // The rest of the library is what the turning tiles show (D46).
    libraryCovers = withCovers.filter((c) => c.item.tier === "library").map((c) => c.url as string);
  }

  // Every 5 to 10 seconds one library tile slowly turns over to another album, as on the TV (D46). The playing
  // album, the queue and the artist's other albums stay where they are.
  let libraryCovers: string[] = [];
  startTurning(
    () => [...wall.querySelectorAll<HTMLElement>(".np-tile-library")],
    () => libraryCovers,
    () => !root.hidden && !document.hidden,
  );

  function renderQueue(): void {
    const view = player.view();
    queueList.replaceChildren();
    view.tracks.forEach((track, place) => {
      const item = el("li", place === view.current ? "np-current" : undefined);
      const button = el("button", "np-queue-item");
      button.type = "button";
      button.append(el("span", "np-queue-title", track.title), el("span", "np-queue-artist", track.artist ?? "Unknown artist"));
      button.addEventListener("click", () => player.jump(place));
      // Right-click: play it now, or take it out of the queue (not the song playing).
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          { label: "Play", action: () => player.jump(place) },
          { label: "Remove from queue", action: () => player.remove(place), disabled: place === view.current },
          ...(playlists ? (["separator", playlists.menuItem(() => [track.source_uri]), { label: "Save the queue as a playlist…", action: () => void playlists.createWith(player.view().tracks.map((t) => t.source_uri)) }] as MenuItem[]) : []),
        ], track.title);
      });
      if (place !== view.current) {
        const remove = el("button", "np-queue-remove", "×");
        remove.type = "button";
        remove.title = "Remove from queue";
        remove.setAttribute("aria-label", `Remove ${track.title} from the queue`);
        remove.addEventListener("click", () => player.remove(place));
        item.append(button, remove);
      } else {
        item.append(button);
      }
      queueList.append(item);
    });
    // Scroll the list itself (scrollIntoView would move every ancestor too).
    const current = queueList.querySelector<HTMLElement>(".np-current");
    if (current && queueList.clientHeight > 0) {
      const at = current.getBoundingClientRect();
      const box = queueList.getBoundingClientRect();
      queueList.scrollTop += at.top - box.top - box.height / 2 + at.height / 2;
    }
  }

  function renderCurrent(): void {
    const view = player.view();
    const track = view.tracks[view.current];
    if (!track) return;
    artist.textContent = (track.artist ?? "Unknown artist").toLocaleUpperCase();
    album.textContent = track.album ?? "";
    title.textContent = track.title;
    void coverUrl(track.source_uri).then((url) => {
      if (player.view().tracks[player.view().current] !== track) return;
      if (!url) {
        cover.hidden = true;
        cover.removeAttribute("src");
        coverColour = null;
        onCoverColour(null);
      } else if (cover.src === url && cover.complete) {
        cover.hidden = false; // same album: the colour is already known
        onCoverColour(coverColour);
      } else {
        cover.hidden = true;
        cover.src = url; // the load event reads its colour
        cover.addEventListener("load", () => (cover.hidden = false), { once: true });
      }
    });
    renderQueue();
    void buildWall();
    void loadLyrics(track);
  }

  player.onChange(() => {
    if (!root.hidden) renderCurrent();
  });
  back.addEventListener("click", () => (root.hidden = true));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") root.hidden = true;
  });

  return {
    reloadLyrics() {
      shownLyricsFor = "";
      const view = player.view();
      void loadLyrics(view.tracks[view.current]);
    },
    open() {
      root.hidden = false;
      root.scrollTop = 0;
      root.scrollLeft = 0;
      renderCurrent();
      void buildWall();
      back.focus();
    },
  };
}
