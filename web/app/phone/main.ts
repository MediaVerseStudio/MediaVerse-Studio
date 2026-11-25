// MediaVerse Studio on the phone: the TV app's library and look, laid out for a phone held upright and moved by
// touch. The music is the phone's own (Android's media index); playing is done by the Android app's player
// (apps/android), so the music goes on with the screen off and in the car. See docs/android-app.md.

import { buildAlbums, buildArtists, buildGenres, buildGuestArtists, clock, searchLibrary, type Album, type Artist, type Genre } from "../tv/library.ts";
import { analyseSong, BANDS, frameAt, type Spectrum } from "../tv/spectrum.ts";
import { analyseInBackground } from "../tv/spectrum-thread.ts";
import { DEFAULT_PALETTE, drawStyle, mixPalette, paletteFromPixels, VIS_FRAME_MS, type Palette } from "../tv/visuals.ts";
import { ACCENT_CHOICES, applyAccent, loadAccent, paletteFromHex, saveAccent } from "../tv/accent-choices.ts";

/** The highlight colour chosen in Settings (D75, one of 20, kept on this phone), as on the PC and the TV. */
const ACCENT_STORE = "mediaverse.phone.accent";
let chosenAccent = loadAccent(ACCENT_STORE);
let chosenPalette: Palette = paletteFromHex(chosenAccent);
applyAccent(document.documentElement, chosenAccent);
import { icon, type IconName } from "../src/icons.ts";
import { el } from "../src/dom.ts";
import { addSongs, changeAt, freeName, loadPlaylists, resolvePlaylist, savePlaylists, type PhonePlaylist } from "./phone-playlists.ts";
import { connect, type EqState, type FromApp, type PhoneTrack, type PlayerState, type PlayStats, type ShareStatus, type Tv, type TvCommand } from "./native.ts";
import { addBookmark, dropQueue, freeQueueName, putQueue, removeBookmark, type Bookmark, type SavedQueue } from "./keep-places.ts";
import { decibels, EQ_PRESETS, hertz, presetLevels } from "./eq-presets.ts";
import { countdown, SMART_LISTS, smartList, type SmartId } from "./smart-lists.ts";
import { addFlag, isFlagged, removeFlag, songKey, type Flag } from "./flags.ts";
import { Jellyfin, JellyfinProblem, savedSession, saveSession, type Http, type HttpReply, type Session } from "./jellyfin-phone.ts";
import { syncFlags, type SyncReport } from "./flag-sync.ts";
import { createHomeSync, type PickLevel } from "./home-sync-ui.ts";
import { currentLine, plainLines, sortedLines, type TrackLyrics } from "../src/lyrics-format.ts";
import { count, LETTERS, letterStarts, playWindow, positionNow, queueInPlayOrder, rowForLetter, songsAndLength, visibleRange } from "./phone-logic.ts";

type Tab = "artists" | "genres" | "albums" | "songs" | "favorites" | "playlists" | "queue" | "settings";
type Page = { kind: "tab"; tab: Tab } | { kind: "album"; album: Album } | { kind: "artist"; artist: Artist } | { kind: "genre"; genre: Genre } | { kind: "playlist"; id: string } | { kind: "smart"; id: SmartId } | { kind: "search" } | { kind: "home" } | { kind: "pick"; level: PickLevel; artist?: { id: string; name: string } };

const LYRICS_STORE = "mediaverse.phone.lyrics-shown";
/** Whether Now Playing shows the lyrics instead of the cover (remembered), the song they were asked for, the answer, and the line lit now (-2: not drawn yet, -1: before the first line). */
let lyricsShown = (() => { try { return localStorage.getItem(LYRICS_STORE) === "1"; } catch { return false; } })();
let lyricsAsked: string | null = null;
let lyricsData: TrackLyrics | null = null;
let lyricsLine = -2;

const FLAG_STORE = "mediaverse.phone.flags";
const DISMISSED_STORE = "mediaverse.phone.flags-dismissed";
/** Flagged problem tracks, the saved Jellyfin sign-in, the last sync message, and the Quick Connect code on show. */
let flags: Flag[] = [];
let jfSession: Session | null = savedSession();
let syncStatus = "";
let syncing = false;
let jfCode = "";

/** How often and when each song was played (kept by the app): feeds Recently played, Not played yet and the like. */
let playStats: PlayStats = {};

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

// ---------- Library ----------

let tracks: PhoneTrack[] = [];
let byId = new Map<string, PhoneTrack>();
let albums: Album[] = [];
let artists: Artist[] = [];
/** Artists who are only on compilations: not on the list, but a search finds them (owner, 2026-11-10). */
let guestArtists: Artist[] = [];
let genres: Genre[] = [];
let albumOf = new Map<string, Album>();
let libraryLoaded = false;
let appVersion = "";
let favorites = new Set<string>();
let share: ShareStatus | null = null;

function setLibrary(list: PhoneTrack[]): void {
  tracks = list;
  byId = new Map(list.map((t) => [t.id, t]));
  albums = buildAlbums(list);
  artists = buildArtists(albums);
  guestArtists = buildGuestArtists(albums);
  genres = buildGenres(albums);
  albumOf = new Map(albums.flatMap((album) => album.tracks.map((t) => [t.id, album] as [string, Album])));
  libraryLoaded = true;
}

const songs = (): PhoneTrack[] => albums.flatMap((a) => a.tracks) as PhoneTrack[];
const coverUrl = (id: string, size = 320): string => `/media/cover/${encodeURIComponent(id)}?size=${size}`;
const lengthOf = (list: { id: string }[]): number => list.reduce((sum, t) => sum + (byId.get(t.id)?.duration_ms ?? 0), 0);

// ---------- The app ----------

let player: PlayerState = { playing: false, buffering: false, index: -1, id: null, position: 0, duration: 0, shuffle: false, repeat: "off" };
let stateAt = performance.now();
/** The phone's own player, kept while the TV plays. */
let phoneState: PlayerState = player;
let tvs: Tv[] = [];

