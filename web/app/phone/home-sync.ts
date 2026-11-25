// Keeping chosen music on the phone in step with the home Jellyfin server (owner, 2026-11-23, D177): the person chooses artists, albums or playlists (or the whole
// library) to keep, much as a cloud-storage app lets you choose which folders to keep on a computer. Songs the server has and the phone does not are downloaded, songs
// whose file was edited on the server are downloaded again, and songs no longer chosen (or no longer on the server) are taken off the phone. Playback is always from the
// local files; the server only supplies them. Pure logic with every outside thing passed in (the server's answers, the download, the delete, the saved record), so the
// rules are unit tested without a phone or a server.

import type { SyncSong } from "./jellyfin-phone.ts";

export type { SyncSong };

/** One thing the person chose to keep. */
/** An artist's own albums ("artist"), or the songs of an artist who only appears on other artists' albums (compilations, guest spots: "appears"). */
export type Choice = { kind: "all" } | { kind: "artist"; id: string; name: string } | { kind: "appears"; id: string; name: string } | { kind: "album"; id: string; name: string; artist: string } | { kind: "playlist"; id: string; name: string };

export const choiceKey = (choice: Choice): string => (choice.kind === "all" ? "all" : `${choice.kind}:${choice.id}`);

export function choiceLabel(choice: Choice): string {
  switch (choice.kind) {
    case "all":
      return "The whole library";
    case "artist":
      return choice.name;
    case "appears":
      return `${choice.name} (on other albums)`;
    case "album":
      return choice.artist ? `${choice.name} · ${choice.artist}` : choice.name;
    case "playlist":
      return `${choice.name} (playlist)`;
  }
}

/** What the phone remembers about a song it fetched: enough to find the file again, to tell whether the server's copy changed, and why it is kept. */
export type KeptFile = {
  id: string;
  mediaId: string | null;
  path: string;
  size: number;
  etag: string | null;
  at: number;
  via: string[];
  title: string;
  artist: string;
  album: string;
  /** A song that was already on the phone and was recognised as the server's (D178): its file is the person's own, so the program never deletes it. */
  adopted?: boolean;
  /** An adopted song that differs from the server's copy (another tag or bitrate): left as it is until the person chooses the server's version. */
  hold?: boolean;
};
export type Manifest = { files: Record<string, KeptFile> };

export const emptyManifest = (): Manifest => ({ files: {} });

/** A record read back from storage, with anything odd dropped. */
export function cleanManifest(raw: unknown): Manifest {
  const files: Record<string, KeptFile> = {};
  const given = (raw as { files?: unknown } | null)?.files;
  if (given && typeof given === "object") {
    for (const [id, value] of Object.entries(given as Record<string, Record<string, unknown>>)) {
      if (!/^[0-9a-f]{32}$/.test(id) || !value || typeof value.path !== "string") continue;
      files[id] = {
        id,
        mediaId: typeof value.mediaId === "string" ? value.mediaId : null,
        path: value.path,
        size: Number(value.size) || 0,
        etag: typeof value.etag === "string" ? value.etag : null,
        at: Number(value.at) || 0,
        via: Array.isArray(value.via) ? value.via.filter((v): v is string => typeof v === "string") : [],
        title: String(value.title ?? ""),
        artist: String(value.artist ?? ""),
        album: String(value.album ?? ""),
        ...(value.adopted === true ? { adopted: true } : {}),
        ...(value.hold === true ? { hold: true } : {}),
      };
    }
  }
  return { files };
}

/** A file or folder name that Android and Windows both accept. */
export function safeName(text: string, fallback = "Unknown"): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

const EXTENSIONS: Record<string, string> = { mp3: "mp3", flac: "flac", m4a: "m4a", mp4: "m4a", aac: "aac", ogg: "ogg", oga: "ogg", opus: "opus", wav: "wav", wma: "wma", wv: "wv" };
export const extensionOf = (container: string): string => EXTENSIONS[container.toLowerCase()] ?? "mp3";

