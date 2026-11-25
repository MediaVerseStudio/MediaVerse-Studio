// Talking to MediaVerse Studio on the computer (web/app/electron/library-share.js). Read only.
// A TV finds computers by asking each address on its own home network (a web app cannot use the network's
// announcement protocols), pairs once with a one-time code shown on the computer, and then sends the key it
// was given as a header. Song and cover addresses cannot send a header, so those use a short-lived ticket
// the computer returns after a request that had the key. The key is never put in an address.

import type { TrackLyrics } from "../src/lyrics-format.ts";
import type { ServerTrack } from "./library.ts";

export const DEFAULT_PORT = 47700;
/** The computer's answer must be this API or newer (pairing came with 2). */
const API_VERSION = 2;

export type Connection = { host: string; key: string; computer: string };
export type Found = { host: string; computer: string };

/** "192.168.1.20" or "192.168.1.20:47700" as a base address; null if it is not an IPv4 address. */
export function baseUrl(host: string): string | null {
  const match = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\s*$/.exec(host);
  if (!match) return null;
  if (match[1].split(".").some((part) => Number(part) > 255)) return null;
  const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
  if (port < 1 || port > 65535) return null;
  return `http://${match[1]}:${port}`;
}

let mediaTicket = "";
let mediaTicketHost = "";

function url(connection: Connection, path: string): string {
  const base = baseUrl(connection.host);
  if (!base) throw new Error("The computer address is not valid.");
  return `${base}${path}`;
}

