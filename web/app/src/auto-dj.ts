// The Auto-DJ (issue #10): when the last song in the queue starts, a few songs that fit what has been playing are added to the end, so the music carries on. Off
// by default. Only songs of the library are used, never the one just played or anything already queued or lately played, and not the same band twice in a row.

import type { LibrarySong } from "./library-format";
import type { Player } from "./player";
import { pickForAutoDj } from "./smart-playlists";

const KEY = "mediaverse.auto-dj.v1";
const HOW_MANY = 6;
const REMEMBER = 80;

export const autoDjOn = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};

export function setAutoDj(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // kept until the window closes
  }
}

export function initAutoDj(player: Player, library: () => LibrarySong[]): void {
  const recent: string[] = [];
  let extendedAt = "";
  player.onChange(() => {
    if (!autoDjOn()) return;
    const view = player.view();
    const current = view.tracks[view.current];
    if (!current) return;
    if (recent[recent.length - 1] !== current.source_uri) {
      recent.push(current.source_uri);
      if (recent.length > REMEMBER) recent.shift();
    }
    const repeating = document.querySelector("#player-repeat")?.classList.contains("is-on") === true;
    if (repeating || view.current < view.tracks.length - 1 || extendedAt === current.source_uri) return;
    const songs = library();
    const now = songs.find((s) => s.source_uri === current.source_uri);
    if (!now) return;
    extendedAt = current.source_uri;
    const avoid = new Set([...recent, ...view.tracks.map((t) => t.source_uri)]);
    const picks = pickForAutoDj(now, songs, avoid, HOW_MANY);
    if (picks.length) player.enqueue(picks.map((s) => ({ title: s.title, artist: s.artist, album: s.album, source_uri: s.source_uri })), "end");
  });
}
