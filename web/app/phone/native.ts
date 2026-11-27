// The channel to the Android app (apps/android, MainActivity): the page asks for the library and sends player
// commands; the app answers with the library and the player's state. Outside the app (a desktop browser, for
// trying the layout) a small stand-in plays a made-up library silently.

import type { TrackLyrics } from "../src/lyrics-format.ts";
import type { ServerTrack } from "../tv/library.ts";

export type PhoneTrack = ServerTrack & { duration_ms: number; disc?: number | null; /** seconds since 1970 when Android first saw the file */ added?: number; /** The file's name and size in bytes (D178: music already on the phone is recognised by them). */ file?: string; size?: number; /** Whether this app created the file. */ own?: boolean };

/** The equalizer of the output the sound goes to now (levels in millibels, one per band). */
export type EqState = { available: false } | { available: true; key: string; name: string; enabled: boolean; min: number; max: number; hz: number[]; levels: number[] };

/** `{ id: [times played, last played in milliseconds] }` for songs played at least once. */
export type PlayStats = Record<string, [number, number]>;

export type PlayerState = {
  playing: boolean;
  buffering: boolean;
  index: number;
  id: string | null;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  /** Song IDs in the player's list order (only sent when the list may have changed). */
  queue?: string[];
  /** The play order as indexes into `queue` (differs from 0, 1, 2… when shuffling). */
  order?: number[];
  /** Sleep timer: milliseconds left (0 = none), and whether it waits for the song to end. */
  sleep_ms?: number;
  sleep_song?: boolean;
  /** A-B repeat marks in milliseconds; -1 when not set. */
};

export type Insets = { top: number; bottom: number; left: number; right: number };

export type FromApp =
  | { type: "hello"; permission: boolean; version: string; insets?: Insets }
  | { type: "library"; tracks: PhoneTrack[] }
  | { type: "libraryChanged" }
  | { type: "permission"; granted: boolean }
  | { type: "insets"; insets: Insets }
  | { type: "openPlaying" }
  | { type: "favorites"; ids: string[] }
  | ({ type: "share" } & ShareStatus)
  | { type: "shareRefused" }
  | { type: "tvs"; tvs: Tv[] }
  | { type: "stats"; stats: PlayStats }
  | { type: "lyrics"; id: string; lyrics: TrackLyrics }
  /** The answer to a `http` request: the status (-1 no answer, -2 refused) and the body text. */
  | { type: "http"; id: string; status: number; body: string }
  /** Keeping music from the home server on the phone (D177): the connection, a song fetched (or not), how far it got, and songs taken off. */
  | { type: "network"; wifi: boolean; metered: boolean }
  | { type: "uploaded"; id: string; ok: boolean; already?: boolean; error?: string }
  | { type: "uploadProgress"; id: string; bytes: number; total: number }
  | { type: "downloaded"; id: string; ok: boolean; mediaId?: string; bytes?: number; error?: string }
  | { type: "downloadProgress"; id: string; bytes: number; total: number }
  | { type: "deletedLocal"; id: string; ids: string[] }
  /** Whether the phone's copy of a song is the same file as the server's (null: could not be told), and Android's answer to the permission to update songs in place. */
  | { type: "fingerprint"; id: string; same: boolean | null; error?: string }
  | { type: "writeGranted"; id: string; ok: boolean }
  /** Songs of the old download folder moved up into the Music folder (D207). */
  | { type: "moveProgress"; id: string; done: number; total: number }
  | { type: "movedToRoot"; id: string; moved: number; failed: number; needPermission: string[] }
  | { type: "eq"; eq: EqState }
  | ({ type: "state" } & PlayerState);

/** A TV playing from the phone that takes commands, with what it last said it plays. */
export type Tv = {
  id: string;
  name: string;
  /** What it plays; shuffle and repeat are reported by Cast and DLNA devices (the phone's queue plays there). */
  state: { id: string | null; playing: boolean; position_ms: number; duration_ms: number; at: number; shuffle?: boolean; repeat?: "off" | "all" | "one"; volume?: number } | null;
};

export type TvCommand =
  | { action: "play"; ids: string[]; index: number; position_ms: number }
  | { action: "toggle" | "pause" | "next" | "previous" | "stop" | "shuffle" | "repeat" }
  | { action: "seek"; ms: number }
  | { action: "volume"; level: number };

/** Sharing the phone's library with the TV app (apps/android ShareServer). */
export type ShareStatus = {
  enabled: boolean;
  running: boolean;
  problem: string | null;
  port: number;
  name: string;
  addresses: string[];
  devices: { id: string; name: string; paired: string }[];
  /** When pairing stops being open (ms since 1970) after Pair a TV or speaker was pressed; null when it is closed. */
  armed?: number | null;
  pairing: { name: string; code: string; expires: number } | null;
};