/** Names the owner gave to TVs and speakers (a TV announces itself as "65" OLED"), kept on the phone by device id. */
const TV_NAMES_KEY = "mediaverse.phone.tvnames";
function tvNames(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TV_NAMES_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function tvName(tv: Tv): string {
  const own = tvNames()[tv.id];
  return typeof own === "string" && own.trim() ? own.trim() : tv.name;
}
function setTvName(tv: Tv, name: string): void {
  const names = tvNames();
  if (name.trim() && name.trim() !== tv.name) names[tv.id] = name.trim().slice(0, 40);
  else delete names[tv.id];
  try {
    localStorage.setItem(TV_NAMES_KEY, JSON.stringify(names));
  } catch {
    // kept until the app closes
  }
}
/** The TV the music was sent to, while it plays there. */
let onTv: Tv | null = null;
/** Whether the TV or speaker has reported what it plays since the music was sent (it is stopped if it then goes quiet). */
let castReported = false;
/** A Cast or DLNA device plays the phone's queue itself, so the phone's shuffle and repeat buttons go to it. */
const isCastDevice = (tv: Tv | null): boolean => !!tv && (tv.id.startsWith("cast:") || tv.id.startsWith("dlna:"));

/** Play/pause, next, previous and seek go to whichever is playing: the phone or the TV. */
function control(type: "toggle" | "next" | "previous" | "seek", ms = 0): void {
  if (onTv) {
    const command: TvCommand = type === "seek" ? { action: "seek", ms } : { action: type };
    bridge.send({ type: "tvSend", target: onTv.id, command });
    if (type === "toggle") {
      player = { ...player, playing: !player.playing, position: positionNow(player, stateAt, performance.now()) };
      stateAt = performance.now();
      updateNowPlaying(false);
    }
  } else if (type === "seek") bridge.send({ type: "seek", ms });
  else bridge.send({ type });
}

function onTvs(list: Tv[]): void {
  tvs = list;
  if (onTv) {
    const now = list.find((tv) => tv.id === onTv!.id);
    if (!now) {
      // The TV stopped listening (switched off, or back to the computer's library): the phone takes over again.
      leaveTv(false);
      toast("The TV is no longer playing from the phone");
    } else {
      onTv = now;
      const state = now.state;
      if (!state && isCastDevice(now) && castReported) {
        // Stopped from the notification (or ended): the phone takes over again, paused.
        leaveTv(false);
        toast(`Stopped on ${tvName(now)}`);
      } else if (state) {
        castReported = true;
        const songChanged = state.id !== player.id;
        player = {
          ...player, id: state.id, playing: state.playing, position: state.position_ms, duration: state.duration_ms, buffering: false,
          shuffle: state.shuffle ?? player.shuffle, repeat: state.repeat ?? player.repeat,
        };
        stateAt = performance.now() - Math.max(0, Date.now() - state.at);
        updateNowPlaying(songChanged);
      }
    }
  }
  updateTvButton();
}

function updateTvButton(): void {
  const button = $<HTMLButtonElement>("#np-tv");
  button.hidden = !tvs.length && !onTv;
  setIcon(button, "tv", onTv ? `Playing on ${tvName(onTv)}: bring it back to the phone` : "Play on the TV", 26);
  button.classList.toggle("is-on", !!onTv);
  updateVolume();
  const from = $("#np-from");
  from.classList.toggle("on-tv", !!onTv);
  if (onTv) from.textContent = `On ${tvName(onTv)}`;
}

/** Sends the queue, from the playing song and place, to a TV; the phone pauses. */
function sendToTv(tv: Tv): void {
  const list = queueInPlayOrder(queue, order);
  const at = list.findIndex((entry) => entry.index === player.index);
  if (at < 0 || !player.id) return;
  const ids = list.map((entry) => entry.id);
  const position = Math.round(positionNow(player, stateAt, performance.now()));
  bridge.send({ type: "tvSend", target: tv.id, command: { action: "play", ids, index: at, position_ms: position } });
  if (player.playing) bridge.send({ type: "toggle" });
  onTv = tv;
  castReported = false;
  player = { ...player, playing: true };
  stateAt = performance.now();
  updateTvButton();
  updateNowPlaying(false);
  toast(`Playing on ${tvName(tv)}`);
}

/** Back to the phone: the TV pauses, and the phone carries on from the TV's song and place. */
function leaveTv(pauseTv = true): void {
  const tv = onTv;
  if (!tv) return;
  const id = player.id;
  const position = Math.round(positionNow(player, stateAt, performance.now()));
  const wasPlaying = player.playing;
  // A TV running the app pauses; a Cast or DLNA device is stopped, so it closes the player and returns to what it showed.
  const castDevice = tv.id.startsWith("cast:") || tv.id.startsWith("dlna:");
  if (pauseTv) bridge.send({ type: "tvSend", target: tv.id, command: { action: castDevice ? "stop" : "pause" } });
  onTv = null;
  player = phoneState;
  updateTvButton();
  if (id && pauseTv) {
    const list = queueInPlayOrder(queue, order).map((entry) => entry.id);
    const at = list.indexOf(id);
    if (at >= 0) bridge.send({ type: "play", ids: list, index: at });
    else bridge.send({ type: "play", ids: [id], index: 0 });
    window.setTimeout(() => {
      bridge.send({ type: "seek", ms: position });
      if (!wasPlaying) bridge.send({ type: "toggle" });
    }, 600);
  }
  updateNowPlaying(true);
}

// Which TVs and speakers can be played on (TVs running the app, Cast devices, DLNA renderers): ask now and then.
setInterval(() => {
  if (!document.hidden) bridge.send({ type: "tvs" }); // not while the app is in the background
}, 5000);
let queue: string[] = [];
let order: number[] = [];

const bridge = connect(onMessage);

function onMessage(message: FromApp): void {
  switch (message.type) {
    case "hello":
      appVersion = message.version;
      if (message.insets) setInsets(message.insets);
      if (message.permission) bridge.send({ type: "library" });
      else showWelcome();
      break;
    case "insets":
      setInsets(message.insets);
      break;
    case "permission":
      if (!message.granted) {
        $("#welcome-title").textContent = "Music access is needed";
        $("#welcome-text").textContent = "Without it there is nothing to play. If Android no longer asks, allow Music and audio for MediaVerse Studio in the phone's Settings > Apps.";
      }
      break;
    case "libraryChanged":
      bridge.send({ type: "library" });
      break;
    case "library": {
      flags = readFlags();
      setLibrary(message.tracks);
      const waiters = libraryWaiters.splice(0);
      for (const waiter of waiters) waiter();
      syncSoon();
      $("#welcome").hidden = true;
      $("#browse").hidden = false;
      if (location.hash === "#playing") openPlaying();
      bridge.send({ type: "favorites" });
      bridge.send({ type: "stats" });
      bridge.send({ type: "share" });
      render();
      updateNowPlaying(true);
      break;
    }
    case "openPlaying":
      openPlaying();
      break;
    case "share": {
      const { type: _kind, ...status } = message;
      share = status;
      showPairing();
      if (currentPage().kind === "tab" && (currentPage() as { tab: Tab }).tab === "settings") render();
      break;
    }
    case "shareRefused":
      toast("Sharing needs access to the home network");
      break;
    case "favorites":
      favorites = new Set(message.ids);
      updateFavorite();
      if (currentPage().kind === "tab" && (currentPage() as { tab: Tab }).tab === "favorites") render();
      break;
    case "tvs":
      onTvs(message.tvs);
      break;
    case "eq":
      eqState = message.eq;
      if (!eqDragging) document.querySelector<HTMLElement>("#eq-box") && fillEq(document.querySelector<HTMLElement>("#eq-box")!);
      break;
    case "network":
    case "downloaded":
    case "downloadProgress":
    case "deletedLocal":
    case "fingerprint":
    case "writeGranted":
      homeSync.onNative(message);
      break;
    case "http": {
      const resolve = waitingHttp.get(message.id);
      waitingHttp.delete(message.id);
      resolve?.({ status: message.status, body: message.body });
      break;
    }
    case "lyrics":
      if (message.id === lyricsAsked) {
        lyricsData = message.lyrics.lines.length ? { ...message.lyrics, lines: sortedLines(message.lyrics.lines) } : message.lyrics;
        lyricsLine = -2;
        renderLyrics();
      }
      break;
    case "stats":
      playStats = message.stats;
      if (currentPage().kind === "smart") render();
      break;
    case "state": {
      const { type: _type, queue: newQueue, order: newOrder, ...rest } = message;
      phoneState = rest;
      // While the TV plays, the screen shows the TV; the phone's own player waits, paused.
      if (onTv) {
        if (newQueue) {
          queue = newQueue;
          order = newOrder ?? [];
        }
        break;
      }
      const songChanged = rest.id !== player.id;
      player = rest;
      stateAt = performance.now();
      if (newQueue) {
        queue = newQueue;
        order = newOrder ?? [];
        if (currentPage().kind === "tab" && (currentPage() as { tab: Tab }).tab === "queue") render();
      }
      updateNowPlaying(songChanged);
      break;
    }
  }
}

function setInsets(insets: { top: number; bottom: number; left: number; right: number }): void {
  const root = document.documentElement.style;
  root.setProperty("--inset-top", `${insets.top}px`);
  root.setProperty("--inset-bottom", `${insets.bottom}px`);
  root.setProperty("--inset-left", `${insets.left}px`);
  root.setProperty("--inset-right", `${insets.right}px`);
}

function showWelcome(): void {
  $("#browse").hidden = true;
  $("#welcome").hidden = false;
}
$("#welcome-go").addEventListener("click", () => bridge.send({ type: "askPermission" }));

function play(list: { id: string }[], index = 0, shuffle = false): void {
  if (!list.length) return;
  snapshotActiveQueue(); // a saved queue that was playing keeps its place when something else starts
  activeQueueId = null;
  const window = playWindow(list, Math.max(0, index));
  bridge.send({ type: "play", ids: window.items.map((t) => t.id), index: shuffle ? Math.floor(Math.random() * window.items.length) : window.index, shuffle });
}

let toastTimer: number | undefined;
function toast(text: string): void {
  const box = $("#toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (box.hidden = true), 2500);
}

// ---------- Pages ----------

const stack: Page[] = [{ kind: "tab", tab: "albums" }];
const scrollOf = new Map<string, number>();
const currentPage = (): Page => stack[stack.length - 1];
const pageKey = (page: Page): string => (page.kind === "tab" ? `tab:${page.tab}` : page.kind === "album" ? `album:${page.album.key}` : page.kind === "artist" ? `artist:${page.artist.name}` : page.kind === "genre" ? `genre:${page.genre.name}` : page.kind === "playlist" ? `playlist:${page.id}` : page.kind === "smart" ? `smart:${page.id}` : page.kind === "home" ? "home" : page.kind === "pick" ? `pick:${page.level}:${page.artist?.id ?? ""}` : "search");

const view = $<HTMLElement>("#view");

function go(page: Page): void {
  scrollOf.set(pageKey(currentPage()), view.scrollTop);
  stack.push(page);
  render(true);
}

function switchTab(tab: Tab): void {
  scrollOf.set(pageKey(currentPage()), view.scrollTop);
  stack.length = 0;
  stack.push({ kind: "tab", tab });
  closeSearch(false);
  render();
}

/** The phone's Back: Now Playing closes, then menus, then pages go back one by one; at the start, leave. */
window.mvBack = (): boolean => {
  if (!$("#sheet").hidden) {
    $("#sheet").hidden = true;
    return true;
  }
  if (!$("#playing").hidden) {
    closePlaying();
    return true;
  }
  if (stack.length > 1) {
    stack.pop();
    if (currentPage().kind !== "search") closeSearch(false);
    render();
    return true;
  }
  return false;
};

for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  button.addEventListener("click", () => switchTab(button.dataset.tab as Tab));
}

function render(fresh = false): void {
  if (!libraryLoaded) return;
  const page = currentPage();
  const rootTab = stack[0].kind === "tab" ? stack[0].tab : null;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".tab")) button.classList.toggle("is-on", button.dataset.tab === rootTab);
  stopVirtual();
  $("#letters").hidden = true;
  view.replaceChildren();
  view.classList.toggle("is-tight", page.kind !== "tab");
  if (page.kind === "tab" && page.tab === "settings") {
    settingsPage();
  } else if (page.kind === "home") {
    homeSync.renderHome(view);
  } else if (page.kind === "pick") {
    homeSync.renderPick(view, page.level, page.artist);
  } else if (!tracks.length) {
    view.append(emptyLibrary());
  } else if (page.kind === "tab") {
    if (page.tab === "artists") artistsList();
    else if (page.tab === "genres") genresList();
    else if (page.tab === "albums") albumsGrid(albums, view);
    else if (page.tab === "songs") songsList();
    else if (page.tab === "favorites") favoritesList();
    else if (page.tab === "playlists") playlistsPage();
    else queuePage();
  } else if (page.kind === "playlist") playlistPage(page.id);
  else if (page.kind === "album") albumPage(page.album);
  else if (page.kind === "artist") artistPage(page.artist);
  else if (page.kind === "genre") genrePage(page.genre);
  else if (page.kind === "smart") smartPage(page.id);
  else searchPage();
  view.scrollTop = fresh ? 0 : scrollOf.get(pageKey(page)) ?? 0;
  refreshVirtual();
}

function emptyLibrary(): HTMLElement {
  const box = el("div", "empty");
  box.append(
    el("h2", undefined, "No music on this phone yet"),
    el("p", "hint", "Copy your music folders into the phone's Music folder (connect the phone to the PC with a USB cable and choose File transfer). Android finds new music by itself within a minute or so."),
  );
  const again = el("button", "primary", "Look again");
  again.type = "button";
  again.addEventListener("click", () => bridge.send({ type: "library", reload: true }));
  const fromServer = el("button", "secondary", "Get music from my home server");
  fromServer.type = "button";
  fromServer.addEventListener("click", () => (jfSession ? go({ kind: "home" }) : switchTab("settings")));
  box.append(again, fromServer);
  return box;
}

// ---------- Long lists: only the rows on screen are made ----------

type Virtual = { count: number; rowHeight: number; make: (i: number) => HTMLElement; body: HTMLElement; rows: Map<number, HTMLElement>; top: number };
let virtual: Virtual | null = null;

function virtualList(count: number, rowHeight: number, make: (i: number) => HTMLElement, names?: string[]): HTMLElement {
  const body = el("div", "vlist");
  body.style.height = `${count * rowHeight}px`;
  virtual = { count, rowHeight, make, body, rows: new Map(), top: 0 };
  if (names && names.length > 30) letterStrip(names, (row) => (view.scrollTop = virtual!.top + row * rowHeight));
  return body;
}

function stopVirtual(): void {
  virtual = null;
}

function refreshVirtual(): void {
  const v = virtual;
  if (!v) return;
  v.top = v.body.offsetTop;
  const [first, last] = visibleRange(Math.max(0, view.scrollTop - v.top), view.clientHeight, v.rowHeight, v.count);
  for (const [i, row] of v.rows) {
    if (i < first || i >= last) {
      row.remove();
      v.rows.delete(i);
    }
  }
  for (let i = first; i < last; i++) {
    if (v.rows.has(i)) continue;
    const row = v.make(i);
    row.style.transform = `translateY(${i * v.rowHeight}px)`;
    row.classList.add("vrow");
    v.body.append(row);
    v.rows.set(i, row);
  }
}

view.addEventListener("scroll", () => requestAnimationFrame(refreshVirtual), { passive: true });
window.addEventListener("resize", () => refreshVirtual());

/** A to Z down the right: touch or slide along it to jump. */
function letterStrip(names: string[], jump: (row: number) => void): void {
  const starts = letterStarts(names);
  const strip = $("#letters");
  strip.replaceChildren();
  for (const letter of LETTERS) {
    const item = el("span", starts.has(letter) ? "letter" : "letter is-empty", letter);
    item.dataset.letter = letter;
    strip.append(item);
  }
  strip.hidden = false;
  const pick = (event: PointerEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const letter = target?.dataset.letter;
    if (!letter) return;
    jump(rowForLetter(starts, letter, names.length));
    showLetter(letter);
  };
  strip.onpointerdown = (event) => {
    strip.setPointerCapture(event.pointerId);
    pick(event);
  };
  strip.onpointermove = (event) => {
    if (strip.hasPointerCapture(event.pointerId)) pick(event);
  };
}