export const MIME: Record<string, string> = { mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", wma: "audio/x-ms-wma", wv: "audio/x-wavpack" };

/** Where a song goes under the phone's Music folder: `Artist/Album/01 - Title.mp3` (a folder per album, which is how the phone groups albums). */
export function relativePath(song: SyncSong): string {
  const number = song.track ? String(song.track).padStart(2, "0") : "";
  const disc = song.disc && song.disc > 1 ? `${song.disc}-` : "";
  const prefix = number ? `${disc}${number} - ` : "";
  return `${safeName(song.albumArtist || song.artist, "Unknown artist")}/${safeName(song.album, "Unknown album")}/${prefix}${safeName(song.title, "Unknown title")}.${extensionOf(song.container)}`;
}

/** Paths that are free for each song: when two songs would share one (the same title twice on an album) the later ones get " (2)", " (3)". */
export function uniquePaths(songs: SyncSong[], taken: Set<string> = new Set()): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set([...taken].map((p) => p.toLowerCase()));
  for (const song of songs) {
    const base = relativePath(song);
    let path = base;
    for (let n = 2; used.has(path.toLowerCase()); n += 1) path = base.replace(/(\.[a-z0-9]+)$/, ` (${n})$1`);
    used.add(path.toLowerCase());
    result.set(song.id, path);
  }
  return result;
}

/** Whether the server's copy of a song is not the one kept: its file was edited (the server's ETag changed) or, with no ETag, its size did. */
export function changedOnServer(file: KeptFile, song: SyncSong): boolean {
  if (file.etag && song.etag) return file.etag !== song.etag;
  return song.size > 0 && file.size > 0 && song.size !== file.size;
}

export type Wanted = Map<string, { song: SyncSong; via: string[] }>;

/** Every song the choices name, each with the choices that name it. */
export function wantedFrom(results: Array<{ choice: Choice; songs: SyncSong[] }>): Wanted {
  const wanted: Wanted = new Map();
  for (const { choice, songs } of results) {
    for (const song of songs) {
      const entry = wanted.get(song.id);
      if (entry) {
        if (!entry.via.includes(choiceKey(choice))) entry.via.push(choiceKey(choice));
      } else wanted.set(song.id, { song, via: [choiceKey(choice)] });
    }
  }
  return wanted;
}

export type Plan = {
  download: Array<{ song: SyncSong; via: string[] }>;
  /** Songs whose file was edited on the server, or whose phone copy is gone: fetched again (a song that was already on the phone is updated where it is). */
  update: Array<{ song: SyncSong; via: string[]; old: KeptFile; why: "edited" | "missing"; inPlace: boolean }>;
  /** Songs that were already on the phone and differ from the server's copy: left as they are. */
  differs: number;
  /** Songs taken off the phone because they are no longer chosen. */
  remove: KeptFile[];
  /** Songs the server no longer has: taken off too, unless so many went at once that something is probably wrong (then they stay, and this says how many). */
  gone: KeptFile[];
  heldBack: number;
  same: number;
  /** Bytes to fetch. */
  bytes: number;
};

/**
 * The most songs that may vanish from the server in one round before it is taken for a fault (a share that is offline answers with an empty library): the larger of 25
 * and a fifth of what is kept. More than that stay on the phone until the person looks.
 */
export const goneLimit = (kept: number): number => Math.max(25, Math.floor(kept / 5));

/**
 * What to do. `present` holds the phone's own ids of the songs it has (null when the phone's library is not read yet: then no copy is taken for missing).
 * `choices` are the choices now; a kept song none of whose reasons is still chosen is "unchosen" (the person removed it), any other song the server no longer lists is "gone".
 */
