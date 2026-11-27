// MediaVerse Studio for TVs (D38): browse and play the library shared by MediaVerse Studio on the computer,
// with a TV remote. Runs as a Samsung Tizen web app (config.xml in tv/public) and, for testing, in any
// Chromium window at 1920 x 1080 with the keyboard (arrows, Enter, Escape/Backspace, space).

import { currentLine, plainLines, sortedLines, type TrackLyrics } from "../src/lyrics-format.ts";
import { audioUrl, coverUrl, discover, fetchLibrary, fetchLyrics, fetchPlaylists, type ServerPlaylist, finishPairing, hello, neighbours, postRemoteState, savedConnection, saveConnection, ShareError, startPairing, waitForCommands, type Connection, type Found, type RemoteCommand } from "./api.ts";
import { readSavedPosition, readSavedQueue, restoreQueue, snapshotQueue, type SavedPosition, type SavedQueue } from "./queue-memory.ts";
import { allSongs, buildAlbums, buildArtists, buildGenres, buildGuestArtists, clock, indexLetter, searchLibrary, shuffledOrder, type Album, type Artist, type Genre, type ServerTrack } from "./library.ts";
import { computerMarks, driveMarks, FLAG_REASONS, forListener, jellyfinMarks, type FlagReason, type Marks, type MarkStore } from "./marks.ts";
import { addProfile, canAddProfile, lastProfile, listProfiles, PROFILE_COLOURS, profileFavorites, rememberProfile, removeProfile, renameProfile, type Profile } from "./profiles.ts";
import { shareFlagLists } from "../src/jellyfin-profiles.ts";
import { playedThreshold } from "../src/home-format.ts";
import { commandOf, directionOf, nextInDirection } from "./spatial.ts";
import { analyseSong, BANDS, frameAt, type Spectrum } from "./spectrum.ts";
import { analyseInBackground } from "./spectrum-thread.ts";
import { createCycle, makeFlipTile, startTurning, wallSizes } from "../src/cover-flip.ts";
import { nextGlow, type GlowState } from "../src/visualizer-math.ts";
import { icon, type IconName } from "../src/icons.ts";
import { bassBands, bodyEnd, css, DEFAULT_PALETTE, drawStyle, mixPalette, paletteFromPixels, STYLES, VIS_FRAME_MS, VIS_IDLE_FRAME_MS, type Palette, type Style } from "./visuals.ts";
import { ACCENT_CHOICES, applyAccent, loadAccent, paletteFromHex, saveAccent } from "./accent-choices.ts";
import { DRIFT_SWATCH, applyMask, loadMask, saveMask, type MaskPrefs } from "./background-mask.ts";
import { cachedDrive, listDrives, rememberDrive, scanDrive, watchDrives, type Drive, type DriveLibrary } from "./usb.ts";
import { fetchJellyfinLibrary,
  fetchJellyfinLyrics,
  JellyfinError,
  jellyfinAudioUrl,
  jellyfinCoverUrl,
  jellyfinPlaylists,
  probeJellyfin,
  quickConnect,
  savedJellyfin,
  saveJellyfin,
  type JellyfinServer,
  type JellyfinSession, flagListClient, jellyfinProfiles, jellyfinRecentlyPlayed, markJellyfinPlayed, setJellyfinFavorite, signInProfile, type JellyfinUser } from "./jellyfin.ts";

// ---------- Tizen glue (absent when testing in a browser) ----------

type TizenGlobal = {
  tvinputdevice?: { registerKeyBatch(keys: string[], ok?: () => void, fail?: (e: unknown) => void): void };
  application?: { getCurrentApplication(): { exit(): void } };
  power?: { request(resource: "SCREEN", state: "SCREEN_NORMAL"): void; release(resource: "SCREEN"): void };
};
const tizen = (window as unknown as { tizen?: TizenGlobal }).tizen;

function registerRemoteKeys(): void {
  const keys = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaTrackNext", "MediaTrackPrevious", "MediaFastForward", "MediaRewind", "ChannelUp", "ChannelDown", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  try {
    tizen?.tvinputdevice?.registerKeyBatch(keys, undefined, () => undefined);
  } catch {
    // Older firmware: arrows, OK and Return still work.
  }
}

type AppCommon = { setScreenSaver(state: unknown, ok?: () => void, fail?: () => void): void; AppCommonScreenSaverState: { SCREEN_SAVER_ON: unknown; SCREEN_SAVER_OFF: unknown } };

/**
 * Keeps the TV's screen saver away while music plays (Samsung's AppCommon API) and allows it again when the
 * music stops. The app looks after the OLED screen itself meanwhile (drift, changing sides, dimming).
 */
/** Whether the Tizen Power API's "keep the screen on" request is held. */
let screenHeld = false;

function holdScreenSaver(playing: boolean): void {
  // The Tizen Power API as well (owner, 2026-11-05: the screen saver still came after about a minute of music with
  // lyrics): a plain "keep the screen on" while music plays, released when it stops. Ignored where unsupported.
  try {
    if (playing && !screenHeld) {
      tizen?.power?.request("SCREEN", "SCREEN_NORMAL");
      screenHeld = true;
    } else if (!playing && screenHeld) {
      tizen?.power?.release("SCREEN");
      screenHeld = false;
    }
  } catch {
    // no Power API or no permission: the other two ways remain
  }
  try {
    const common = (window as unknown as { webapis?: { appcommon?: AppCommon } }).webapis?.appcommon;
    if (!common) return;
    const state = playing ? common.AppCommonScreenSaverState.SCREEN_SAVER_OFF : common.AppCommonScreenSaverState.SCREEN_SAVER_ON;
    common.setScreenSaver(state, undefined, () => undefined);
  } catch {
    // older firmware: the TV's own screen saver timing applies
  }
}

/**
 * The one rule for the TV's screen saver: held off only while music plays on Now Playing (the moving picture
 * looks after the OLED screen there). Paused, or on any other screen, the TV's own screen saver applies.
 *
 * READ docs/tv-screen-saver.md FIRST. On Samsung OLED TVs the panel's own screen saver (2 minutes of a still
 * picture) ignores AppCommon and the Power API; only playback in Samsung's AVPlay holds it off. So a silent black
 * clip loops through AVPlay while music plays (startNativeClip, D70). The HTML <video> clip below is only the
 * fallback where AVPlay is missing: on the S95F it stood still at 0.1 s during music, and starting it while the
 * AVPlay clip runs freezes AVPlay. Letting the screen saver back means releasing the clip completely (owner,
 * 2026-11-03: a paused clip that stays loaded still kept it away).
 */
const keepAwakeClip = document.querySelector<HTMLVideoElement>("#keep-awake");
const KEEP_AWAKE_SOURCE = "keep-awake.mp4";
let keepAwakeRefused = false;
// Measured on the living room TV (2026-11-04): the clip's `loop` is not honoured. It played its 4 s once and then sat
// on the last frame, still "playing", so the TV saw no video and its screen saver came during music. It is looped
// here instead: back to the start just before the end (and if it ends anyway).
keepAwakeClip?.addEventListener("timeupdate", () => {
  const clip = keepAwakeClip;
  if (clip.duration > 1 && clip.currentTime > clip.duration - 0.6) clip.currentTime = 0;
});
keepAwakeClip?.addEventListener("ended", () => {
  keepAwakeClip.currentTime = 0;
  void keepAwakeClip.play().catch(() => undefined);
});
keepAwakeClip?.addEventListener("error", () => {
  if (keepAwakeClip.getAttribute("src")) keepAwakeRefused = true;
});

/**
 * The keep-awake clip through Samsung's own player, AVPlay (2026-11-06). The OLED panel's screen saver (2 minutes
 * of a still picture; apps cannot switch it off) is held off by media playing in Samsung's player, not by the
 * page's own <video>: measured on the bedroom TV, the HTML clip said "playing" but stood still at 0.1 s while the
 * music played, so with lyrics (a nearly still picture) the screen saver came. Another Tizen app found the same
 * and a tester confirmed an AVPlay clip fixed it (tessel-tizen-tv issue #132). On the bedroom TV an AVPlay clip
 * plays and loops alongside the music and across song changes, as long as the HTML clip is not started too (that
 * froze it). It sits under the page, which covers it. The HTML clip stays as the fallback where AVPlay is missing.
 */
type AvPlay = {
  open(url: string): void;
  close(): void;
  stop(): void;
  play(): void;
  seekTo(ms: number): void;
  prepareAsync(ok: () => void, fail: (error: unknown) => void): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setListener(listener: { onstreamcompleted?: () => void; onerror?: (error: unknown) => void }): void;
  getState(): string;
  getCurrentTime(): number;
};
const avplay = (window as unknown as { webapis?: { avplay?: AvPlay } }).webapis?.avplay;
/** The clip's address in the installed app, found once at start (AVPlay needs a real file address). */
let nativeClipPath: string | null = null;
let nativeClip: "off" | "starting" | "on" | "failed" = avplay ? "off" : "failed";
let nativeClipLastTime = -1;
try {
  const fs = (window as unknown as { tizen?: { filesystem?: { resolve(where: string, ok: (dir: { toURI(): string }) => void, fail: () => void, mode: string): void } } }).tizen?.filesystem;
  if (avplay && fs) {
    fs.resolve("wgt-package", (dir) => {
      nativeClipPath = `${dir.toURI()}/${KEEP_AWAKE_SOURCE}`;
      if (!audio.paused) keepAwake();
    }, () => (nativeClip = "failed"), "r");
  } else {
    nativeClip = "failed";
  }
} catch {
  nativeClip = "failed";
}

/** Whether the AVPlay clip is (or may become) the keep-awake: then the HTML clip must stay unloaded. */
function nativeClipUsable(): boolean {
  return nativeClip !== "failed" && !!avplay;
}

function stopNativeClip(): void {
  if (!avplay || nativeClip === "off" || nativeClip === "failed") return;
  try {
    avplay.stop();
  } catch {
    // already stopped
  }
  try {
    avplay.close();
  } catch {
    // already closed
  }
  nativeClip = "off";
  nativeClipLastTime = -1;
}

function startNativeClip(): void {
  if (!avplay || !nativeClipPath || nativeClip === "starting" || nativeClip === "on" || nativeClip === "failed") return;
  const player = avplay;
  nativeClip = "starting";
  try {
    try {
      player.close();
    } catch {
      // nothing open
    }
    player.open(nativeClipPath);
    player.setListener({
      onstreamcompleted: () => {
        try {
          player.seekTo(0);
          player.play();
        } catch {
          // the watchdog restarts it
        }
      },
    });
    player.setDisplayRect(0, 0, 1920, 1080);
    player.prepareAsync(
      () => {
        if (nativeClip !== "starting") return; // stopped meanwhile
        try {
          player.play();
          nativeClip = "on";
        } catch {
          nativeClip = "off";
        }
      },
      () => {
        nativeClip = "failed"; // the HTML clip takes over
        keepAwake();
      },
    );
  } catch {
    nativeClip = "failed";
  }
}

/** Every 10 s while music plays: a native clip that is not moving (paused by the TV, frozen) is started afresh. */
function checkNativeClip(): void {
  if (!avplay || nativeClip !== "on") return;
  let state = "";
  let time = -1;
  try {
    state = avplay.getState();
    time = avplay.getCurrentTime();
  } catch {
    // treated as stopped
  }
  if (state !== "PLAYING" || time === nativeClipLastTime) {
    stopNativeClip();
    startNativeClip();
    return;
  }
  nativeClipLastTime = time;
}

document.addEventListener("visibilitychange", () => {
  // Samsung's player must let go while the app is in the background; it comes back with the music.
  if (document.hidden) stopNativeClip();
  else keepAwake();
});

let keepAwakeTimer: number | undefined;
/** True from asking for music until it is asked of the player (the keep-awake clip starts first). */
let musicStarting = false;

function keepAwake(): void {
  // Held off whenever music plays, on any screen (owner, 2026-11-04: Now Playing is its own screen saver, and the
  // app returns to it after 20 s without the remote).
  const wanted = !audio.paused || musicStarting; // starting: the clip goes first, the music follows
  holdScreenSaver(wanted);
  if (nativeClipUsable()) {
    if (wanted && !document.hidden) startNativeClip();
    else if (!wanted) stopNativeClip();
    return;
  }
  if (!keepAwakeClip || keepAwakeRefused) return;
  clearTimeout(keepAwakeTimer);
  if (wanted) {
    // The clip is started by playMusic, before the music: started while the music plays it never loads.
  } else if (keepAwakeClip.getAttribute("src")) {
    keepAwakeClip.pause();
    keepAwakeClip.removeAttribute("src");
    keepAwakeClip.load(); // releases the TV's video player, so the screen saver can come back
  }
}

/**
 * Starts the music, with the keep-awake clip playing first. Measured on the living room TV (2026-11-04): the
 * clip never loads if it is started while the music already plays (it sat "loading" with no data, so the TV saw
 * no video and its screen saver came during music), but started first it plays, and keeps playing alongside the
 * music. So the clip starts, the music follows once the clip plays (at most 1.5 s), and the clip stays loaded
 * across songs until a pause has lasted 3 s.
 */
function playMusic(): void {
  const go = (): void => {
    musicStarting = false;
    void audio.play().catch(() => undefined);
  };
  const clip = keepAwakeClip;
  if (nativeClipUsable() || !clip || keepAwakeRefused || (!clip.paused && clip.readyState >= 2)) {
    go(); // Samsung's player: it runs alongside the music, started by keepAwake when the music plays
    return;
  }
  musicStarting = true;
  clearTimeout(keepAwakeTimer);
  // A clip left half-loaded (started while music played) never recovers: start it afresh.
  if (clip.getAttribute("src") && clip.readyState < 2) {
    clip.removeAttribute("src");
    clip.load();
  }
  if (!clip.getAttribute("src")) clip.src = KEEP_AWAKE_SOURCE;
  clip.muted = true;
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    go();
  };
  clip.addEventListener("playing", start, { once: true });
  window.setTimeout(start, 1_500);
  clip.play().catch(() => {
    keepAwakeRefused = true;
    start();
  });
}

function exitApp(): void {
  try {
    tizen?.application?.getCurrentApplication().exit();
  } catch {
    // In a browser there is nothing to exit.
  }
}

// ---------- Elements ----------

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const screens = { connect: $("#connect"), who: $("#who"), browse: $("#browse"), playing: $("#playing") };
const view = $("#view");
const audio = $<HTMLAudioElement>("#audio");
const toastBox = $("#toast");
const dim = $("#dim");

type ScreenName = keyof typeof screens;
let screen: ScreenName = "connect";

/** While "Who's listening?" is up, other screens wait behind it (the library keeps loading meanwhile). */
let choosingListener = false;
let afterChoosing: ScreenName | null = null;

function showScreen(name: ScreenName): void {
  if (choosingListener && name !== "who") {
    afterChoosing = name;
    return;
  }
  screen = name;
  for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
  document.body.dataset.screen = name;
  keepAwake();
  // The idle timers belong to the screen now showing. A key press arms them for the screen it was pressed on, so
  // Back from Now Playing left the list with none and it never went back to Now Playing (owner, 2026-11-04).
  // Deferred: wake() uses timers declared further down, and a screen can be shown while the app starts.
  window.setTimeout(wake, 0);
}

let toastTimer: number | undefined;
function toast(message: string, ms = 3500): void {
  toastBox.textContent = message;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastBox.hidden = true), ms);
}

// ---------- Focus and remote-control movement ----------

function focusables(): HTMLElement[] {
  // An open window (the flag chooser) keeps the highlight inside it.
  const modal = screens[screen].querySelector<HTMLElement>(".modal:not([hidden])");
  return [...(modal ?? screens[screen]).querySelectorAll<HTMLElement>(".f")].filter((el) => !el.closest("[hidden]") && !(el as HTMLButtonElement).disabled);
}

function focus(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  element.dispatchEvent(new CustomEvent("tv-focus"));
}

function current(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  return active && active.classList.contains("f") && screens[screen].contains(active) ? active : null;
}

function move(direction: "up" | "down" | "left" | "right"): void {
  const items = focusables();
  const from = current();
  if (!from) {
    focus(items[0]);
    return;
  }
  const others = items.filter((el) => el !== from);
  const index = nextInDirection(from.getBoundingClientRect(), others.map((el) => el.getBoundingClientRect()), direction);
  if (index >= 0) focus(others[index]);
}

/** Moves about one screen up or down in a long list (the remote's channel rocker). */
function page(direction: 1 | -1): void {
  const from = current();
  if (!from) return;
  const items = focusables().filter((el) => view.contains(el));
  const at = items.indexOf(from);
  if (at < 0) return;
  const top = from.getBoundingClientRect().top;
  const target = top + direction * view.clientHeight * 0.85;
  let best = at;
  for (let i = at; i >= 0 && i < items.length; i += direction) {
    best = i;
    const y = items[i].getBoundingClientRect().top;
    if (direction > 0 ? y >= target : y <= target) break;
  }
  focus(items[best]);
}

// ---------- Finding the computer and pairing ----------

let connection: Connection | null = savedConnection();
let computerName = connection?.computer ?? "";

type ConnectPanel = "sources" | "manual" | "pair" | "jellyfin";
let panel: ConnectPanel = "sources";
const typed = { host: "", code: "" };
/** The computer being paired with. */
let pairingWith: Found | null = null;
let search: { stopped: boolean } | null = null;
const foundComputers = new Map<string, Found>();
let drives: Drive[] = [];
/** The USB drive being played from, or null when the music comes from the computer. */
let drive: { drive: Drive; library: DriveLibrary } | null = null;

/** The Jellyfin server being played from, or null. */
let jelly: JellyfinSession | null = null;
/** The profiles of the Jellyfin server in use (D213), when it has any; and the one picked. */
let serverProfiles: { server: { base: string; name: string; serverId: string }; users: JellyfinUser[] } | null = null;
let serverProfile: string | null = null;
const SERVER_PROFILE = "mediaverse.tv.jellyfin.profile";
const foundJellyfin = new Map<string, JellyfinServer>(); // by server ID
let signIn: { stopped: boolean } | null = null;