function authHeaders(connection: Connection, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${connection.key}`, ...extra };
}

function noteTicket(connection: Connection, reply: Response): void {
  const ticket = reply.headers.get("X-MediaVerse-Ticket");
  if (ticket && /^[0-9a-f]{48}$/i.test(ticket)) {
    mediaTicket = ticket.toLowerCase();
    mediaTicketHost = connection.host;
  }
}

function withTicket(connection: Connection, address: string): string {
  if (!mediaTicket || mediaTicketHost !== connection.host) return address;
  return `${address}${address.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(mediaTicket)}`;
}

type ShareErrorKind = "unreachable" | "wrong_code" | "not_paired" | "expired" | "busy" | "locked" | "old_version" | "other";

export class ShareError extends Error {
  readonly kind: ShareErrorKind;
  constructor(message: string, kind: ShareErrorKind) {
    super(message);
    this.kind = kind;
  }
}

async function getJson<T>(address: string, timeoutMs = 15_000, headers?: Record<string, string>, connection?: Connection): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reply: Response;
  try {
    reply = await fetch(address, { signal: controller.signal, cache: "no-store", headers });
  } catch {
    throw new ShareError("The computer did not answer. Check that MediaVerse Studio is running there and that sharing is on (Settings > TV).", "unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (connection) noteTicket(connection, reply);
  if (!reply.ok) {
    let said: { error?: string; message?: string } = {};
    try {
      said = (await reply.json()) as typeof said;
    } catch {
      // plain text
    }
    const kinds: Record<string, ShareError["kind"]> = { wrong_code: "wrong_code", not_paired: "not_paired", no_pairing: "expired", busy: "busy", locked: "locked", not_armed: "other" };
    const kind = (said.error && kinds[said.error]) || (reply.status === 429 ? "locked" : "other");
    throw new ShareError(said.message ?? `The computer answered with an error (${reply.status}).`, kind);
  }
  return (await reply.json()) as T;
}

type Hello = { app: string; api: number; computer: string };

/** Checks that MediaVerse Studio answers at this address (no key needed). */
export async function hello(host: string, timeoutMs = 6_000): Promise<Hello> {
  const base = baseUrl(host);
  if (!base) throw new ShareError("Type the computer's address as four numbers with dots, like 192.168.1.20.", "other");
  const reply = await getJson<Hello>(`${base}/api/hello`, timeoutMs);
  if (reply.app !== "MediaVerse Studio") throw new ShareError("Something else answered at that address.", "other");
  if (!(reply.api >= API_VERSION)) throw new ShareError(`${reply.computer} has an older MediaVerse Studio. Update it there, then try again.`, "old_version");
  return reply;
}

/** Asks the computer to show a one-time pairing code. */
export async function startPairing(host: string, tvName: string): Promise<{ computer: string }> {
  const base = baseUrl(host);
  if (!base) throw new ShareError("The computer address is not valid.", "other");
  return getJson<{ computer: string }>(`${base}/api/pair?name=${encodeURIComponent(tvName)}`, 8_000);
}

/** Trades the code typed on the TV for this TV's key. */
export async function finishPairing(host: string, code: string): Promise<Connection> {
  const base = baseUrl(host);
  if (!base) throw new ShareError("The computer address is not valid.", "other");
  const reply = await getJson<{ key: string; computer: string }>(`${base}/api/pair/confirm?code=${encodeURIComponent(code)}`, 8_000);
  return { host, key: reply.key, computer: reply.computer };
}

/**
 * The addresses of a home network, from one address on it: "192.168.1.37" gives 192.168.1.1 to .254.
 * With the network's `mask`, a wider network (mesh systems often use 255.255.252.0: four times 254 addresses)
 * is covered too: the address's own 254 first, where the computer most likely is, then the rest. Never more
 * than those four blocks, however wide the mask: asking more addresses would take too long.
 */
export function neighbours(address: string, mask?: string | null): string[] {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address.trim());
  if (!match || [match[1], match[2], match[3]].some((p) => Number(p) > 255)) return [];
  const block = (third: number): string[] => Array.from({ length: 254 }, (_, i) => `${match[1]}.${match[2]}.${third}.${i + 1}`);
  const own = Number(match[3]);
  // How many blocks of 254 the mask spans: 1 for 255.255.255.0 (or no mask), 2 for 255.255.254.0, else 4.
  const parts = /^255\.(\d{1,3})\.(\d{1,3})\.0$/.exec(mask?.trim() ?? "");
  const blocks = !parts || (parts[1] === "255" && parts[2] === "255") ? 1 : parts[1] === "255" && parts[2] === "254" ? 2 : 4;
  const first = own - (own % blocks);
  const thirds = [own];
  for (let third = first; third < first + blocks; third += 1) if (third !== own) thirds.push(third);
  return thirds.flatMap(block);
}

/**
 * Asks every address in `hosts` whether MediaVerse Studio answers, a few at a time, calling `found` for each
 * computer as it answers. Most addresses have nothing on them, and those take the full timeout, so the asking
 * is spread over `parallel` at once.
 */
export async function discover(hosts: string[], found: (computer: Found) => void, options: { parallel?: number; timeoutMs?: number; signal?: { stopped: boolean } } = {}): Promise<void> {
  const { parallel = 48, timeoutMs = 1_500, signal } = options;
  const queue = [...new Set(hosts)];
  async function worker(): Promise<void> {
    while (queue.length && !signal?.stopped) {
      const host = queue.shift()!;
      try {
        const reply = await hello(host, timeoutMs);
        if (!signal?.stopped) found({ host, computer: reply.computer });
      } catch {
        // nothing there, or something else
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
}

export async function fetchLibrary(connection: Connection): Promise<ServerTrack[]> {
  const reply = await getJson<{ tracks: ServerTrack[] }>(url(connection, "/api/library"), 60_000, authHeaders(connection), connection);
  return reply.tracks;
}

export type ServerPlaylist = { id: string; name: string; updated_at: number; ids: string[] };

/** The computer's playlists (D82); null when the computer is older and has none to give (or a phone). */
export async function fetchPlaylists(connection: Connection): Promise<ServerPlaylist[] | null> {
  const reply = await fetch(url(connection, "/api/playlists"), { cache: "no-store", headers: authHeaders(connection) });
  noteTicket(connection, reply);
  if (reply.status === 404) return null;
  if (!reply.ok) throw new ShareError(`The computer answered with an error (${reply.status}).`, "other");
  const data = (await reply.json()) as { playlists?: ServerPlaylist[] };
  return Array.isArray(data.playlists) ? data.playlists : [];
}

export async function fetchLyrics(connection: Connection, id: string): Promise<TrackLyrics> {
  return getJson<TrackLyrics>(url(connection, `/api/lyrics/${encodeURIComponent(id)}`), 15_000, authHeaders(connection), connection);
}

export function audioUrl(connection: Connection, id: string): string {
  return withTicket(connection, url(connection, `/api/audio/${encodeURIComponent(id)}`));
}

/** A track's cover, `size` pixels on its longer side at most (the computer shrinks it). */
export function coverUrl(connection: Connection, id: string, size: number): string {
  return withTicket(connection, url(connection, `/api/cover/${encodeURIComponent(id)}?size=${size}`));
}

const STORE = "mediaverse.tv.connection";

export function savedConnection(): Connection | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    return saved && typeof saved.host === "string" && typeof saved.key === "string" && /^[0-9a-f]{64}$/.test(saved.key)
      ? { host: saved.host, key: saved.key, computer: typeof saved.computer === "string" ? saved.computer : "" }
      : null;
  } catch {
    return null;
  }
}

export function saveConnection(connection: Connection | null): void {
  if (!connection || connection.host !== mediaTicketHost) {
    mediaTicket = "";
    mediaTicketHost = "";
  }
  try {
    if (connection) localStorage.setItem(STORE, JSON.stringify(connection));
    else localStorage.removeItem(STORE);
  } catch {
    // not remembered; paired again next time
  }
}

/** Which songs are favorites and which are flagged on the computer (track IDs); null from an older computer. */
export async function fetchMarks(connection: Connection): Promise<{ favorites: string[]; flagged: string[] } | null> {
  try {
    return await getJson<{ favorites: string[]; flagged: string[] }>(url(connection, "/api/marks"), 15_000, authHeaders(connection), connection);
  } catch (error) {
    if (error instanceof ShareError && error.kind === "other") return null; // 404: MediaVerse Studio before D44
    throw error;
  }
}

/**
 * A command from a phone acting as the remote (D58): play these songs from here, play/pause, next, previous,
 * seek. Only MediaVerse Studio on a phone sends them; a computer has no remote and answers 404.
 */
export type RemoteCommand =
  | { seq: number; action: "play"; ids: string[]; index: number; position_ms: number; shuffle?: boolean }
  | { seq: number; action: "toggle" | "pause" | "next" | "previous" }
  | { seq: number; action: "seek"; ms: number };

/**
 * Waits (up to about 20 s) for commands after `after` (-1 the first time: only learns where the list is).
 * Null when the source has no remote (a computer).
 */
export async function waitForCommands(connection: Connection, after: number): Promise<{ seq: number; commands: RemoteCommand[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const reply = await fetch(url(connection, `/api/remote?after=${after}`), { signal: controller.signal, cache: "no-store", headers: authHeaders(connection) });
    noteTicket(connection, reply);
    if (reply.status === 404) return null;
    if (!reply.ok) throw new ShareError(`The phone answered with an error (${reply.status}).`, "other");
    return (await reply.json()) as { seq: number; commands: RemoteCommand[] };
  } finally {
    clearTimeout(timer);
  }
}

/** Tells the phone what the TV is playing, so its screen can show it. */
export async function postRemoteState(connection: Connection, state: { id: string | null; playing: boolean; position_ms: number; duration_ms: number }): Promise<void> {
  await fetch(url(connection, "/api/remote/state"), { method: "POST", headers: authHeaders(connection, { "Content-Type": "text/plain" }), body: JSON.stringify(state) });
}

/** Flags a song for review, or marks it a favorite, on the computer (D44). */
export async function postMark(connection: Connection, kind: "flag" | "favorite", id: string, body: Record<string, unknown>): Promise<void> {
  const reply = await fetch(url(connection, `/api/${kind}/${encodeURIComponent(id)}`), {
    method: "POST",
    headers: authHeaders(connection, { "Content-Type": "text/plain" }),
    body: JSON.stringify(body),
  });
  noteTicket(connection, reply);
  if (reply.status === 405) {
    throw new ShareError("MediaVerse Studio on the computer is older than this TV app. Close it there and start it again (or update it), then try again.", "old_version");
  }
  if (!reply.ok) throw new ShareError(`The computer could not save that (${reply.status}).`, "other");
}
