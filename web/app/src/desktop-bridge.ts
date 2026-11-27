// The page's only way to reach the program: the allowlisted bridge that Electron's preload script
// puts on `window.mediaVerse` (web/app/electron). Outside Electron (a plain browser tab) every call
// fails with a clear message instead of guessing.

import { type ServerHandlerSet, routeServerCommand } from "./server-routing";

type EventHandler<T> = (event: { payload: T }) => void;

/** Library sharing with the TV app (electron/library-share.js). */
export type ShareStatus = {
  enabled: boolean;
  running: boolean;
  problem: string | null;
  port: number;
  addresses: string[];
  /** TVs paired with this computer. */
  devices: { id: string; name: string; paired: string | null; phone?: boolean }[];
  /** A TV or phone asking to pair right now, with the one-time code to type on it. */
  pairing: { name: string; code: string; expires: number; phone?: boolean } | null;
  /** True after Pair a TV or phone, until one asks or the wait runs out. */
  pairing_armed?: boolean;
  /** Whether paired phones may send new music to this computer (D214). */
  uploads?: boolean;
};

export type RemoteDevice = { id: string; name: string; state: { path: string | null; playing: boolean; position_ms: number; duration_ms: number; at: number } | null };
export type CastDevice = { id: string; name: string; model: string; host: string; kind?: "Google Cast" | "DLNA" };
export type CastStatus = { state: string; position: number; duration: number; uri: string; /** The device's own number for the song playing (Google Cast queues). */ itemId?: number; /** The device volume, 0 to 1, or -1 when unknown. */ volume?: number };
export type RemoteCommand =
  | { action: "play"; paths: string[]; index: number; position_ms: number; shuffle?: boolean }
  | { action: "toggle" | "pause" | "next" | "previous" }
  | { action: "seek"; ms: number };

type Envelope<T> ={ ok: true; result: T } | { ok: false; error: unknown };

export type JellyfinServerInfo = {
  id: string;
  name: string;
  base: string;
  version: string | null;
  reachable: boolean;
  /** Whether Quick Connect (how the TV app signs in) is on; null when the server did not say. */
  quickConnect: boolean | null;
  onThisComputer: boolean;
};

export const jellyfinBridge = () => window.mediaVerse?.jellyfin ?? null;

export async function copyText(text: string): Promise<boolean> {
  return window.mediaVerse?.copyText ? window.mediaVerse.copyText(text) : false;
}

export type AboutInfo ={ version: string; electron: string; commit: string | null; licences: boolean };

type ElectronBridge = {
  chooseFolder(title?: string): Promise<string | null>;
  /** Several JPEG or PNG pictures chosen in the system window (lyrics by photo); empty when cancelled. */
  choosePictures?(title?: string): Promise<string[]>;
  openExternal(address: string): Promise<boolean>;
  /** Opens MusicBrainz's Add Release form, pre-filled, in the person's browser (D107). */
  musicbrainzAddRelease?(release: MusicBrainzRelease): Promise<{ ok: boolean; message?: string }>;
  showInFolder?(filePath: string): Promise<boolean>;
  /** Holds off the computer's sleep while a long job runs (D206). */
  keepAwake?(on: boolean): Promise<boolean>;
  /** Settings > About (D88): version and whether the licences folder is there. */
  about?(): Promise<AboutInfo>;
  /** Opens the licences folder (licence texts, notices, how to get the source) in Explorer. */
  openLicences?(): Promise<boolean>;
  copyText?(text: string): Promise<boolean>;
  /** The Jellyfin sign-in songs are played and cast with when the server alone is the library (D173); null forgets it. */
  jellyfinStreamSession?(session: { base: string; token: string; userId: string; deviceId: string } | null): Promise<boolean>;
  /** A request to a server on the home network, made by the program (the page's security rules allow only this computer). Status -1: no answer, -2: refused. */
  homeHttp?(request: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number; binary?: boolean }): Promise<{ status: number; body: string }>;
  /** Settings > Jellyfin (D90). */
  jellyfin?: {
    find(): Promise<JellyfinServerInfo[]>;
    open(id: string): Promise<boolean>;
    downloadPage(): Promise<boolean>;
    firewallCheck(): Promise<{ blocked: boolean; categories: string[] }>;
    firewallAllow(): Promise<boolean>;
  };
  share?: {
    status(): Promise<ShareStatus>;
    setEnabled(enabled: boolean): Promise<ShareStatus>;
    forgetDevice(id: string): Promise<ShareStatus>;
    cancelPairing(): Promise<ShareStatus>;
    /** Lets a TV ask to pair for a few minutes. Pairing does not start from the TV alone. */
    armPairing(): Promise<ShareStatus>;
    setUploads?(allowed: boolean): Promise<ShareStatus>;
    openIncoming?(): Promise<boolean>;
    /** Windows Firewall: whether TVs on the connected network are turned away. */
    firewallCheck?(): Promise<{ blocked: boolean; categories: string[] }>;
    /** Adds the narrow rule through Windows' administrator prompt; true when TVs can reach this computer after it. */
    firewallAllow?(): Promise<boolean>;
    onChange(handler: () => void): () => void;
    /** "Play on the TV" (D76): paired TVs with the app open, and what each last said it was playing. */
    remoteDevices?(): Promise<RemoteDevice[]>;
    remoteSend?(id: string, command: RemoteCommand): Promise<{ sent: boolean }>;
    onRemoteChange?(handler: () => void): () => void;
    /** Playlists as files (D78): a save dialog (XSPF or M3U8), and an open dialog returning the file's text. */
    playlistSave?(name: string, contents: { xspf: string; m3u8: string }): Promise<string | null>;
    playlistOpen?(): Promise<{ name: string; text: string } | null>;
    /** DLNA TVs and speakers (D77). */
    castDiscover?(): Promise<CastDevice[]>;
    /** `queued`: the device can be told which song follows (`castPreload`) and then starts it by itself, with no gap. */
    castLoad?(id: string, filePath: string, startSeconds: number): Promise<{ ok: boolean; queued?: boolean }>;
    castPreload?(id: string, filePath: string): Promise<{ ok: boolean }>;
    /** `value`: the place in seconds for "seek", the level 0 to 1 for "volume". */
    castControl?(id: string, action: "play" | "pause" | "stop" | "seek" | "volume", value?: number): Promise<unknown>;
    castStatus?(id: string): Promise<CastStatus>;
  };
  invoke<T>(command: string, arguments_: Record<string, unknown> | undefined): Promise<Envelope<T>>;
  listen<T>(eventName: string, handler: EventHandler<T>): () => void;
};