const LAST_SOURCE = "mediaverse.tv.last-source";
function rememberSource(kind: "computer" | "jellyfin" | "usb"): void {
  try {
    localStorage.setItem(LAST_SOURCE, kind);
  } catch {
    // the computer is tried first next time
  }
}
function lastSource(): string | null {
  try {
    return localStorage.getItem(LAST_SOURCE);
  } catch {
    return null;
  }
}

/** Where a song plays from: its file on the drive, Jellyfin, or the computer's address for it. */
function trackAudio(track: ServerTrack): string | null {
  if (drive) return drive.library.audio.get(track.id) ?? null;
  if (jelly) return jellyfinAudioUrl(jelly, track.id);
  return connection ? audioUrl(connection, track.id) : null;
}

/** A song's cover: the folder's picture on the drive, or a copy of `size` pixels from the server. */
function trackCover(track: ServerTrack, size: number): string | null {
  if (drive) return drive.library.covers.get(track.cover_key) ?? null;
  if (jelly) return jellyfinCoverUrl(jelly, track, size);
  return connection ? coverUrl(connection, track.id, size) : null;
}

function trackLyrics(track: ServerTrack): Promise<TrackLyrics> {
  if (jelly) return fetchJellyfinLyrics(jelly, track.id);
  if (connection && !drive) return fetchLyrics(connection, track.id);
  return Promise.reject(new Error("no lyrics on drives yet"));
}

