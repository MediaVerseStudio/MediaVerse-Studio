// Songs held whole in memory (owner, 2026-11-23): the player does not stream a song and fetch a piece of it each time the position is moved or the buffer runs
// dry (which felt like buffering, and was slow over a network share or from a server). It reads the whole file first, plays from memory, and reads the songs that
// follow in the queue ahead of time, so jumping inside a song or to the next one has nothing to wait for. Pure (the fetching and the object URLs are passed in), so it
// is unit tested.

export type AudioCacheDeps = {
  /** The whole file of a song. */
  fetchBlob: (uri: string) => Promise<Blob>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  now?: () => number;
  /** Memory the finished songs may use together (songs being played or next in line are never dropped for it). */
  maxBytes?: number;
  maxEntries?: number;
  /** A song kept this long is read again the next time it is wanted (the file may have changed). */
  maxAgeMs?: number;
};

export type AudioCache = {
  /** The in-memory address of a song when it is already loaded, else null. */
  ready: (uri: string) => string | null;
  /** Loads a song (or joins the load in progress); resolves with its in-memory address. */
  load: (uri: string) => Promise<string>;
  /** Loads these songs one after another in the background, then drops old ones, never `keep`. A newer call replaces the order of the one before. */
  warm: (uris: string[], keep: string[]) => void;
  /** Lets go of songs whose files are about to change. */
  forget: (uris: string[]) => void;
  clear: () => void;
};

type Entry = { promise: Promise<string>; url: string | null; bytes: number; used: number; loaded: number };

export function createAudioCache(deps: AudioCacheDeps): AudioCache {
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? 600 * 1024 * 1024;
  const maxEntries = deps.maxEntries ?? 10;
  const maxAge = deps.maxAgeMs ?? 10 * 60_000;
  const entries = new Map<string, Entry>();
  let run = 0;

  const drop = (uri: string): void => {
    const entry = entries.get(uri);
    entries.delete(uri);
    if (entry?.url) deps.revokeUrl(entry.url);
  };

  const fresh = (entry: Entry): boolean => now() - entry.loaded <= maxAge;

  /** Drops what is too old, then the least recently used while over budget. Songs in `keep` and songs still loading stay. */
  function trim(keep: Set<string>): void {
    for (const [uri, entry] of [...entries]) if (entry.url && !keep.has(uri) && !fresh(entry)) drop(uri);
    const finished = (): Array<[string, Entry]> => [...entries].filter(([uri, e]) => e.url && !keep.has(uri)).sort((a, b) => a[1].used - b[1].used);
    const bytes = (): number => [...entries.values()].reduce((sum, e) => sum + e.bytes, 0);
    while ((bytes() > maxBytes || entries.size > maxEntries) && finished().length > 0) drop(finished()[0]![0]);
  }

  function load(uri: string): Promise<string> {
    const found = entries.get(uri);
    if (found && (found.url === null || fresh(found))) {
      found.used = now();
      return found.promise;
    }
    if (found) drop(uri); // too old: read again
    const entry: Entry = { promise: Promise.resolve(""), url: null, bytes: 0, used: now(), loaded: now() };
    entry.promise = deps.fetchBlob(uri).then(
      (blob) => {
        if (entries.get(uri) !== entry) return deps.createUrl(blob); // forgotten while loading: used once, not kept
        entry.url = deps.createUrl(blob);
        entry.bytes = blob.size;
        entry.loaded = now();
        return entry.url;
      },
      (thrown) => {
        if (entries.get(uri) === entry) entries.delete(uri);
        throw thrown;
      },
    );
    entries.set(uri, entry);
    return entry.promise;
  }

  return {
    ready(uri) {
      const entry = entries.get(uri);
      if (!entry?.url || !fresh(entry)) return null;
      entry.used = now();
      return entry.url;
    },
    load,
    warm(uris, keep) {
      const mine = ++run;
      const kept = new Set(keep);
      void (async () => {
        for (const uri of uris) {
          if (mine !== run) return;
          await load(uri).catch(() => undefined);
        }
        if (mine === run) trim(kept);
      })();
      trim(kept);
    },
    forget(uris) {
      for (const uri of uris) drop(uri);
    },
    clear() {
      run++;
      for (const uri of [...entries.keys()]) drop(uri);
    },
  };
}