export function planSync(wanted: Wanted, manifest: Manifest, present: Set<string> | null, choices: Choice[]): Plan {
  const keys = new Set(choices.map(choiceKey));
  const download: Plan["download"] = [];
  const update: Plan["update"] = [];
  let same = 0;
  let differs = 0;
  let bytes = 0;
  for (const { song, via } of wanted.values()) {
    const kept = manifest.files[song.id];
    if (!kept) {
      download.push({ song, via });
      bytes += song.size;
    } else if (present && (!kept.mediaId || !present.has(kept.mediaId))) {
      update.push({ song, via, old: kept, why: "missing", inPlace: false });
      bytes += song.size;
    } else if (kept.hold) {
      differs += 1; // the person's own version stays until they choose the server's
    } else if (changedOnServer(kept, song)) {
      update.push({ song, via, old: kept, why: "edited", inPlace: kept.adopted === true });
      bytes += song.size;
    } else same += 1;
  }
  const remove: KeptFile[] = [];
  let gone: KeptFile[] = [];
  for (const file of Object.values(manifest.files)) {
    if (wanted.has(file.id)) continue;
    if (file.via.every((key) => !keys.has(key))) remove.push(file);
    else gone.push(file);
  }
  let heldBack = 0;
  if (gone.length > goneLimit(Object.keys(manifest.files).length)) {
    heldBack = gone.length;
    gone = [];
  }
  return { download, update, remove, gone, heldBack, same, bytes, differs };
}

/** Marks every song that differs from the server's copy as wanted from the server (the next round fetches them); answers how many. */
export function useServerVersions(manifest: Manifest): number {
  let n = 0;
  for (const file of Object.values(manifest.files)) {
    if (file.hold) {
      delete file.hold;
      n += 1;
    }
  }
  return n;
}

export type SyncIo = {
  /** The songs of one choice, as the server lists them now. A throw stops the round before anything is taken off the phone. */
  fetchSongs: (choice: Choice) => Promise<SyncSong[]>;
  manifest: Manifest;
  saveManifest: (manifest: Manifest) => void;
  /** The phone's own ids of the songs on it now, or null when not known. */
  present: () => Set<string> | null;
  /** Fetches a song into `path` (replacing the phone's copy `replace`, when there is one; `inPlace`: writing over that copy, keeping its id) and answers the copy's id. */
  download: (song: SyncSong, path: string, replace: string | null, inPlace: boolean) => Promise<{ mediaId: string; bytes: number }>;
  /** Songs on the server that the phone may already have: answers the ones recognised (see adopt.ts), each marked exact or differing. Optional. */
  adopt?: (songs: SyncSong[]) => Promise<Array<{ song: SyncSong; local: { id: string; folder: string; file: string; size: number }; level: "exact" | "differs" }>>;
  /** Asks Android's permission to update these songs in place; answers the ids that may be. Optional (without it nothing is updated in place). */
  grantWrite?: (mediaIds: string[]) => Promise<Set<string>>;
  /** Takes songs off the phone; answers the ids that were taken off. */
  removeLocal: (mediaIds: string[]) => Promise<string[]>;
  progress: (text: string) => void;
  cancelled: () => boolean;
  now: () => number;
};

export type SyncOutcome = { downloaded: number; updated: number; removed: number; adopted: number; differs: number; forgotten: number; heldBack: number; failed: string[]; bytes: number; kept: number; cancelled: boolean; /** The phone's own ids of songs that were fetched again: old id to new id (a favorite, a flag or a playlist entry follows). */ moved: Record<string, string> };

const CONSECUTIVE_FAILURES = 3;

