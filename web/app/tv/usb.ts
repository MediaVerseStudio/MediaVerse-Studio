// Music on a USB drive plugged into the TV (Samsung Tizen filesystem API: `filesystem.read` and
// `externalstorage` privileges). Tried on the S95F with files in the app's own folder: listing, reading and
// playing from a file:// address all work; a real USB drive (an EXTERNAL storage) is still to be tried.
// The drive is walked for music files, each file's tags are read from its first bytes (tags.ts), and the
// result is remembered per drive so the next visit starts at once.

import type { ServerTrack } from "./library.ts";
import { fromFileName, readTags, tagLength } from "./tags.ts";

type FileHandle = { readData(size?: number): Uint8Array; seek(offset: number, whence?: string): number; close(): void };
type TizenFilesystem = {
  listStorages(ok: (storages: Array<{ label: string; type: string; state: string }>) => void, fail?: (error: Error) => void): void;
  addStorageStateChangeListener?(listener: (storage: { label: string; type: string; state: string }) => void): number;
  listDirectory(path: string, ok: (names: string[]) => void, fail?: (error: Error) => void): void;
  isDirectory(path: string): boolean;
  openFile(path: string, mode: string): FileHandle;
  toURI(path: string): string;
};

function filesystem(): TizenFilesystem | null {
  return (window as unknown as { tizen?: { filesystem?: TizenFilesystem } }).tizen?.filesystem ?? null;
}

export type Drive = { label: string };

/** USB drives the TV has mounted (none outside a TV). */
export function listDrives(): Promise<Drive[]> {
  const fs = filesystem();
  if (!fs) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      fs.listStorages(
        (storages) => resolve(storages.filter((s) => s.type === "EXTERNAL" && s.state === "MOUNTED").map((s) => ({ label: s.label }))),
        () => resolve([]),
      );
    } catch {
      resolve([]);
    }
  });
}

/** Calls `changed` when a drive is plugged in or taken out. */
export function watchDrives(changed: () => void): void {
  try {
    filesystem()?.addStorageStateChangeListener?.((storage) => {
      if (storage.type === "EXTERNAL") changed();
    });
  } catch {
    // not available: "Search again" still finds drives
  }
}

const MUSIC = /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i;
const PICTURE = /^(cover|folder|front|albumart)\.(jpe?g|png)$/i;
const MAX_FILES = 30_000;
const MAX_DEPTH = 10;

function list(fs: TizenFilesystem, path: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      fs.listDirectory(path, resolve, () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/** Up to `max` bytes from the start of a file (0 bytes if it cannot be read). */
function readStart(fs: TizenFilesystem, path: string, max: number): Uint8Array {
  try {
    const handle = fs.openFile(path, "r");
    try {
      return handle.readData(max);
    } finally {
      handle.close();
    }
  } catch {
    return new Uint8Array(0);
  }
}

export type DriveLibrary = {
  tracks: ServerTrack[];
  /** Track id -> file:// address to play. */
  audio: Map<string, string>;
  /** cover_key -> picture address (a folder image, or the first embedded cover in that folder). */
  covers: Map<string, string>;
};

/**
 * Walks a drive for music and reads each song's details. `progress` is told how many songs so far. Embedded
 * covers become blob: addresses, one per folder.
 */
export async function scanDrive(
  drive: Drive,
  progress: (songs: number) => void,
  signal: { stopped: boolean },
  early?: (library: DriveLibrary) => void,
): Promise<DriveLibrary> {
  const fs = filesystem();
  const library: DriveLibrary = { tracks: [], audio: new Map(), covers: new Map() };
  if (!fs) return library;
  const folders: Array<{ path: string; depth: number }> = [{ path: drive.label, depth: 0 }];
  let lastYield = performance.now();
  const began = performance.now();
  let toldEarly = false;
  while (folders.length && library.tracks.length < MAX_FILES && !signal.stopped) {
    const { path, depth } = folders.shift()!;
    const names = (await list(fs, path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const coverKey = `${drive.label}:${path}`;
    for (const name of names) {
      if (name.startsWith(".")) continue; // hidden files and the Mac's ._ copies
      const full = `${path}/${name}`;
      if (MUSIC.test(name)) {
        const head = readStart(fs, full, 10);
        const length = tagLength(head);
        const bytes = length === null ? head : readStart(fs, full, length < 0 ? 2_000_000 : Math.min(length, 8_000_000));
        const tags = length === null ? {} : readTags(bytes);
        const named = fromFileName(full.slice(drive.label.length + 1));
        const id = `usb:${full}`;
        library.tracks.push({
          id,
          title: tags.title || named.title || name,
          artist: tags.artist ?? named.artist ?? null,
          album: tags.album ?? named.album ?? null,
          album_artist: tags.album_artist ?? null,
          genre: tags.genre ?? null,
          year: tags.year ?? null,
          track_number: tags.track_number ?? named.track_number ?? null,
          folder: path.split("/").pop() ?? path,
          cover_key: coverKey,
        });
        library.audio.set(id, fs.toURI(full));
        if (tags.picture && !library.covers.has(coverKey)) {
          library.covers.set(coverKey, URL.createObjectURL(new Blob([tags.picture.data.slice()], { type: tags.picture.mime })));
        }
        if (library.tracks.length % 25 === 0) progress(library.tracks.length);
        // Show what there is so far (the library keeps filling in behind it): after 100 songs or 3 seconds.
        if (early && !toldEarly && (library.tracks.length >= 100 || performance.now() - began > 3_000)) {
          toldEarly = true;
          early(library);
        }
      } else if (PICTURE.test(name)) {
        library.covers.set(coverKey, fs.toURI(full)); // a folder picture wins over an embedded one
      } else if (depth < MAX_DEPTH && !/\.[a-z0-9]{1,5}$/i.test(name)) {
        try {
          if (fs.isDirectory(full)) folders.push({ path: full, depth: depth + 1 });
        } catch {
          // not a folder
        }
      }
      if (performance.now() - lastYield > 40) {
        await new Promise((resolve) => setTimeout(resolve, 0)); // keep the remote responsive
        lastYield = performance.now();
      }
    }
  }
  progress(library.tracks.length);
  return library;
}

const CACHE = "mediaverse.tv.drive:";
/** Drives with more songs than this are not remembered (the TV's page storage is small). */
const MAX_CACHED = 8_000;

/**
 * What was found on this drive last time, to show at once while it is read again. Embedded covers are not
 * kept (they are read again); folder pictures are.
 */
export function cachedDrive(drive: Drive): DriveLibrary | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE + drive.label) ?? "null");
    if (!saved || !Array.isArray(saved.tracks) || !Array.isArray(saved.audio) || !Array.isArray(saved.covers)) return null;
    return { tracks: saved.tracks, audio: new Map(saved.audio), covers: new Map(saved.covers) };
  } catch {
    return null;
  }
}

export function rememberDrive(drive: Drive, library: DriveLibrary): void {
  try {
    if (library.tracks.length > MAX_CACHED) return;
    const covers = [...library.covers].filter(([, address]) => !address.startsWith("blob:"));
    localStorage.setItem(CACHE + drive.label, JSON.stringify({ tracks: library.tracks, audio: [...library.audio], covers }));
  } catch {
    // too big for the page's storage: read in full next time
  }
}