export type ToApp =
  | { type: "hello" }
  | { type: "askPermission" }
  | { type: "library"; reload?: boolean }
  | { type: "favorites" }
  | { type: "favorite"; id: string; on: boolean }
  | { type: "share" }
  | { type: "shareSet"; on: boolean }
  | { type: "shareArm" }
  | { type: "shareRemove"; id: string }
  | { type: "tvs" }
  | { type: "stats" }
  /** The profile now in use (D213): favorites, play counts and the queue are its own. `adopted` took over what the phone had before. */
  | { type: "profile"; name: string; adopted: string }
  | { type: "lyrics"; id: string }
  | { type: "http"; id: string; method?: string; url: string; headers?: Record<string, string>; body?: string; timeout?: number }
  | { type: "network" }
  /** Fetch one song into the Music folder as `path` ("Artist/Album/01 - Song.mp3"), replacing the phone copy `replace` (its id) when there is one. */
  | { type: "download"; id: string; url: string; headers: Record<string, string>; path: string; replace: string | null; inPlace?: boolean }
  | { type: "deleteLocal"; id: string; ids: string[] }
  /** Sends one of the phone's songs to the computer (D214). */
  | { type: "upload"; id: string; url: string; headers: Record<string, string>; mediaId: string }
  /** Compares a fingerprint of the head and tail of the phone's copy (`localId`) with the server's (fetched by byte range). */
  | { type: "fingerprint"; id: string; url: string; headers: Record<string, string>; localId: string; size: number }
  /** Asks Android's permission (one prompt) to update these songs of the phone in place. */
  | { type: "grantWrite"; id: string; ids: string[] }
  | { type: "moveToRoot"; id: string }
  | { type: "keepScreenOn"; on: boolean }
  | { type: "eq" }
  | { type: "eqSet"; key: string; enabled: boolean; levels: number[] }
  | { type: "sleep"; minutes?: number; song?: boolean }
  | { type: "tvSend"; target: string; command: TvCommand }
  | { type: "play"; ids: string[]; index: number; shuffle?: boolean }
  | { type: "enqueue"; ids: string[]; next?: boolean }
  | { type: "toggle" | "next" | "previous" | "shuffle" | "repeat" }
  | { type: "seek"; ms: number }
  | { type: "jump" | "remove"; index: number };

type Channel = { postMessage(text: string): void; addEventListener(type: "message", listener: (event: { data: string }) => void): void };

declare global {
  interface Window {
    mvNative?: Channel;
    mvBack?: () => boolean;
  }
}

export type Bridge = { send(message: ToApp): void; native: boolean };

export function connect(onMessage: (message: FromApp) => void): Bridge {
  const channel = window.mvNative;
  if (channel) {
    channel.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data) as FromApp);
      } catch {
        // not for us
      }
    });
    return { send: (message) => channel.postMessage(JSON.stringify(message)), native: true };
  }
  return standIn(onMessage);
}