/** Signs in to a Jellyfin server with Quick Connect (or reuses this TV's earlier sign-in there). */
async function chooseJellyfin(server: JellyfinServer): Promise<void> {
  stopSearching();
  if (driveScan) driveScan.stopped = true;
  const saved = savedJellyfin();
  if (saved && saved.serverId === server.id) {
    await enterJellyfin({ ...saved, base: server.base, name: server.name });
    return;
  }
  showPanel("jellyfin");
  $("#jf-title").textContent = `Sign in to ${server.name}`;
  $("#jf-code").textContent = "· · · · · ·";
  const status = $("#jf-status");
  status.textContent = "Asking Jellyfin for a code…";
  focus($("#jf-cancel"));
  if (signIn) signIn.stopped = true;
  const mine = (signIn = { stopped: false });
  try {
    const session = await quickConnect(
      server,
      (code) => {
        $("#jf-code").textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
        status.textContent = "Waiting for you to enter the code in Jellyfin…";
      },
      mine,
    );
    if (mine.stopped) return;
    if (!session) {
      status.textContent = "The code has expired. Choose the server again for a new one.";
      return;
    }
    saveJellyfin(session);
    await enterJellyfin(session);
  } catch (error) {
    if (!mine.stopped) status.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Looks for the server's profiles: with some, "Who's listening?" is asked; with none, the TV's own sign-in is used. */
async function enterJellyfin(session: JellyfinSession): Promise<void> {
  const users = await jellyfinProfiles(session.base).catch(() => []);
  if (!users.length) {
    serverProfiles = null;
    serverProfile = null;
    await openJellyfin(session);
    return;
  }
  serverProfiles = { server: { base: session.base, name: session.name, serverId: session.serverId }, users };
  listener = null;
  openPicker(!albums.length); // from a library already open, Back returns to where it was
}

/** A profile was picked: sign in to it, carry over what this TV kept for a person of that name, and show its music. */
async function chooseServerProfile(name: string): Promise<void> {
  const at = serverProfiles?.server;
  if (!at) return;
  const hint = $("#who-hint");
  hint.textContent = `Opening ${name}…`;
  let session: JellyfinSession;
  try {
    session = await signInProfile(at, name);
  } catch (error) {
    hint.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  await carryFavorites(session, name);
  const same = jelly?.serverId === session.serverId && songs.length > 0;
  const switching = serverProfile !== null && serverProfile !== name;
  if (same && switching) {
    // The same library, another person: their music stops here and theirs comes back.
    rememberQueue();
    audio.pause();
    queue = [];
    order = [];
    position = 0;
    restoredWaiting = null;
  }
  serverProfile = name;
  writeMemory(SERVER_PROFILE, name);
  listener = null;
  showListenerTab();
  if (same) {
    jelly = session;
    useProfileSource(session);
    updateNowPlaying();
    restoreSavedQueue();
    playlists = [];
    playlistsKnown = false;
    void loadPlaylists();
    pickerReturn = null;
    closePicker();
    openTab("albums");
    toast(`Hi, ${name}`, 1800);
    return;
  }
  choosingListener = false;
  afterChoosing = null;
  showPanel("sources");
  await openJellyfin(session);
}

/** Favorites this TV kept for a person (D45) go to the profile of the same name, once. */
async function carryFavorites(session: JellyfinSession, name: string): Promise<void> {
  const person = listProfiles().find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!person) return;
  const done = `mediaverse.tv.carried:${person.id}:${session.serverId}`;
  try {
    if (localStorage.getItem(done)) return;
    for (const id of profileFavorites(person.id, `jellyfin:${session.serverId}`)) await setJellyfinFavorite(session, id, true);
    localStorage.setItem(done, "1");
  } catch {
    // The server is away, or a song is gone: tried again the next time the profile is picked.
  }
}

/** Marks and flags for the session; with a profile, its own queue memory too. */
function useProfileSource(session: JellyfinSession): void {
  setMarkSource(jellyfinMarks(session), serverProfile ? `jellyfin:${session.serverId}:${serverProfile}` : `jellyfin:${session.serverId}`);
  // Anyone added to the server may check and clear the flags (D213).
  void shareFlagLists(flagListClient, session).catch(() => 0);
}

async function openJellyfin(session: JellyfinSession): Promise<void> {
  showPanel("sources");
  $("#source-list").replaceChildren();
  const status = $("#sources-status");
  status.textContent = `Loading the music from ${session.name}…`;
  try {
    const tracks = await fetchJellyfinLibrary(session, (count) => (status.textContent = `Loading the music from ${session.name}: ${count.toLocaleString()} songs…`));
    if (!tracks.length) throw new Error(`${session.name} has no music this account can see.`);
    leaveDrive();
    jelly = session;
    computerName = session.name;
    rememberSource("jellyfin");
    useProfileSource(session);
    setLibrary(tracks);
    showScreen("browse");
    openTab("albums");
    toast(`${tracks.length.toLocaleString()} songs from ${session.name}`);
    playlists = []; // the last source's lists are not this one's
    playlistsKnown = false;
    void loadPlaylists();
  } catch (error) {
    if (error instanceof JellyfinError && error.kind === "signed_out" && !session.deviceId) saveJellyfin(null);
    void showSources(error instanceof Error ? error.message : String(error));
  }
}

function leaveDrive(): void {
  if (!drive) return;
  for (const address of drive.library.covers.values()) if (address.startsWith("blob:")) URL.revokeObjectURL(address);
  drive = null;
}

let driveScan: { stopped: boolean } | null = null;

async function chooseDrive(chosen: Drive): Promise<void> {
  stopSearching();
  if (driveScan) driveScan.stopped = true;
  const mine = (driveScan = { stopped: false });
  audio.pause();
  const status = $("#sources-status");
  status.textContent = `Reading the USB drive (${chosen.label})…`;
  let shown = false;
  // Into the albums as soon as there is something to show: what this drive held last time, or else the
  // first songs read. The rest fills in as the drive is read.
  const show = (library: DriveLibrary): void => {
    if (mine.stopped) return;
    if (drive?.library !== library) leaveDrive(); // the early library and the finished one are the same object
    jelly = null;
    drive = { drive: chosen, library };
    rememberSource("usb");
    computerName = "USB drive";
    if (shown) {
      refreshLibrary([...library.tracks]);
      return;
    }
    shown = true;
    setMarkSource(driveMarks(chosen.label), `drive:${chosen.label}`);
    setLibrary([...library.tracks]);
    showScreen("browse");
    openTab("albums");
    toast("Reading the USB drive… more songs will appear.", 3000);
  };
  const remembered = cachedDrive(chosen);
  if (remembered?.tracks.length) show(remembered);
  const library = await scanDrive(chosen, (songs) => (status.textContent = `Reading the USB drive: ${songs.toLocaleString()} songs so far…`), mine, (partial) => {
    if (!shown) show(partial);
  });
  if (mine.stopped) return;
  if (!library.tracks.length) {
    if (shown) toast("No music found on that USB drive any more.");
    status.textContent = "No music found on that USB drive.";
    if (shown) void showSources("No music found on that USB drive.");
    return;
  }
  const wasShown = shown;
  shown = true;
  show(library);
  if (!wasShown) {
    showScreen("browse");
    openTab("albums");
  }
  rememberDrive(chosen, library);
  toast(`${library.tracks.length.toLocaleString()} songs on the USB drive`);
}

/** New songs arrived for the library on show: redraw the list in view, keeping the highlight where it was. */
function refreshLibrary(tracks: ServerTrack[]): void {
  setLibrary(tracks);
  if (screen !== "browse" || !["albums", "artists", "songs"].includes(viewState.kind)) return;
  const from = current();
  const inView = from && view.contains(from);
  const index = inView ? focusables().filter((el) => view.contains(el)).indexOf(from) : -1;
  const scroll = view.scrollTop;
  renderView();
  if (index >= 0) {
    chunkedView?.ensure(index + 1);
    view.scrollTop = scroll;
    const items = focusables().filter((el) => view.contains(el));
    focus(items[index] ?? items[0]);
  }
}
type Webapis = { network?: { getIp(): string; getSubnetMask?(): string } };

/** The TV's network mask (Samsung's network API), or null: wider home networks are then searched too. */
function ownMask(): string | null {
  try {
    const mask = (window as unknown as { webapis?: Webapis }).webapis?.network?.getSubnetMask?.();
    return typeof mask === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(mask) ? mask : null;
  } catch {
    return null;
  }
}

/** The TV's own address (Samsung's network API), to know which home network to look on. */
function ownAddress(): string | null {
  try {
    const ip = (window as unknown as { webapis?: Webapis }).webapis?.network?.getIp();
    return typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** Where to look: the TV's own network, the last computer's network, and (for testing) ?look=<address>. */
function addressesToTry(): string[] {
  const hosts: string[] = [];
  const jellyfinHost = savedJellyfin()?.base.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  const own = ownAddress();
  const hints = [connection?.host, jellyfinHost, new URLSearchParams(location.search).get("look"), own];
  for (const hint of hints) {
    if (!hint) continue;
    if (!hosts.includes(hint)) hosts.push(hint); // a remembered or given computer first
    const port = /:(\d+)$/.exec(hint)?.[0] ?? "";
    hosts.push(...neighbours(hint.replace(/:\d+$/, "")).map((host) => host + port));
  }
  // Last, the rest of a home network wider than 254 addresses (the TV's own part is already listed above).
  if (own) hosts.push(...neighbours(own, ownMask()));
  return hosts;
}

function showPanel(name: ConnectPanel): void {
  panel = name;
  showScreen("connect");
  for (const id of ["sources", "manual", "pair", "jellyfin"] as const) $(`#${id}`).hidden = id !== name;
}

function renderSources(): void {
  const list = $("#source-list");
  list.replaceChildren();
  for (const found of drives) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source f";
    button.innerHTML = `<span class="source-kind">USB drive</span><span class="source-name"></span><span class="source-where"></span>`;
    button.children[1].textContent = "Music on the USB drive";
    button.children[2].textContent = found.label;
    button.addEventListener("click", () => void chooseDrive(found));
    list.append(button);
  }
  for (const found of foundComputers.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source f";
    button.innerHTML = `<span class="source-kind">Computer</span><span class="source-name"></span><span class="source-where"></span>`;
    button.children[1].textContent = found.computer;
    button.children[2].textContent = connection && connection.host === found.host ? `${found.host} · paired` : found.host;
    button.addEventListener("click", () => void chooseComputer(found));
    list.append(button);
  }
  const signedInTo = savedJellyfin()?.serverId;
  for (const server of foundJellyfin.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source f";
    button.innerHTML = `<span class="source-kind">Jellyfin</span><span class="source-name"></span><span class="source-where"></span>`;
    button.children[1].textContent = server.name;
    const host = server.base.replace(/^https?:\/\//, "");
    button.children[2].textContent = signedInTo === server.id ? `${host} · signed in` : host;
    button.addEventListener("click", () => void chooseJellyfin(server));
    list.append(button);
  }
}

/** Asks each address for a Jellyfin server, a few at a time, alongside the search for computers. */
async function findJellyfin(hosts: string[], signal: { stopped: boolean }, found: () => void): Promise<void> {
  const queue = [...new Set(hosts.map((host) => host.replace(/:\d+$/, "")))];
  const worker = async (): Promise<void> => {
    while (queue.length && !signal.stopped) {
      const server = await probeJellyfin(queue.shift()!);
      if (server && !signal.stopped && !foundJellyfin.has(server.id)) {
        foundJellyfin.set(server.id, server);
        found();
      }
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
}

async function showSources(message = ""): Promise<void> {
  if (signIn) signIn.stopped = true;
  showPanel("sources");
  drives = await listDrives();
  renderSources();
  const status = $("#sources-status");
  focus($("#source-list").querySelector<HTMLElement>(".f") ?? $("#sources-again"));
  if (search) search.stopped = true;
  const hosts = addressesToTry();
  if (!hosts.length) {
    status.textContent = message || "This TV did not say which network it is on. Choose \"Type an address\".";
    return;
  }
  const mine = (search = { stopped: false });
  status.textContent = message || "Looking for music on your home network…";
  // Redrawing the list replaces its buttons: keep the highlight on the same row (or the first, if it was
  // nowhere or on "Search again" while the list was empty).
  const shown = (): void => {
    const hadFocus = current();
    const rows = [...$("#source-list").querySelectorAll<HTMLElement>(".f")];
    const row = hadFocus ? rows.indexOf(hadFocus) : -1;
    renderSources();
    const now = [...$("#source-list").querySelectorAll<HTMLElement>(".f")];
    if (row >= 0) focus(now[row] ?? now[0]);
    else if (!hadFocus || hadFocus.id === "sources-again") focus(now[0]);
  };
  await Promise.all([
    discover(
      hosts,
      (found) => {
        if (foundComputers.has(found.host)) return;
        foundComputers.set(found.host, found);
        shown();
      },
      { signal: mine },
    ),
    findJellyfin(hosts, mine, shown),
  ]);
  if (mine.stopped || panel !== "sources" || screen !== "connect") return;
  search = null;
  status.textContent =
    foundComputers.size || foundJellyfin.size || drives.length
      ? message || "Choose where to play music from."
      : message ||
        "Nothing found. Is MediaVerse Studio running with sharing on (Settings > TV & Phone Pairing)? If it is, the computer's firewall may be turning the TV away: in Windows, allow MediaVerse Studio on private networks. Or choose Jellyfin server, USB drive, or Type an address.";
}

function stopSearching(): void {
  if (search) search.stopped = true;
  search = null;
}

/** A remote-control name for this TV, shown on the computer when pairing. */
function tvName(): string {
  return "Samsung TV";
}

async function chooseComputer(found: Found): Promise<void> {
  stopSearching();
  if (driveScan) driveScan.stopped = true;
  if (connection && connection.host === found.host) {
    await openLibrary(connection);
    return;
  }
  pairingWith = found;
  typed.code = "";
  showPanel("pair");
  $("#pair-title").textContent = `Pair with ${found.computer}`;
  $("#pair-hint").textContent = `A 6-digit code is appearing on ${found.computer}. Type it here with the number buttons (press 123 on the remote) or the keypad. You only do this once.`;
  renderTyped();
  focus($("#pair-keypad").querySelector<HTMLElement>(".f"));
  const status = $("#pair-status");
  status.textContent = "Asking the computer for a code…";
  try {
    await startPairing(found.host, tvName());
    status.textContent = "";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function finish(): Promise<void> {
  if (!pairingWith || typed.code.length !== 6) return;
  const status = $("#pair-status");
  status.textContent = "Checking…";
  try {
    const paired = await finishPairing(pairingWith.host, typed.code);
    connection = paired;
    saveConnection(paired);
    await openLibrary(paired);
  } catch (error) {
    typed.code = "";
    renderTyped();
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ShareError && error.kind === "expired") {
      status.textContent = "The code has expired. A new one is on its way…";
      void chooseComputer(pairingWith);
    } else {
      status.textContent = message;
    }
  }
}

function renderTyped(): void {
  $("#host-value").textContent = typed.host || "e.g. 192.168.1.20";
  $("#host-value").classList.toggle("placeholder", !typed.host);
  const code = typed.code.padEnd(6, "·");
  $("#pair-value").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
}

function typeKey(key: string): void {
  if (panel === "pair") {
    if (key === "⌫") typed.code = typed.code.slice(0, -1);
    else if (/^\d$/.test(key) && typed.code.length < 6) typed.code += key;
    renderTyped();
    if (typed.code.length === 6) void finish();
  } else if (panel === "manual") {
    if (key === "⌫") typed.host = typed.host.slice(0, -1);
    else if (/^[\d.:]$/.test(key) && typed.host.length < 21) typed.host += key;
    renderTyped();
  }
}

function buildKeypad(container: HTMLElement, keys: string[]): void {
  for (const key of keys) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key f";
    button.textContent = key;
    button.addEventListener("click", () => typeKey(key));
    container.append(button);
  }
}

function buildConnect(): void {
  buildKeypad($("#host-keypad"), ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫", ":"]);
  buildKeypad($("#pair-keypad"), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"]);
  $("#sources-again").addEventListener("click", () => {
    foundComputers.clear();
    void showSources();
  });
  const openManual = (jellyfin: boolean): void => {
    stopSearching();
    $("#manual-title").textContent = jellyfin ? "Type the Jellyfin server's address" : "Type the computer's address";
    $("#manual-hint").textContent = jellyfin
      ? "The address of the computer or NAS running Jellyfin (its port, 8096, is added for you). Use the number buttons (123 on the remote) or the keypad below."
      : "It is shown in MediaVerse Studio under Settings > TV & Phone Pairing. Use the number buttons (press 123 on the remote) or the keypad below.";
    showPanel("manual");
    renderTyped();
    focus($("#host-keypad").querySelector<HTMLElement>(".f"));
  };
  $("#sources-manual").addEventListener("click", () => openManual(false));
  // Always offered (owner, 2026-11-05: when the computer cannot be found, offer Jellyfin and USB too).
  $("#sources-jellyfin").addEventListener("click", () => openManual(true));
  $("#sources-usb").addEventListener("click", async () => {
    drives = await listDrives();
    renderSources();
    const first = drives[0];
    if (first) void chooseDrive(first);
    else $("#sources-status").textContent = "No USB drive with music was found. Plug one into the TV, wait a few seconds, then choose USB drive again.";
  });
  $("#manual-go").addEventListener("click", () => void findTyped());
  $("#jf-cancel").addEventListener("click", () => void showSources());
}

async function findTyped(): Promise<void> {
  const status = $("#manual-status");
  status.textContent = "Looking…";
  try {
    const greeting = await hello(typed.host.trim());
    status.textContent = "";
    const found = { host: typed.host.trim(), computer: greeting.computer };
    foundComputers.set(found.host, found);
    await chooseComputer(found);
  } catch (error) {
    // Not MediaVerse Studio there: perhaps a Jellyfin server.
    const server = await probeJellyfin(typed.host.trim(), 4_000);
    if (server) {
      status.textContent = "";
      foundJellyfin.set(server.id, server);
      await chooseJellyfin(server);
      return;
    }
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function openLibrary(paired: Connection): Promise<void> {
  showPanel("sources");
  $("#source-list").replaceChildren();
  const status = $("#sources-status");
  status.textContent = `Loading the library from ${paired.computer || paired.host}…`;
  try {
    const greeting = await hello(paired.host, 3_000); // a computer that is off should not hold up the start
    computerName = greeting.computer;
    const tracks = await fetchLibrary(paired);
    if (paired.computer !== greeting.computer) {
      paired = { ...paired, computer: greeting.computer };
      saveConnection(paired);
    }
    connection = paired;
    leaveDrive();
    jelly = null;
    rememberSource("computer");
    setMarkSource(computerMarks(paired), `computer:${paired.computer || paired.host}`);
    setLibrary(tracks);
    showScreen("browse");
    openTab("albums");
    toast(`${tracks.length.toLocaleString()} songs from ${computerName}`);
    void listenToRemote(paired);
    playlists = []; // the last source's lists are not this one's
    playlistsKnown = false;
    void loadPlaylists();
  } catch (error) {
    if (error instanceof ShareError && error.kind === "not_paired") {
      // Removed on the computer: pair again.
      saveConnection(null);
      connection = null;
      void chooseComputer({ host: paired.host, computer: paired.computer || paired.host });
      return;
    }
    void showSources(error instanceof Error ? error.message : String(error));
  }
}
// ---------- Library ----------

let albums: Album[] = [];
let artists: Artist[] = [];
/** Artists who are only on compilations: not on the list, but a search finds them (owner, 2026-11-10). */
let guestArtists: Artist[] = [];
let songs: ServerTrack[] = [];
let genres: Genre[] = [];

/**
 * Playlists made in MediaVerse Studio on the computer (D82), read when the library is and again when the tab
 * opens. A USB drive, Jellyfin or a phone has none (yet), and an older computer answers without them.
 */
let playlists: ServerPlaylist[] = [];
let playlistsKnown = false;

async function loadPlaylists(): Promise<void> {
  if (jelly) {
    // Jellyfin's own playlists (the computer's are not in Jellyfin).
    const session = jelly;
    try {
      const found = await jellyfinPlaylists(session);
      const recent = await jellyfinRecentlyPlayed(session).catch(() => []);
      if (jelly !== session) return; // the source changed meanwhile
      playlists = found.sort((a, b) => a.name.localeCompare(b.name));
      if (recent.length) playlists.unshift({ id: "recently-played", name: "Recently played", updated_at: 0, ids: recent });
      playlistsKnown = true;
    } catch {
      // keep the last list
    }
    return;
  }
  if (!connection || drive) {
    playlists = [];
    playlistsKnown = false;
    return;
  }
  try {
    const found = await fetchPlaylists(connection);
    playlists = (found ?? []).sort((a, b) => a.name.localeCompare(b.name));
    playlistsKnown = found !== null;
  } catch {
    // keep the last list
  }
}

/** A playlist's songs in this library, in its order. */
function playlistTracks(playlist: ServerPlaylist): ServerTrack[] {
  if (songsById?.from !== songs) songsById = { from: songs, map: new Map(songs.map((s) => [s.id, s])) };
  const byId = songsById.map;
  return playlist.ids.map((id) => byId.get(id)).filter((track): track is ServerTrack => !!track);
}

function setLibrary(tracks: ServerTrack[]): void {
  albums = buildAlbums(tracks);
  artists = buildArtists(albums);
  guestArtists = buildGuestArtists(albums);
  songs = allSongs(albums);
  genres = buildGenres(albums);
  wallBuilt = false; // the cover wall is made again from the new library
  restoreSavedQueue(); // the queue from before the app was closed, if this is the same music source
}

function cover(track: ServerTrack | undefined, className: string): HTMLElement {
  const box = document.createElement("div");
  box.className = `cover ${className}`;
  // Small copies for the artist stacks and album tiles (the TV holds hundreds of them), large for Now Playing.
  const address = track ? trackCover(track, className === "tile-cover" ? 320 : className.startsWith("stack-cover") ? 200 : 600) : null;
  if (address) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = address;
    image.addEventListener("error", () => image.remove());
    box.append(image);
  }
  return box;
}

// ---------- Browse views ----------

type ViewState =
  | { kind: "albums" }
  | { kind: "artists" }
  | { kind: "genres" }
  | { kind: "songs" }
  | { kind: "favorites" }
  | { kind: "playlists" }
  | { kind: "playlist"; playlist: ServerPlaylist }
  | { kind: "queue" }
  | { kind: "search"; query: string }
  | { kind: "settings" }
  | { kind: "album"; album: Album }
  | { kind: "artist"; artist: Artist }
  | { kind: "genre"; genre: Genre };
type Remembered = { state: ViewState; focusIndex: number; scroll: number };
let viewState: ViewState = { kind: "albums" };
const history: Remembered[] = [];

/** Appends items a chunk at a time, adding more as the highlight nears the end, so huge lists stay quick. */
function chunked<T>(container: HTMLElement, items: T[], make: (item: T, index: number) => HTMLElement, chunk: number): { ensure(count: number): void; jump(index: number): HTMLElement | null } {
  let start = 0; // the first item drawn (after a jump the list starts there)
  let shown = 0;
  function more(): void {
    const end = Math.min(items.length, shown + chunk);
    const fragment = document.createDocumentFragment();
    for (let i = shown; i < end; i++) {
      const element = make(items[i], i);
      if (i >= end - Math.ceil(chunk / 3) && end < items.length) {
        element.addEventListener("tv-focus", () => shown === end && more(), { once: true });
      }
      fragment.append(element);
    }
    shown = end;
    container.append(fragment);
  }
  more();
  return {
    ensure(count: number) {
      while (shown < Math.min(count, items.length)) more();
    },
    /**
     * The element for item `index`, drawn if needed. Far down a long list (Songs runs to thousands), the list is
     * drawn again starting at that item instead of drawing everything before it: drawing 13,000 rows to reach
     * "Z" took 13 s on the TV. The rows keep their own indexes, so playing from them queues the right songs.
     */
    jump(index: number) {
      if (index < 0 || index >= items.length) return null;
      if (index >= start && index < shown) return container.children[index - start] as HTMLElement;
      if (index >= start && index < shown + chunk * 2) {
        while (shown <= index) more();
        return container.children[index - start] as HTMLElement;
      }
      container.replaceChildren();
      start = index;
      shown = index;
      more();
      return container.children[0] as HTMLElement;
    },
  };
}

function heading(text: string, sub = ""): HTMLElement {
  const box = document.createElement("div");
  box.className = "view-heading";
  box.innerHTML = `<h2></h2><p></p>`;
  box.querySelector("h2")!.textContent = text;
  box.querySelector("p")!.textContent = sub;
  return box;
}

function albumTile(album: Album): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile f";
  tile.append(cover(album.tracks[0], "tile-cover"));
  const title = document.createElement("span");
  title.className = "tile-title";
  title.textContent = album.title;
  const artist = document.createElement("span");
  artist.className = "tile-sub";
  artist.textContent = album.year ? `${album.artist} · ${album.year}` : album.artist;
  tile.append(title, artist);
  tile.addEventListener("click", () => openView({ kind: "album", album }));
  return tile;
}

// ---------- Selecting songs (owner, 2026-11-04: as in the modern Windows Media Player) ----------
// Each song row has a tick box on its left (press left to reach it, OK to tick). Once anything is ticked, a bar at
// the top of the list offers Play, Play next, Add to queue and Add to favorites for the ticked songs.

const ticked = new Set<string>();
/** The list last drawn, so ticks are kept while the same list is redrawn and cleared for another. */
let renderedState: unknown = null;

let songsById: { from: ServerTrack[]; map: Map<string, ServerTrack> } | null = null;

function tickedTracks(): ServerTrack[] {
  // Built once per library (the TV is slow to rebuild a map of thousands of songs on every tick).
  if (songsById?.from !== songs) songsById = { from: songs, map: new Map(songs.map((s) => [s.id, s])) };
  const byId = songsById.map;
  const found: ServerTrack[] = [];
  const seen = new Set<string>();
  for (const row of view.querySelectorAll<HTMLElement>(".row[data-track-id]")) {
    const id = row.dataset.trackId ?? "";
    if (ticked.has(id) && !seen.has(id)) {
      seen.add(id);
      const track = byId.get(id);
      if (track) found.push(track);
    }
  }
  return found;
}

/** Puts songs straight after the one playing, or at the end; with nothing playing they simply play. */
function addToQueue(tracks: ServerTrack[], where: "next" | "end"): void {
  if (!tracks.length) return;
  if (!queue.length || position < 0) {
    play(tracks, 0);
    return;
  }
  const first = queue.length;
  queue = [...queue, ...tracks];
  const added = tracks.map((_, i) => first + i);
  if (where === "next") order.splice(position + 1, 0, ...added);
  else order.push(...added);
  rememberQueue();
  updateNowPlaying();
  toast(`${tracks.length === 1 ? "1 song" : `${tracks.length} songs`} ${where === "next" ? "will play next" : "added to the queue"}.`, 2200);
}

async function favoriteTicked(tracks: ServerTrack[]): Promise<void> {
  if (!markStore) return;
  const store = markStore;
  let saved = 0;
  for (const track of tracks) {
    if (marks.favorites.has(track.id)) continue;
    try {
      await store.favorite(track.id, true);
      marks.favorites.add(track.id);
      saved += 1;
    } catch {
      // reported below
    }
  }
  showMarks();
  toast(saved === tracks.length || saved > 0 ? `Added ${saved === 1 ? "1 song" : `${saved} songs`} to your favorites.` : "Could not save those favorites.", 2500);
}

/** Takes ticked songs out of the queue (the song playing stays: it is what is on). */
function removeFromQueue(tracks: ServerTrack[]): void {
  const ids = new Set(tracks.map((t) => t.id));
  const playingSlot = order[position];
  const kept = order.filter((slot, place) => place === position || !ids.has(queue[slot]?.id ?? ""));
  const removed = order.length - kept.length;
  order = kept;
  position = order.indexOf(playingSlot);
  ticked.clear();
  rememberQueue();
  updateNowPlaying();
  renderView();
  focus(view.querySelector<HTMLElement>(".row"));
  const skipped = tracks.some((t) => t.id === queue[playingSlot]?.id);
  toast(`${removed === 1 ? "1 song" : `${removed} songs`} taken out of the queue.${skipped ? " The song playing stays." : ""}`, 2500);
}

async function unfavoriteTicked(tracks: ServerTrack[]): Promise<void> {
  if (!markStore) return;
  const store = markStore;
  let removed = 0;
  for (const track of tracks) {
    if (!marks.favorites.has(track.id)) continue;
    try {
      await store.favorite(track.id, false);
      marks.favorites.delete(track.id);
      removed += 1;
    } catch {
      // reported below
    }
  }
  ticked.clear();
  showMarks();
  renderView();
  focus(view.querySelector<HTMLElement>(".row") ?? document.querySelector<HTMLElement>('.tab[data-tab="favorites"]'));
  toast(removed ? `Removed ${removed === 1 ? "1 song" : `${removed} songs`} from your favorites.` : "Could not remove those favorites.", 2500);
}

function renderTickBar(): void {
  let bar = view.querySelector<HTMLElement>(".tick-bar");
  const chosen = tickedTracks();
  if (!chosen.length) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "tick-bar";
    view.prepend(bar);
  }
  const keep = document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) ? document.activeElement.dataset.act : undefined;
  const label = document.createElement("span");
  label.className = "tick-count";
  label.textContent = chosen.length === 1 ? "1 song selected" : `${chosen.length} songs selected`;
  const button = (text: string, act: string, action: () => void, symbol?: IconName, main = false): HTMLButtonElement => {
    const b = actionButton(text, action, symbol, main);
    b.dataset.act = act;
    return b;
  };
  bar.replaceChildren(
    label,
    button("Play", "play", () => play(chosen, 0), "play", true),
    button("Play next", "next", () => addToQueue(chosen, "next"), "play-next"),
    button("Add to queue", "end", () => addToQueue(chosen, "end"), "add"),
    ...(viewState.kind === "queue"
      ? [button("Remove from queue", "remove", () => removeFromQueue(chosen), "remove")]
      : viewState.kind === "favorites"
        ? [button("Remove from favorites", "remove", () => void unfavoriteTicked(chosen), "remove")]
        : [button("Add to favorites", "fav", () => void favoriteTicked(chosen), "heart")]),
    button("Clear", "clear", () => {
      ticked.clear();
      for (const box of view.querySelectorAll<HTMLElement>(".row-check")) {
        box.classList.remove("is-on");
        box.setAttribute("aria-checked", "false");
      }
      renderTickBar();
      focus(view.querySelector<HTMLElement>(".row"));
    }),
  );
  if (keep) focus(bar.querySelector<HTMLElement>(`[data-act="${keep}"]`));
}

function songRow(track: ServerTrack, list: ServerTrack[], index: number, showAlbum: boolean, pick?: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "row-wrap";
  const check = document.createElement("button");
  check.type = "button";
  check.className = ticked.has(track.id) ? "row-check f is-on" : "row-check f";
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", String(ticked.has(track.id)));
  check.setAttribute("aria-label", `Select ${track.title}`);
  check.addEventListener("click", () => {
    const on = !ticked.has(track.id);
    if (on) ticked.add(track.id);
    else ticked.delete(track.id);
    check.classList.toggle("is-on", on);
    check.setAttribute("aria-checked", String(on));
    renderTickBar();
  });
  const row = document.createElement("button");
  row.type = "button";
  row.className = "row f";
  row.dataset.trackId = track.id;
  const number = document.createElement("span");
  number.className = "row-number";
  number.textContent = showAlbum ? "" : track.track_number ? String(track.track_number) : "";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = track.title;
  const sub = document.createElement("span");
  sub.className = "row-sub";
  sub.textContent = showAlbum ? [track.artist, track.album].filter(Boolean).join(" · ") : track.artist ?? "";
  const marked = document.createElement("span");
  marked.className = "row-marks";
  showRowMarks(marked, track.id);
  row.append(number, title, sub, marked);
  row.addEventListener("click", () => {
    if (pick) pick();
    else if (nowPlaying()) openSongMenu(track, list, index);
    else play(list, index);
  });
  wrap.append(check, row);
  return wrap;
}

/** The buttons that put a list of songs into the queue being played, beside Play (owner, 2026-11-06). */
function queueButtons(tracks: () => ServerTrack[]): HTMLButtonElement[] {
  return [
    actionButton("Play next", () => addToQueue(tracks(), "next"), "play-next"),
    actionButton("Add to queue", () => addToQueue(tracks(), "end"), "add"),
  ];
}

let songMenuReturn: HTMLElement | null = null;

/**
 * OK on a song while music is playing (owner, 2026-11-06: build up the queue that is playing): play from this song
 * as a new queue, as before, or put just this song next or at the end of the queue. With nothing playing, OK plays
 * at once as before.
 */
function openSongMenu(track: ServerTrack, list: ServerTrack[], index: number): void {
  songMenuReturn = current();
  $("#song-menu-title").textContent = track.title;
  const playing = nowPlaying();
  $("#song-menu-hint").textContent = [track.artist, track.album].filter(Boolean).join(" · ") + (playing ? `\nPlaying now: ${playing.title}` : "");
  const buttons = $("#song-menu-buttons");
  buttons.replaceChildren();
  const add = (label: string, act: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "f";
    button.textContent = label;
    button.addEventListener("click", () => {
      closeSongMenu();
      act();
    });
    buttons.append(button);
  };
  add(list.length > 1 ? "Play from here (replaces the queue)" : "Play now (replaces the queue)", () => play(list, index));
  add("Play next", () => addToQueue([track], "next"));
  add("Add to the end of the queue", () => addToQueue([track], "end"));
  add("Cancel", () => undefined);
  $("#song-menu").hidden = false;
  focus(buttons.querySelector<HTMLElement>(".f"));
}

function closeSongMenu(): void {
  $("#song-menu").hidden = true;
  if (songMenuReturn?.isConnected) focus(songMenuReturn);
  songMenuReturn = null;
}

const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The four ways to look at the library, chosen inside the Library tab (owner, 2026-11-06). */
type LibraryKind = "artists" | "albums" | "genres" | "songs";
const LIBRARY_KINDS: LibraryKind[] = ["artists", "albums", "genres", "songs"];
let libraryKind: LibraryKind = "artists";

/** artists · albums · genres · songs across the top of the library, Zune style; the one showing is bright. */
function libraryPivots(current: LibraryKind, sub: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "view-heading";
  const row = document.createElement("div");
  row.className = "pivots";
  for (const kind of LIBRARY_KINDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === current ? "pivot f is-active" : "pivot f";
    button.textContent = kind;
    button.addEventListener("click", () => {
      if (kind === current) return;
      openTab(kind);
      focus(view.querySelector<HTMLElement>(`.pivot.is-active`));
    });
    row.append(button);
  }
  const line = document.createElement("p");
  line.textContent = sub;
  box.append(row, line);
  return box;
}

/**
 * An artist with their newest album's cover beside the name and how many albums and songs (owner, 2026-11-06:
 * one cover is enough on the TV; a stack like the PC's would load three times the pictures). The cover is asked
 * for small and only as it comes near the screen.
 */
function artistTile(artist: Artist, letter?: string): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "artist-tile f";
  if (letter) tile.dataset.letter = letter;
  // A band that is only on compilations shows those (it has no album of its own).
  const shownAlbums = artist.albums.length ? artist.albums : artist.also;
  const shownTracks = artist.tracks.length ? artist.tracks : artist.alsoTracks;
  const newest = shownAlbums.reduce<Album | undefined>((best, album) => (!best || (album.year ?? 0) >= (best.year ?? 0) ? album : best), undefined);
  const stack = cover(newest?.tracks[0], "stack-cover");
  const text = document.createElement("span");
  text.className = "artist-text";
  const name = document.createElement("span");
  name.className = "artist-name";
  name.textContent = artist.name;
  const line = document.createElement("span");
  line.className = "artist-line";
  const songsText = shownTracks.length === 1 ? "1 song" : `${shownTracks.length} songs`;
  line.textContent = shownAlbums.length > 1 ? `${shownAlbums.length} albums, ${songsText}` : songsText;
  text.append(name, line);
  const genre = shownTracks.find((t) => t.genre)?.genre;
  if (genre) {
    const g = document.createElement("span");
    g.className = "artist-genre";
    g.textContent = genre;
    text.append(g);
  }
  tile.append(stack, text);
  tile.addEventListener("click", () => openView({ kind: "artist", artist }));
  return tile;
}

/**
 * The narrow Back strip down the left. On a page reached from another it goes back; on the long top-level lists
 * (artists, albums, genres, songs, favorites) it is there too (owner, 2026-11-07) and takes you back to the top of
 * the page, to the artists · albums · genres · songs choices, without scrolling all the way up.
 */
const TOP_LEVEL_WITH_STRIP: ViewState["kind"][] = [...LIBRARY_KINDS, "favorites"];
function showBackStrip(): void {
  const strip = $("#back-strip");
  const goesBack = history.length > 0;
  const show = goesBack || TOP_LEVEL_WITH_STRIP.includes(viewState.kind);
  strip.hidden = !show;
  strip.setAttribute("aria-label", goesBack ? "Back" : "Back to the top");
  strip.title = goesBack ? "Back" : "Back to the top";
  view.classList.toggle("has-back", show);
}
$("#back-strip").addEventListener("click", () => {
  if (goBackInBrowse()) return;
  view.scrollTop = 0;
  focus(view.querySelector<HTMLElement>(".pivot.is-active") ?? view.querySelector<HTMLElement>(".f") ?? document.querySelector<HTMLElement>(".tab.is-active"));
});

/**
 * The A to Z jump (as on the desktop): a letter bar down the right of a long list. `keys` are the list's sort names
 * in list order (an album or song list is in artist order, so it jumps by artist). Letters with nothing under them
 * are dimmed and skipped by the remote.
 */
function showLetters(keys: string[], list: HTMLElement): void {
  const bar = $("#letters");
  const first = new Map<string, number>();
  keys.forEach((key, index) => {
    const letter = indexLetter(key);
    if (!first.has(letter)) first.set(letter, index);
  });
  bar.replaceChildren();
  for (const letter of LETTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = letter;
    const at = first.get(letter);
    if (at === undefined) {
      button.className = "letter is-empty";
      button.disabled = true;
    } else {
      button.className = "letter f";
      button.setAttribute("aria-label", letter === "#" ? "Numbers and symbols" : `Jump to ${letter}`);
      button.addEventListener("click", () => {
        const item = (chunkedView ? chunkedView.jump(at) : (list.children[at] as HTMLElement | undefined)) ?? undefined;
        // A song row's own button, not the tick box in front of it.
        const target = item?.classList.contains("f") ? item : (item?.querySelector<HTMLElement>(".row") ?? item?.querySelector<HTMLElement>(".f"));
        if (!target) return;
        target.scrollIntoView({ block: "start" });
        focus(target);
      });
    }
    bar.append(button);
  }
  bar.hidden = false;
  view.classList.add("has-letters");
}

function hideLetters(): void {
  $("#letters").hidden = true;
  view.classList.remove("has-letters");
}

function renderView(): void {
  if (renderedState !== viewState) ticked.clear(); // a different list: start with nothing ticked
  renderedState = viewState;
  hideLetters();
  view.replaceChildren();
  view.scrollTop = 0;
  for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
    const root = history[0]?.state.kind ?? viewState.kind;
    const tabFor = LIBRARY_KINDS.includes(root as LibraryKind) ? "library" : root === "queue" ? "playlists" : root;
    tab.classList.toggle("is-active", tab.dataset.tab === tabFor);
  }
  showBackStrip();
  const state = viewState;
  if (state.kind === "albums") {
    view.append(libraryPivots("albums", `${albums.length.toLocaleString()} albums`));
    const grid = document.createElement("div");
    grid.className = "grid";
    view.append(grid);
    chunkedView = chunked(grid, albums, albumTile, 60);
    showLetters(albums.map((album) => album.artist), grid);
  } else if (state.kind === "artists") {
    view.append(libraryPivots("artists", `${artists.length.toLocaleString()} artists`));
    const list = document.createElement("div");
    list.className = "artist-grid";
    view.append(list);
    let lastLetter = "";
    chunkedView = chunked(
      list,
      artists,
      (artist) => {
        const letter = indexLetter(artist.name);
        const first = letter !== lastLetter;
        lastLetter = letter;
        return artistTile(artist, first ? letter : undefined);
      },
      48,
    );
    showLetters(artists.map((artist) => artist.name), list);
  } else if (state.kind === "songs") {
    view.append(libraryPivots("songs", `${songs.length.toLocaleString()} songs`));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(actionButton("Shuffle all", () => play(songs, Math.floor(Math.random() * songs.length), true), "shuffle"));
    view.append(actions);
    const list = document.createElement("div");
    list.className = "rows";
    view.append(list);
    chunkedView = chunked(list, songs, (track, index) => songRow(track, songs, index, true), 80);
    // Songs are every album's songs in album order, so each song jumps by its album's artist.
    showLetters(albums.flatMap((album) => album.tracks.map(() => album.artist)), list);
  } else if (state.kind === "artist") {
    const { artist } = state;
    const all = [...artist.tracks, ...artist.alsoTracks];
    const count = all.length;
    const own = artist.albums.length;
    const onAlbums = own ? `${own} ${own === 1 ? "album" : "albums"}` : "";
    const onOthers = artist.also.length ? `${artist.also.length} ${own ? "other " : ""}${artist.also.length === 1 ? "album" : "albums"}` : "";
    view.append(heading(artist.name, `${count} ${count === 1 ? "song" : "songs"} on ${[onAlbums, onOthers].filter(Boolean).join(" and ")}`));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      actionButton("Play all", () => play(all, 0), "play", true),
      actionButton("Shuffle", () => play(all, Math.floor(Math.random() * all.length), true), "shuffle"),
      ...queueButtons(() => all),
    );
    view.append(actions);
    const grid = document.createElement("div");
    grid.className = "grid";
    view.append(grid);
    chunkedView = chunked(grid, artist.albums, albumTile, 60);
    // A line and a note before the compilations the artist is on (owner, 2026-11-10). A few albums at most, so no chunking.
    if (artist.also.length) {
      if (own) {
        const rule = document.createElement("hr");
        rule.className = "search-rule";
        view.append(rule);
      }
      const note = document.createElement("p");
      note.className = "search-section";
      note.textContent = `${artist.name} also appears in:`;
      view.append(note);
      const alsoGrid = document.createElement("div");
      alsoGrid.className = "grid";
      for (const album of artist.also) alsoGrid.append(albumTile(album));
      view.append(alsoGrid);
    }
  } else if (state.kind === "album") {
    const { album } = state;
    const layout = document.createElement("div");
    layout.className = "album-view";
    const side = document.createElement("div");
    side.className = "album-side";
    side.append(cover(album.tracks[0], "album-cover"));
    const right = document.createElement("div");
    right.className = "album-main";
    right.append(heading(album.title, [album.artist, album.year, `${album.tracks.length} songs`].filter(Boolean).join(" · ")));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      actionButton("Play", () => play(album.tracks, 0), "play", true),
      actionButton("Shuffle", () => play(album.tracks, Math.floor(Math.random() * album.tracks.length), true), "shuffle"),
      ...queueButtons(() => album.tracks),
    );
    const variousArtists = new Set(album.tracks.map((t) => t.artist)).size > 1;
    const list = document.createElement("div");
    list.className = "rows";
    album.tracks.forEach((track, index) => {
      const row = songRow(track, album.tracks, index, false);
      if (!variousArtists) row.querySelector(".row-sub")!.textContent = "";
      list.append(row);
    });
    right.append(actions, list);
    layout.append(side, right);
    view.append(layout);
    chunkedView = null;
  } else if (state.kind === "genres") {
    view.append(libraryPivots("genres", genres.length ? `${genres.length.toLocaleString()} genres` : ""));
    if (!genres.length) view.append(emptyHint("None of these songs has a genre in its details."));
    const list = document.createElement("div");
    list.className = "name-grid";
    view.append(list);
    chunkedView = chunked(
      list,
      genres,
      (genre) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "name f";
        const name = document.createElement("span");
        name.textContent = genre.name;
        const count = document.createElement("span");
        count.className = "name-count";
        count.textContent = genre.tracks.length === 1 ? "1 song" : `${genre.tracks.length.toLocaleString()} songs`;
        button.append(name, count);
        button.addEventListener("click", () => openView({ kind: "genre", genre }));
        return button;
      },
      120,
    );
    showLetters(genres.map((genre) => genre.name), list);
  } else if (state.kind === "genre") {
    const { genre } = state;
    view.append(heading(genre.name, `${genre.tracks.length.toLocaleString()} songs on ${genre.albums.length} ${genre.albums.length === 1 ? "album" : "albums"}`));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      actionButton("Play all", () => play(genre.tracks, 0), "play", true),
      actionButton("Shuffle", () => play(genre.tracks, Math.floor(Math.random() * genre.tracks.length), true), "shuffle"),
      ...queueButtons(() => genre.tracks),
    );
    view.append(actions);
    const grid = document.createElement("div");
    grid.className = "grid";
    view.append(grid);
    chunkedView = chunked(grid, genre.albums, albumTile, 60);
  } else if (state.kind === "favorites") {
    const favorites = songs.filter((track) => marks.favorites.has(track.id));
    view.append(heading("Favorites", favorites.length === 1 ? "1 song" : `${favorites.length.toLocaleString()} songs`));
    if (!favorites.length) {
      view.append(emptyHint("Press ♡ on the Now playing screen to add the song playing to your favorites."));
      chunkedView = null;
    } else {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        actionButton("Play all", () => play(favorites, 0), "play", true),
        actionButton("Shuffle", () => play(favorites, Math.floor(Math.random() * favorites.length), true), "shuffle"),
        ...queueButtons(() => favorites),
      );
      view.append(actions);
      const list = document.createElement("div");
      list.className = "rows";
      view.append(list);
      chunkedView = chunked(list, favorites, (track, index) => songRow(track, favorites, index, true), 80);
    }
  } else if (state.kind === "playlists") {
    view.append(heading("Playlists", playlists.length === 1 ? "1 playlist" : playlists.length ? `${playlists.length} playlists` : ""));
    // The queue playing now lives here too (owner, 2026-11-06: one tab fewer).
    const upcoming = order.map((slot) => queue[slot]).filter(Boolean);
    const queueRow = document.createElement("div");
    queueRow.className = "name-grid queue-entry";
    const queueButton = document.createElement("button");
    queueButton.type = "button";
    queueButton.className = "name f";
    const queueName = document.createElement("span");
    queueName.textContent = "Now playing queue";
    const queueCount = document.createElement("span");
    queueCount.className = "name-count";
    queueCount.textContent = upcoming.length ? (upcoming.length === 1 ? "1 song" : `${upcoming.length.toLocaleString()} songs`) : "empty";
    queueButton.append(queueName, queueCount);
    queueButton.addEventListener("click", () => openView({ kind: "queue" }));
    queueRow.append(queueButton);
    view.append(queueRow);
    if (!playlists.length) {
      const hint = serverProfile
        ? `${serverProfile} has no playlists yet. Make them on a computer or phone using this profile, or in Jellyfin.`
        : jelly
        ? "No playlists in Jellyfin yet. Playlists made in MediaVerse Studio are on your computer; choose the computer as the music source to see them."
        : drive
        ? "Playlists come from MediaVerse Studio on your computer. Choose the computer as the music source to see them."
        : playlistsKnown || !connection
          ? "No playlists yet. Make them in MediaVerse Studio on your computer (Library > playlists), and they show up here."
          : "This computer's MediaVerse Studio is older and has no playlists to share. Update it, then choose Reload the library in Settings.";
      view.append(emptyHint(hint));
      chunkedView = null;
    } else {
      const list = document.createElement("div");
      list.className = "name-grid";
      view.append(list);
      chunkedView = chunked(
        list,
        playlists,
        (playlist) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "name f";
          const name = document.createElement("span");
          name.textContent = playlist.name;
          const count = document.createElement("span");
          count.className = "name-count";
          count.textContent = playlist.ids.length === 1 ? "1 song" : `${playlist.ids.length.toLocaleString()} songs`;
          button.append(name, count);
          button.addEventListener("click", () => openView({ kind: "playlist", playlist }));
          return button;
        },
        120,
      );
    }
  } else if (state.kind === "playlist") {
    const tracks = playlistTracks(state.playlist);
    view.append(heading(state.playlist.name, tracks.length === 1 ? "1 song" : `${tracks.length.toLocaleString()} songs`));
    if (!tracks.length) {
      view.append(emptyHint("This playlist is empty, or its songs are not in the library the TV can see."));
      chunkedView = null;
    } else {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        actionButton("Play all", () => play(tracks, 0), "play", true),
        actionButton("Shuffle", () => play(tracks, Math.floor(Math.random() * tracks.length), true), "shuffle"),
        ...queueButtons(() => tracks),
      );
      view.append(actions);
      const list = document.createElement("div");
      list.className = "rows";
      view.append(list);
      chunkedView = chunked(list, tracks, (track, index) => songRow(track, tracks, index, true), 80);
    }
  } else if (state.kind === "queue") {
    const upcoming = order.map((slot) => queue[slot]).filter(Boolean);
    view.append(heading("Queue", upcoming.length ? `${upcoming.length === 1 ? "1 song" : `${upcoming.length.toLocaleString()} songs`} · playing ${position + 1} of ${upcoming.length}` : ""));
    if (!upcoming.length) {
      view.append(emptyHint("Nothing is queued. Play an album or a song, or tick songs and choose Play next or Add to queue."));
      chunkedView = null;
    } else {
      const list = document.createElement("div");
      list.className = "rows";
      view.append(list);
      // OK on a song jumps to it in the queue (the order and the rest of the queue stay as they are).
      chunkedView = chunked(list, upcoming, (track, place) => songRow(track, upcoming, place, true, () => {
        position = place;
        startTrack();
        openNowPlaying();
      }), 80);
      chunkedView.ensure(Math.max(80, position + 20));
      // Opens at the song playing, not at the top of a queue that may be thousands of songs long.
      requestAnimationFrame(() => {
        const playingRow = list.querySelectorAll<HTMLElement>(".row")[position];
        if (!playingRow) return;
        playingRow.scrollIntoView({ block: "center" });
        focus(playingRow);
      });
    }
  } else if (state.kind === "search") {
    renderSearch(state);
    chunkedView = null;
  } else {
    renderSettings();
    chunkedView = null;
  }
  markPlaying();
}