let letterTimer: number | undefined;
function showLetter(letter: string): void {
  let bubble = document.querySelector<HTMLElement>(".letter-bubble");
  if (!bubble) document.body.append((bubble = el("div", "letter-bubble")));
  bubble.textContent = letter;
  bubble.hidden = false;
  clearTimeout(letterTimer);
  letterTimer = window.setTimeout(() => (bubble!.hidden = true), 700);
}

// ---------- Rows and tiles ----------

function cover(id: string | undefined, size: number, className = "cover"): HTMLElement {
  const box = el("span", className);
  if (!id) return box;
  const image = el("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.src = coverUrl(id, size);
  image.addEventListener("error", () => image.remove());
  box.append(image);
  return box;
}

function iconButton(name: IconName, label: string, action: () => void, filled = false): HTMLButtonElement {
  const button = el("button", "icon-only");
  button.type = "button";
  button.append(icon(name, { size: 24, filled }));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });
  return button;
}

function moreButton(title: string, ids: () => string[]): HTMLButtonElement {
  const button = iconButton("play-next", "More", () =>
    sheet(title, [
      ["Play next", () => {
        bridge.send({ type: "enqueue", ids: ids(), next: true });
        toast("Plays next");
      }],
      ["Add to queue", () => {
        bridge.send({ type: "enqueue", ids: ids() });
        toast("Added to the queue");
      }],
      ["Add to playlist…", () => addToPlaylist(ids())],
    ]),
  );
  button.classList.add("more");
  return button;
}

function sheet(title: string, actions: [string, () => void][]): void {
  const box = $("#sheet");
  $("#sheet-title").textContent = title;
  const buttons = $("#sheet-buttons");
  buttons.replaceChildren();
  for (const [label, action] of actions) {
    const button = el("button", "sheet-button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      box.hidden = true;
      action();
    });
    buttons.append(button);
  }
  box.hidden = false;
}
$("#sheet").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) $("#sheet").hidden = true;
});

function songRow(track: PhoneTrack, onPlay: () => void, options: { number?: boolean; showAlbum?: boolean; art?: boolean } = {}): HTMLElement {
  const row = el("div", "row song");
  row.dataset.id = track.id;
  if (track.id === player.id) row.classList.add("is-current");
  if (options.art) row.append(cover(track.id, 96, "cover small"));
  else if (options.number) row.append(el("span", "num", track.track_number ? String(track.track_number) : ""));
  const text = el("span", "row-text");
  text.append(el("span", "row-title", track.title));
  const sub = options.showAlbum ? [track.artist, albumOf.get(track.id)?.title].filter(Boolean).join(" · ") : track.artist && track.artist !== albumOf.get(track.id)?.artist ? track.artist : "";
  if (sub) text.append(el("span", "row-sub", sub));
  row.append(text, el("span", "row-time", clock(track.duration_ms / 1000)), moreButton(track.title, () => [track.id]));
  row.addEventListener("click", onPlay);
  return row;
}

function albumTile(album: Album): HTMLElement {
  const tile = el("button", "tile");
  tile.type = "button";
  tile.append(cover(album.tracks[0]?.id, 320), el("span", "tile-title", album.title), el("span", "tile-sub", [album.artist, album.year].filter(Boolean).join(" · ")));
  tile.addEventListener("click", () => go({ kind: "album", album }));
  return tile;
}

function albumsGrid(list: Album[], into: HTMLElement): void {
  // Rows of two (three on a wide screen) tiles, only those on screen made.
  const columns = Math.max(2, Math.floor((view.clientWidth || 360) / 180));
  const width = (view.clientWidth || 360) - 32;
  const rowHeight = Math.round((width - (columns - 1) * 12) / columns + 64);
  const rows = Math.ceil(list.length / columns);
  const names = Array.from({ length: rows }, (_, r) => list[r * columns].artist);
  into.append(
    virtualList(rows, rowHeight, (r) => {
      const line = el("div", "tile-row");
      line.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
      for (let c = 0; c < columns; c++) {
        const album = list[r * columns + c];
        if (album) line.append(albumTile(album));
      }
      return line;
    }, into === view ? names : undefined),
  );
}

function header(title: string, subtitle: string, list: () => { id: string }[]): HTMLElement {
  const head = el("div", "page-head");
  const text = el("div", "page-head-text");
  text.append(el("h1", undefined, title), el("p", "hint", subtitle));
  const actions = el("div", "page-actions");
  // Play next / Add to queue for a whole artist or genre too (owner, 2026-11-06), as for albums and songs.
  actions.append(iconButton("play", "Play", () => play(list()), true), iconButton("shuffle", "Shuffle", () => play(list(), 0, true)), moreButton(title, () => list().map((t) => t.id)));
  head.append(text, actions);
  return head;
}

// ---------- The tabs ----------

function artistsList(): void {
  view.append(
    virtualList(artists.length, 64, (i) => {
      const artist = artists[i];
      const row = el("div", "row");
      row.append(cover(artist.tracks[0]?.id, 96, "cover small"));
      const text = el("span", "row-text");
      text.append(el("span", "row-title", artist.name), el("span", "row-sub", `${count(artist.albums.length, "album")} · ${count(artist.tracks.length, "song")}`));
      row.append(text);
      row.addEventListener("click", () => go({ kind: "artist", artist }));
      return row;
    }, artists.map((a) => a.name)),
  );
}

function genresList(): void {
  view.append(
    virtualList(genres.length, 64, (i) => {
      const genre = genres[i];
      const row = el("div", "row");
      row.append(cover(genre.tracks[0]?.id, 96, "cover small"));
      const text = el("span", "row-text");
      text.append(el("span", "row-title", genre.name), el("span", "row-sub", `${count(genre.albums.length, "album")} · ${count(genre.tracks.length, "song")}`));
      row.append(text);
      row.addEventListener("click", () => go({ kind: "genre", genre }));
      return row;
    }, genres.map((g) => g.name)),
  );
}

function songsList(): void {
  const all = songs();
  const head = el("div", "list-head");
  head.append(el("span", "hint", count(all.length, "song")), iconButton("shuffle", "Shuffle all", () => play(all, 0, true)));
  view.append(head, virtualList(all.length, 64, (i) => songRow(all[i], () => play(all, i), { art: true, showAlbum: true }), all.map((t) => t.title)));
}

// ---------- Playlists (D82): made and kept on the phone ----------

let playlists: PhonePlaylist[] = loadPlaylists();

function storePlaylists(): void {
  savePlaylists(playlists);
}

/** Asks for a name in a small box over the page; resolves to the name, or null when cancelled. */
function askName(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const shade = el("div", "name-shade");
    const box = el("form", "name-box");
    const input = el("input");
    input.value = initial;
    input.maxLength = 200;
    input.setAttribute("aria-label", "Name");
    const ok = el("button", "primary", "OK");
    ok.type = "submit";
    const cancel = el("button", "link", "Cancel");
    cancel.type = "button";
    const buttons = el("div", "name-buttons");
    buttons.append(cancel, ok);
    box.append(el("p", "sheet-title", title), input, buttons);
    shade.append(box);
    document.body.append(shade);
    const done = (value: string | null): void => {
      shade.remove();
      resolve(value);
    };
    box.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name) done(name);
    });
    cancel.addEventListener("click", () => done(null));
    shade.addEventListener("click", (event) => event.target === shade && done(null));
    input.focus();
    input.select();
  });
}

async function newPlaylist(ids: string[] = []): Promise<PhonePlaylist | null> {
  const name = await askName("New playlist", freeName("New playlist", playlists));
  if (name === null) return null;
  const playlist: PhonePlaylist = { id: `p${Date.now().toString(36)}`, name: freeName(name, playlists), entries: [], updated: Date.now() };
  addSongs(playlist, ids.map((id) => byId.get(id)).filter((t): t is PhoneTrack => !!t));
  playlists.push(playlist);
  storePlaylists();
  return playlist;
}

/** "Add to playlist…": the playlists to choose from, or a new one. */
function addToPlaylist(ids: string[]): void {
  const songsToAdd = ids.map((id) => byId.get(id)).filter((t): t is PhoneTrack => !!t);
  const recent = [...playlists].sort((a, b) => b.updated - a.updated).slice(0, 12);
  sheet("Add to playlist", [
    ["New playlist…", () => void newPlaylist(ids).then((made) => made && toast(`Made “${made.name}”`))],
    ...recent.map((p): [string, () => void] => [p.name, () => {
      const added = addSongs(p, songsToAdd);
      storePlaylists();
      toast(added ? `Added to “${p.name}”` : `Already in “${p.name}”`);
    }]),
  ]);
}

function playlistsPage(): void {
  const head = el("div", "list-head");
  const make = el("button", "link", "New playlist");
  make.type = "button";
  make.addEventListener("click", () => void newPlaylist().then((made) => made && go({ kind: "playlist", id: made.id })));
  head.append(el("span", "hint", count(playlists.length, "playlist")), make);
  view.append(head);
  // The automatic lists come first (from Musicolet and Poweramp); the counts are asked for again each time.
  bridge.send({ type: "stats" });
  for (const smart of SMART_LISTS) {
    const row = el("button", "row");
    row.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", smart.name), el("span", "row-sub", smart.hint));
    row.append(text);
    row.addEventListener("click", () => go({ kind: "smart", id: smart.id }));
    view.append(row);
  }
  if (playlists.length) view.append(el("h2", "section", "Your playlists"));
  if (!playlists.length) {
    view.append(el("p", "empty hint", "No playlists yet. Tap New playlist, or tap ⋯ on any song, album or artist and choose Add to playlist."));
    return;
  }
  for (const playlist of [...playlists].sort((a, b) => a.name.localeCompare(b.name))) {
    const row = el("button", "row");
    row.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", playlist.name), el("span", "row-sub", count(playlist.entries.length, "song")));
    row.append(text);
    row.addEventListener("click", () => go({ kind: "playlist", id: playlist.id }));
    view.append(row);
  }
}

