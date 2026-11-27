// "New music on this phone": music the library lacks, sent to its incoming folder, on the computer (D214) or on the
// Jellyfin server through the MediaVerse Sync plugin (D215). Which songs are offered is send-music.ts; this is the
// screen and the sending, one song at a time. Text is set with textContent.

import { el } from "../src/dom.ts";
import { sizeText } from "./home-sync.ts";
import type { Session } from "./jellyfin-phone.ts";
import type { Bridge, FromApp, PhoneTrack } from "./native.ts";
import { newForLibrary, type Listing, type SendAlbum } from "./send-music.ts";

/** Albums listed for sending; "Send all" covers the rest. */
const LISTED = 100;
/** "5 minutes' worth". */
const CHUNK_MS = 5 * 60_000;

export type SendTarget = {
  place: "computer" | "server";
  /** Who it goes to now, or null when not paired or signed in. */
  session: () => Session | null;
  /** The library's songs there, or why nothing can be sent. */
  library: (to: Session) => Promise<{ songs: Listing[] } | { refused: string }>;
  request: (to: Session, path: string) => { url: string; headers: Record<string, string> };
  /** What the screen says before anything is looked for. */
  hint: string;
  /** Where sent music waits, as said after sending. */
  folder: string;
  /** The storage key of the songs already sent there (not offered again while they wait to be looked over). */
  sentKey: (to: Session) => string;
  /** The phone's ids of songs that came from there. */
  skip: () => Set<string>;
};

export type SendDeps = {
  bridge: Bridge;
  tracks: () => PhoneTrack[];
  /** Reads the phone's music again and resolves when the page has it. */
  reloadLibrary: () => Promise<void>;
  changed: () => void;
  confirm: (title: string, yes: string, action: () => void) => void;
};

export type SendMusic = {
  render: (into: HTMLElement) => void;
  onNative: (message: FromApp) => void;
  forget: () => void;
};