let chunkedView: { ensure(count: number): void; jump(index: number): HTMLElement | null } | null = null;

function emptyHint(text: string): HTMLElement {
  const hint = document.createElement("p");
  hint.className = "empty-hint";
  hint.textContent = text;
  return hint;
}

// ---------- Search ----------

const SEARCH_KEYS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "Space", "⌫", "Clear"];

/** The search page: what is typed, a letter keyboard for the remote, and the results below it. */
function renderSearch(state: { kind: "search"; query: string }): void {
  view.append(heading("Search"));
  const box = document.createElement("div");
  box.className = "search-box";
  const text = document.createElement("div");
  text.className = "search-text";
  text.id = "search-text";
  const keys = document.createElement("div");
  keys.className = "search-keys";
  for (const key of SEARCH_KEYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `key f${key.length > 1 ? " wide" : ""}`;
    button.textContent = key;
    button.addEventListener("click", () => typeSearch(key));
    keys.append(button);
  }
  box.append(text, keys);
  const results = document.createElement("div");
  results.id = "search-results";
  view.append(box, results);
  showSearchResults(state.query);
}

function typeSearch(key: string): void {
  if (viewState.kind !== "search") return;
  const state = viewState;
  if (key === "⌫") state.query = state.query.slice(0, -1);
  else if (key === "Clear") state.query = "";
  else if (key === "Space" || key === " ") state.query = state.query && !state.query.endsWith(" ") ? `${state.query} ` : state.query;
  else if (state.query.length < 40) state.query += key.toLowerCase();
  showSearchResults(state.query);
}