function playlistPage(id: string): void {
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist) {
    view.append(el("p", "empty hint", "This playlist was deleted."));
    return;
  }
  const list = resolvePlaylist(playlist, tracks, byId);
  const top = el("div", "album-text");
  top.append(el("h1", undefined, playlist.name), el("p", "hint", `${count(list.length, "song")}${playlist.entries.length > list.length ? ` · ${playlist.entries.length - list.length} not on this phone` : ""}`));
  const head = el("div", "list-head");
  const playAll = el("button", "primary", "Play");
  playAll.type = "button";
  playAll.disabled = !list.length;
  playAll.addEventListener("click", () => play(list, 0));
  const options = iconButton("play-next", "Playlist options", () =>
    sheet(playlist.name, [
      ["Play next", () => {
        bridge.send({ type: "enqueue", ids: list.map((t) => t.id), next: true });
        toast("Plays next");
      }],
      ["Add to queue", () => {
        bridge.send({ type: "enqueue", ids: list.map((t) => t.id) });
        toast("Added to the queue");
      }],
      ["Rename…", () => void askName("Rename playlist", playlist.name).then((name) => {
        if (!name) return;
        playlist.name = freeName(name, playlists, playlist.id);
        playlist.updated = Date.now();
        storePlaylists();
        render();
      })],
      ["Delete playlist", () => {
        sheet(`Delete “${playlist.name}”? Its songs stay on the phone.`, [
          ["Delete", () => {
            playlists = playlists.filter((p) => p.id !== playlist.id);
            storePlaylists();
            window.mvBack?.();
            toast("Playlist deleted");
          }],
          ["Keep it", () => {}],
        ]);
      }],
    ]),
  );
  options.classList.add("more");
  head.append(playAll, iconButton("shuffle", "Shuffle", () => play(list, 0, true)), options);
  view.append(top, head);
  if (!list.length) {
    view.append(el("p", "empty hint", "Nothing here yet. Tap ⋯ on any song, album or artist and choose Add to playlist."));
    return;
  }
  // Each song's ⋯ moves it or takes it out. The places are those in the playlist's own list of entries.
  const placeOf = (track: PhoneTrack): number => playlist.entries.findIndex((e) => e.id === track.id || (e.title === track.title && e.artist === (track.artist || track.album_artist || "")));
  view.append(
    virtualList(list.length, 64, (i) => {
      const row = songRow(list[i], () => play(list, i), { art: true, showAlbum: true });
      const change = (what: "up" | "down" | "remove"): void => {
        changeAt(playlist, placeOf(list[i]), what);
        storePlaylists();
        render();
      };
      const more = iconButton("play-next", "Song options", () =>
        sheet(list[i].title, [
          ["Move up", () => change("up")],
          ["Move down", () => change("down")],
          ["Remove from playlist", () => change("remove")],
        ]),
      );
      more.classList.add("more");
      row.append(more);
      return row;
    }),
  );
}

// ---------- Equalizer: one for each place the sound goes ----------

let eqState: EqState = { available: false };
let eqDragging = false;
let eqTimer: number | undefined;

function eqSection(): HTMLElement {
  const wrap = el("div", "eq");
  wrap.id = "eq-box";
  fillEq(wrap);
  bridge.send({ type: "eq" });
  return wrap;
}

function fillEq(wrap: HTMLElement): void {
  wrap.replaceChildren();
  wrap.append(el("h2", undefined, "Equalizer"));
  if (!eqState.available) {
    wrap.append(el("p", "hint", "The equalizer starts with the music: play a song, then look here again."));
    return;
  }
  const state = eqState;
  wrap.append(el("p", "hint", `For ${state.name}. Each speaker, headphone and Bluetooth device keeps its own settings, and they switch by themselves when the sound moves.`));
  const levels = [...state.levels];
  let enabled = state.enabled;
  const send = (): void => {
    clearTimeout(eqTimer);
    eqTimer = window.setTimeout(() => bridge.send({ type: "eqSet", key: state.key, enabled, levels }), 120);
  };
  const row = el("button", "switch-row");
  row.type = "button";
  const text = el("span", "row-text");
  text.append(el("span", "row-title", "Equalizer on"));
  const knob = el("span", enabled ? "switch is-on" : "switch");
  row.append(text, knob);
  row.addEventListener("click", () => {
    enabled = !enabled;
    knob.classList.toggle("is-on", enabled);
    send();
  });
  wrap.append(row);
  const presets = el("div", "eq-presets");
  const sliders: HTMLInputElement[] = [];
  const labels: HTMLElement[] = [];
  for (const name of EQ_PRESETS) {
    const button = el("button", "link", name);
    button.type = "button";
    button.addEventListener("click", () => {
      levels.splice(0, levels.length, ...presetLevels(name, state.hz.length, state.min, state.max));
      levels.forEach((v, i) => { sliders[i].value = String(v); labels[i].textContent = decibels(v); });
      if (!enabled) { enabled = true; knob.classList.add("is-on"); }
      send();
    });
    presets.append(button);
  }
  wrap.append(presets);
  state.hz.forEach((hz, i) => {
    const line = el("label", "eq-band");
    const name = el("span", "eq-hz", hertz(hz));
    const slider = el("input");
    slider.type = "range";
    slider.min = String(state.min);
    slider.max = String(state.max);
    slider.step = "50";
    slider.value = String(levels[i] ?? 0);
    slider.setAttribute("aria-label", `${hertz(hz)} level`);
    const value = el("span", "eq-db", decibels(levels[i] ?? 0));
    slider.addEventListener("pointerdown", () => (eqDragging = true));
    slider.addEventListener("change", () => (eqDragging = false));
    slider.addEventListener("input", () => {
      levels[i] = Number(slider.value);
      value.textContent = decibels(levels[i]);
      if (!enabled) { enabled = true; knob.classList.add("is-on"); }
      send();
    });
    sliders.push(slider);
    labels.push(value);
    line.append(name, slider, value);
    wrap.append(line);
  });
}

/** One of the automatic lists (Recently played, Recently added, Not played yet). */
function smartPage(id: SmartId): void {
  const info = SMART_LISTS.find((s) => s.id === id)!;
  const list = smartList(id, tracks, playStats);
  const top = el("div", "album-text");
  top.append(el("h1", undefined, info.name), el("p", "hint", info.hint));
  view.append(top);
  if (!list.length) {
    view.append(el("p", "empty hint", id === "never" ? "Every song has been played." : "Nothing here yet. Play some music and it fills in."));
    return;
  }
  const head = el("div", "list-head");
  head.append(el("span", "hint", count(list.length, "song")), iconButton("shuffle", "Shuffle", () => play(list, 0, true)), moreButton(info.name, () => list.map((t) => t.id)));
  view.append(head, virtualList(list.length, 64, (i) => songRow(list[i], () => play(list, i), { art: true, showAlbum: true })));
}

function favoritesList(): void {
  const list = songs().filter((t) => favorites.has(t.id));
  if (!list.length) {
    view.append(el("p", "empty hint", "No favorites yet. Tap the heart in Now Playing to keep a song here."));
    return;
  }
  const head = el("div", "list-head");
  head.append(el("span", "hint", count(list.length, "song")), iconButton("shuffle", "Shuffle favorites", () => play(list, 0, true)), moreButton("Favorites", () => list.map((t) => t.id)));
  view.append(head, virtualList(list.length, 64, (i) => songRow(list[i], () => play(list, i), { art: true, showAlbum: true })));
}

// ---------- Saved queues (from Musicolet): each resumes from where it was left ----------

const QUEUE_STORE = "mediaverse.phone.queues";
let savedQueues: SavedQueue[] = (() => {
  try { return JSON.parse(localStorage.getItem(QUEUE_STORE) ?? "[]") as SavedQueue[]; } catch { return []; }
})();
let activeQueueId: string | null = null;
function storeQueues(): void {
  try { localStorage.setItem(QUEUE_STORE, JSON.stringify(savedQueues)); } catch { /* storage unavailable */ }
}

/** The queue now playing, with its place, written back to the saved queue it came from (if any). */
function snapshotActiveQueue(): void {
  const active = savedQueues.find((q) => q.id === activeQueueId);
  if (!active || !queue.length) return;
  savedQueues = putQueue(savedQueues, { ...active, ids: [...queue], index: Math.max(0, player.index), position: Math.round(positionNow(player, stateAt, performance.now())), updated: Date.now() });
  storeQueues();
}

function queuesMenu(): void {
  const resume = (q: SavedQueue): [string, () => void] => [`Resume “${q.name}” (${count(q.ids.filter((id) => byId.has(id)).length, "song")})`, () => {
    snapshotActiveQueue();
    const ids = q.ids.filter((id) => byId.has(id));
    if (!ids.length) { toast("Its songs are not on this phone"); return; }
    const index = Math.min(Math.max(0, q.ids.slice(0, q.index).filter((id) => byId.has(id)).length), ids.length - 1);
    activeQueueId = q.id;
    bridge.send({ type: "play", ids, index });
    window.setTimeout(() => bridge.send({ type: "seek", ms: q.position }), 700);
    toast(`Resuming “${q.name}”`);
  }];
  sheet("Queues", [
    ["Save the current queue as…", () => void askName("Name this queue", freeQueueName("Queue", savedQueues)).then((name) => {
      if (name === null || !queue.length) return;
      const made: SavedQueue = { id: `q${Date.now().toString(36)}`, name: freeQueueName(name, savedQueues), ids: [...queue], index: Math.max(0, player.index), position: Math.round(positionNow(player, stateAt, performance.now())), updated: Date.now() };
      savedQueues = putQueue(savedQueues, made);
      activeQueueId = made.id;
      storeQueues();
      toast(`Saved “${made.name}”`);
      render();
    })],
    ...savedQueues.map(resume),
    ...(savedQueues.length ? [["Delete a queue…", () => sheet("Delete which queue? Its songs stay on the phone.", [
      ...savedQueues.map((q): [string, () => void] => [q.name, () => { savedQueues = dropQueue(savedQueues, q.id); if (activeQueueId === q.id) activeQueueId = null; storeQueues(); toast("Queue deleted"); }]),
      ["Cancel", () => {}],
    ])] as [string, () => void]] : []),
    ["Cancel", () => {}],
  ]);
}

function queuePage(): void {
  const list = queueInPlayOrder(queue, order);
  const queuesLink = el("button", "link", "Queues…");
  queuesLink.type = "button";
  queuesLink.addEventListener("click", queuesMenu);
  if (!list.length) {
    const none = el("div", "list-head");
    none.append(el("span", "hint", "Nothing is queued"), queuesLink);
    view.append(none, el("p", "empty hint", "Choose an album or a song to play, or resume a saved queue."));
    return;
  }
  const playingAt = list.findIndex((entry) => entry.index === player.index);
  const head = el("div", "list-head");
  head.append(el("span", "hint", `${count(list.length, "song")}${playingAt >= 0 ? ` · ${list.length - playingAt - 1} to come` : ""}`));
  // The queue kept as a playlist (Musicolet's saved queues): the songs in the order they play.
  const save = el("button", "link", "Save as playlist");
  save.type = "button";
  save.addEventListener("click", () => void newPlaylist(list.map((entry) => entry.id)).then((made) => made && toast(`Saved as “${made.name}”`)));
  head.append(queuesLink, save);
  view.append(
    head,
    virtualList(list.length, 64, (i) => {
      const entry = list[i];
      const track = byId.get(entry.id);
      const row = el("div", "row song");
      if (entry.index === player.index) row.classList.add("is-current");
      row.append(cover(entry.id, 96, "cover small"));
      const text = el("span", "row-text");
      text.append(el("span", "row-title", track?.title ?? "Unknown song"), el("span", "row-sub", track?.artist ?? ""));
      row.append(text, iconButton("remove", "Remove from the queue", () => bridge.send({ type: "remove", index: entry.index })));
      row.addEventListener("click", () => bridge.send({ type: "jump", index: entry.index }));
      return row;
    }),
  );
  // The playing song in view.
  if (playingAt > 3) requestAnimationFrame(() => (view.scrollTop = virtual ? virtual.top + (playingAt - 2) * 64 : 0));
}

