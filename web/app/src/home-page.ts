// The Home page: shelves of albums to get back to, inspired by Zune's Quickplay. "New in your library" (file dates) comes
// first, "Recently played" uses the listening history (which can be switched off in Settings), "Needs a look" points at
// flagged tracks, and "I'm feeling lucky" spins a jukebox of covers and starts an album. Clicking an album plays it.
// All text is set with textContent.

import { coverUrl } from "./cover-art";
import { loadDisplayPrefs, systemMotionHeldBack } from "./display-prefs";
import { folderOf } from "./cover-util";
import { invoke } from "./desktop-bridge";
import { openMenu, type MenuItem } from "./context-menu";
import { el } from "./dom";
import {
  type AlbumShelfItem,
  type HistoryEntry,
  type LibraryTrack,
  type RecentFile,
  albumsByFolder,
  luckySettle,
  luckySpin,
  pinnedAlbums,
  newAlbums,
  recentlyPlayedAlbums,
} from "./home-format";
import type { PinStore } from "./pins";
import type { PlaylistStore } from "./playlists";
import type { PlayableTrack } from "./play-queue";

export type HomeDeps = {
  libraryTracks: () => LibraryTrack[];
  /** False until the first read of the library has finished (then an empty list really means an empty library). */
  libraryReady?: () => boolean;
  flaggedCount: () => number;
  /** Paths of favorite songs (D44). */
  favorites: () => string[];
  play: (tracks: PlayableTrack[], index: number) => void;
  /** "Play next" or "Add to queue": adds to what is playing instead of replacing it. */
  enqueue: (tracks: PlayableTrack[], where: "next" | "end") => void;
  openArtist: (artist: string) => void;
  go: (page: "review" | "rip" | "library" | "settings") => void;
  pins: PinStore;
  playlists: PlaylistStore;
};

const SHELF_SIZE = 12;
/** How long a new Home page waits for its covers before it is shown without the ones still coming. */
const COVER_WAIT_MS = 250;
/** Covers that scroll past in one lucky spin (how long it takes and how it settles are chosen at random for each spin, `luckySettle`), and covers on show before the first spin. */
const SPIN_COVERS = 34;
const IDLE_COVERS = 31;
const IDLE_MESSAGE = "Click an album, or spin the jukebox to start one: an album you have not played lately if there is one.";

/** What the lucky jukebox shows: its covers, which one is in the middle, and what it last said. Kept between page rebuilds. */
type Reel = { strip: AlbumShelfItem[]; centre: number; message: string };

