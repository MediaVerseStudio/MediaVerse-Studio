// Where the music library comes from (owner, 2026-11-23, D173): a music folder on this computer or on the Jellyfin server's shared folder ("folder", the full
// program: ripping, tag, cover and lyrics editing), or the Jellyfin server alone ("jellyfin": playing and casting only, because Jellyfin does not let other programs
// change its files). The choice is kept in the page's storage and read once as the program starts; changing it reloads the page.

import { readSaved, writeSaved } from "./jellyfin-desktop";

export type LibraryMode = "folder" | "jellyfin";
const MODE_STORE = "mediaverse.desktop.library-mode";

export function libraryMode(): LibraryMode {
  return readSaved<unknown>(MODE_STORE, "folder") === "jellyfin" ? "jellyfin" : "folder";
}

export function setLibraryMode(mode: LibraryMode): void {
  writeSaved(MODE_STORE, mode === "jellyfin" ? "jellyfin" : null);
}

/** Whether the library is the Jellyfin server alone. */
export const serverLibrary = (): boolean => libraryMode() === "jellyfin";

/** A song of the server library is named `jellyfin:<album id>/<song id>` (`loose-<song id>` when it has no album): the album part makes the folder-based views group by album. */
export const isServerSong = (path: string): boolean => path.startsWith("jellyfin:");

/** The song's id on the server (the last part of its name), or null for a file path. */
export function serverSongId(path: string): string | null {
  const match = /^jellyfin:[A-Za-z0-9_-]{1,64}\/([0-9a-f]{32})$/i.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}