// ---------- Settings: sharing with the TV app ----------

function settingsPage(): void {
  const box = el("div", "settings");
  // Music from the home server (D177): chosen music kept on the phone, in step with the Jellyfin server.
  box.append(el("h2", undefined, "Music from your home server"));
  const homeRow = el("button", "switch-row");
  homeRow.type = "button";
  const homeText = el("span", "row-text");
  homeText.append(el("span", "row-title", "Keep music from the server on this phone"), el("span", "row-sub", homeSync.summary()));
  homeRow.append(homeText, el("span", "chevron", "›"));
  homeRow.addEventListener("click", () => go({ kind: "home" }));
  box.append(homeRow);
  box.append(flagSettings());
  box.append(eqSection());
  // The highlight colour (D75): tap a swatch. Now Playing's visualizer still follows the cover.
  box.append(el("h2", undefined, "Highlight colour"));
  const swatches = el("div", "accent-swatches");
  const colourName = el("p", "hint accent-name", ACCENT_CHOICES.find((c) => c.hex === chosenAccent)?.name ?? "");
  for (const choice of ACCENT_CHOICES) {
    const swatch = el("button", choice.hex === chosenAccent ? "swatch is-on" : "swatch");
    swatch.type = "button";
    swatch.style.setProperty("--swatch", choice.hex);
    swatch.setAttribute("aria-label", choice.name);
    swatch.setAttribute("aria-pressed", String(choice.hex === chosenAccent));
    swatch.addEventListener("click", () => {
      chosenAccent = choice.hex;
      chosenPalette = paletteFromHex(choice.hex);
      saveAccent(ACCENT_STORE, choice.hex);
      applyAccent(document.documentElement, choice.hex);
      for (const other of swatches.querySelectorAll<HTMLElement>(".swatch")) {
        other.classList.toggle("is-on", other === swatch);
        other.setAttribute("aria-pressed", String(other === swatch));
      }
      colourName.textContent = choice.name;
    });
    swatches.append(swatch);
  }
  box.append(swatches, colourName);

  // The music on this phone, and where it can be played (owner, 2026-11-11: more in Settings).
  box.append(el("h2", undefined, "Music on this phone"));
  box.append(el("p", "hint", `${count(tracks.length, "song")} · ${count(albums.length, "album")} · ${count(artists.length, "artist")}. Songs come from the Music folder; an album picture is the one inside the songs, or cover.jpg, folder.jpg or front.jpg in the album's folder.`));
  const rescan = el("button", "switch-row");
  rescan.type = "button";
  const rescanText = el("span", "row-text");
  rescanText.append(el("span", "row-title", "Look for new music"), el("span", "row-sub", "Reads the Music folder again after you add or change songs."));
  rescan.append(rescanText);
  rescan.addEventListener("click", () => {
    bridge.send({ type: "library", reload: true });
    toast("Looking for new music");
  });
  box.append(rescan);

  box.append(el("h2", undefined, "TVs and speakers"));
  box.append(el("p", "hint", "On the Now Playing screen the TV button plays the queue on a TV or speaker on your home Wi-Fi: a TV running MediaVerse Studio, a Chromecast or Google TV, or a Samsung TV or speaker that accepts DLNA. Found now:"));
  if (!tvs.length) box.append(el("p", "hint", "Nothing yet. Searching starts when the app opens; allow access to nearby devices on the home network if Android asks."));
  if (tvs.length) box.append(el("p", "hint", "Tap a name to change it, for example to \"Bedroom TV\"."));
  for (const tv of tvs) {
    const field = el("input", "tv-name");
    field.type = "text";
    field.value = tvName(tv);
    field.maxLength = 40;
    field.placeholder = tv.name;
    field.setAttribute("aria-label", `Name for ${tv.name}`);
    field.addEventListener("change", () => {
      setTvName(tv, field.value);
      field.value = tvName(tv);
      updateTvButton();
    });
    box.append(field);
  }

  box.append(el("h2", undefined, "TV"));
  const row = el("button", "switch-row");
  row.type = "button";
  const text = el("span", "row-text");
  text.append(el("span", "row-title", "Share my library with the TV app"), el("span", "row-sub", "The MediaVerse Studio app on the TV finds this phone and plays its music. Home network only; each TV pairs once with a code."));
  const knob = el("span", share?.enabled ? "switch is-on" : "switch");
  row.append(text, knob);
  row.setAttribute("role", "switch");
  row.setAttribute("aria-checked", String(!!share?.enabled));
  row.addEventListener("click", () => bridge.send({ type: "shareSet", on: !share?.enabled }));
  box.append(row);
  if (share?.enabled) {
    if (share.problem) box.append(el("p", "problem", share.problem));
    else if (share.addresses.length) {
      box.append(el("p", "hint", `On the TV, open MediaVerse Studio and choose "${share.name}". If it is not listed, choose Type an address and enter:`));
      for (const address of share.addresses) box.append(el("p", "address", address));
    } else box.append(el("p", "hint", "Connect the phone to your home Wi-Fi to share with the TV."));
    // A TV or speaker may only pair while this is open (D151): pressing the button opens pairing for five minutes for one device.
    const arm = el("button", "primary");
    arm.type = "button";
    const left = share.armed ? share.armed - Date.now() : 0;
    arm.textContent = left > 0 ? "Pairing is open" : "Pair a TV or speaker";
    arm.disabled = left > 0;
    arm.addEventListener("click", () => bridge.send({ type: "shareArm" }));
    box.append(arm);
    box.append(el("p", "hint", left > 0 ? `Open for ${Math.max(1, Math.ceil(left / 60_000))} more minute${Math.ceil(left / 60_000) === 1 ? "" : "s"}. Now start pairing on the TV; its code appears here.` : "Press this, then start pairing on the TV. Nothing can pair with this phone until you do."));
    if (left > 0) window.setTimeout(() => bridge.send({ type: "share" }), left + 500);
    box.append(el("h2", undefined, "Paired TVs"));
    if (!share.devices.length) box.append(el("p", "hint", "None yet."));
    for (const device of share.devices) {
      const line = el("div", "device-row");
      const words = el("span", "row-text");
      words.append(el("span", "row-title", device.name), el("span", "row-sub", device.paired ? `Paired ${new Date(device.paired).toLocaleDateString()}` : ""));
      line.append(words, iconButton("remove", `Remove ${device.name}`, () => bridge.send({ type: "shareRemove", id: device.id })));
      box.append(line);
    }
  }
  box.append(el("h2", undefined, "About"));
  box.append(el("p", "hint", `MediaVerse Studio for Android${appVersion && appVersion !== "browser" ? ` ${appVersion}` : ""}. Free and open source (GPL-3.0-or-later).`));
  view.append(box);
}

let pairTimer: number | undefined;
/** The pairing code over whatever page is open, while a TV pairs; it counts down and goes when done. */
function showPairing(): void {
  const pairing = share?.pairing;
  const modal = $("#pair-modal");
  clearInterval(pairTimer);
  if (!pairing || pairing.expires < Date.now()) {
    modal.hidden = true;
    return;
  }
  $("#pair-title").textContent = pairing.name;
  $("#pair-code").textContent = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
  const left = (): void => {
    const seconds = Math.max(0, Math.round((pairing.expires - Date.now()) / 1000));
    $("#pair-left").textContent = `Valid for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (!seconds) {
      modal.hidden = true;
      clearInterval(pairTimer);
    }
  };
  left();
  pairTimer = window.setInterval(left, 1000);
  modal.hidden = false;
}

// ---------- Album, artist, genre ----------

function albumPage(album: Album): void {
  const list = album.tracks as PhoneTrack[];
  const head = el("div", "album-head");
  head.append(cover(list[0]?.id, 800, "cover big"));
  const text = el("div", "album-text");
  text.append(el("h1", undefined, album.title));
  const artistName = el("button", "link", album.artist);
  artistName.type = "button";
  const artist = artists.find((a) => a.name === album.artist);
  if (artist) artistName.addEventListener("click", () => go({ kind: "artist", artist }));
  text.append(artistName, el("p", "hint", [album.year, songsAndLength(list.length, lengthOf(list))].filter(Boolean).join(" · ")));
  const actions = el("div", "page-actions");
  actions.append(iconButton("play", "Play", () => play(list), true), iconButton("shuffle", "Shuffle", () => play(list, 0, true)), moreButton(album.title, () => list.map((t) => t.id)));
  text.append(actions);
  head.append(text);
  view.append(head);
  const body = el("div", "tracks");
  list.forEach((track, i) => body.append(songRow(track, () => play(list, i), { number: true })));
  view.append(body);
}

function artistPage(artist: Artist): void {
  const all = [...artist.tracks, ...artist.alsoTracks];
  const own = artist.albums.length ? count(artist.albums.length, "album") : "";
  const others = artist.also.length ? `${own ? "+ " : ""}${count(artist.also.length, own ? "other album" : "album")}` : "";
  view.append(header(artist.name, [own, others, songsAndLength(all.length, lengthOf(all))].filter(Boolean).join(" · "), () => all));
  // As in Media Player: each album's cover beside its songs.
  const block = (album: Album, mine: Set<unknown>): void => {
    const own = album.tracks.filter((t) => mine.has(t)) as PhoneTrack[];
    const section = el("section", "artist-album");
    const top = el("button", "artist-album-head");
    top.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", album.title), el("span", "row-sub", [album.year, `${own.length} song${own.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")));
    top.append(cover(album.tracks[0]?.id, 192, "cover medium"), text);
    top.addEventListener("click", () => go({ kind: "album", album }));
    section.append(top);
    own.forEach((track, i) => section.append(songRow(track, () => play(own, i), { number: true })));
    view.append(section);
  };
  const ownTracks = new Set<unknown>(artist.tracks);
  for (const album of artist.albums) block(album, ownTracks);
  // A note before the compilations the artist is on (owner, 2026-11-10).
  if (artist.also.length) {
    view.append(el("h2", "section", `${artist.name} also appears in:`));
    // The whole compilation, so a whole album or just this artist's song can be chosen (owner, 2026-11-11).
    for (const album of artist.also) block(album, new Set<unknown>(album.tracks));
  }
}

function genrePage(genre: Genre): void {
  view.append(header(genre.name, `${count(genre.albums.length, "album")} · ${count(genre.tracks.length, "song")}`, () => genre.tracks));
  const grid = el("div");
  view.append(grid);
  albumsGrid(genre.albums, grid);
}

// ---------- Search ----------

const searchInput = $<HTMLInputElement>("#search-input");

function openSearch(): void {
  $("#search-bar").hidden = false;
  $("#tabs").hidden = true;
  if (currentPage().kind !== "search") go({ kind: "search" });
  searchInput.focus();
}

function closeSearch(back = true): void {
  if ($("#search-bar").hidden) return;
  $("#search-bar").hidden = true;
  $("#tabs").hidden = false;
  searchInput.blur();
  if (back && currentPage().kind === "search") {
    stack.pop();
    render();
  }
}

$("#search-open").append(icon("search", { size: 24 }));
$("#search-close").append(icon("back", { size: 24 }));
$("#search-open").addEventListener("click", openSearch);
$("#search-close").addEventListener("click", () => closeSearch());
let searchTimer: number | undefined;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (currentPage().kind === "search") render();
  }, 150);
});