function showSearchResults(query: string): void {
  const text = document.querySelector<HTMLElement>("#search-text");
  const results = document.querySelector<HTMLElement>("#search-results");
  if (!text || !results) return;
  text.textContent = query || "Type with the letters below, or the number buttons";
  text.classList.toggle("placeholder", !query);
  results.replaceChildren();
  if (!query.trim()) return;
  const found = searchLibrary(query, [...artists, ...guestArtists], albums, songs);
  if (!found.artists.length && !found.albums.length && !found.songs.length) {
    results.append(emptyHint(`Nothing called “${query.trim()}”.`));
    return;
  }
  const section = (title: string): void => {
    const label = document.createElement("p");
    label.className = "search-section";
    label.textContent = title;
    results.append(label);
  };
  if (found.artists.length) {
    section("Artists");
    const list = document.createElement("div");
    list.className = "artist-grid";
    for (const artist of found.artists.slice(0, 8)) list.append(artistTile(artist));
    results.append(list);
  }
  if (found.albums.length) {
    section("Albums");
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const album of found.albums.slice(0, 12)) grid.append(albumTile(album));
    results.append(grid);
  }
  if (found.songs.length) {
    // Artists and albums first, then a line, then songs, as on the PC.
    if (found.artists.length || found.albums.length) {
      const rule = document.createElement("hr");
      rule.className = "search-rule";
      results.append(rule);
    }
    section("Songs");
    const list = document.createElement("div");
    list.className = "rows";
    found.songs.forEach((track, index) => list.append(songRow(track, found.songs, index, true)));
    results.append(list);
  }
  markPlaying();
}

// ---------- Favorites and flags ----------

let marks: Marks = { favorites: new Set(), flagged: new Set() };
let markStore: MarkStore | null = null;

/** A song row's heart and flag, as the same icons as Now Playing. */
function showRowMarks(cell: HTMLElement, id: string): void {
  cell.replaceChildren();
  if (marks.favorites.has(id)) cell.append(icon("heart", { size: 30, filled: true }));
  if (marks.flagged.has(id)) cell.append(icon("flag", { size: 30, filled: true }));
}

/** The source changed: its favorites and flags are read, and shown wherever songs are listed. */
function useMarks(store: MarkStore | null): void {
  markStore = store;
  marks = { favorites: new Set(), flagged: new Set() };
  showMarks();
  store
    ?.load()
    .then((loaded) => {
      if (markStore !== store) return;
      marks = loaded;
      showMarks();
      if (screen === "browse" && viewState.kind === "favorites") renderView();
    })
    .catch(() => undefined);
}

function showMarks(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".row[data-track-id]")) {
    const cell = row.querySelector<HTMLElement>(".row-marks");
    if (cell) showRowMarks(cell, row.dataset.trackId!);
  }
  const id = nowPlaying()?.id ?? "";
  const favorite = marks.favorites.has(id);
  setControl("#np-favorite", "heart", favorite ? "Favorite (press to remove)" : "Add to favorites", favorite);
  $("#np-favorite").classList.toggle("is-on", favorite);
  const flagged = marks.flagged.has(id);
  setControl("#np-flag", "flag", flagged ? "Flagged (press to change)" : "Flag a problem", flagged);
  $("#np-flag").classList.toggle("is-on", flagged);
}

async function toggleFavorite(): Promise<void> {
  const track = nowPlaying();
  if (!track || !markStore) return;
  const on = !marks.favorites.has(track.id);
  if (on) marks.favorites.add(track.id);
  else marks.favorites.delete(track.id);
  showMarks();
  toast(on ? "Added to your favorites" : "Removed from your favorites", 1800);
  try {
    await markStore.favorite(track.id, on);
  } catch (error) {
    if (on) marks.favorites.delete(track.id);
    else marks.favorites.add(track.id);
    showMarks();
    toast(`Could not save that: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let flagReturn: HTMLElement | null = null;

function openFlagPanel(): void {
  const track = nowPlaying();
  if (!track || !markStore) return;
  const store = markStore;
  const at = audio.currentTime;
  const reasons = $("#flag-reasons");
  reasons.replaceChildren();
  const add = (label: string, act: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "f";
    button.textContent = label;
    button.addEventListener("click", act);
    reasons.append(button);
  };
  const flagged = marks.flagged.has(track.id);
  for (const [reason, label] of FLAG_REASONS) {
    add(label, () => void saveFlag(store, track, true, reason, at));
  }
  if (flagged) add("Remove the flag", () => void saveFlag(store, track, false, "other", at));
  add("Cancel", closeFlagPanel);
  $("#flag-where").textContent = `“${track.title}” at ${clock(at)}. The flag is kept ${store.flagsWhere}.`;
  flagReturn = current();
  $("#flag-panel").hidden = false;
  wake(); // the chooser answers its first OK press, even if the controls had faded
  focus(reasons.querySelector<HTMLElement>(".f"));
}

function closeFlagPanel(): void {
  $("#flag-panel").hidden = true;
  focus(flagReturn ?? $("#np-flag"));
}

async function saveFlag(store: MarkStore, track: ServerTrack, on: boolean, reason: FlagReason, at: number): Promise<void> {
  closeFlagPanel();
  try {
    await store.flag(track.id, on, reason, at * 1000);
    if (on) marks.flagged.add(track.id);
    else marks.flagged.delete(track.id);
    showMarks();
    toast(on ? `Flagged. You will find it ${store.flagsWhere}.` : "Flag removed.", 3500);
  } catch (error) {
    toast(`Could not save the flag: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function actionButton(label: string, action: () => void, symbol?: IconName, main = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  // Lighter buttons, as in the modern Media Player: an icon and a word; only the main one (Play) is filled.
  button.className = main ? "action is-main f" : "action f";
  button.textContent = label;
  if (symbol) button.prepend(icon(symbol, { size: 28, filled: symbol === "play" }));
  button.addEventListener("click", action);
  return button;
}

function renderSettings(): void {
  view.append(heading("Settings"));
  const box = document.createElement("div");
  box.className = "settings";
  const can = (type: string) => (audio.canPlayType(type) === "probably" ? "yes" : audio.canPlayType(type) === "maybe" ? "probably" : "no");
  const lines = [
    drive ? ["Music from", `the USB drive (${drive.drive.label})`] : jelly ? ["Jellyfin", `${jelly.name} at ${jelly.base.replace(/^https?:\/\//, "")}`] : ["Computer", `${computerName || "?"} at ${connection?.host ?? "?"}`],
    ["Library", `${songs.length.toLocaleString()} songs, ${albums.length.toLocaleString()} albums`],
    ["This TV plays", `MP3: ${can("audio/mpeg")} · FLAC: ${can("audio/flac")} · AAC: ${can("audio/mp4")}`],
    ["App", `MediaVerse Studio for TV ${__TV_VERSION__}`],
  ];
  for (const [label, value] of lines) {
    const row = document.createElement("p");
    row.innerHTML = `<span class="settings-label"></span><span></span>`;
    row.children[0].textContent = label;
    row.children[1].textContent = value;
    box.append(row);
  }
  // Songs without lyrics: the visualizer in the middle (livelier) or the glow from the bottom (calmer).
  const looks = document.createElement("div");
  looks.className = "actions settings-choice";
  const lookLabel = document.createElement("span");
  lookLabel.className = "settings-label";
  lookLabel.textContent = "Songs without lyrics";
  looks.append(lookLabel);
  for (const [mode, label] of [["middle", "Visualizer in the middle"], ["glow", "Glow from the bottom"]] as const) {
    const choice = actionButton(label, () => {
      setVisualizerMode(mode);
      for (const other of looks.querySelectorAll<HTMLElement>(".action")) other.classList.toggle("is-main", other === choice);
    });
    if (visualizerMode === mode) choice.classList.add("is-main");
    looks.append(choice);
  }
  box.append(looks);
  // The highlight colour (D75): 20 swatches; OK picks one. Now Playing still follows the cover.
  const colours = document.createElement("div");
  colours.className = "settings-choice accent-choice";
  const colourLabel = document.createElement("span");
  colourLabel.className = "settings-label";
  colourLabel.textContent = "Highlight colour";
  const swatches = document.createElement("div");
  swatches.className = "accent-swatches";
  const colourName = document.createElement("span");
  colourName.className = "accent-name";
  const nameOf = (hex: string): string => ACCENT_CHOICES.find((c) => c.hex === hex)?.name ?? "";
  colourName.textContent = nameOf(chosenAccent);
  for (const choice of ACCENT_CHOICES) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = choice.hex === chosenAccent ? "swatch f is-on" : "swatch f";
    swatch.style.setProperty("--swatch", choice.hex);
    swatch.setAttribute("aria-label", choice.name);
    swatch.addEventListener("focus", () => (colourName.textContent = choice.name));
    swatch.addEventListener("blur", () => (colourName.textContent = nameOf(chosenAccent)));
    swatch.addEventListener("click", () => {
      setAccent(choice.hex);
      for (const other of swatches.querySelectorAll<HTMLElement>(".swatch")) other.classList.toggle("is-on", other === swatch);
      colourName.textContent = choice.name;
    });
    swatches.append(swatch);
  }
  colours.append(colourLabel, swatches, colourName);
  box.append(colours);
  // The colour mask over the cover wall: on washes the covers with one colour (the desktop's look); then its colour.
  const maskRow = document.createElement("div");
  maskRow.className = "settings-choice";
  const maskToggle = actionButton("", () => {
    setMask({ ...maskPrefs, on: !maskPrefs.on });
    showMask();
  });
  const maskColours = document.createElement("div");
  maskColours.className = "settings-choice accent-choice";
  const maskLabel = document.createElement("span");
  maskLabel.className = "settings-label";
  maskLabel.textContent = "Mask colour";
  const maskSwatches = document.createElement("div");
  maskSwatches.className = "accent-swatches";
  const maskName = document.createElement("span");
  maskName.className = "accent-name";
  const maskNameOf = (hex: string | null): string => (hex ? (ACCENT_CHOICES.find((c) => c.hex === hex)?.name ?? "") : "Drifting");
  const showMask = (): void => {
    maskToggle.textContent = `Background colour mask: ${maskPrefs.on ? "On" : "Off"}`;
    maskName.textContent = maskPrefs.on ? maskNameOf(maskPrefs.hex) : "Covers show in their own colours";
    maskColours.hidden = !maskPrefs.on;
  };
  for (const choice of [{ hex: null as string | null, name: "Drifting" }, ...ACCENT_CHOICES]) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = choice.hex === maskPrefs.hex ? "swatch f is-on" : "swatch f";
    swatch.style.setProperty("--swatch", choice.hex ?? DRIFT_SWATCH);
    swatch.setAttribute("aria-label", choice.name);
    swatch.addEventListener("focus", () => (maskName.textContent = choice.name));
    swatch.addEventListener("blur", () => (maskName.textContent = maskNameOf(maskPrefs.hex)));
    swatch.addEventListener("click", () => {
      setMask({ ...maskPrefs, hex: choice.hex });
      for (const other of maskSwatches.querySelectorAll<HTMLElement>(".swatch")) other.classList.toggle("is-on", other === swatch);
      maskName.textContent = choice.name;
    });
    maskSwatches.append(swatch);
  }
  maskColours.append(maskLabel, maskSwatches, maskName);
  maskRow.append(maskToggle);
  showMask();
  box.append(maskRow, maskColours);
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    actionButton("Reload the library", () => void reloadLibrary()),
    actionButton("Choose another source", () => {
      audio.pause();
      foundComputers.clear();
      void showSources();
    }),
    actionButton(jelly ? "Sign out of Jellyfin" : "Forget this computer", () => {
      audio.pause();
      if (jelly) {
        saveJellyfin(null);
        jelly = null;
        serverProfiles = null;
        serverProfile = null;
      } else {
        saveConnection(null);
        connection = null;
      }
      foundComputers.clear();
      void showSources();
    }),
  );
  box.append(actions);
  view.append(box);
}

async function reloadLibrary(): Promise<void> {
  if (drive) {
    await chooseDrive(drive.drive);
    return;
  }
  if (jelly) {
    await openJellyfin(jelly);
    return;
  }
  if (!connection) return;
  toast("Reloading the library…");
  try {
    setLibrary(await fetchLibrary(connection));
    await loadPlaylists();
    renderView();
    focus(focusables().find((el) => view.contains(el)));
    toast(`${songs.length.toLocaleString()} songs`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

type TabName = "library" | "albums" | "artists" | "genres" | "songs" | "favorites" | "playlists" | "queue" | "search" | "settings" | "playing" | "who";

function openTab(kind: TabName): void {
  if (kind === "who") {
    openPicker(false);
    return;
  }
  if (kind === "playing") {
    if (queue.length) openNowPlaying();
    else toast("Nothing is playing yet. Choose an album or a song.");
    return;
  }
  history.length = 0;
  // Library opens the view last chosen inside it (artists, albums, genres or songs).
  if (kind === "library") kind = libraryKind;
  if (LIBRARY_KINDS.includes(kind as LibraryKind)) libraryKind = kind as LibraryKind;
  viewState = kind === "search" ? { kind, query: "" } : { kind: kind as Exclude<TabName, "library" | "search" | "playing" | "who"> };
  renderView();
  // Playlists may have changed on the computer since the library was read.
  if (kind === "playlists") {
    void loadPlaylists().then(() => {
      if (viewState.kind === "playlists" && !history.length) {
        renderView();
        focus(focusables().find((el) => view.contains(el)) ?? document.querySelector<HTMLElement>('.tab[data-tab="playlists"]'));
      }
    });
  }
}

function openView(state: ViewState): void {
  const from = current();
  const items = focusables().filter((el) => view.contains(el));
  history.push({ state: viewState, focusIndex: from ? items.indexOf(from) : -1, scroll: view.scrollTop });
  viewState = state;
  renderView();
  focus(focusables().find((el) => view.contains(el)));
}

function goBackInBrowse(): boolean {
  const last = history.pop();
  if (!last) return false;
  viewState = last.state;
  renderView();
  if (last.focusIndex >= 0) chunkedView?.ensure(last.focusIndex + 1);
  view.scrollTop = last.scroll;
  const items = focusables().filter((el) => view.contains(el));
  focus(items[last.focusIndex] ?? items[0]);
  return true;
}

// ---------- Playing ----------

let queue: ServerTrack[] = [];
let order: number[] = [];
let position = -1;
let shuffle = false;
let lyrics: TrackLyrics | null = null;
let showLyrics = true;
/** The playing song's lyrics have been asked for and not yet answered. */
let lyricsPending = false;

function nowPlaying(): ServerTrack | undefined {
  return queue[order[position]];
}

// ---------- Remembering the queue (owner, 2026-11-24) ----------
// What was playing is kept in the TV app's storage: the queue and its order when they change, how far into the song every few seconds. When the app starts
// again and the same music source is back, the queue is restored paused (music must not start by itself on a TV that was just switched on); Play, or
// Next, carries on from there.

const QUEUE_MEMORY_KEY = "mediaverse.tv.queue.v1";
const POSITION_MEMORY_KEY = "mediaverse.tv.queue-position.v1";
/** A restored queue that has not been started yet; Play starts it where it was. */
let restoredWaiting: { seconds: number } | null = null;

function sourceKey(): string {
  try {
    return markSource?.key ?? "";
  } catch {
    return ""; // the source is not set up yet
  }
}

function writeMemory(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: remembering is a convenience only
  }
}

/** Each profile keeps its own queue and place (D213). */
const memoryKey = (base: string): string => (serverProfile ? `${base}:${serverProfile.toLowerCase()}` : base);

function rememberQueue(): void {
  const saved = snapshotQueue(sourceKey(), queue, order, position, shuffle, repeat);
  if (saved) writeMemory(memoryKey(QUEUE_MEMORY_KEY), saved);
  rememberPosition();
}

function rememberPosition(): void {
  if (restoredWaiting) return; // nothing has been played since the queue came back: the saved place stays
  const track = nowPlaying();
  const source = sourceKey();
  if (!track || !source || !audio.getAttribute("src")) return;
  writeMemory(memoryKey(POSITION_MEMORY_KEY), { source, id: track.id, seconds: Math.floor(audio.currentTime) });
}

/** Puts the remembered queue back once the library it belongs to has songs; returns whether it did. Run again as a USB drive's songs arrive. */
function restoreSavedQueue(): void {
  if (queue.length && !restoredWaiting) return; // something else is playing (or was started): leave it
  let saved: SavedQueue | null = null;
  let place: SavedPosition | null = null;
  try {
    saved = readSavedQueue(localStorage.getItem(memoryKey(QUEUE_MEMORY_KEY)));
    place = readSavedPosition(localStorage.getItem(memoryKey(POSITION_MEMORY_KEY)));
  } catch {
    return;
  }
  if (!saved || saved.source !== sourceKey()) return;
  const byId = new Map(songs.map((song) => [song.id, song]));
  const back = restoreQueue(saved, byId, place);
  if (!back) return;
  const firstTime = !restoredWaiting;
  queue = back.queue;
  order = back.order;
  position = back.position;
  shuffle = saved.shuffle;
  repeat = saved.repeat;
  restoredWaiting = { seconds: back.seconds };
  showRepeat();
  updateNowPlaying();
  if (firstTime) toast(`Your queue is back: ${back.order.length.toLocaleString()} songs. Press Play to carry on.`, 4000);
}

/** Play on a restored queue: opens the song that was playing and goes to where it was. */
function startRestored(): void {
  const waiting = restoredWaiting;
  if (!waiting) return;
  startTrack(); // clears `restoredWaiting`
  if (waiting.seconds > 1) {
    audio.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(waiting.seconds, Math.max(0, audio.duration - 1));
      },
      { once: true },
    );
  }
}

setInterval(() => {
  if (!audio.paused) rememberPosition();
}, 5000);
window.addEventListener("pagehide", rememberPosition);

function play(list: ServerTrack[], start: number, shuffled = false): void {
  if (!list.length) return;
  queue = list;
  shuffle = shuffled;
  order = shuffled ? shuffledOrder(list.length, start) : list.map((_, i) => i);
  position = shuffled ? 0 : start;
  startTrack();
  openNowPlaying(true);
}

function toggleShuffle(): void {
  if (!queue.length) return;
  const playingIndex = order[position];
  shuffle = !shuffle;
  order = shuffle ? shuffledOrder(queue.length, playingIndex) : queue.map((_, i) => i);
  position = order.indexOf(playingIndex);
  rememberQueue();
  updateNowPlaying();
  toast(shuffle ? "Shuffle on" : "Shuffle off", 1500);
}

