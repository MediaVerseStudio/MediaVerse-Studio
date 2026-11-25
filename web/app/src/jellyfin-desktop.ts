// The desktop program's way of talking to the Jellyfin server (D96, D97): one signed-in session shared by the
// shared-problem-tracks sync (Settings > Jellyfin) and the artist photos tool (Review > Artists).

import { Jellyfin, type Http, type Session } from "../phone/jellyfin-phone.ts";

export const SESSION_STORE = "mediaverse.desktop.jellyfin";
const DEVICE_STORE = "mediaverse.desktop.device-id";

export function readSaved<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeSaved(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept until the program closes
  }
}

/** The Jellyfin server this computer uses (owner, 2026-11-22: one default server, chosen on Settings > Jellyfin, for flags, playlists and rescans). */
export type ChosenServer = { id: string; name: string; base: string };
const CHOSEN_STORE = "mediaverse.desktop.jellyfin-default";
const HIDDEN_STORE = "mediaverse.desktop.jellyfin-hidden";
const chosenListeners: Array<(server: ChosenServer | null) => void> = [];

export function chosenServer(): ChosenServer | null {
  const saved = readSaved<ChosenServer | null>(CHOSEN_STORE, null);
  return saved && typeof saved.id === "string" && typeof saved.base === "string" ? { id: saved.id, name: String(saved.name ?? ""), base: saved.base } : null;
}

export function chooseServer(server: ChosenServer | null): void {
  writeSaved(CHOSEN_STORE, server);
  for (const listener of chosenListeners) listener(server);
}

export function onChosenServerChange(listener: (server: ChosenServer | null) => void): void {
  chosenListeners.push(listener);
}

/** Servers the person hid from the list (the test server on this computer, say), by their id. */
export function hiddenServers(): string[] {
  const saved = readSaved<unknown>(HIDDEN_STORE, []);
  return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
}

export function setHiddenServers(ids: string[]): void {
  writeSaved(HIDDEN_STORE, ids);
}

export function deviceId(): string {
  let id = readSaved<string | null>(DEVICE_STORE, null);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    writeSaved(DEVICE_STORE, id);
  }
  return id;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * In the desktop program the request is made by the program itself (the page's security rules allow only this
 * computer's own addresses; the program refuses anything outside the home network). In a plain browser it is fetch.
 * With `binary`, the reply's body is the answer's bytes as base64 (a picture).
 */
export const jellyfinHttp: Http = async (request) => {
  const bridge = window.mediaVerse?.homeHttp;
  if (bridge) {
    try {
      return await bridge(request);
    } catch (error) {
      return { status: -1, body: String(error) };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout ?? 15_000);
  try {
    const reply = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body, signal: controller.signal, cache: "no-store" });
    return { status: reply.status, body: request.binary ? toBase64(new Uint8Array(await reply.arrayBuffer())) : await reply.text() };
  } catch (error) {
    return { status: -1, body: String(error) };
  } finally {
    clearTimeout(timer);
  }
};

export function desktopJellyfin(): Jellyfin {
  return new Jellyfin(jellyfinHttp, deviceId(), "Computer");
}

/** The session saved when this computer signed in (Settings > Jellyfin), or null. */
export function savedDesktopSession(): Session | null {
  const saved = readSaved<Session | null>(SESSION_STORE, null);
  return saved && typeof saved.base === "string" && typeof saved.token === "string" && typeof saved.userId === "string" ? saved : null;
}