function searchPage(): void {
  const query = searchInput.value;
  if (!query.trim()) {
    view.append(el("p", "empty hint", "Type an artist, an album or a song."));
    return;
  }
  const found = searchLibrary(query, [...artists, ...guestArtists], albums, tracks, 20);
  if (!found.artists.length && !found.albums.length && !found.songs.length) {
    view.append(el("p", "empty hint", "Nothing matches."));
    return;
  }
  if (found.artists.length) {
    view.append(el("h2", "section", "Artists"));
    for (const artist of found.artists) {
      const row = el("div", "row");
      row.append(cover((artist.tracks[0] ?? artist.alsoTracks[0])?.id, 96, "cover small"), el("span", "row-title", artist.name));
      row.addEventListener("click", () => go({ kind: "artist", artist }));
      view.append(row);
    }
  }
  if (found.albums.length) {
    view.append(el("h2", "section", "Albums"));
    const grid = el("div", "tile-row static");
    for (const album of found.albums.slice(0, 8)) grid.append(albumTile(album));
    view.append(grid);
  }
  if (found.songs.length) {
    view.append(el("h2", "section", "Songs"));
    const list = found.songs as PhoneTrack[];
    list.forEach((track, i) => view.append(songRow(track, () => play(list, i), { art: true, showAlbum: true })));
  }
}

// ---------- The bar at the bottom and Now Playing ----------

const miniPlay = $<HTMLButtonElement>("#mini-play");
const miniNext = $<HTMLButtonElement>("#mini-next");
miniPlay.addEventListener("click", () => control("toggle"));
miniNext.addEventListener("click", () => control("next"));
miniNext.append(icon("next", { size: 26, filled: true }));
miniNext.setAttribute("aria-label", "Next");
// The bar's three buttons come first (owner, 2026-11-14): previous, play or pause, next. Shuffle, repeat and the rest
// are on the full Now Playing screen; there is no skip-10-seconds, the position bar does that.
const miniPrevious = $<HTMLButtonElement>("#mini-previous");
miniPrevious.addEventListener("click", () => control("previous"));
miniPrevious.append(icon("previous", { size: 26, filled: true }));
miniPrevious.setAttribute("aria-label", "Previous");
$("#mini-open").addEventListener("click", openPlaying);

const npPlay = $<HTMLButtonElement>("#np-play");
const npShuffle = $<HTMLButtonElement>("#np-shuffle");
const npRepeat = $<HTMLButtonElement>("#np-repeat");
npPlay.addEventListener("click", () => control("toggle"));
$("#np-previous").addEventListener("click", () => control("previous"));
$("#np-next-button").addEventListener("click", () => control("next"));
// While a Cast or DLNA device plays, shuffle and repeat act on the queue it is playing, not on the phone's paused one.
npShuffle.addEventListener("click", () => (isCastDevice(onTv) ? bridge.send({ type: "tvSend", target: onTv!.id, command: { action: "shuffle" } }) : bridge.send({ type: "shuffle" })));
npRepeat.addEventListener("click", () => (isCastDevice(onTv) ? bridge.send({ type: "tvSend", target: onTv!.id, command: { action: "repeat" } }) : bridge.send({ type: "repeat" })));
$("#np-close").addEventListener("click", closePlaying);
// Always ask which device (even when only one is found), with a way to cancel: nothing starts playing by surprise.
$("#np-tv").addEventListener("click", () => {
  if (onTv) leaveTv();
  else sheet("Play on", [...tvs.map((tv) => [tvName(tv), () => sendToTv(tv)] as [string, () => void]), ["Cancel", () => {}]]);
});
// Sleep timer (from Musicolet and MediaMonkey): fades out and pauses after a time, or when this song ends.
$("#np-sleep").addEventListener("click", () => {
  const active = (player.sleep_ms ?? 0) > 0 || !!player.sleep_song;
  const set = (minutes: number): [string, () => void] => [`${minutes} minutes`, () => { bridge.send({ type: "sleep", minutes }); toast(`Sleep timer: ${minutes} minutes`); }];
  sheet("Sleep timer", [
    set(15), set(30), set(45), set(60),
    ["When this song ends", () => { bridge.send({ type: "sleep", song: true }); toast("Pauses when this song ends"); }],
    ...(active ? [["Turn the timer off", () => { bridge.send({ type: "sleep", minutes: 0 }); toast("Sleep timer off"); }] as [string, () => void]] : []),
    ["Cancel", () => {}],
  ]);
});
// A-B repeat (from Musicolet): tap once for the start, again for the end (it then loops), a third time to stop.
$("#np-ab").addEventListener("click", () => {
  if (onTv) { toast("A-B repeat works on the phone only"); return; }
  const before = player.ab_a ?? -1, beforeB = player.ab_b ?? -1;
  bridge.send({ type: "ab" });
  toast(before < 0 ? "Start marked: tap again for the end" : beforeB < 0 ? "Looping between the marks" : "A-B repeat off");
});

// A song with no cover shows the dark backing square instead of the browser's broken-image icon.
for (const id of ["mini-cover", "np-cover", "backdrop-image"]) {
  const image = $<HTMLImageElement>(`#${id}`);
  image.addEventListener("error", () => image.classList.add("no-art"));
  image.addEventListener("load", () => image.classList.remove("no-art"));
}

// ---------- Lyrics (saved in the song's tags; synced lines follow the song, plain ones scroll by hand) ----------

function lyricsNote(box: HTMLElement, text: string): void {
  box.classList.add("is-plain");
  box.replaceChildren(el("p", "np-lyrics-note", text));
}

function renderLyrics(): void {
  const box = $("#np-lyrics-box");
  $("#np-art-wrap").classList.toggle("has-lyrics", lyricsShown);
  box.hidden = !lyricsShown;
  $("#np-lyrics").classList.toggle("is-on", lyricsShown);
  if (!lyricsShown) return;
  box.scrollTop = 0;
  if (!lyricsData) return lyricsNote(box, "Looking for lyrics…");
  if (lyricsData.synced && lyricsData.lines.length) {
    box.classList.remove("is-plain");
    box.replaceChildren(...lyricsData.lines.map((line, index) => {
      const p = el("p", undefined, line.text || "♪");
      p.dataset.index = String(index);
      return p;
    }));
    lyricsLine = -2;
    tickLyrics(positionNow(player, stateAt, performance.now()));
  } else if (lyricsData.plain?.trim()) {
    box.classList.add("is-plain");
    box.replaceChildren(...plainLines(lyricsData.plain).map((line) => el("p", undefined, line)));
  } else {
    lyricsNote(box, "This song has no lyrics saved in its tags.");
  }
}

/** Asks the app for the playing song's lyrics (when they are shown and not yet known). */
function wantLyrics(): void {
  if (!lyricsShown || !player.id || lyricsAsked === player.id) return;
  lyricsAsked = player.id;
  lyricsData = null;
  bridge.send({ type: "lyrics", id: player.id });
}

/** Lights the line being sung and keeps it in the middle; called from the clock. */
function tickLyrics(ms: number): void {
  if (!lyricsShown || !lyricsData?.synced) return;
  const line = currentLine(lyricsData.lines, ms);
  if (line === lyricsLine) return;
  lyricsLine = line;
  const box = $("#np-lyrics-box");
  box.querySelectorAll("p").forEach((p, index) => {
    p.classList.toggle("is-now", index === line);
    p.classList.toggle("is-sung", index < line);
  });
  const now = box.children[line] as HTMLElement | undefined;
  if (now) box.scrollTo({ top: now.offsetTop - box.clientHeight / 2 + now.clientHeight / 2, behavior: "smooth" });
}

$("#np-lyrics").addEventListener("click", () => {
  lyricsShown = !lyricsShown;
  try { localStorage.setItem(LYRICS_STORE, lyricsShown ? "1" : "0"); } catch { /* only a convenience */ }
  wantLyrics();
  renderLyrics();
});
// Tapping a synced line jumps the song there.
$("#np-lyrics-box").addEventListener("click", (event) => {
  const p = (event.target as HTMLElement).closest("p");
  const line = p?.dataset.index !== undefined ? lyricsData?.lines[Number(p.dataset.index)] : undefined;
  if (line && lyricsData?.synced) bridge.send({ type: "seek", ms: line.ms });
});

// Bookmarks inside songs (from Musicolet): a place and a note, kept on this phone.
const BOOKMARK_STORE = "mediaverse.phone.bookmarks";
function readBookmarks(): Record<string, Bookmark[]> {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_STORE) ?? "{}") as Record<string, Bookmark[]>; } catch { return {}; }
}
function writeBookmarks(all: Record<string, Bookmark[]>): void {
  try { localStorage.setItem(BOOKMARK_STORE, JSON.stringify(all)); } catch { /* storage unavailable: the bookmark is lost on restart */ }
}
$("#np-bookmarks").addEventListener("click", () => {
  const id = player.id;
  if (!id) return;
  const all = readBookmarks();
  const list = all[id] ?? [];
  const here = Math.round(positionNow(player, stateAt, performance.now()));
  const label = (b: Bookmark): string => `${clock(b.ms / 1000)}${b.note ? ` · ${b.note}` : ""}`;
  sheet("Bookmarks in this song", [
    [`Add a bookmark at ${clock(here / 1000)}`, () => void askName("Note for this bookmark (optional)", "").then((note) => {
      if (note === null) return;
      all[id] = addBookmark(list, here, note);
      writeBookmarks(all);
      toast("Bookmarked");
    })],
    ...list.map((b, i): [string, () => void] => [`Go to ${label(b)}`, () => control("seek", b.ms)]),
    ...(list.length ? [["Remove a bookmark…", () => sheet("Remove which bookmark?", [
      ...list.map((b, i): [string, () => void] => [label(b), () => { all[id] = removeBookmark(list, i); writeBookmarks(all); toast("Bookmark removed"); }]),
      ["Cancel", () => {}],
    ])] as [string, () => void]] : []),
    ["Cancel", () => {}],
  ]);
});

$("#np-eq").addEventListener("click", () => {
  closePlaying();
  switchTab("settings");
});
// Volume of the TV or speaker (Cast devices); the phone's own volume keys still control the phone.
const npVolume = $<HTMLInputElement>("#np-volume");
let volumeTouched = 0;
npVolume.addEventListener("input", () => {
  volumeTouched = performance.now();
  if (onTv && isCastDevice(onTv)) bridge.send({ type: "tvSend", target: onTv.id, command: { action: "volume", level: Number(npVolume.value) / 100 } });
});
function updateVolume(): void {
  const row = $("#np-volume-row");
  const level = onTv?.state?.volume;
  // Cast devices always take volume; a DLNA device only when it has reported one (it has a RenderingControl service).
  const cast = !!onTv && (onTv.id.startsWith("cast:") || (onTv.id.startsWith("dlna:") && level !== undefined));
  row.hidden = !cast;
  if (cast && level !== undefined && performance.now() - volumeTouched > 2000) npVolume.value = String(Math.round(level * 100));
}
const npFavorite = $<HTMLButtonElement>("#np-favorite");
npFavorite.addEventListener("click", () => {
  if (player.id) bridge.send({ type: "favorite", id: player.id, on: !favorites.has(player.id) });
});