function startTrack(): void {
  const track = nowPlaying();
  const address = track && trackAudio(track);
  if (!track || !address) return;
  restoredWaiting = null;
  rememberQueue();
  audio.src = address;
  playMusic();
  lyrics = null;
  // Until this song's lyrics are known the layout stays as it is (with or without lyrics), so one song with lyrics
  // after another does not flash to the large layout in between.
  lyricsPending = true;
  const asked = track.id;
  const settle = (): void => {
    if (nowPlaying()?.id !== asked || !lyricsPending) return;
    lyricsPending = false;
    renderLyrics();
  };
  window.setTimeout(settle, 5_000); // a slow or silent source: decide without lyrics
  trackLyrics(track)
    .then((found) => {
      if (nowPlaying()?.id === asked) lyrics = found.lines.length ? { ...found, lines: sortedLines(found.lines) } : found;
    })
    .catch(() => undefined)
    .finally(settle);
  updateNowPlaying();
  renderLyrics();
  markPlaying();
  analyseSoon();
}

let analyseTimer = 0;

/**
 * Starts the visualizer's analysis once the song has been playing smoothly for 3 s, not at the same moment it
 * starts: the analysis reads and decodes the whole song again, and at the start that competed with the player
 * (a slow USB stick read the file twice at once; the TV's player once stalled 1.5 s in).
 */
function analyseSoon(): void {
  if (analysis) analysis.stopped = true;
  spectrum = null;
  window.clearTimeout(analyseTimer);
  const id = nowPlaying()?.id;
  const go = (): void => {
    window.clearTimeout(analyseTimer);
    analyseTimer = window.setTimeout(() => {
      if (nowPlaying()?.id !== id) return;
      if (!audio.paused) analyseCurrent();
      else audio.addEventListener("playing", go, { once: true });
    }, 3000);
  };
  audio.addEventListener("playing", go, { once: true });
}

function next(): void {
  if (position + 1 < order.length) {
    position += 1;
    startTrack();
  } else if (repeat !== "off" && order.length) {
    // Repeat all (or this song, when skipped by hand): back to the start of the queue, freshly shuffled if on.
    if (shuffle) order = shuffledOrder(queue.length, order[position]).slice(1).concat(order[position]);
    position = 0;
    startTrack();
  } else {
    audio.pause();
    toast("End of the list.");
  }
}

function previous(): void {
  if (audio.currentTime > 3 || position === 0) {
    audio.currentTime = 0;
    return;
  }
  position -= 1;
  startTrack();
}

function playPause(): void {
  if (!nowPlaying()) return;
  if (audio.paused) resume();
  else audio.pause();
}

// ---------- Resuming safely ----------
// Owner, 2026-11-03: after a song had been paused for about 5 minutes, Play made the visualizer jitter and the
// song did not continue; skipping to the next song and back worked. The connection to the computer can go stale
// during a long pause, so a long pause reopens the song where it stopped, and a watchdog reopens it when it is
// meant to be playing but has not moved for a while.

let pausedSince = 0;
audio.addEventListener("pause", () => (pausedSince = Date.now()));
audio.addEventListener("play", () => (pausedSince = 0));

/** Opens the current song again and continues at `seconds` (the same song: its visualizer analysis is kept). */
function reopenAt(seconds: number): void {
  const address = audio.getAttribute("src");
  if (!address) return;
  audio.src = address;
  audio.addEventListener(
    "loadedmetadata",
    () => {
      if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 1));
    },
    { once: true },
  );
  playMusic();
}

// ---------- The phone as the remote (D58) ----------
// When the library comes from MediaVerse Studio on a phone, the phone can send "play these songs from here" and
// the usual controls, and sees what the TV plays. A computer has no remote (404): then this stops at once.

let remoteFor: Connection | null = null;

async function listenToRemote(source: Connection): Promise<void> {
  remoteFor = source;
  let after = -1;
  let reported = 0;
  const report = window.setInterval(() => {
    if (remoteFor !== source || connection !== source) return window.clearInterval(report);
    const track = nowPlaying();
    // Every 2 s while playing; every 10 s otherwise, so the phone knows the TV is still there.
    if (!track || (audio.paused && Date.now() - reported < 10_000)) return;
    reported = Date.now();
    void postRemoteState(source, { id: track.id, playing: !audio.paused, position_ms: Math.round(audio.currentTime * 1000), duration_ms: Math.round((audio.duration || 0) * 1000) }).catch(() => undefined);
  }, 2000);
  while (remoteFor === source && connection === source) {
    try {
      const reply = await waitForCommands(source, after);
      if (!reply) break; // a computer: no remote
      after = reply.seq;
      for (const command of reply.commands) obey(command);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // the phone is away; try again shortly
    }
  }
  window.clearInterval(report);
}

function obey(command: RemoteCommand): void {
  switch (command.action) {
    case "play": {
      const byId = new Map(songs.map((track) => [track.id, track]));
      const list = command.ids.map((id) => byId.get(id)).filter((track): track is ServerTrack => !!track);
      if (!list.length) return;
      const start = Math.min(Math.max(0, command.index), list.length - 1);
      play(list, start, !!command.shuffle);
      if (command.position_ms > 1000) audio.addEventListener("loadedmetadata", () => (audio.currentTime = command.position_ms / 1000), { once: true });
      toast(`Playing from ${computerName || "the phone"}`, 2000); // the phone or, since D76, the computer
      break;
    }
    case "toggle":
      playPause();
      break;
    case "pause":
      audio.pause();
      break;
    case "next":
      next();
      break;
    case "previous":
      previous();
      break;
    case "seek":
      if (nowPlaying() && Number.isFinite(command.ms)) audio.currentTime = Math.max(0, command.ms / 1000);
      break;
  }
}

/** Play after a pause: after a long one, reopen the song where it stopped rather than trust the old connection. */
function resume(): void {
  if (restoredWaiting) {
    startRestored();
    return;
  }
  if (pausedSince && Date.now() - pausedSince > 60_000) reopenAt(audio.currentTime);
  else playMusic();
}

let stuckSeconds = 0;
let stuckAt = -1;
let reopenings = 0;
let lastPosition = -1;
setInterval(() => {
  if (audio.paused || !audio.getAttribute("src") || audio.ended) {
    stuckSeconds = 0;
    lastPosition = -1;
    return;
  }
  const now = audio.currentTime;
  if (now !== lastPosition) {
    lastPosition = now;
    stuckSeconds = 0;
    if (Math.abs(now - stuckAt) > 5) reopenings = 0; // moving well again, away from the trouble spot
    return;
  }
  // Measured on the living room TV (2026-11-04): the player stopped 1.5 s into a song with 157 s already
  // downloaded, and sat there until this watchdog stepped in. With plenty downloaded the hold-up is the TV's
  // player, not the network, so it is reopened after 2.5 s; when the download itself is behind, after 6 s.
  stuckSeconds += 0.5;
  const ahead = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) - now : 0;
  if (stuckSeconds < (ahead > 10 ? 2.5 : 6)) return;
  stuckSeconds = 0;
  if (reopenings >= 2) {
    reopenings = 0;
    toast("This song stopped playing. Going on to the next one.", 4000);
    next();
    return;
  }
  reopenings += 1;
  stuckAt = now;
  reopenAt(now);
}, 500);

/**
 * Measured on the living room TV (2026-11-04): after any pause (a new queue started from silence, or Play after
 * Pause) the TV's player stops once, 1.5 s in, with the song already downloaded, and only reopening the song gets
 * it going. Neither a silent Web Audio tone nor a second silent player keeps it from happening; reopening at once
 * (rather than waiting for the watchdog) turns a 2.5 s halt into about a third of a second. At most once every 10 s;
 * the watchdog stays as the backup.
 */
let lastQuickReopen = 0;
audio.addEventListener("waiting", () => {
  const ahead = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) - audio.currentTime : 0;
  if (audio.paused || audio.currentTime < 0.5 || ahead < 10 || Date.now() - lastQuickReopen < 10_000) return;
  lastQuickReopen = Date.now();
  reopenAt(audio.currentTime);
});

function seekBy(seconds: number): void {
  if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration - 1, audio.currentTime + seconds));
}

let failures = 0;
audio.addEventListener("ended", () => {
  failures = 0;
  if (repeat === "one") {
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
    return;
  }
  next();
});
audio.addEventListener("playing", () => (failures = 0));
audio.addEventListener("error", () => {
  const track = nowPlaying();
  if (!track) return;
  failures += 1;
  toast(`Could not play “${track.title}”. ${failures < 5 ? "Skipping to the next song." : "Stopped after several songs failed: check the computer."}`, 4000);
  if (failures < 5) setTimeout(next, 1500);
});
audio.addEventListener("play", updatePlayButton);
audio.addEventListener("pause", updatePlayButton);
audio.addEventListener("playing", keepAwake);
audio.addEventListener("pause", () => {
  // Between songs the player pauses for a moment; only a pause that lasts lets the screen saver back.
  setTimeout(() => {
    if (audio.paused) keepAwake();
  }, 3_000);
});
// The TV accepts "screen saver off" but on the S95F still brought it back after 20 to 30 seconds of music, so
// the request is repeated while music plays on Now Playing (and only then).
let clipLastTime = -1;
setInterval(() => {
  if (audio.paused) return;
  keepAwake();
  if (nativeClipUsable()) {
    checkNativeClip();
    return;
  }
  // A clip that has stopped moving (stuck at its end) is sent back to the start.
  const clip = keepAwakeClip;
  if (clip && clip.getAttribute("src") && clip.readyState >= 2) {
    if (clip.currentTime === clipLastTime) {
      clip.currentTime = 0;
      void clip.play().catch(() => undefined);
    }
    clipLastTime = clip.currentTime;
  }
}, 10_000);
audio.addEventListener("timeupdate", updateTime);
/** The song whose play has been counted for the profile (once per play, after 30 seconds or half of a short one). */
let countedPlay = "";
audio.addEventListener("timeupdate", () => {
  const track = nowPlaying();
  if (!track || !jelly || !serverProfile || audio.paused) return;
  if (audio.currentTime < 2 && countedPlay === track.id) countedPlay = ""; // the same song again from the start
  if (countedPlay === track.id || audio.currentTime < playedThreshold(audio.duration)) return;
  countedPlay = track.id;
  const list = playlists.find((p) => p.id === "recently-played");
  if (list) list.ids = [track.id, ...list.ids.filter((id) => id !== track.id)].slice(0, 100);
  void markJellyfinPlayed(jelly, track.id).catch(() => undefined);
});
audio.addEventListener("durationchange", updateTime);

/** Gives a control its icon (shared with the desktop) and its name. */
function setControl(selector: string, name: IconName, label: string, filled = false, size = 36): void {
  const button = $(selector);
  button.replaceChildren(icon(name, { size, filled }));
  button.setAttribute("aria-label", label);
}
setControl('[data-action="previous"]', "previous", "Previous", true);
setControl('[data-action="next"]', "next", "Next", true);
setControl("#np-lyrics-toggle", "lyrics", "Lyrics");
document.querySelector('.tab[data-tab="search"]')?.append(icon("search", { size: 36 }));

function updatePlayButton(): void {
  setControl("#np-play", audio.paused ? "play" : "pause", audio.paused ? "Play" : "Pause", true, 46);
}

// Repeat, as in Media Player: off, every song in the queue, or this song.
type RepeatMode = "off" | "all" | "one";
let repeat: RepeatMode = "off";
const REPEAT_LABELS: Record<RepeatMode, string> = { off: "Repeat: off", all: "Repeat: all songs", one: "Repeat: this song" };

function showRepeat(): void {
  setControl("#np-repeat", repeat === "one" ? "repeat-one" : "repeat", REPEAT_LABELS[repeat]);
  $("#np-repeat").classList.toggle("is-on", repeat !== "off");
}

function toggleRepeat(): void {
  repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
  rememberQueue();
  showRepeat();
  toast(REPEAT_LABELS[repeat], 1500);
}

function showShuffle(): void {
  setControl("#np-shuffle", "shuffle", shuffle ? "Shuffle: on" : "Shuffle: off");
  $("#np-shuffle").classList.toggle("is-on", shuffle);
}
showRepeat();

// Low-power pass (owner, 2026-11-05: smooth on older and weaker TVs, and cool when left on all day): the times are
// written only when the shown second changes, and the bars move by transform (drawn by the graphics chip) rather
// than by width (which made the TV lay the page out again four times a second).
let shownElapsed = "";
let shownDuration = "";
let shownFraction = "";
const elapsedText = $("#np-elapsed");
const durationText = $("#np-duration");
const npBar = $("#np-bar");
const miniBar = $("#mini-bar");
function updateTime(): void {
  const duration = audio.duration;
  const fraction = Number.isFinite(duration) && duration > 0 ? audio.currentTime / duration : 0;
  const elapsed = clock(audio.currentTime);
  if (elapsed !== shownElapsed) elapsedText.textContent = shownElapsed = elapsed;
  const total = clock(duration);
  if (total !== shownDuration) durationText.textContent = shownDuration = total;
  const scale = `scaleX(${fraction.toFixed(4)})`;
  if (scale !== shownFraction) npBar.style.transform = miniBar.style.transform = shownFraction = scale;
  followLyrics();
}

function setImage(image: HTMLImageElement, track: ServerTrack | undefined, size: number): void {
  const source = track && trackCover(track, size);
  if (!source) {
    image.hidden = true;
    return;
  }
  if (image.src === source) return;
  image.hidden = true;
  image.onload = () => (image.hidden = false);
  image.onerror = () => (image.hidden = true);
  // Read for the visualizer's colours; the computer and Jellyfin allow it, local files need no permission.
  if (/^https?:/i.test(source)) image.crossOrigin = "anonymous";
  else image.removeAttribute("crossorigin");
  image.src = source;
}

let shownTrackId = "";

function updateNowPlaying(): void {
  const track = nowPlaying();
  $("#mini").hidden = !track;
  if (!track) return;
  const fill = (): void => {
    $("#np-title").textContent = track.title;
    $("#np-artist").textContent = track.artist ?? "";
    $("#np-album").textContent = track.album ?? "";
    $("#np-year").textContent = track.year ? String(track.year) : "";
    setImage($<HTMLImageElement>("#np-cover"), firstOfAlbum, 512);
  };
  $("#mini-title").textContent = track.title;
  $("#mini-artist").textContent = track.artist ?? "";
  const coverTrack = queue.find((t) => t.cover_key === track.cover_key) ?? track;
  const firstOfAlbum = albums.find((a) => a.tracks.includes(track))?.tracks[0] ?? coverTrack;
  if (track.id !== shownTrackId && shownTrackId && screen === "playing") {
    swapSides(fill); // a new song: the cover and the details change sides as it comes in
  } else {
    fill();
  }
  shownTrackId = track.id;
  setImage($<HTMLImageElement>("#mini-cover"), firstOfAlbum, 128);
  setImage($<HTMLImageElement>("#backdrop-image"), firstOfAlbum, 256);
  // No cover: the soft backdrop (a canvas, see below) is cleared rather than left with the last album's.
  if (!firstOfAlbum || !trackCover(firstOfAlbum, 256)) clearBackdrop();
  showShuffle();
  const upcoming = queue[order[position + 1]];
  $("#np-next").textContent = upcoming ? `Next: ${upcoming.title}${upcoming.artist ? ` · ${upcoming.artist}` : ""}` : "";
  updatePlayButton();
  updateTime();
  showMarks();
}

function markPlaying(): void {
  const id = nowPlaying()?.id;
  for (const row of view.querySelectorAll<HTMLElement>(".row")) row.classList.toggle("is-playing", row.dataset.trackId === id);
}

let lyricLines: HTMLElement[] = [];
let lastLine = -2;

/** Plain lyrics' offset last set. */
let shownOffset = "";

function renderLyrics(): void {
  const box = $("#np-lyrics");
  box.replaceChildren();
  lyricLines = [];
  lastLine = -2;
  lyricGeometry = null;
  shownOffset = "";
  // Lyrics sit over the visualizer, which dims behind them; with none (or switched off) the visualizer has the
  // middle to itself.
  const has = showLyrics && !!lyrics && ((lyrics.synced && lyrics.lines.length > 0) || !!lyrics.plain);
  box.hidden = !has;
  $("#np-lyrics-toggle").classList.toggle("is-on", showLyrics);
  // Still waiting for this song's lyrics: the layout stays as it was (the box is empty meanwhile).
  if (document.body.classList.contains("has-lyrics") !== has && !(lyricsPending && showLyrics)) {
    document.body.classList.toggle("has-lyrics", has);
    // The two layouts differ a lot (small cover in a corner with lyrics): fade the new one in, not a jump.
    if (screen === "playing") {
      const fading = $("#np-stage");
      fading.classList.remove("is-relayout");
      void fading.offsetWidth; // restarts the fade
      fading.classList.add("is-relayout");
    }
  }
  const inner = document.createElement("div");
  inner.className = "np-lyrics-inner";
  box.append(inner);
  if (!lyrics || !has) return;
  if (lyrics.synced && lyrics.lines.length) {
    for (const line of lyrics.lines) {
      const p = document.createElement("p");
      p.textContent = line.text || "♪";
      inner.append(p);
      lyricLines.push(p);
    }
    box.classList.add("is-synced");
  } else if (lyrics.plain) {
    box.classList.remove("is-synced");
    for (const text of plainLines(lyrics.plain)) {
      const p = document.createElement("p");
      p.textContent = text || " ";
      inner.append(p);
    }
  }
  followLyrics();
}

/**
 * Where each lyric line sits in the scrolling box, and the box's height: measured once per song and layout
 * (measuring made the TV lay the page out on every time update). Null until measured.
 */
let lyricGeometry: { box: number; lines: Array<{ el: HTMLElement; top: number; height: number; out: boolean }> } | null = null;