/** Sendings under way, on either screen: the phone's screen stays on until the last ends. */
let underWay = 0;

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function createSendMusic(deps: SendDeps, target: SendTarget): SendMusic {
  const tag = target.place === "server" ? "s" : "";
  let found: SendAlbum[] | null = null;
  /** Who the list and the words on screen are about. */
  let about = "";
  let words = "";
  let sending = false;
  let looking = false;
  let stop = false;
  let noteLine: HTMLElement | null = null;
  let bar: HTMLProgressElement | null = null;
  /** How far a sending has got, in bytes (songs differ too much in size to count them). */
  let reached = { done: 0, total: 0, since: 0 };
  const paintBar = (): void => {
    if (!bar) return;
    bar.hidden = !sending;
    bar.max = reached.total || 1;
    bar.value = reached.done;
  };
  /** " · about 12 minutes left", once there is enough to judge by. */
  const timeLeft = (): string => {
    if (reached.done <= 0 || Date.now() - reached.since < 10_000) return "";
    const minutes = Math.round(((Date.now() - reached.since) / reached.done) * (reached.total - reached.done) / 60_000);
    return minutes < 1 ? " · under a minute left" : ` · about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  };
  let counter = 0;
  let waiting: { id: string; done: (error: string | null) => void; progress: (fraction: number) => void } | null = null;
  const who = (to: Session): string => `${to.base} ${to.serverId} ${to.userId}`;
  const note = (text: string): void => {
    words = text;
    if (noteLine?.isConnected) noteLine.textContent = text;
  };
  const forget = (): void => {
    found = null;
    words = "";
    about = "";
  };

  async function look(): Promise<void> {
    const to = target.session();
    if (!to || looking || sending) return;
    looking = true;
    found = null;
    about = who(to);
    note(`Comparing this phone's music with the ${target.place}'s…`);
    deps.changed();
    try {
      const there = await target.library(to);
      if ("refused" in there) {
        note(there.refused);
        return;
      }
      await deps.reloadLibrary();
      const skip = new Set([...readList(target.sentKey(to)), ...target.skip()]);
      found = newForLibrary(deps.tracks().map((t) => ({ id: t.id, title: t.title, artist: t.artist, album_artist: t.album_artist, album: t.album, file: t.file, size: t.size })), there.songs, skip);
      note(found.length ? "" : `Nothing new to send: the rest is on the ${target.place} already, or was sent to it before.`);
    } catch (thrown) {
      note(thrown instanceof Error ? thrown.message : "That did not work.");
    } finally {
      looking = false;
      deps.changed();
    }
  }

  function upload(to: Session, mediaId: string, path: string, progress: (fraction: number) => void): Promise<string | null> {
    return new Promise((resolve) => {
      const id = `${tag}up${++counter}`;
      const timer = window.setTimeout(() => waiting?.id === id && waiting.done("The song took too long."), 30 * 60_000);
      waiting = { id, progress, done: (error) => (window.clearTimeout(timer), (waiting = null), resolve(error)) };
      deps.bridge.send({ type: "upload", id, ...target.request(to, path), mediaId });
    });
  }

  /** `chunk`: five minutes' worth, ending between songs. */
  async function send(albums: SendAlbum[], chunk = false): Promise<void> {
    const to = target.session();
    if (!to || sending || who(to) !== about) return;
    sending = true;
    stop = false;
    const songs = albums.flatMap((a) => a.songs);
    const sent = new Set<string>();
    let failures = 0;
    let problem = "";
    underWay += 1;
    const deadline = Date.now() + CHUNK_MS;
    let timeUp = false;
    reached = { done: 0, total: songs.reduce((sum, s) => sum + s.size, 0), since: Date.now() };
    deps.bridge.send({ type: "keepScreenOn", on: true });
    deps.changed();
    try {
      for (const [n, song] of songs.entries()) {
        const now = target.session();
        if (stop || !now || who(now) !== about) break;
        if (chunk && n > 0 && Date.now() >= deadline) {
          timeUp = true;
          break;
        }
        const line = `Sending ${n + 1} of ${songs.length}: ${song.title}`;
        const before = reached.done;
        note(`${line}${timeLeft()}`);
        paintBar();
        const error = await upload(to, song.id, song.path, (fraction) => {
          reached.done = before + fraction * song.size;
          paintBar();
          note(`${line} (${Math.round(fraction * 100)}%)${timeLeft()}`);
        });
        reached.done = before + song.size;
        if (error === null) {
          failures = 0;
          sent.add(song.id);
          try {
            localStorage.setItem(target.sentKey(to), JSON.stringify([...readList(target.sentKey(to)), song.id]));
          } catch {
            /* offered again next time; the other side keeps one copy */
          }
        } else {
          problem = `${song.title}: ${error}`;
          if (++failures >= 3) break;
        }
      }
    } finally {
      sending = false;
      underWay -= 1;
      if (!underWay) deps.bridge.send({ type: "keepScreenOn", on: false });
      found = (found ?? []).flatMap((a) => {
        const left = a.songs.filter((s) => !sent.has(s.id));
        return left.length ? [{ ...a, songs: left, bytes: left.reduce((sum, s) => sum + s.size, 0) }] : [];
      });
      const left = songs.length - sent.size;
      const rest = timeUp ? ` Five minutes' worth done, ${left} left (send again to carry on).` : left ? ` ${left} not sent${problem ? ` (${problem.replace(/\.$/, "")})` : ""}.` : "";
      note(`${sent.size} song${sent.size === 1 ? "" : "s"} sent to ${target.folder}.${rest}`);
      deps.changed();
    }
  }

  function onNative(message: FromApp): void {
    if (message.type === "uploaded" && waiting?.id === message.id) waiting.done(message.ok ? null : (message.error ?? "not sent"));
    else if (message.type === "uploadProgress" && waiting?.id === message.id && message.total > 0) waiting.progress(message.bytes / message.total);
  }

  function button(text: string, kind: "primary" | "secondary", action: () => void): HTMLElement {
    const made = el("button", kind, text);
    made.type = "button";
    made.addEventListener("click", action);
    return made;
  }

  function albumRow(album: SendAlbum): HTMLElement {
    const row = el("button", "switch-row");
    row.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", album.title), el("span", "row-sub", `${album.artist} · ${album.songs.length} song${album.songs.length === 1 ? "" : "s"} (${sizeText(album.bytes)}). Tap to send.`));
    row.append(text);
    row.addEventListener("click", () => void send([album]));
    return row;
  }

  function render(into: HTMLElement): void {
    const to = target.session();
    if (!to) return;
    if (about && about !== who(to) && !sending) forget();
    const box = el("div", "settings");
    box.append(el("h2", "section", "New music on this phone"));
    box.append(el("p", "hint", target.hint));
    if (sending) box.append(button("Stop sending", "secondary", () => ((stop = true), note("Stopping after this song…"))));
    else box.append(button(looking ? "Looking…" : "Look for new music to send", "secondary", () => void look()));
    noteLine = el("p", "hint", words);
    noteLine.setAttribute("role", "status");
    bar = el("progress", "sync-progress");
    paintBar();
    box.append(bar, noteLine);
    if (sending) box.append(el("p", "hint", "Sending keeps the screen on until it ends; leave the app open and the phone charging for a large one."));
    if (found?.length && !sending) {
      const everything = found;
      const count = everything.reduce((sum, a) => sum + a.songs.length, 0);
      const size = sizeText(everything.reduce((sum, a) => sum + a.bytes, 0));
      box.append(button(`Send all ${count} song${count === 1 ? "" : "s"} (${size})`, "primary", () => deps.confirm(`Send ${count} song${count === 1 ? "" : "s"} (${size}) to the ${target.place}?`, "Send them", () => void send(everything))));
      box.append(button("Send 5 minutes' worth", "secondary", () => void send(everything, true)));
      for (const album of everything.slice(0, LISTED)) box.append(albumRow(album));
      if (everything.length > LISTED) box.append(el("p", "hint", `And ${everything.length - LISTED} more albums.`));
    }
    into.append(box);
  }

  return { render, onNative, forget };
}