function updateFavorite(): void {
  const on = !!player.id && favorites.has(player.id);
  setIcon(npFavorite, "heart", on ? "Favorite: on" : "Favorite: off", 28, on);
  npFavorite.classList.toggle("is-on", on);
}
// ---------- Problem tracks: flag a song, send flags to a Jellyfin server when home (D96) ----------

function readFlags(): Flag[] {
  try {
    const stored = JSON.parse(localStorage.getItem(FLAG_STORE) ?? "[]");
    return Array.isArray(stored) ? (stored as Flag[]) : [];
  } catch {
    return [];
  }
}
function saveFlags(next: Flag[]): void {
  flags = next;
  try { localStorage.setItem(FLAG_STORE, JSON.stringify(next)); } catch { /* kept until the app closes */ }
  updateFlag();
}
/** Songs unflagged on this phone while the server still lists them: not taken back from the server's list until it clears them. */
function readDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_STORE) ?? "[]") as string[]); } catch { return new Set(); }
}
function saveDismissed(keys: Set<string>): void {
  try { localStorage.setItem(DISMISSED_STORE, JSON.stringify([...keys].slice(-500))); } catch { /* only a convenience */ }
}

function deviceId(): string {
  try {
    let id = localStorage.getItem("mediaverse.phone.device-id");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("mediaverse.phone.device-id", id);
    }
    return id;
  } catch {
    return "mediaverse-phone";
  }
}
/** The phone's model ("Pixel 11 Pro") from the browser engine's description, for the inbox playlist's name. */
function deviceLabel(): string {
  const match = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\)|;)/.exec(navigator.userAgent);
  const model = match?.[1]?.trim();
  return model && !/^(K|wv)$/i.test(model) ? model : "Phone";
}

let httpCounter = 0;
const waitingHttp = new Map<string, (reply: HttpReply) => void>();
/** Requests to the home network go through the app (the page is https and may not fetch plain http itself). */
const appHttp: Http = (request) =>
  new Promise((resolve) => {
    const id = String(++httpCounter);
    waitingHttp.set(id, resolve);
    bridge.send({ type: "http", id, ...request });
    setTimeout(() => {
      if (waitingHttp.delete(id)) resolve({ status: -1, body: "No answer" });
    }, (request.timeout ?? 15_000) + 5_000);
  });
const jf = new Jellyfin(appHttp, deviceId(), deviceLabel());

// ---------- Music from the home server (D177) ----------
/** Resolved when the next "library" message arrives: a round reads the phone's music again and waits for it. */
const libraryWaiters: Array<() => void> = [];
const homeSync = createHomeSync({
  bridge,
  jf,
  deviceId: deviceId(),
  deviceLabel: deviceLabel(),
  session: () => jfSession,
  tracks: () => tracks,
  libraryLoaded: () => libraryLoaded,
  reloadLibrary: () =>
    new Promise<void>((resolve) => {
      libraryWaiters.push(resolve);
      bridge.send({ type: "library", reload: true });
      window.setTimeout(resolve, 20_000);
    }),
  playlists: () => playlists,
  setPlaylists: (next) => {
    playlists = next;
    storePlaylists();
  },
  flags: () => flags,
  setFlags: (next) => saveFlags(next),
  runFlagSync: () => runSync(),
  changed: () => {
    const kind = currentPage().kind;
    if (kind === "home" || (kind === "tab" && (currentPage() as { tab: Tab }).tab === "settings")) {
      const top = view.scrollTop;
      render();
      view.scrollTop = top;
    }
  },
  openHome: () => go({ kind: "home" }),
  openPick: (level, artist) => go({ kind: "pick", level, artist }),
  openSettings: () => switchTab("settings"),
  confirm: (title, yes, action) => sheet(title, [[yes, action], ["Cancel", () => undefined]]),
  toast,
});

const npFlag = $<HTMLButtonElement>("#np-flag");
function updateFlag(): void {
  const on = !!player.id && isFlagged(flags, player.id);
  setIcon(npFlag, "flag", on ? "Flagged as a problem track" : "Flag as a problem track", 26, on);
  npFlag.classList.toggle("is-on", on);
}
npFlag.addEventListener("click", () => {
  const track = player.id ? byId.get(player.id) : undefined;
  if (!track) return;
  if (isFlagged(flags, track.id)) {
    const flag = flags.find((f) => f.id === track.id);
    if (flag?.sent !== null && flag) {
      const dismissed = readDismissed();
      dismissed.add(songKey(flag));
      saveDismissed(dismissed);
    }
    saveFlags(removeFlag(flags, track.id));
    toast("Flag removed on this phone");
    return;
  }
  const dismissed = readDismissed();
  if (dismissed.delete(songKey(track))) saveDismissed(dismissed);
  saveFlags(addFlag(flags, { id: track.id, title: track.title, artist: track.artist, album: albumOf.get(track.id)?.title ?? track.album, durationMs: track.duration_ms }, Date.now()));
  toast(jfSession ? "Flagged. Sending to the server…" : "Flagged as a problem track");
  scheduleSync();
});

let syncTimer: number | undefined;
let lastSyncAt = 0;
/** Syncs a few seconds after the last change, so several flags in a row go as one playlist. */
function scheduleSync(): void {
  if (!jfSession) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void runSync(), 4_000);
}

function describeSync(report: SyncReport): string {
  const parts: string[] = [];
  if (report.uploaded) parts.push(`sent ${count(report.uploaded, "flag")} as "${report.inbox}"`);
  if (report.cleared) parts.push(`${count(report.cleared, "flag")} cleared on the computer`);
  if (report.adopted) parts.push(`${count(report.adopted, "flagged song")} added from the server's list`);
  if (report.notOnServer) parts.push(`${count(report.notOnServer, "song")} not found on the server (kept, tried again next time)`);
  return parts.length ? `Synced: ${parts.join("; ")}.` : "Synced: nothing new.";
}

async function runSync(): Promise<void> {
  if (!jfSession || syncing) return;
  syncing = true;
  syncStatus = "Syncing…";
  refreshSettings();
  try {
    const dismissed = readDismissed();
    const library = tracks.filter((t) => !dismissed.has(songKey(t))).map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: albumOf.get(t.id)?.title ?? t.album }));
    const report = await syncFlags(jf, jfSession, flags, library, deviceLabel(), new Date());
    saveFlags(report.flags);
    lastSyncAt = Date.now();
    syncStatus = describeSync(report);
  } catch (error) {
    if (error instanceof JellyfinProblem && error.kind === "signed_out") {
      jfSession = null;
      saveSession(null);
      syncStatus = "Jellyfin no longer accepts this phone. Sign in again.";
    } else if (error instanceof JellyfinProblem && error.kind === "unreachable") {
      syncStatus = "The server is not reachable (away from home?). Flags are kept and sent when it is.";
    } else {
      syncStatus = error instanceof Error ? error.message : "Syncing did not work.";
    }
  } finally {
    syncing = false;
    refreshSettings();
  }
}

/** Sync when the app comes back to the front or the phone gets a network, at most once a minute. */
function syncSoon(): void {
  if (jfSession && Date.now() - lastSyncAt > 60_000) scheduleSync();
  homeSync.autoSoon();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncSoon(); });
window.addEventListener("online", syncSoon);

/** Redraws Settings when a sync or sign-in changes something, keeping the place the person scrolled to. */
function refreshSettings(): void {
  if (currentPage().kind === "tab" && (currentPage() as { tab: Tab }).tab === "settings") {
    const top = view.scrollTop;
    render();
    view.scrollTop = top;
  }
}

let connecting: { stopped: boolean } | null = null;
async function connectJellyfin(host: string): Promise<void> {
  connecting = { stopped: false };
  const mine = connecting;
  syncStatus = "Looking for the server…";
  jfCode = "";
  refreshSettings();
  try {
    const server = await jf.probe(host);
    if (!server) {
      syncStatus = "No Jellyfin server answered at that address. Check it and that the phone is on the home Wi-Fi.";
      return;
    }
    syncStatus = `Found ${server.name}. In Jellyfin on another device, open your profile menu, choose Quick Connect and enter the code:`;
    const session = await jf.quickConnect(server, (code) => { jfCode = code; refreshSettings(); }, mine);
    if (!session) {
      syncStatus = mine.stopped ? "Cancelled." : "The code was not approved in time.";
      return;
    }
    jfSession = session;
    saveSession(session);
    jfCode = "";
    syncStatus = `Signed in to ${session.name}.`;
    refreshSettings();
    void runSync();
  } catch (error) {
    syncStatus = error instanceof Error ? error.message : "Signing in did not work.";
  } finally {
    jfCode = "";
    if (connecting === mine) connecting = null;
    refreshSettings();
  }
}

function flagSettings(): HTMLElement {
  const box = el("div");
  box.append(el("h2", undefined, "Problem tracks"));
  box.append(el("p", "hint", "Flag a song on Now Playing (the flag beside the heart) when it sounds wrong. Flags are sent to your Jellyfin server when you are home, so you can listen to them and fix them at the computer. Only the song is sent, not a reason."));
  const waiting = flags.filter((f) => f.sent === null).length;
  const list = el("button", "switch-row");
  list.type = "button";
  const text = el("span", "row-text");
  text.append(el("span", "row-title", `Flagged on this phone: ${flags.length}`), el("span", "row-sub", waiting ? `${waiting} not sent yet. Tap to see them.` : flags.length ? "All sent. Tap to see them." : "Nothing flagged."));
  list.append(text);
  list.addEventListener("click", () => {
    if (!flags.length) return toast("Nothing flagged");
    sheet("Flagged songs (tap to remove)", [...flags].reverse().slice(0, 12).map((f): [string, () => void] => [`${f.title}${f.artist ? ` · ${f.artist}` : ""}${f.sent === null ? " (waiting)" : ""}`, () => saveFlags(removeFlag(flags, f.id))]));
  });
  box.append(list);

  box.append(el("h2", undefined, "Jellyfin server"));
  if (jfSession) {
    box.append(el("p", "hint", `Signed in to ${jfSession.name} (${jfSession.base.replace("http://", "")}).`));
    const sync = el("button", "switch-row");
    sync.type = "button";
    const syncText = el("span", "row-text");
    syncText.append(el("span", "row-title", syncing ? "Syncing…" : "Sync now"), el("span", "row-sub", syncStatus || "Sends new flags and brings back the computer's changes."));
    sync.append(syncText);
    sync.addEventListener("click", () => void runSync());
    const out = el("button", "switch-row");
    out.type = "button";
    const outText = el("span", "row-text");
    outText.append(el("span", "row-title", "Sign out"), el("span", "row-sub", "This phone stops using the server. Flags stay on the phone."));
    out.append(outText);
    out.addEventListener("click", () => {
      jfSession = null;
      saveSession(null);
      syncStatus = "";
      refreshSettings();
    });
    box.append(sync, out);
  } else {
    box.append(el("p", "hint", "Connect to Jellyfin on your home network. Enter the server's address, then approve a code in Jellyfin (Quick Connect): nothing to type on the phone."));
    const field = el("input", "tv-name");
    field.type = "text";
    field.placeholder = "Server address, for example 192.168.1.20";
    field.value = lastHost();
    field.setAttribute("aria-label", "Jellyfin server address");
    field.setAttribute("autocapitalize", "off");
    const connect = el("button", "switch-row");
    connect.type = "button";
    const connectText = el("span", "row-text");
    connectText.append(el("span", "row-title", connecting ? "Cancel" : "Connect"), el("span", "row-sub", ""));
    connect.append(connectText);
    connect.addEventListener("click", () => {
      if (connecting) {
        connecting.stopped = true;
        return;
      }
      rememberHost(field.value);
      void connectJellyfin(field.value);
    });
    box.append(field, connect);
    if (syncStatus) box.append(el("p", "hint", syncStatus));
    if (jfCode) box.append(el("p", "address", jfCode));
  }
  return box;
}
const HOST_STORE = "mediaverse.phone.jellyfin-host";
function lastHost(): string {
  try { return localStorage.getItem(HOST_STORE) ?? ""; } catch { return ""; }
}
function rememberHost(host: string): void {
  try { localStorage.setItem(HOST_STORE, host.trim()); } catch { /* only a convenience */ }
}