function measureLyrics(box: HTMLElement, inner: HTMLElement): typeof lyricGeometry {
  if (lyricGeometry) return lyricGeometry;
  if (box.clientHeight <= 0) return null;
  const lines = [...inner.children].map((el) => ({ el: el as HTMLElement, top: (el as HTMLElement).offsetTop, height: (el as HTMLElement).offsetHeight, out: false }));
  lyricGeometry = { box: box.clientHeight, lines };
  return lyricGeometry;
}

/**
 * Lines only partly inside the box fade out, each on its own, and fade in once wholly inside (owner, 2026-11-06:
 * a gradient mask over the box's top and bottom showed on the TV as dark bands that surged as synced lyrics
 * jumped ahead).
 */
function fadeLyricEdges(geometry: NonNullable<typeof lyricGeometry>, offset: number): void {
  for (const line of geometry.lines) {
    const top = line.top + offset;
    const out = top < 0 || top + line.height > geometry.box;
    if (out !== line.out) {
      line.out = out;
      line.el.classList.toggle("is-out", out);
    }
  }
}

function followLyrics(): void {
  if (!showLyrics || !lyrics || screen !== "playing") return;
  const box = $("#np-lyrics");
  const inner = box.firstElementChild as HTMLElement | null;
  if (!inner) return;
  const geometry = measureLyrics(box, inner);
  if (!geometry) return;
  if (lyrics.synced && lyricLines.length) {
    const index = currentLine(lyrics.lines, audio.currentTime * 1000);
    if (index === lastLine) return;
    lyricLines[lastLine]?.classList.remove("is-now");
    lastLine = index;
    const at = Math.max(0, index);
    if (index >= 0) lyricLines[at].classList.add("is-now");
    const line = geometry.lines[at];
    const offset = Math.round(geometry.box / 2 - line.top - line.height / 2);
    inner.style.transform = `translateY(${offset}px)`;
    fadeLyricEdges(geometry, offset);
  } else if (lyrics.plain && Number.isFinite(audio.duration) && audio.duration > 0 && geometry.lines.length) {
    // Plain lyrics rise through the box over the song, like credits (owner, 2026-11-06): the first line starts at
    // the bottom of the box and the last line reaches the top as the song ends.
    const first = geometry.lines[0];
    const last = geometry.lines[geometry.lines.length - 1];
    const start = geometry.box - first.top - first.height;
    const end = -last.top;
    // One whole line at a time, every few seconds, as synced lyrics move (owner, 2026-11-06): a smooth crawl of a
    // pixel or so at a time let the TV's still-picture screen saver in about 2 minutes into a song.
    const step = Math.max(1, first.height);
    const travelled = (start - end) * Math.min(1, audio.currentTime / audio.duration);
    const offset = Math.round(Math.max(end, start - Math.floor(travelled / step) * step));
    const transform = `translateY(${offset}px)`;
    if (transform !== shownOffset) {
      inner.style.transform = shownOffset = transform;
      fadeLyricEdges(geometry, offset);
    }
  }
}

function openNowPlaying(fresh = false): void {
  showScreen("playing");
  updateNowPlaying();
  renderLyrics();
  focus($("#np-play"));
  wake();
  fillWall();
  // The wall builds itself from black for a new queue (or the first time); otherwise it is shown as it is.
  if (fresh || !wallStarted) {
    wallStarted = true;
    assembleWall();
  }
  startVisualizer();
}

/**
 * The cover wall builds itself slowly (owner, 2026-11-04): Now Playing opens on black; once the song and the
 * visualizer are under way, tiles fade in a few at a time in random places, the whole wall over 45 seconds,
 * each loading its picture only as it appears; tiles start turning over only once the wall is complete. A new
 * song start then never competes with loading and drawing some 170 covers.
 */
const WALL_BUILD_MS = 45_000;
const WALL_START_MS = 4_000; // after the song starts playing: the visualizer's analysis starts at 3 s
const TILES_PER_STEP = 3;
let wallComplete = false;
let wallStarted = false;
let wallBuild = 0; // the current build; an older one stops

function assembleWall(): void {
  const build = ++wallBuild;
  wallComplete = false;
  const tiles = [...document.querySelectorAll<HTMLElement>("#np-wall .flip-tile")];
  for (const tile of tiles) tile.classList.remove("is-shown");
  // Random order: a shuffled copy.
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  const steps = Math.max(1, Math.ceil(tiles.length / TILES_PER_STEP));
  const every = WALL_BUILD_MS / steps;
  let next = 0;
  const step = (): void => {
    if (build !== wallBuild) return;
    if (screen === "playing") {
      for (const tile of tiles.slice(next, next + TILES_PER_STEP)) {
        const image = tile.querySelector<HTMLImageElement>("img.flip-face[data-src]");
        if (image) {
          image.src = image.dataset.src!;
          delete image.dataset.src;
          image.addEventListener("load", () => tile.classList.add("is-shown"), { once: true });
          image.addEventListener("error", () => tile.classList.add("is-shown"), { once: true });
        } else {
          tile.classList.add("is-shown");
        }
      }
      next += TILES_PER_STEP;
    }
    if (next < tiles.length) window.setTimeout(step, every);
    else wallComplete = true;
  };
  const begin = (): void => {
    if (build === wallBuild) window.setTimeout(step, WALL_START_MS);
  };
  if (!audio.paused) begin();
  else if (audio.getAttribute("src")) audio.addEventListener("playing", begin, { once: true });
  else begin();
}
// ---------- Now Playing: visualizer, cover wall, changing sides ----------

let spectrum: Spectrum | null = null;
let analysis: { stopped: boolean } | null = null;

/** Analyses the playing song for the visualizer (the TV's player cannot be listened to directly). */
function analyseCurrent(): void {
  if (analysis) analysis.stopped = true;
  spectrum = null;
  const track = nowPlaying();
  const address = track && trackAudio(track);
  if (!track || !address) return;
  const mine = (analysis = { stopped: false });
  void analyseSong(address, mine, (found) => {
    if (!mine.stopped && nowPlaying()?.id === track.id) spectrum = found;
  }, analyseInBackground);
}

const canvas = $<HTMLCanvasElement>("#np-vis");
const pen = canvas.getContext("2d")!;
const levels = new Float32Array(BANDS);
const peaks = new Float32Array(BANDS);
let visFrame = 0;
let style: Style = STYLES[0];
let styleIndex = 0;
/**
 * The highlight colour chosen in Settings (D75, one of 20, kept on this TV): buttons, focus and progress outside
 * Now Playing, and the visualizer's colours when a cover has none that can be read. Now Playing otherwise takes
 * its colours from the cover.
 */
const ACCENT_STORE = "mediaverse.tv.accent";
let chosenAccent = loadAccent(ACCENT_STORE);
let chosenPalette: Palette = paletteFromHex(chosenAccent);
applyAccent(document.documentElement, chosenAccent);
function setAccent(hex: string): void {
  chosenAccent = hex;
  chosenPalette = paletteFromHex(hex);
  saveAccent(ACCENT_STORE, hex);
  applyAccent(document.documentElement, hex);
}
/** The colour mask over the cover wall (owner, 2026-11-11): off shows the covers in their own colours (the TV's look). */
const MASK_STORE = "mediaverse.tv.mask";
let maskPrefs: MaskPrefs = loadMask(MASK_STORE, false);
applyMask(document.documentElement, maskPrefs);
function setMask(next: MaskPrefs): void {
  maskPrefs = next;
  saveMask(MASK_STORE, next);
  applyMask(document.documentElement, next);
}
let palette: Palette = chosenPalette;
let targetPalette: Palette = chosenPalette;
const playingScreen = $("#playing");
let shownAccent = "";

/** The next visualizer style (with each new song, as the sides change). */
function nextStyle(): void {
  styleIndex = (styleIndex + 1) % STYLES.length;
  style = STYLES[styleIndex];
}

/** Takes the visualizer's colours from the cover now showing, once it has loaded. */
function paletteFromCover(image: HTMLImageElement): void {
  try {
    const small = document.createElement("canvas");
    small.width = 32;
    small.height = 32;
    const context = small.getContext("2d")!;
    context.drawImage(image, 0, 0, 32, 32);
    const read = paletteFromPixels(context.getImageData(0, 0, 32, 32).data);
    targetPalette = read === DEFAULT_PALETTE ? chosenPalette : read;
  } catch {
    targetPalette = chosenPalette; // a picture the page may not read (some USB drive covers)
  }
}

function startVisualizer(): void {
  if (!visFrame) visFrame = requestAnimationFrame(drawVisualizer);
}

/**
 * What songs without lyrics show (owner, 2026-11-06, Settings on the TV): the visualizer in the middle, or the
 * calmer glow from the bottom that lyrics use. Kept on this TV.
 */
type VisualizerMode = "middle" | "glow";
const VISUALIZER_STORE = "mediaverse.tv.visualizer";
let visualizerMode: VisualizerMode = "middle";
try {
  if (localStorage.getItem(VISUALIZER_STORE) === "glow") visualizerMode = "glow";
} catch {
  // storage unavailable: the default
}
document.body.classList.toggle("vis-glow", visualizerMode === "glow");

function setVisualizerMode(mode: VisualizerMode): void {
  visualizerMode = mode;
  document.body.classList.toggle("vis-glow", mode === "glow");
  try {
    localStorage.setItem(VISUALIZER_STORE, mode);
  } catch {
    // kept until the app closes
  }
}

/** The glow from the bottom of the screen (with lyrics, or chosen in Settings): brightness, sway, colour last set. */
const glowLayer = $("#np-glow");
let glow: GlowState = { average: 0, out: 0 };
let shownGlow = "";
let shownSway = "";
let shownGlowColour = "";
let lastDrawn = 0;
let lastAccentAt = 0;

/** True once two palettes are too close to tell apart, so the colour blend can stop. */
function samePalette(a: Palette, b: Palette): boolean {
  for (const key of ["hi", "mid", "lo"] as const) {
    for (let i = 0; i < 3; i++) if (Math.abs(a[key][i] - b[key][i]) > 0.5) return false;
  }
  return true;
}

/**
 * One frame. The levels rise quickly and fall gently, so they move with the music without flickering; paused,
 * they sink to nothing. With lyrics showing, a glow from the bottom of the screen answers the music instead,
 * leaving the lyrics the whole middle; it is brighter than it was and sways, because the S95F's own screen saver
 * starts on a still picture (it came about a minute into songs with lyrics, 2026-11-05/06).
 *
 * Kept light for the TV (performance pass): drawn at most 60 times a second whatever the screen's refresh rate,
 * with the smoothing measured in time rather than frames; colours blended only while they are changing; and
 * nothing set on the whole Now Playing screen each frame (that made the TV restyle every element on it).
 */
// At most 30 drawings a second (VIS_FRAME_MS, shared with the phone), 20 while the controls are faded (no button pressed
// for 10 s; VIS_IDLE_FRAME_MS): the bars rise and fall over time, not frames, so they look the same at half the work.

function drawVisualizer(now: number): void {
  visFrame = 0;
  if (screen !== "playing" || document.hidden) return;
  const elapsed = lastDrawn ? now - lastDrawn : VIS_FRAME_MS; // the first frame is always drawn
  // Nobody has pressed a button for a while (the controls have faded): 20 drawings a second are plenty.
  const frameMs = document.body.classList.contains("controls-faded") ? VIS_IDLE_FRAME_MS : VIS_FRAME_MS;
  if (elapsed < frameMs) {
    visFrame = requestAnimationFrame(drawVisualizer); // not time for the next one yet
    return;
  }
  lastDrawn = now;
  const steps = Math.min(elapsed, 100) / 16.7; // frames' worth of time at 60 per second (capped after a stall)
  const rise = 1 - 0.4 ** steps;
  const fall = 0.9 ** steps;
  const peakFall = 0.006 * steps;
  const frame = spectrum && !audio.paused ? frameAt(spectrum, audio.currentTime) : null;
  let moving = false;
  // With lyrics and no analysis yet (or none possible for this song), a slow gentle wave keeps the glow pulsing:
  // with the sway, it is what stops the TV seeing a still picture.
  const idleWave = !frame && !audio.paused && (document.body.classList.contains("has-lyrics") || visualizerMode === "glow");
  for (let b = 0; b < BANDS; b++) {
    const target = frame && frame.length ? frame[b] / 255 : idleWave ? 0.22 + 0.16 * Math.sin(now / 700 + b * 0.35) : 0;
    levels[b] = target > levels[b] ? levels[b] + (target - levels[b]) * rise : levels[b] * fall;
    peaks[b] = Math.max(levels[b], peaks[b] - peakFall);
    if (levels[b] > 0.002 || peaks[b] > 0.002) moving = true;
  }
  if (palette !== targetPalette) {
    // Colours change over about two seconds, then stay put (the same palette lets the drawing reuse gradients).
    palette = samePalette(palette, targetPalette) ? targetPalette : mixPalette(palette, targetPalette, 1 - 0.97 ** steps);
    // The screen's accents (progress, highlighted button, Shuffle and Lyrics when on) follow the visualizer,
    // updated a few times a second while the colours change.
    if (now - lastAccentAt > 250 || palette === targetPalette) {
      lastAccentAt = now;
      const accent = css(palette.mid);
      if (accent !== shownAccent) {
        shownAccent = accent;
        playingScreen.style.setProperty("--accent", accent);
        playingScreen.style.setProperty("--accent-soft", css(palette.mid, 0.18));
      }
    }
  }
  if (document.body.classList.contains("has-lyrics") || visualizerMode === "glow") {
    // Brighter than the first glow (0.15 to 0.85, too still for the S95F's screen saver), and swaying slowly from
    // side to side about once every 40 s, so a quiet song still changes the picture.
    let bass = 0;
    let body = 0;
    const low = bassBands(BANDS);
    const high = bodyEnd(BANDS);
    for (let b = 0; b < low; b++) bass += levels[b] / low;
    for (let b = low; b < high; b++) body += levels[b] / (high - low);
    glow = nextGlow(glow, Math.min(1, 0.85 * bass + 0.15 * body));
    const opacity = (0.3 + glow.out * 0.7).toFixed(2);
    if (opacity !== shownGlow) glowLayer.style.opacity = shownGlow = opacity;
    const sway = `translateX(${(Math.sin(now / 6400) * 9).toFixed(1)}%)`;
    if (sway !== shownSway) glowLayer.style.transform = shownSway = sway;
    if (shownAccent !== shownGlowColour) glowLayer.style.setProperty("--glow-colour", (shownGlowColour = shownAccent));
  } else {
    if (shownGlow) glowLayer.style.opacity = shownGlow = "";
    drawStyle(pen, style, levels, peaks, palette, now / 1000);
  }
  if (moving || (!audio.paused && nowPlaying())) visFrame = requestAnimationFrame(drawVisualizer);
  else lastDrawn = 0;
}

$<HTMLImageElement>("#np-cover").addEventListener("load", (event) => paletteFromCover(event.target as HTMLImageElement));

// The soft backdrop: the cover drawn once, centred and filling, into a tiny canvas the screen stretches (see style.css).
const backdropSoft = $<HTMLCanvasElement>("#backdrop-soft");
const backdropPen = backdropSoft.getContext("2d");
$<HTMLImageElement>("#backdrop-image").addEventListener("load", (event) => {
  const image = event.target as HTMLImageElement;
  if (!backdropPen || !image.naturalWidth) return;
  const { width, height } = backdropSoft;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  backdropPen.clearRect(0, 0, width, height);
  backdropPen.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
});
function clearBackdrop(): void {
  backdropPen?.clearRect(0, 0, backdropSoft.width, backdropSoft.height);
}
$<HTMLImageElement>("#backdrop-image").addEventListener("error", clearBackdrop);
audio.addEventListener("play", startVisualizer);
audio.addEventListener("pause", startVisualizer); // to let the bars sink
document.addEventListener("visibilitychange", startVisualizer);

const stage = $("#np-stage");
let swapping = false;

/** Fades the stage out, puts the cover and the details on the other sides (with `between` done), fades back. */
function swapSides(between?: () => void): void {
  if (swapping) {
    between?.();
    return;
  }
  swapping = true;
  stage.classList.add("is-changing");
  setTimeout(() => {
    stage.classList.toggle("is-swapped");
    nextStyle();
    between?.();
    stage.classList.remove("is-changing");
    swapping = false;
  }, 1300);
}

// Only with a new song, never during one (owner, 2026-11-06: the cover and the details swapping mid-song was
// distracting). The picture still drifts a little every minute, and the visualizer keeps it moving.

/** The wall's grid: cells of 120 px over the whole screen (1920 x 1080 plus the edges). */
const WALL_COLUMNS = 17;
const WALL_ROWS = 10;
let wallBuilt = false;

/** Every album's cover at wall size (one per album), for the wall to show and turn over to. */
function wallCovers(): string[] {
  const covers: string[] = [];
  for (const album of albums) {
    const address = trackCover(album.tracks[0], 256);
    if (address && !noCover.has(address)) covers.push(address);
  }
  return covers;
}

/** Albums found to have no cover: left off the wall from then on. */
const noCover = new Set<string>();

/** Builds the wall: tiles of varied sizes (small, medium, a few large), each showing a different album. */
function fillWall(): void {
  if (wallBuilt || !albums.length) return;
  const pool = wallCovers();
  if (!pool.length) return;
  wallBuilt = true;
  const wall = $("#np-wall");
  wall.replaceChildren();
  const order = createCycle(pool.length);
  for (const size of wallSizes(WALL_COLUMNS * WALL_ROWS)) {
    const tile = makeFlipTile(pool[order.next()], "wall-tile", true); // pictures load once the song is under way
    tile.style.gridColumn = `span ${size}`;
    tile.style.gridRow = `span ${size}`;
    for (const image of tile.querySelectorAll("img")) {
      image.addEventListener("error", () => {
        // No cover for that album: forget it and show another one instead of a blank tile.
        const missing = image.getAttribute("src");
        if (missing) noCover.add(missing);
        const others = wallCovers();
        if (others.length) image.src = others[Math.floor(Math.random() * others.length)];
      });
    }
    wall.append(tile);
  }
}