/** One round: reads what the server has for each choice, recognises songs already on the phone, works out the plan, then fetches and removes. The record is saved after every song, so an interrupted round loses nothing. */
export async function runHomeSync(choices: Choice[], io: SyncIo): Promise<SyncOutcome> {
  const manifest = io.manifest;
  const empty = (cancelled: boolean): SyncOutcome => ({ downloaded: 0, updated: 0, removed: 0, adopted: 0, differs: 0, forgotten: 0, heldBack: 0, failed: [], bytes: 0, kept: Object.keys(manifest.files).length, cancelled, moved: {} });
  const results: Array<{ choice: Choice; songs: SyncSong[] }> = [];
  for (const [n, choice] of choices.entries()) {
    io.progress(`Reading the server (${n + 1} of ${choices.length}): ${choiceLabel(choice)}`);
    results.push({ choice, songs: await io.fetchSongs(choice) });
    if (io.cancelled()) return empty(true);
  }
  const wanted = wantedFrom(results);
  // Songs the phone already has (copied over by cable, say) are recognised and marked as kept, instead of being fetched again.
  let adopted = 0;
  if (io.adopt) {
    const unkept = [...wanted.values()].filter((w) => !manifest.files[w.song.id]).map((w) => w.song);
    if (unkept.length) {
      io.progress("Looking for songs already on the phone…");
      for (const found of await io.adopt(unkept)) {
        const entry = wanted.get(found.song.id);
        if (!entry) continue;
        manifest.files[found.song.id] = {
          id: found.song.id,
          mediaId: found.local.id,
          path: `${found.local.folder}${found.local.file}`,
          size: found.local.size,
          etag: found.level === "exact" ? found.song.etag : null,
          at: io.now(),
          via: entry.via,
          title: found.song.title,
          artist: found.song.artist,
          album: found.song.album,
          ...(isOwn(found.local.folder) ? {} : { adopted: true }),
          ...(found.level === "differs" ? { hold: true } : {}),
        };
        adopted += 1;
      }
      if (adopted) io.saveManifest(manifest);
    }
  }
  const plan = planSync(wanted, manifest, io.present(), choices);
  const paths = uniquePaths(
    [...plan.download.map((d) => d.song), ...plan.update.map((u) => u.song)],
    new Set(Object.values(manifest.files).filter((f) => !f.adopted && !plan.update.some((u) => u.old.id === f.id)).map((f) => f.path)),
  );
  const outcome: SyncOutcome = { ...empty(false), kept: 0, heldBack: plan.heldBack, adopted, differs: plan.differs };
  const jobs = [
    ...plan.download.map((d) => ({ song: d.song, via: d.via, old: null as KeptFile | null, inPlace: false })),
    ...plan.update.map((u) => ({ song: u.song, via: u.via, old: u.old as KeptFile | null, inPlace: u.inPlace })),
  ];
  // Songs updated where they are need Android's permission, asked once for all of them.
  let writable = new Set<string>();
  const wantWrite = jobs.filter((j) => j.inPlace && j.old?.mediaId).map((j) => j.old!.mediaId!);
  if (wantWrite.length && io.grantWrite) {
    io.progress(`Asking Android for permission to update ${wantWrite.length} song${wantWrite.length === 1 ? "" : "s"} on the phone…`);
    writable = await io.grantWrite(wantWrite);
  }
  let failures = 0;
  let refused = 0;
  for (const [n, job] of jobs.entries()) {
    if (io.cancelled()) {
      outcome.cancelled = true;
      break;
    }
    if (job.inPlace && !(job.old?.mediaId && writable.has(job.old.mediaId))) {
      refused += 1;
      continue;
    }
    io.progress(`Downloading ${n + 1} of ${jobs.length}: ${job.song.title}`);
    try {
      const path = job.old && !job.old.adopted ? job.old.path : (paths.get(job.song.id) ?? relativePath(job.song));
      const done = await io.download(job.song, path, job.old?.mediaId ?? null, job.inPlace);
      manifest.files[job.song.id] = { ...(job.inPlace && job.old ? job.old : {}), id: job.song.id, mediaId: done.mediaId, path: job.inPlace && job.old ? job.old.path : path, size: done.bytes || job.song.size, etag: job.song.etag, at: io.now(), via: job.via, title: job.song.title, artist: job.song.artist, album: job.song.album };
      if (!job.inPlace) {
        delete manifest.files[job.song.id]!.adopted; // a copy the program fetched itself is its own
        delete manifest.files[job.song.id]!.hold;
      }
      io.saveManifest(manifest);
      outcome.bytes += done.bytes;
      if (job.old) {
        outcome.updated += 1;
        if (job.old.mediaId && job.old.mediaId !== done.mediaId) outcome.moved[job.old.mediaId] = done.mediaId;
      } else outcome.downloaded += 1;
      failures = 0;
    } catch (thrown) {
      outcome.failed.push(`${job.song.title}: ${thrown instanceof Error ? thrown.message : "not downloaded"}`);
      failures += 1;
      if (failures >= CONSECUTIVE_FAILURES) {
        outcome.failed.push("Stopped after several failures in a row (the server may be away).");
        break;
      }
    }
  }
  if (refused) outcome.failed.push(`${refused} song${refused === 1 ? "" : "s"} on the phone could not be updated because Android did not give permission (they keep their old version; try again and allow it).`);
  // Songs whose choice is still there but whose reasons changed keep their record up to date.
  for (const { song, via } of wanted.values()) {
    const kept = manifest.files[song.id];
    if (kept && kept.via.join("|") !== via.join("|")) kept.via = via;
  }
  // Only when the whole round was read from the server, and not stopped: take off what is no longer wanted. A song that was already on the phone is only forgotten: its file is left alone.
  if (!outcome.cancelled) {
    const taking = [...plan.remove, ...plan.gone];
    const ids = taking.flatMap((f) => (f.mediaId && !f.adopted ? [f.mediaId] : []));
    const taken = new Set(ids.length ? await io.removeLocal(ids) : []);
    for (const file of taking) {
      if (file.adopted) {
        delete manifest.files[file.id];
        outcome.forgotten += 1;
      } else if (!file.mediaId || taken.has(file.mediaId)) {
        delete manifest.files[file.id];
        outcome.removed += 1;
      } else outcome.failed.push(`${file.title}: could not be taken off the phone`);
    }
  }
  io.saveManifest(manifest);
  outcome.kept = Object.keys(manifest.files).length;
  return outcome;
}