declare global {
  interface Window {
    mediaVerse?: ElectronBridge;
  }
}

const electronBridge = window.mediaVerse;

function noBridge(): Error {
  return new Error("MediaVerse Studio must be started as the desktop program; this page cannot reach it from a browser.");
}

/** With the Jellyfin server alone as the library (D173) the commands that read the music folder are answered from the server instead; the page sets these once as it starts (see server-routing.ts). */
let serverHandlers: ServerHandlerSet | null = null;

export function useServerLibrary(handlers: ServerHandlerSet | null): void {
  serverHandlers = handlers;
}
/**
 * A record of the calls to the background program (when each was asked and answered, in milliseconds since the page began), kept for finding what makes the
 * program slow to start. Read it in the developer tools with `__mvTrace()`. The newest 800 are kept; it costs next to nothing.
 */
type TraceEntry = { command: string; asked: number; answered: number; ok: boolean };
const trace: TraceEntry[] = [];
(globalThis as { __mvTrace?: () => TraceEntry[] }).__mvTrace = () => trace.slice();

export async function invoke<T>(command: string, arguments_?: Record<string, unknown>): Promise<T> {
  const asked = Math.round(performance.now());
  let ok = true;
  try {
    return await invokeUntraced<T>(command, arguments_);
  } catch (thrown) {
    ok = false;
    throw thrown;
  } finally {
    trace.push({ command, asked, answered: Math.round(performance.now()), ok });
    if (trace.length > 800) trace.shift();
  }
}

async function invokeUntraced<T>(
  command: string,
  arguments_?: Record<string, unknown>,
): Promise<T> {
  const server = await routeServerCommand(serverHandlers, command, arguments_);
  if (server) return server.answer as T;
  if (!electronBridge) {
    throw noBridge();
  }
  const reply = await electronBridge.invoke<T>(command, arguments_);
  if (reply.ok) {
    return reply.result;
  }
  throw reply.error; // the sidecar's structured `{ code, message }` error
}

export async function listen<T>(
  eventName: string,
  handler: EventHandler<T>,
): Promise<() => void> {
  if (!electronBridge) {
    throw noBridge();
  }
  return electronBridge.listen(eventName, handler);
}

/** Asks the person to choose one folder. Returns null if they cancel. */
export function open(options: {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
}): Promise<string | null> {
  if (!electronBridge) {
    return Promise.reject(noBridge());
  }
  if (!options.directory || options.multiple) {
    return Promise.reject(new Error("Only choosing one folder is supported."));
  }
  return electronBridge.chooseFolder(options.title);
}

export async function choosePictures(title?: string): Promise<string[]> {
  return electronBridge?.choosePictures ? electronBridge.choosePictures(title) : [];
}

let awakeAskers = 0;
/** Holds off sleep while at least one job asked for it. */
export async function keepAwake(on: boolean): Promise<boolean> {
  awakeAskers = Math.max(0, awakeAskers + (on ? 1 : -1));
  return electronBridge?.keepAwake ? electronBridge.keepAwake(awakeAskers > 0) : false;
}

export async function aboutInfo(): Promise<AboutInfo | null> {
  return electronBridge?.about ? electronBridge.about() : null;
}

export async function openLicences(): Promise<boolean> {
  return electronBridge?.openLicences ? electronBridge.openLicences() : false;
}

/** Opens an https link to one of the program's services in the person's own browser. */
/** Opens Windows Explorer at a library song (refused for anything outside the music library). */
export async function showInFolder(filePath: string): Promise<boolean> {
  return electronBridge?.showInFolder ? electronBridge.showInFolder(filePath) : false;
}

export async function openExternal(address: string): Promise<boolean> {
  return electronBridge ? electronBridge.openExternal(address) : false;
}

/** What the Add Release form is seeded with: only what the person confirmed on the Rip page. */
export type MusicBrainzRelease = {
  album: string;
  artist: string;
  date?: string;
  year?: number | null;
  country?: string;
  label?: string;
  catalog_number?: string;
  barcode?: string;
  tracks: { title: string; artist?: string | null; length_ms?: number }[];
  note?: string;
};

export async function musicbrainzAddRelease(release: MusicBrainzRelease): Promise<{ ok: boolean; message?: string }> {
  return electronBridge?.musicbrainzAddRelease ? electronBridge.musicbrainzAddRelease(release) : { ok: false, message: "This needs the desktop program." };
}