// One tile turns over every 5 to 10 seconds while Now Playing is on screen (shared with the desktop, D46).
startTurning(
  () => [...document.querySelectorAll<HTMLElement>("#np-wall .flip-tile")],
  wallCovers,
  () => screen === "playing" && !document.hidden && wallComplete, // no turning while the wall is still being built
);

for (const button of document.querySelectorAll<HTMLElement>("#np-controls [data-action]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "previous") previous();
    else if (action === "next") next();
    else if (action === "playPause") playPause();
    else if (action === "shuffle") toggleShuffle();
    else if (action === "repeat") toggleRepeat();
    else if (action === "favorite") toggleFavorite();
    else if (action === "flag") openFlagPanel();
    else if (action === "lyrics") {
      showLyrics = !showLyrics;
      renderLyrics();
    }
  });
}

for (const tab of document.querySelectorAll<HTMLElement>(".tab")) {
  tab.addEventListener("click", () => {
    openTab(tab.dataset.tab as TabName);
    if (screen === "browse") focus(focusables().find((el) => view.contains(el)) ?? tab);
  });
}

// ---------- Screen care (OLED) ----------
// The Now Playing picture drifts a little every minute, its buttons fade when the remote is not used, and the
// browse screens dim after a while without a key press (or switch to Now Playing while music plays).

let idleTimer: number | undefined;
let fadeTimer: number | undefined;
/** Where the person was when the app went to Now Playing by itself (Back returns there). */
let returnTo: { element: HTMLElement | null; scroll: number } | null = null;

function wake(): void {
  dim.hidden = true;
  document.body.classList.remove("controls-faded");
  clearTimeout(idleTimer);
  clearTimeout(fadeTimer);
  if (screen === "playing") {
    fadeTimer = window.setTimeout(() => document.body.classList.add("controls-faded"), 10_000);
  } else if (screen === "browse") {
    // Music playing and the remote left alone: back to Now Playing after 20 s, remembering where the person was
    // (Back returns there). Nothing playing: the screen dims after 3 minutes.
    const playing = !!nowPlaying() && !audio.paused;
    idleTimer = window.setTimeout(() => {
      if (nowPlaying() && !audio.paused) {
        if (!$("#song-menu").hidden) closeSongMenu(); // left open: Back would find it still there
        returnTo = { element: current(), scroll: view.scrollTop };
        openNowPlaying();
      } else dim.hidden = false;
    }, playing ? 20_000 : 3 * 60_000);
  }
}

audio.addEventListener("playing", () => {
  if (screen === "browse") wake(); // the 20 s count starts when the music does
});
// (The screen saver hold follows playback through the listeners further down: on "playing", and on "pause" only
// once the pause has lasted 3 s. The player also reports "pause" for a moment at every song change and reopen;
// reacting to that at once let the screen saver back during music, 2026-11-04.)

let driftStep = 0;
setInterval(() => {
  driftStep += 1;
  const x = Math.round(Math.sin(driftStep * 0.7) * 14);
  const y = Math.round(Math.cos(driftStep * 0.45) * 10);
  $("#np-drift").style.transform = `translate(${x}px, ${y}px)`;
}, 60_000);

// ---------- Who's listening? (D45) ----------

let listener: Profile | null = null;
let markSource: { store: MarkStore; key: string } | null = null;
let editingPeople = false;
/** Where Back goes from the picker when it was opened from the tabs. */
let pickerReturn: ScreenName | null = null;

/** The music source changed: its flags, and the listener's own favorites for it. */
function setMarkSource(store: MarkStore, key: string): void {
  if (serverProfiles && !key.startsWith("jellyfin:")) {
    // Back to the computer or a drive: the server's profiles stay with the server; the TV's own people return.
    serverProfiles = null;
    serverProfile = null;
    listener = listProfiles().find((p) => p.id === lastProfile()) ?? null;
    showListenerTab();
  }
  markSource = { store, key };
  useMarks(forListener(store, listener, key));
}

function initial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

function showListenerTab(): void {
  const tab = $("#listener-tab");
  const shown = serverProfile ? { name: serverProfile, colour: colourOf(serverProfile) } : listener;
  tab.hidden = !shown;
  tab.replaceChildren();
  if (!shown) return;
  const dot = document.createElement("span");
  dot.className = "who-dot";
  dot.style.background = PROFILE_COLOURS[shown.colour % PROFILE_COLOURS.length];
  dot.textContent = initial(shown.name);
  const name = document.createElement("span");
  name.textContent = shown.name;
  tab.append(dot, name);
}

/** A profile's colour, from its place among the server's profiles (by name), so neighbours never share one. */
function colourOf(name: string): number {
  return Math.max(0, serverProfiles?.users.findIndex((user) => user.name === name) ?? 0) % PROFILE_COLOURS.length;
}

/** The server's profiles as tiles. They are added and changed on the computer or in Jellyfin. */
function renderServerPicker(users: JellyfinUser[]): void {
  const list = $("#who-list");
  list.replaceChildren();
  $("#who").classList.remove("editing");
  $("#who-title").textContent = "Who's listening?";
  for (const user of users) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "who-tile f";
    tile.dataset.profile = user.name;
    const avatar = document.createElement("span");
    avatar.className = "who-avatar";
    avatar.style.background = PROFILE_COLOURS[colourOf(user.name)];
    avatar.textContent = initial(user.name);
    const name = document.createElement("span");
    name.className = "who-tile-name";
    name.textContent = user.name;
    tile.append(avatar, name);
    tile.addEventListener("click", () => void chooseServerProfile(user.name));
    list.append(tile);
  }
  $("#who-edit").hidden = true;
  $("#who-skip").hidden = true;
  $("#who-hint").textContent = "Each profile has its own favorites, playlists and recently played. Add profiles in MediaVerse Studio on the computer (Settings, Jellyfin).";
}

function renderPicker(): void {
  if (serverProfiles) {
    renderServerPicker(serverProfiles.users);
    return;
  }
  const people = listProfiles();
  const list = $("#who-list");
  list.replaceChildren();
  $("#who").classList.toggle("editing", editingPeople);
  $("#who-title").textContent = editingPeople ? "Edit people" : "Who's listening?";
  for (const person of people) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "who-tile f";
    tile.dataset.profile = person.id;
    const avatar = document.createElement("span");
    avatar.className = "who-avatar";
    avatar.style.background = PROFILE_COLOURS[person.colour % PROFILE_COLOURS.length];
    avatar.textContent = initial(person.name);
    const name = document.createElement("span");
    name.className = "who-tile-name";
    name.textContent = person.name;
    tile.append(avatar, name);
    tile.addEventListener("click", () => (editingPeople ? openPerson(person) : chooseListener(person)));
    list.append(tile);
  }
  if (canAddProfile() && !editingPeople) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "who-tile f";
    add.innerHTML = `<span class="who-avatar add">+</span><span class="who-tile-name">Add a person</span>`;
    add.addEventListener("click", () => openNameEntry(null));
    list.append(add);
  }
  $("#who-edit").hidden = people.length === 0;
  $("#who-edit").textContent = editingPeople ? "Done" : "Edit people";
  $("#who-skip").hidden = people.length > 0;
  $("#who-hint").textContent = people.length
    ? editingPeople
      ? "Choose a person to rename or remove them."
      : "Each person has their own favorites on this TV."
    : "Add the people who listen on this TV, so each has their own favorites.";
}

/** Shows the picker: at start-up (`starting`), or from the name at the end of the tabs. */
function openPicker(starting: boolean): void {
  pickerReturn = starting ? null : screen;
  choosingListener = true;
  editingPeople = false;
  showScreen("who");
  renderPicker();
  let last: string | null | undefined = lastProfile() ?? listener?.id;
  if (serverProfiles) {
    try {
      last = serverProfile ?? (JSON.parse(localStorage.getItem(SERVER_PROFILE) ?? "null") as string | null);
    } catch {
      last = serverProfile;
    }
  }
  const tiles = [...$("#who-list").querySelectorAll<HTMLElement>(".f")];
  focus(tiles.find((tile) => tile.dataset.profile === last) ?? tiles[0]);
}

function closePicker(): void {
  choosingListener = false;
  const next = afterChoosing ?? pickerReturn ?? (albums.length ? "browse" : "connect");
  afterChoosing = null;
  showScreen(next);
  if (next === "browse") {
    if (!view.childElementCount) openTab("albums");
    focus(focusables().find((el) => view.contains(el)) ?? focusables()[0]);
  } else if (next === "playing") {
    focus($("#np-play"));
  } else {
    focus(focusables()[0]);
  }
}

function chooseListener(person: Profile | null): void {
  listener = person;
  if (person) rememberProfile(person.id);
  showListenerTab();
  if (markSource) useMarks(forListener(markSource.store, listener, markSource.key));
  if (person && pickerReturn === null) toast(`Hi, ${person.name}`, 1800);
  closePicker();
}

function whoBack(): void {
  if (!$("#who-name").hidden) {
    closeWhoModal("#who-name");
    return;
  }
  if (!$("#who-person").hidden) {
    closeWhoModal("#who-person");
    return;
  }
  if (editingPeople) {
    editingPeople = false;
    renderPicker();
    focus(focusables()[0]);
    return;
  }
  if (pickerReturn) {
    closePicker(); // opened from the tabs: back to where it was
    return;
  }
  const now = Date.now();
  if (now - backPressedAt < 2500) exitApp();
  else toast("Press Return again to leave MediaVerse Studio.", 2500);
  backPressedAt = now;
}

function closeWhoModal(selector: string): void {
  $(selector).hidden = true;
  renderPicker();
  focus(focusables()[0]);
}

// Typing a name with the remote: the same letter keyboard as Search.
const nameEntry: { text: string; person: Profile | null } = { text: "", person: null };
const NAME_KEYS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "Space", "⌫", "Done"];

function openNameEntry(person: Profile | null): void {
  nameEntry.text = person?.name ?? "";
  nameEntry.person = person;
  $("#who-person").hidden = true;
  $("#who-name-title").textContent = person ? `Rename ${person.name}` : "Add a person";
  $("#who-name-status").textContent = "";
  showName();
  $("#who-name").hidden = false;
  focus($("#who-name-keys").querySelector<HTMLElement>(".f"));
}

function showName(): void {
  const text = $("#who-name-text");
  text.textContent = nameEntry.text || "Type a name";
  text.classList.toggle("placeholder", !nameEntry.text);
}

function typeName(key: string): void {
  if (key === "⌫") nameEntry.text = nameEntry.text.slice(0, -1);
  else if (key === "Space" || key === " ") nameEntry.text = nameEntry.text && !nameEntry.text.endsWith(" ") ? `${nameEntry.text} ` : nameEntry.text;
  else if (key === "Done") return void saveName();
  else if (nameEntry.text.length < 20) nameEntry.text += nameEntry.text && !nameEntry.text.endsWith(" ") ? key.toLowerCase() : key.toUpperCase();
  showName();
}

function saveName(): void {
  const status = $("#who-name-status");
  if (nameEntry.person) {
    if (!renameProfile(nameEntry.person.id, nameEntry.text)) {
      status.textContent = "Type a name that nobody else here has.";
      return;
    }
    if (listener?.id === nameEntry.person.id) listener = listProfiles().find((p) => p.id === listener!.id) ?? null;
    showListenerTab();
    closeWhoModal("#who-name");
    return;
  }
  const added = addProfile(nameEntry.text);
  if (!added) {
    status.textContent = "Type a name that nobody else here has.";
    return;
  }
  $("#who-name").hidden = true;
  chooseListener(added); // a new person starts listening straight away
}

function openPerson(person: Profile): void {
  $("#who-person-title").textContent = person.name;
  const buttons = $("#who-person-buttons");
  buttons.replaceChildren();
  const add = (label: string, act: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "f";
    button.textContent = label;
    button.addEventListener("click", act);
    buttons.append(button);
  };
  add("Rename", () => openNameEntry(person));
  add(`Remove ${person.name} and their favorites`, () => {
    removeProfile(person.id);
    if (listener?.id === person.id) {
      listener = null;
      showListenerTab();
    }
    if (!listProfiles().length) editingPeople = false;
    closeWhoModal("#who-person");
  });
  add("Cancel", () => closeWhoModal("#who-person"));
  $("#who-person").hidden = false;
  focus(buttons.querySelector<HTMLElement>(".f"));
}

function buildPicker(): void {
  const keys = $("#who-name-keys");
  for (const key of NAME_KEYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `key f${key.length > 1 ? " wide" : ""}`;
    button.textContent = key;
    button.addEventListener("click", () => typeName(key));
    keys.append(button);
  }
  $("#who-edit").addEventListener("click", () => {
    editingPeople = !editingPeople;
    renderPicker();
    focus(focusables()[0]);
  });
  $("#who-skip").addEventListener("click", () => chooseListener(null));
}
// ---------- Keys ----------

let backPressedAt = 0;

function back(): void {
  if (screen === "who") {
    whoBack();
    return;
  }
  if (!$("#flag-panel").hidden) {
    closeFlagPanel();
    return;
  }
  if (!$("#song-menu").hidden) {
    closeSongMenu();
    return;
  }
  if (screen === "playing") {
    showScreen("browse");
    if (!view.childElementCount) renderView();
    const back = returnTo;
    returnTo = null;
    if (back?.element && back.element.isConnected) {
      view.scrollTop = back.scroll;
      focus(back.element);
    } else {
      focus(focusables().find((el) => view.contains(el)));
    }
    return;
  }
  if (screen === "browse") {
    if (goBackInBrowse()) return;
    if (viewState.kind !== "albums") {
      openTab("albums");
      focus(document.querySelector<HTMLElement>('.tab[data-tab="library"]'));
      return;
    }
  }
  if (screen === "connect" && panel !== "sources") {
    stopSearching();
    void showSources();
    return;
  }
  if (screen === "connect" && connection && albums.length) {
    showScreen("browse");
    focus(focusables()[0]);
    return;
  }
  const now = Date.now();
  if (now - backPressedAt < 2500) exitApp();
  else toast("Press Return again to leave MediaVerse Studio.", 2500);
  backPressedAt = now;
}

document.addEventListener("keydown", (event) => {
  const wasAsleep = !dim.hidden || document.body.classList.contains("controls-faded");
  wake();
  const early = commandOf(event);
  if (wasAsleep && (early === "ok" || directionOf(event))) {
    event.preventDefault();
    return; // the first arrow or OK only wakes the screen; Return, play/pause and skip act at once
  }
  const direction = directionOf(event);
  if (direction) {
    event.preventDefault();
    if (screen === "playing" && current()?.closest("#np-controls") && (direction === "up" || direction === "down")) return;
    move(direction);
    return;
  }
  if (screen === "who" && !$("#who-name").hidden && (/^[\p{L}\p{N}]$/u.test(event.key) || event.key === " " || event.key === "Backspace")) {
    event.preventDefault();
    typeName(event.key === "Backspace" ? "⌫" : event.key);
    return;
  }
  if (screen === "browse" && viewState.kind === "search" && (/^[\p{L}\p{N}]$/u.test(event.key) || event.key === " " || event.key === "Backspace")) {
    // Number buttons on the remote (and a keyboard, if one is plugged in) type into the search.
    if (event.key === "Backspace" && !viewState.query) {
      // nothing to delete: Back as usual
    } else {
      event.preventDefault();
      typeSearch(event.key === "Backspace" ? "⌫" : event.key);
      return;
    }
  }
  if (screen === "connect" && panel !== "sources" && /^\d$/.test(event.key)) {
    event.preventDefault();
    typeKey(event.key);
    return;
  }
  if (screen === "connect" && event.key === "Backspace" && (panel === "pair" ? typed.code : panel === "manual" ? typed.host : "")) {
    event.preventDefault();
    typeKey("⌫");
    return;
  }
  if (event.keyCode === 427 || event.key === "PageUp") {
    event.preventDefault();
    page(-1);
    return;
  }
  if (event.keyCode === 428 || event.key === "PageDown") {
    event.preventDefault();
    page(1);
    return;
  }
  const command = commandOf(event);
  if (!command) return;
  if (command === "ok") {
    // OK presses the highlighted item ourselves rather than relying on the browser turning Enter into a click.
    event.preventDefault();
    if (event.repeat) return;
    const target = current();
    if (target) target.click();
    else focus(focusables()[0]);
    return;
  }
  event.preventDefault();
  if (command === "back") back();
  else if (command === "playPause") playPause();
  else if (command === "play") {
    if (nowPlaying() && audio.paused) resume();
  }
  else if (command === "pause") audio.pause();
  else if (command === "stop") audio.pause();
  else if (command === "next") next();
  else if (command === "previous") previous();
  else if (command === "forward") seekBy(15);
  else if (command === "rewind") seekBy(-15);
});

// ---------- Start ----------

registerRemoteKeys();
buildConnect();
buildPicker();
// With Jellyfin as the last source the picker waits for the server's profiles; otherwise the TV's own people, at once.
if (!(lastSource() === "jellyfin" && savedJellyfin())) openPicker(true);
// A drive plugged in while choosing a source appears in the list at once.
watchDrives(() => {
  if (screen === "connect" && panel === "sources") {
    void listDrives().then((found) => {
      drives = found;
      renderSources();
    });
  }
});
// Start with the source used last time, if it is there; otherwise the list of sources.
void (async () => {
  const jellyfinSaved = savedJellyfin();
  const last = lastSource();
  if (last === "usb") {
    const [first] = await listDrives();
    if (first) {
      showPanel("sources");
      await chooseDrive(first);
      return;
    }
  }
  if (jellyfinSaved && last === "jellyfin") {
    showPanel("sources");
    $("#sources-status").textContent = `Looking for ${jellyfinSaved.name}…`;
    const users = await jellyfinProfiles(jellyfinSaved.base).catch(() => []);
    if (users.length) await enterJellyfin(jellyfinSaved);
    else {
      openPicker(true);
      void openJellyfin(jellyfinSaved);
    }
  } else if (jellyfinSaved && !connection) void enterJellyfin(jellyfinSaved);
  else if (connection) void openLibrary(connection);
  else void showSources();
})();