/** What one render builds: the page so far and the covers still loading. Each render has its own (see render()). */
type Build = { out: DocumentFragment; covers: Promise<unknown>[] };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function initHomePage(root: HTMLElement, deps: HomeDeps): { render: () => Promise<void> } {
  const shelves = root.querySelector<HTMLElement>("#home-shelves")!;
  // Home is built off screen and swapped in whole, with its covers ready, and only when something changed: it is
  // rebuilt after every song, favourite, flag and library change, and emptying it first made the page jolt
  // and the covers flash (owner, 2026-11-06).
  let shown = "";
  let rendering = 0;
  let reelState: Reel | null = null;
  let spinning = false;
  let rebuildAfterSpin = false;

  const toPlayable = (t: LibraryTrack): PlayableTrack => ({ title: t.title, artist: t.artist, source_uri: t.source_uri, album: t.album });

  /** Right-click on an album or song here: play it, or add it to what is playing (owner, 2026-11-06). */
  function queueMenu(target: HTMLElement, label: string, tracks: () => PlayableTrack[], extra: MenuItem[] = []): void {
    const show = (x: number, y: number): void =>
      openMenu(x, y, [
        { label: "Play", action: () => deps.play(tracks(), 0) },
        { label: "Play next", action: () => deps.enqueue(tracks(), "next") },
        { label: "Add to queue", action: () => deps.enqueue(tracks(), "end") },
        deps.playlists.menuItem(() => tracks().map((t) => t.source_uri)),
        ...extra,
      ], label);
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      show(event.clientX, event.clientY);
    });
    target.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const box = target.getBoundingClientRect();
        show(box.left + 20, box.bottom);
      }
    });
  }

  /** An album's cover over its first letter; the returned promise settles when the picture has been looked up. */
  function coverFor(item: AlbumShelfItem): { letter: HTMLElement; cover: HTMLImageElement; loaded: Promise<unknown> } {
    const cover = el("img", "home-cover");
    cover.alt = "";
    cover.hidden = true;
    // "Urgent": what is on the page the person is looking at is read ahead of the background wall's covers (a cover already asked for is not asked again).
    const loaded = coverUrl(item.tracks[0].source_uri, true).then((url) => {
      if (url) {
        cover.src = url;
        cover.hidden = false;
      }
    });
    return { letter: el("span", "home-cover-letter", item.album.slice(0, 1).toLocaleUpperCase()), cover, loaded };
  }

  function albumTile(ctx: Build, item: AlbumShelfItem, pinnedShelf = false): HTMLElement {
    const tile = el("div", "home-tile");
    const play = el("button", "home-tile-play");
    play.type = "button";
    play.setAttribute("aria-label", `Play ${item.album} by ${item.artist}`);
    const { letter, cover, loaded } = coverFor(item);
    ctx.covers.push(loaded);
    play.append(letter, cover);
    play.addEventListener("click", () => deps.play(item.tracks.map(toPlayable), 0));
    queueMenu(play, item.album, () => item.tracks.map(toPlayable), ["separator", { label: `Open ${item.artist}`, action: () => deps.openArtist(item.artist) }]);
    const open = el("button", "home-tile-open", item.artist);
    open.type = "button";
    open.addEventListener("click", () => deps.openArtist(item.artist));
    tile.append(play, el("strong", "home-tile-title", item.album), open);
    const pin = el("button", "home-tile-open", pinnedShelf ? "Unpin" : deps.pins.has(item.key) ? "★ Pinned" : "☆ Pin");
    pin.type = "button";
    pin.setAttribute("aria-label", `${pinnedShelf || deps.pins.has(item.key) ? "Unpin" : "Pin"} ${item.album}`);
    pin.addEventListener("click", () => void deps.pins.toggle(item.key, item.album, item.artist).catch(() => {}));
    tile.append(pin);
    return tile;
  }

  function shelf(ctx: Build, title: string, note: string | null, content: HTMLElement[]): void {
    const section = el("section", "home-shelf");
    section.append(el("h3", undefined, title));
    if (note) section.append(el("p", "field-hint", note));
    const row = el("div", "home-row");
    row.append(...content);
    section.append(row);
    ctx.out.append(section);
  }

  /** One disc of the jukebox: the album's cover, a button that plays the album like the tiles above and below it. */
  function luckyDisc(item: AlbumShelfItem): { disc: HTMLElement; loaded: Promise<unknown> } {
    const disc = el("button", "lucky-disc");
    disc.type = "button";
    disc.title = `${item.album} — ${item.artist}`;
    disc.setAttribute("aria-label", `Play ${item.album} by ${item.artist}`);
    const { letter, cover, loaded } = coverFor(item);
    disc.append(letter, cover);
    disc.addEventListener("click", () => {
      if (!spinning) deps.play(item.tracks.map(toPlayable), 0);
    });
    queueMenu(disc, item.album, () => item.tracks.map(toPlayable), ["separator", { label: `Open ${item.artist}`, action: () => deps.openArtist(item.artist) }]);
    return { disc, loaded };
  }

  /**
   * "I'm feeling lucky": a jukebox window with a box in the middle (in the accent colour). It is full of random albums from the
   * start, and every album in it can be clicked to play, like the tiles on the other shelves. Pressing the button scrolls a long
   * strip of covers past the box, overshooting the chosen album a little and wiggling back onto it like a slot machine, and then
   * plays it. Albums not played lately are preferred.
   * The reel keeps what it shows (reelState) so the page rebuilding itself, which it does after every song, never blanks or
   * changes it. Where it rests is worked out by the stylesheet from `--i`, the number of the disc in the middle, so the box and
   * that disc stay in the middle of the window at any window size.
   */
  function luckyShelf(ctx: Build, albums: AlbumShelfItem[], recentKeys: Set<string>): void {
    const byKey = new Map(albums.map((album) => [album.key, album]));
    if (!reelState || reelState.strip.some((album) => !byKey.has(album.key))) {
      const first = luckySpin(albums, recentKeys, IDLE_COVERS, Math.random)!;
      reelState = { strip: first.strip, centre: Math.floor(IDLE_COVERS / 2), message: IDLE_MESSAGE };
    } else {
      reelState.strip = reelState.strip.map((album) => byKey.get(album.key)!); // the library's current copy of each album
    }
    const state = reelState;

    const section = el("section", "home-shelf home-lucky");
    section.append(el("h3", undefined, "Feeling lucky?"));
    const windowBox = el("div", "lucky-window");
    const reel = el("div", "lucky-reel");
    const painted = state.strip.map(luckyDisc);
    reel.append(...painted.map((p) => p.disc));
    ctx.covers.push(...painted.map((p) => p.loaded));
    reel.style.setProperty("--i", String(state.centre));
    windowBox.append(reel, el("div", "lucky-frame"));
    const button = el("button", undefined, "I'm feeling lucky");
    button.type = "button";
    button.disabled = spinning;
    const status = el("p", "field-hint", spinning ? "Spinning…" : state.message);
    status.setAttribute("aria-live", "polite");
    const controls = el("div", "lucky-controls");
    controls.append(button, status);
    section.append(windowBox, controls);
    ctx.out.append(section);

    button.addEventListener("click", () => {
      if (spinning) return;
      const spun = luckySpin(albums, recentKeys, SPIN_COVERS, Math.random);
      if (!spun) return;
      const settle = luckySettle(Math.random);
      spinning = true;
      button.disabled = true;
      windowBox.classList.add("is-spinning");
      status.textContent = "Spinning…";
      void (async () => {
        try {
          reel.getAnimations().forEach((animation) => animation.cancel());
          // The new strip starts with the covers now on show, so the reel does not jump when it begins to move.
          const from = Math.max(0, state.centre - 5);
          const head = state.strip.slice(from, state.centre + 6);
          const start = state.centre - from;
          const strip = [...head, ...spun.strip];
          const winner = head.length + spun.winner;
          const next = strip.map(luckyDisc);
          await Promise.race([Promise.all(next.map((n) => n.loaded)), pause(1500)]); // covers ready, or not worth waiting for
          reel.replaceChildren(...next.map((n) => n.disc));
          reel.style.setProperty("--i", String(start));
          // Where the middle of disc `index` is, measured from the middle of the window; `nudge` is a fraction of a disc.
          const at = (index: number, nudge = 0): string => `translateX(calc(-1 * (${index} * (var(--tile) + var(--gap)) + var(--tile) / 2) + ${nudge} * var(--tile)))`;
          // Windows' reduce-motion setting stops the spin, unless Settings > Display says to ignore it (a virtual machine reports it on).
          if (!systemMotionHeldBack(loadDisplayPrefs())) {
            // It runs past the album (or stops short of it), then comes to rest in a way chosen for this spin: a wiggle, a creep, a bounce or a quick snap.
            const run = reel.animate([{ transform: at(start) }, { transform: at(winner, settle.over) }], { duration: settle.spinMs, easing: settle.spinEasing, fill: "forwards" });
            await run.finished;
            const swing = reel.animate(
              [{ transform: at(winner, settle.over), easing: settle.swingEasing }, ...settle.swings.map((nudge) => ({ transform: at(winner, nudge), easing: settle.swingEasing })), { transform: at(winner, 0) }],
              { duration: settle.settleMs, fill: "forwards" },
            );
            await swing.finished;
          }
          reel.style.setProperty("--i", String(winner));
          reel.getAnimations().forEach((animation) => animation.cancel());
          const album = strip[winner];
          state.strip = strip;
          state.centre = winner;
          state.message = `${album.album} — ${album.artist}`;
          status.textContent = state.message;
          await pause(900);
          deps.play(album.tracks.map(toPlayable), 0);
          state.message = `Playing ${album.album} — ${album.artist}`;
          status.textContent = state.message;
        } catch {
          status.textContent = "The jukebox jammed. Try again.";
        } finally {
          spinning = false;
          button.disabled = false;
          windowBox.classList.remove("is-spinning");
          if (rebuildAfterSpin) {
            rebuildAfterSpin = false;
            void render();
          }
        }
      })();
    });
  }

  async function render(): Promise<void> {
    // Not while the jukebox spins: swapping the page would replace the reel that is moving with a still copy. It is rebuilt
    // as soon as the spin ends.
    if (spinning) {
      rebuildAfterSpin = true;
      return;
    }
    const ticket = ++rendering;
    // Each render builds into its own fragment. They were one shared variable, so when a second render started while the
    // first was still waiting for the history, both added their shelves to the newer page and every shelf showed twice
    // (found 2026-11-16).
    const ctx: Build = { out: document.createDocumentFragment(), covers: [] };
    await build(ctx);
    // Covers are waited for only briefly, so the shelves do not appear only when the last picture has come over the network share (owner, 2026-11-24: Home
    // took seconds). Every tile already has its letter and its size, and a cover replaces the letter when it arrives, so nothing moves. Covers already known come at once.
    await Promise.race([Promise.all(ctx.covers), pause(COVER_WAIT_MS)]);
    if (ticket !== rendering) return; // a newer render has started
    if (spinning) {
      rebuildAfterSpin = true; // a spin began while this was being built
      return;
    }
    const urls = [...ctx.out.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "").join("|");
    const signature = `${ctx.out.textContent}#${urls}#${deps.favorites().join("|")}#${deps.libraryTracks().length}`;
    if (signature === shown && shelves.childElementCount > 0) return; // nothing changed: leave the page alone
    shown = signature;
    shelves.replaceChildren(ctx.out);
  }

  async function build(ctx: Build): Promise<void> {
    const out = ctx.out;
    const tracks = deps.libraryTracks();
    if (tracks.length === 0) {
      // Until the library has been read, an empty list means "not loaded yet", not "no music".
      if (deps.libraryReady && !deps.libraryReady()) return;
      out.append(el("p", "empty-note", "Your library is empty. Choose a music folder on the Library page, or rip a CD."));
      return;
    }
    const albums = albumsByFolder(tracks, folderOf);

    const [recent, history] = await Promise.all([
      // Both are quick; "urgent" lets them past the Settings pages' start-up questions queued in the sidecar's ordinary lane (D192).
      invoke<{ files: RecentFile[] }>("recent_files", { limit: 120, urgent: true }).catch(() => ({ files: [] as RecentFile[] })),
      invoke<{ enabled: boolean; entries: HistoryEntry[] }>("list_history", { urgent: true }).catch(() => ({ enabled: false, entries: [] as HistoryEntry[] })),
    ]);

    // Order (owner, 2026-11-16): what is new first, then pins, the lucky jukebox in the middle, favorites, what needs a look,
    // and last what was played recently.
    const fresh = newAlbums(recent.files, albums, folderOf, SHELF_SIZE);
    if (fresh.length > 0) shelf(ctx, "New in your library", "Newest files first.", fresh.map((item) => albumTile(ctx, item)));

    const pinned = pinnedAlbums(deps.pins.all(), albums);
    if (pinned.length > 0) shelf(ctx, "Pins", "Albums you pinned.", pinned.map((item) => albumTile(ctx, item, true)));

    const lastPlayed = history.enabled ? recentlyPlayedAlbums(history.entries, albums, folderOf, 60) : [];
    luckyShelf(ctx, [...albums.values()], new Set(lastPlayed.map((item) => item.key)));

    // Favorites: play them all, or shuffled (the first playlist; user playlists may follow).
    const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
    const favorites = deps.favorites().flatMap((path) => (byPath.has(path) ? [byPath.get(path)!] : []));
    if (favorites.length > 0) {
      const play = el("button", undefined, "▶ Play favorites");
      play.type = "button";
      play.addEventListener("click", () => deps.play(favorites.map(toPlayable), 0));
      const shuffle = el("button", "secondary", "Shuffle");
      shuffle.type = "button";
      shuffle.addEventListener("click", () => {
        const mixed = [...favorites].sort(() => Math.random() - 0.5);
        deps.play(mixed.map(toPlayable), 0);
      });
      // Play next / Add to queue on right-click (owner, 2026-11-06: no extra buttons on the PC).
      queueMenu(play, "Favorites", () => favorites.map(toPlayable));
      const box = el("div", "home-favorites");
      box.append(el("span", undefined, `♥ ${favorites.length} favorite song${favorites.length === 1 ? "" : "s"}`), play, shuffle);
      const section = el("section", "home-shelf");
      section.append(el("h3", undefined, "Favorites"), box);
      out.append(section);
    }

    const flagged = deps.flaggedCount();
    if (flagged > 0) {
      const link = el("button", "secondary", `${flagged} track${flagged === 1 ? "" : "s"} flagged for review: open the list`);
      link.type = "button";
      link.addEventListener("click", () => deps.go("review"));
      const box = el("div", "home-attention");
      box.append(link);
      out.append(box);
    }

    if (history.enabled) {
      const played = lastPlayed.slice(0, SHELF_SIZE);
      if (played.length > 0) shelf(ctx, "Recently played", null, played.map((item) => albumTile(ctx, item)));
      else out.append(el("p", "field-hint", "Listening history is on: albums you play will appear here. You can turn it off in Settings."));
    } else {
      const note = el("p", "field-hint", "Listening history is off, so there is no Recently played shelf. ");
      const link = el("button", "secondary", "Open Settings");
      link.type = "button";
      link.addEventListener("click", () => deps.go("settings"));
      note.append(link);
      out.append(note);
    }
  }

  return { render };
}