const isOwn = (folder: string): boolean => folder.replace(/\\/g, "/").startsWith("Music/MediaVerse Home/");
/** "3 songs, 12.4 MB" style size text. */
export function sizeText(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The sentence after a round. */
export function describeOutcome(outcome: SyncOutcome): string {
  const parts: string[] = [];
  if (outcome.adopted) parts.push(`${outcome.adopted} song${outcome.adopted === 1 ? "" : "s"} already on the phone recognised and kept as they are`);
  if (outcome.downloaded) parts.push(`${outcome.downloaded} song${outcome.downloaded === 1 ? "" : "s"} downloaded (${sizeText(outcome.bytes)})`);
  if (outcome.updated) parts.push(`${outcome.updated} updated from the server`);
  if (outcome.removed) parts.push(`${outcome.removed} taken off the phone`);
  if (outcome.forgotten) parts.push(`${outcome.forgotten} you already had are no longer kept in step (their files are left alone)`);
  if (outcome.differs) parts.push(`${outcome.differs} on the phone differ from the server's copy and were left as they are`);
  if (outcome.heldBack) parts.push(`${outcome.heldBack} songs the server no longer lists were kept on the phone (that many at once looks like a fault; check the server)`);
  if (outcome.failed.length) parts.push(`${outcome.failed.length} problem${outcome.failed.length === 1 ? "" : "s"}: ${outcome.failed[0]}`);
  const head = outcome.cancelled ? "Stopped. " : "";
  return `${head}${parts.length ? parts.join("; ") : "Everything chosen is already on the phone."}.`.replace(/\.\.$/, ".");
}