$("#np-previous").append(icon("previous", { size: 32, filled: true }));
$("#np-previous").setAttribute("aria-label", "Previous");
$("#np-next-button").append(icon("next", { size: 32, filled: true }));
$("#np-next-button").setAttribute("aria-label", "Next");
$("#np-close").append(icon("back", { size: 26 }));
$("#np-close").classList.add("np-down");

function setIcon(button: HTMLButtonElement, name: IconName, label: string, size: number, filled = false): void {
  if (button.dataset.icon === name + label) return;
  button.dataset.icon = name + label;
  button.replaceChildren(icon(name, { size, filled }));
  button.setAttribute("aria-label", label);
  button.title = label;
}

// Dragging the position: the bar follows the finger; the song moves when it is let go.
const seek = $<HTMLInputElement>("#np-seek");
let seeking = false;
seek.addEventListener("input", () => {
  seeking = true;
  $("#np-elapsed").textContent = clock((Number(seek.value) / 1000) * (player.duration / 1000));
});
seek.addEventListener("change", () => {
  control("seek", Math.round((Number(seek.value) / 1000) * player.duration));
  seeking = false;
});

function openPlaying(): void {
  if (!player.id) return;
  $("#playing").hidden = false;
  document.body.classList.add("is-playing-open");
  startVisualizer();
  tick();
}

function closePlaying(): void {
  $("#playing").hidden = true;
  document.body.classList.remove("is-playing-open");
  if (location.hash) history.replaceState(null, "", location.pathname);
}

function updateNowPlaying(songChanged: boolean): void {
  const track = player.id ? byId.get(player.id) : undefined;
  $("#mini").hidden = !track;
  document.body.classList.toggle("has-mini", !!track);
  setIcon(miniPlay, player.playing ? "pause" : "play", player.playing ? "Pause" : "Play", 28, true);
  setIcon(npPlay, player.playing ? "pause" : "play", player.playing ? "Pause" : "Play", 40, true);
  setIcon(npShuffle, "shuffle", player.shuffle ? "Shuffle: on" : "Shuffle: off", 26);
  npShuffle.classList.toggle("is-on", player.shuffle);
  setIcon(npRepeat, player.repeat === "one" ? "repeat-one" : "repeat", `Repeat: ${player.repeat === "off" ? "off" : player.repeat === "all" ? "all" : "this song"}`, 26);
  npRepeat.classList.toggle("is-on", player.repeat !== "off");
  updateFavorite();
  updateFlag();
  const abA =player.ab_a ?? -1, abB = player.ab_b ?? -1;
  $("#np-ab").textContent = abA < 0 ? "A-B repeat" : abB < 0 ? `A at ${clock(abA / 1000)}` : `Loop ${clock(abA / 1000)}–${clock(abB / 1000)}`;
  $("#np-ab").classList.toggle("is-on", abA >= 0);
  $("#np-sleep").textContent = player.sleep_song ? "Sleep: end of this song" : (player.sleep_ms ?? 0) > 0 ? `Sleep in ${countdown(player.sleep_ms!)}` : "Sleep timer";
  if (!track) {
    if (!$("#playing").hidden) closePlaying();
    return;
  }
  // While a TV or speaker plays, the bar says where (owner, 2026-11-11); refreshed each time, not only on a new song.
  const albumTitle = albumOf.get(track.id)?.title ?? track.album ?? "";
  const artistAlbum = [track.artist, albumTitle].filter(Boolean).join(" · ");
  $("#mini-artist").textContent = onTv ? `On ${tvName(onTv)}${artistAlbum ? ` · ${artistAlbum}` : ""}` : artistAlbum;
  if (songChanged) {
    const album = albumOf.get(track.id);
    ($("#mini-cover") as HTMLImageElement).src = coverUrl(track.id, 192);
    $("#mini-title").textContent = track.title;
    ($("#np-cover") as HTMLImageElement).src = coverUrl(track.id, 800);
    ($("#backdrop-image") as HTMLImageElement).src = coverUrl(track.id, 320);
    $("#np-title").textContent = track.title;
    $("#np-artist").textContent = track.artist ?? "";
    $("#np-album").textContent = [album?.title ?? track.album, track.year].filter(Boolean).join(" · ");
    if (!onTv) $("#np-from").textContent = album ? album.title : "Now playing";
    takePalette(track.id);
    lyricsAsked = null;
    lyricsData = null;
    wantLyrics();
    renderLyrics();
    if (!$("#playing").hidden) startVisualizer();
    // The playing song stands out in whatever list is showing (the queue marks its own rows).
    if (currentPage().kind !== "tab" || (currentPage() as { tab: Tab }).tab !== "queue") {
      for (const row of view.querySelectorAll<HTMLElement>(".row.song[data-id]")) row.classList.toggle("is-current", row.dataset.id === track.id);
    }
  }
  const list = queueInPlayOrder(queue, order);
  const at = list.findIndex((entry) => entry.index === player.index);
  const next = at >= 0 ? list[at + 1] ?? (player.repeat === "all" ? list[0] : undefined) : undefined;
  const nextTrack = next ? byId.get(next.id) : undefined;
  $("#np-next").textContent = nextTrack ? `Next: ${nextTrack.title}${nextTrack.artist ? ` · ${nextTrack.artist}` : ""}` : "";
  $("#mini-up-next").textContent = nextTrack ? `Next: ${nextTrack.title}` : "";
  tick();
}

/** The clock and bars, between the app's updates too. */
function tick(): void {
  const position = positionNow(player, stateAt, performance.now());
  const fraction = player.duration > 0 ? position / player.duration : 0;
  $("#mini-bar").style.width = `${(fraction * 100).toFixed(2)}%`;
  if (!$("#playing").hidden && !seeking) {
    seek.value = String(Math.round(fraction * 1000));
    seek.style.setProperty("--done", `${(fraction * 100).toFixed(2)}%`);
    $("#np-elapsed").textContent = clock(position / 1000);
    $("#np-duration").textContent = player.duration ? clock(player.duration / 1000) : "";
    tickLyrics(position);
  }
}
setInterval(() => {
  if (player.playing && !document.hidden) tick();
}, 250);
// Coming back to the app: the screen catches up and the visualizer starts again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (player.playing) tick();
  if (!$("#playing").hidden) startVisualizer();
});

// ---------- The visualizer (the TV app's, fed from the phone's own copy of the song) ----------

const canvas = $<HTMLCanvasElement>("#np-vis");
const pen = canvas.getContext("2d")!;
const levels = new Float32Array(BANDS);
const peaks = new Float32Array(BANDS);
let spectrum: Spectrum | null = null;
let analysis = { stopped: true };
let analysedId: string | null = null;
let palette: Palette = chosenPalette;
let targetPalette: Palette = chosenPalette;
let visFrame = 0;
let lastDrawn = 0;

function startVisualizer(): void {
  const id = player.id;
  if (id && id !== analysedId) {
    analysis.stopped = true;
    spectrum = null;
    analysedId = id;
    const mine = (analysis = { stopped: false });
    void analyseSong(`/media/audio/${encodeURIComponent(id)}`, mine, (found) => {
      if (!mine.stopped && player.id === id) spectrum = found;
    }, analyseInBackground);
  }
  if (!visFrame) visFrame = requestAnimationFrame(drawVisualizer);
}

/**
 * Kept cool for the phone (heat pass, 2026-11-17), as on the TV: at most 30 drawings a second whatever the screen's refresh
 * rate (the Pixel's screen runs at 120 Hz, and this used to draw on every one of those), nothing drawn while the page is
 * hidden, and the loop ends once the song is paused and the bars have settled (the next state message starts it again).
 */
function drawVisualizer(now: number): void {
  visFrame = 0;
  if ($("#playing").hidden || document.hidden) {
    lastDrawn = 0;
    return;
  }
  const elapsed = lastDrawn ? now - lastDrawn : VIS_FRAME_MS; // the first frame is always drawn
  if (elapsed < VIS_FRAME_MS) {
    visFrame = requestAnimationFrame(drawVisualizer); // not time for the next one yet
    return;
  }
  lastDrawn = now;
  const steps = Math.min(elapsed, 100) / 16.7;
  const rise = 1 - 0.4 ** steps;
  const fall = 0.9 ** steps;
  const peakFall = 0.006 * steps;
  const frame = spectrum && player.playing ? frameAt(spectrum, positionNow(player, stateAt, performance.now()) / 1000) : null;
  let moving = false;
  for (let b = 0; b < BANDS; b++) {
    const target = frame && frame.length ? frame[b] / 255 : 0;
    levels[b] = target > levels[b] ? levels[b] + (target - levels[b]) * rise : levels[b] * fall;
    peaks[b] = Math.max(levels[b], peaks[b] - peakFall);
    if (levels[b] > 0.002 || peaks[b] > 0.002) moving = true;
  }
  if (palette !== targetPalette) palette = mixPalette(palette, targetPalette, 1 - 0.97 ** steps);
  drawStyle(pen, "mirror", levels, peaks, palette, now / 1000);
  if (moving || player.playing) visFrame = requestAnimationFrame(drawVisualizer);
  else lastDrawn = 0;
}

/** The visualizer's colours from the album cover, as on the TV. */
function takePalette(id: string): void {
  const image = new Image();
  image.onload = () => {
    try {
      const small = document.createElement("canvas");
      small.width = small.height = 24;
      const context = small.getContext("2d")!;
      context.drawImage(image, 0, 0, 24, 24);
      const read = paletteFromPixels(context.getImageData(0, 0, 24, 24).data);
      targetPalette = read === DEFAULT_PALETTE ? chosenPalette : read;
    } catch {
      targetPalette = chosenPalette;
    }
  };
  image.onerror = () => (targetPalette = chosenPalette);
  image.src = coverUrl(id, 96);
}

// ---------- Start ----------

bridge.send({ type: "hello" });