/** A pretend app for the desktop browser: a made-up library and a silent player with a moving clock. */
function standIn(onMessage: (message: FromApp) => void): Bridge {
  const artists = ["Orbital", "The Offspring", "AFI", "NOFX", "MxPx", "Bad Religion", "Rancid", "Pennywise", "Lagwagon", "Descendents", "Green Day", "Sublime"];
  const genres = ["Electronic", "Punk", "Punk", "Punk", "Punk", "Punk", "Punk", "Punk", "Punk", "Punk", "Punk", "Ska"];
  const tracks: PhoneTrack[] = [];
  let id = 1;
  artists.forEach((artist, a) => {
    for (let album = 1; album <= 2 + (a % 3); album++) {
      for (let n = 1; n <= 10; n++) {
        tracks.push({
          id: String(id++), title: `Song ${n} of album ${album}`, artist, album: `${artist} album ${album}`, album_artist: artist, genre: genres[a],
          year: 1990 + a + album, track_number: n, cover_key: `${artist}/${album}`, folder: `Album ${album}`, duration_ms: 150_000 + ((n * 37_000) % 120_000),
        });
      }
    }
  });
  const state: PlayerState = { playing: false, buffering: false, index: -1, id: null, position: 0, duration: 0, shuffle: false, repeat: "off", queue: [], order: [] };
  let queue: string[] = [];
  const emit = (withQueue = true): void => {
    const current = state.index >= 0 ? tracks.find((t) => t.id === queue[state.index]) : undefined;
    state.id = current?.id ?? null;
    state.duration = current?.duration_ms ?? 0;
    const message: FromApp = { type: "state", ...state };
    if (withQueue) {
      message.queue = [...queue];
      message.order = queue.map((_, i) => i);
    } else {
      delete message.queue;
      delete message.order;
    }
    setTimeout(() => onMessage(message), 0);
  };
  setInterval(() => {
    if (!state.playing) return;
    state.position += 500;
    if (state.position >= state.duration) {
      state.position = 0;
      state.index = state.index + 1 < queue.length ? state.index + 1 : 0;
      emit();
    } else emit(false);
  }, 500);
  const favorites = new Set<string>();
  const share: ShareStatus = { enabled: false, running: false, problem: null, port: 47700, name: "Browser", addresses: ["192.168.1.40"], devices: [], pairing: null };
  const send = (message: ToApp): void => {
    switch (message.type) {
      case "shareSet":
        share.enabled = share.running = message.on;
        if (!message.on) share.armed = null;
        setTimeout(() => onMessage({ type: "share", ...share }), 0);
        break;
      case "shareArm":
        share.armed = Date.now() + 300_000;
        share.pairing = { name: "Living room TV (192.168.1.50)", code: "482913", expires: Date.now() + 300_000 };
      // falls through: answer with the status
      case "share":
      case "shareRemove":
        setTimeout(() => onMessage({ type: "share", ...share }), 0);
        break;
      case "favorite":
        if (message.on) favorites.add(message.id);
        else favorites.delete(message.id);
      // falls through: answer with the list
      case "favorites":
        setTimeout(() => onMessage({ type: "favorites", ids: [...favorites] }), 0);
        break;
      case "http":
        // In a desktop browser the page asks the server itself (Jellyfin allows any origin).
        void fetch(message.url, { method: message.method ?? "GET", headers: message.headers, body: message.body })
          .then(async (reply) => onMessage({ type: "http", id: message.id, status: reply.status, body: await reply.text() }))
          .catch((error: Error) => onMessage({ type: "http", id: message.id, status: -1, body: String(error.message) }));
        break;
      case "network":
        setTimeout(() => onMessage({ type: "network", wifi: true, metered: false }), 0);
        break;
      case "download": {
        // In a desktop browser nothing is written: the song "arrives" a moment later so the screens can be tried.
        const mediaId = `d${++id}`;
        setTimeout(() => onMessage({ type: "downloadProgress", id: message.id, bytes: 500_000, total: 1_000_000 }), 100);
        setTimeout(() => onMessage({ type: "downloaded", id: message.id, ok: true, mediaId, bytes: 1_000_000 }), 250);
        break;
      }
      case "deleteLocal":
        setTimeout(() => onMessage({ type: "deletedLocal", id: message.id, ids: message.ids }), 50);
        break;
      case "fingerprint":
        setTimeout(() => onMessage({ type: "fingerprint", id: message.id, same: true }), 50);
        break;
      case "moveToRoot":
        setTimeout(() => onMessage({ type: "movedToRoot", id: message.id, moved: 0, failed: 0, needPermission: [] }), 50);
        break;
      case "grantWrite":
        setTimeout(() => onMessage({ type: "writeGranted", id: message.id, ok: true }), 50);
        break;
      case "lyrics": {
        // Made-up lyrics so the screen can be tried in a desktop browser: synced, plain, or none by song number.
        const n = Number(message.id) || 0;
        const words = ["Walking down the empty street", "Streetlights hum a quiet tune", "Every window tells a story", "Hold the night a little longer", "Echoes fade into the dawn", "Carry me back to the shore"];
        const lyrics: TrackLyrics =
          n % 5 === 0 ? { plain: null, synced: false, lines: [], source: null }
          : n % 2 === 0 ? { plain: words.join("\n"), synced: true, lines: words.map((text, i) => ({ ms: 4_000 + i * 9_000, text })), source: "tag" }
          : { plain: `${words.slice(0, 3).join("\n")}\n\n${words.slice(3).join("\n")}`, synced: false, lines: [], source: "tag" };
        setTimeout(() => onMessage({ type: "lyrics", id: message.id, lyrics }), 80);
        break;
      }
      case "hello":
        setTimeout(() => onMessage({ type: "hello", permission: true, version: "browser" }), 0);
        emit();
        break;
      case "library":
        setTimeout(() => onMessage({ type: "library", tracks }), 50);
        break;
      case "play":
        queue = [...message.ids];
        state.index = message.index;
        state.position = 0;
        state.playing = true;
        state.shuffle = !!message.shuffle;
        emit();
        break;
      case "enqueue":
        if (message.next) queue.splice(state.index + 1, 0, ...message.ids);
        else queue.push(...message.ids);
        emit();
        break;
      case "toggle":
        state.playing = !state.playing && queue.length > 0;
        emit(false);
        break;
      case "next":
        if (state.index + 1 < queue.length) state.index += 1;
        state.position = 0;
        emit();
        break;
      case "previous":
        if (state.position < 3000 && state.index > 0) state.index -= 1;
        state.position = 0;
        emit();
        break;
      case "seek":
        state.position = message.ms;
        emit(false);
        break;
      case "jump":
        state.index = message.index;
        state.position = 0;
        state.playing = true;
        emit();
        break;
      case "remove":
        queue.splice(message.index, 1);
        if (message.index < state.index) state.index -= 1;
        emit();
        break;
      case "shuffle":
        state.shuffle = !state.shuffle;
        emit();
        break;
      case "repeat":
        state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
        emit(false);
        break;
      default:
        break;
    }
  };
  return { send, native: false };
}
