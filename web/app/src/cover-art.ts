// Cover pictures for the library and player. The sidecar finds the picture (embedded in an MP3, or a
// cover file in the same folder) and returns it as base64; it is turned into an object URL here and
// remembered per album folder so each album is asked about once.

import { blobFromBase64, folderOf } from "./cover-util";
import { invoke } from "./desktop-bridge";

type CoverReply = { mime: string; data_base64: string; from: string } | null;

const cache = new Map<string, Promise<string | null>>();

/** An object URL for the cover of the album that holds `trackPath`, or null when it has none. */
export function coverUrl(trackPath: string, urgent = false): Promise<string | null> {
  const key = folderOf(trackPath);
  let found = cache.get(key);
  if (!found) {
    found = invoke<CoverReply>("track_cover", { path: trackPath, urgent })
      .then((reply) => (reply && (reply.mime === "image/jpeg" || reply.mime === "image/png") ? URL.createObjectURL(blobFromBase64(reply.data_base64, reply.mime)) : null))
      .catch(() => null);
    cache.set(key, found);
  }
  return found;
}

const photoCache = new Map<string, Promise<string | null>>();

/**
 * An object URL for an artist's photo (the "Artist" picture embedded in their songs, or an artist.jpg in the artist's
 * folder), looked for in the given songs one after another; null when none has one. Asked once per set of songs.
 */
export function artistPhotoUrl(trackPaths: string[]): Promise<string | null> {
  const key = trackPaths.join("\n");
  let found = photoCache.get(key);
  if (!found) {
    found = (async () => {
      for (const path of trackPaths) {
        const reply = await invoke<CoverReply>("track_artist_photo", { path }).catch(() => null);
        if (reply && (reply.mime === "image/jpeg" || reply.mime === "image/png")) return URL.createObjectURL(blobFromBase64(reply.data_base64, reply.mime));
      }
      return null;
    })();
    photoCache.set(key, found);
  }
  return found;
}

const forgetListeners: (() => void)[] = [];
/** Told when remembered covers are forgotten, because every object URL handed out before then is now revoked (a broken image). */
export function onCoversForgotten(listener: () => void): void {
  forgetListeners.push(listener);
}

/** Forget remembered covers and photos (after tags or pictures change). */
export function forgetCovers(): void {
  for (const listener of forgetListeners) listener();
  for (const pending of [...cache.values(), ...photoCache.values()]) {
    void pending.then((url) => url && URL.revokeObjectURL(url));
  }
  cache.clear();
  photoCache.clear();
}
