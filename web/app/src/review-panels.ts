// The Review page's Missing artwork, Missing lyrics and Audio defects sections. Each reads from the library
// (what the page already knows) plus the sidecar's gap scan and stored defect scan results. All text is set with
// textContent; nothing from files is inserted as HTML.

import { runJob } from "./jobs";
import { createProgress, progressCounts } from "./progress-bar";
import { describeFinding, describeCounts, groupFindings, isSilentScan } from "./defect-format";
import type { PlaylistStore } from "./playlists";
import { RERIP_PLAYLIST, discsOf, reripReason, silentSongs } from "./rerip-list";
import { el } from "./dom";
import { describeError, toApiError } from "./drive-format";
import type { PlayableTrack } from "./play-queue";
import { invoke, listen } from "./desktop-bridge";
import { blobFromBase64 } from "./cover-util";
import { type LyricsReviewDeps, initLyricsReview } from "./lyrics-review";
import { askAgain, sureInstrumental } from "./lyrics-instrumental";
import { lyricAiBox } from "./lyric-ai-panel";
import { lyricTimeBox } from "./lyric-time-panel";
import { lyricWrongBox } from "./lyric-wrong-panel";
import { lyricPhotosBox } from "./lyric-photos-panel";
import { infoButton, type InfoBlock } from "./info-popup";
import { imageSize, nativeCopy, prepareImage } from "./image-prep";
import { type FileResult, PICTURE_LIMITS, type PictureKindName, picturesRequest, wantsFolderCopy } from "./media-request";
import {
  type AlbumGap,
  type DefectResult,
  type EmbedIssue,
  type MediaChange,
  type GapFile,
  type GapTrack,
  OVERSIZED_GROUPS,
  type OversizedGroup,
  oversizedGroup,
  albumsWithLargeEmbedded,
  albumsWithLowCover,
  albumsWithoutCover,
  albumsWithoutLyrics,
  markSaved,
} from "./review-data";

export type ReviewPanelDeps = {
  libraryTracks: () => GapTrack[];
  openAlbumPictures: (album: AlbumGap) => void;
  play: (tracks: PlayableTrack[], index: number) => void;
  /** Plays a short sample around a defect (the person's chosen length, defect at the midpoint). */
  listenToDefect: (tracks: PlayableTrack[], index: number, defectMs: number) => void;
  scanTracks: (tracks: PlayableTrack[]) => void;
  /** Before pictures are written: stops the songs if they are playing. */
  beforePictureEdit: (paths: string[]) => void;
  /** After pictures were written by the artwork tools: covers and the library are read again. */
  picturesChanged: () => void;
  /** The player, for Lyrics › To review (playing a song while its lyrics are checked and timed). */
  lyricsPlayer: Omit<LyricsReviewDeps, "beforeEdit" | "saved">;
  /** Lyrics were saved into a song from the review list. */
  lyricsSaved: (path: string) => void;
  /** Titles were written into songs (track numbers taken off): the library is read again. */
  titlesChanged: (message: string) => void;
  /** The playlists, for the "Needs re-ripping" list made from songs with no sound. */
  playlists: PlaylistStore;
};

const playable = (t: GapTrack): PlayableTrack => ({ title: t.title, artist: t.artist, source_uri: t.source_uri, album: t.album });

export function initReviewPanels(
  roots: { artwork: HTMLElement; lyrics: HTMLElement; defects: HTMLElement },
  deps: ReviewPanelDeps,
): { showArtwork: () => void; showLyrics: () => void; showDefects: () => void; invalidate: () => void; openLyricsEditor: (track: PlayableTrack) => void; mediaSaved: (saved: { paths: string[] } & MediaChange) => void } {
  let files: GapFile[] | null = null;
  let scanning = false;

  async function loadGaps(root: HTMLElement, rerender: () => void): Promise<void> {
    if (files !== null || scanning) return;
    scanning = true;
    const checking = createProgress("Checking your library");
    root.replaceChildren(checking.element);
    try {
      const reply = await runJob<{ files: GapFile[] }>("library_gaps", {}, (p) => {
        const { done, total } = progressCounts(p);
        checking.set(done, total);
      });
      checking.stop();
      files = reply.files;
    } catch (thrown) {
      checking.stop();
      root.replaceChildren(el("p", "result-warning", describeError(toApiError(thrown))));
      scanning = false;
      return;
    }
    scanning = false;
    rerender();
  }

  const rescanButton = (root: HTMLElement, rerender: () => void): HTMLElement => {
    const button = el("button", "secondary", "Check the library again");
    button.type = "button";
    button.addEventListener("click", () => {
      files = null;
      void loadGaps(root, rerender);
    });
    return button;
  };

  // ---- Artwork: albums with no cover, a low-resolution cover, or pictures too large inside the songs ----
  type ArtView = "missing" | "low" | "large";
  let artView: ArtView = "missing";
  let fixing: { done: number; total: number; stop: boolean } | null = null;
  let fixNote = "";
  const LOW_KEY = "mediaverse.low-res-threshold";
  const UNDO_KEY = "mediaverse.last-picture-fix";
  const GROUP_TITLES: Record<OversizedGroup, string> = { resize: "Need resizing: over 1000 × 1000 pixels", over500: "Large JPEGs: 500 KB or more", png: "PNG pictures: convert to JPEG", over200: "Too much data: 200 to 500 KB" };
  const GROUP_HINTS: Record<OversizedGroup, string> = {
    resize: "Shrunk to fit 1000 × 1000 inside the songs; the full size is kept in the album folder.",
    over500: "Stored again as JPEG at the same size, at the best quality that fits.",
    png: "Converted to JPEG at the same size (smaller files that every player shows), each or all at once; or find a better cover for an album.",
    over200: "Within the 500 KB limit but over the ideal 200 KB. Fixing only helps when it can get smaller without visible loss; you can ignore these.",
  };
  const stored = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (key: string, value: string | null): void => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // a convenience only
    }
  };
  /** Owner, 2026-11-05: replace artwork under 500 × 500, or standardise on 1000 × 1000. */
  let lowThreshold = stored(LOW_KEY) === "1000" ? 1000 : 500;

  const KIND_NAMES: Record<string, string> = { front_cover: "Front cover", back_cover: "Back cover", artist_photo: "Artist photo", other: "Other picture" };
  const describeIssue = (i: EmbedIssue): string => `${KIND_NAMES[i.kind] ?? i.kind} ${i.width} × ${i.height}${i.png ? " · PNG" : ""} · ${i.kb >= 1024 ? `${(i.kb / 1024).toFixed(1)} MB` : `${i.kb} KB`}`;

  function gapTable(gaps: AlbumGap[], columns: [string, boolean, (gap: AlbumGap) => string][], action: (gap: AlbumGap) => HTMLElement): HTMLElement {
    const table = el("table", "gap-table");
    const head = el("tr");
    for (const [label, numeric] of [["Album", false], ["Album artist", false], ...columns.map(([l, n]) => [l, n] as const), ["", false]] as const) {
      head.append(el("th", numeric ? "num" : undefined, label));
    }
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    for (const gap of gaps) {
      const row = el("tr");
      row.append(el("td", undefined, gap.album), el("td", undefined, gap.albumArtist ?? gap.artist));
      for (const [, numeric, value] of columns) row.append(el("td", numeric ? "num" : undefined, value(gap)));
      const cell = el("td");
      cell.append(action(gap));
      row.append(cell);
      body.append(row);
    }
    table.append(thead, body);
    return table;
  }

  const button = (label: string, run: () => void, kind = "secondary"): HTMLButtonElement => {
    const b = el("button", kind, label);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  };
  const openButton = (label: string) => (gap: AlbumGap): HTMLElement =>
    gap.mp3Paths.length > 0 || (gap.albumMp3Paths?.length ?? 0) > 0 ? button(label, () => deps.openAlbumPictures(gap)) : el("span", "field-hint", "Not MP3: put a cover.jpg in the folder");

  /**
   * Brings one album's pictures within the embedding rules: each picture that is over 1000 pixels, a PNG or 500 KB
   * or more is stored again in the songs as a JPEG of at most 1000 × 1000 (owner, 2026-11-05), and its full size is
   * kept in the album folder when the folder has no picture of that kind at least as large. Journalled as `batch`.
   */
  async function fixAlbum(gap: AlbumGap, batch: string): Promise<string | null> {
    const paths = gap.albumMp3Paths ?? gap.mp3Paths;
    const kinds = [...new Set((gap.issues ?? []).map((i) => i.kind))].filter((k): k is PictureKindName => k !== "other");
    if (paths.length === 0 || kinds.length === 0) return "nothing to fix here";
    const reply = await invoke<{ folder?: Record<PictureKindName, { width: number; height: number } | null> } & Record<PictureKindName, { mime: string; data_base64: string; from: string } | null>>("album_pictures", { paths });
    const pictures: { kind: PictureKindName; base64: string }[] = [];
    const folder: { kind: PictureKindName; base64: string }[] = [];
    for (const kind of kinds) {
      const picture = reply[kind];
      if (!picture || picture.from !== "embedded") continue;
      const original = blobFromBase64(picture.data_base64, picture.mime);
      const size = await imageSize(original);
      const prepared = await prepareImage(original);
      // A JPEG already within 1000 pixels that would not get smaller is left as it is (no quality lost for nothing).
      if (picture.mime === "image/jpeg" && Math.max(size.width, size.height) <= PICTURE_LIMITS.maxSide && prepared.bytes >= original.size) {
        URL.revokeObjectURL(prepared.previewUrl);
        continue;
      }
      URL.revokeObjectURL(prepared.previewUrl);
      pictures.push({ kind, base64: prepared.base64 });
      if (wantsFolderCopy("embedded", Math.min(size.width, size.height), reply.folder?.[kind] ?? null)) folder.push({ kind, base64: (await nativeCopy(original)).base64 });
    }
    if (pictures.length === 0) return "already as small as it can be at good quality, so it was left as it is";
    deps.beforePictureEdit(paths);
    const result = await invoke<{ results: FileResult[]; folder?: { ok: boolean; error?: string }[] }>("update_track_media", picturesRequest(paths, pictures, folder, batch));
    const failed = result.results.find((r) => !r.ok) ?? result.folder?.find((f) => !f.ok);
    if (failed) return failed.error ?? "it failed";
    files = markSaved(files ?? [], paths, { fixedKinds: pictures.map((p) => p.kind) });
    return null;
  }

  async function fixAll(gaps: AlbumGap[], root: HTMLElement): Promise<void> {
    if (!window.confirm(`Store the pictures of ${gaps.length} album${gaps.length === 1 ? "" : "s"} again at most 1000 × 1000 pixels as JPEG?\n\nThe full-size pictures are kept in the album folders. You can undo this afterwards.`)) return;
    const batch = `fix-${Date.now()}`;
    fixing = { done: 0, total: gaps.length, stop: false };
    const problems: string[] = [];
    renderArtwork(root);
    for (const gap of gaps) {
      if (fixing.stop) break;
      try {
        const problem = await fixAlbum(gap, batch);
        if (problem) problems.push(`${gap.album}: ${problem}`);
      } catch (thrown) {
        problems.push(`${gap.album}: ${describeError(toApiError(thrown))}`);
      }
      fixing.done += 1;
      renderArtwork(root);
    }
    const done = fixing.done;
    fixing = null;
    store(UNDO_KEY, batch);
    fixNote = `${done - problems.length} of ${gaps.length} albums fixed.${problems.length ? ` Problems: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "…" : ""}` : ""}`;
    deps.picturesChanged();
    renderArtwork(root);
  }

  async function undoLastFix(root: HTMLElement): Promise<void> {
    const batch = stored(UNDO_KEY);
    if (!batch || !window.confirm("Put back the pictures as they were before the last fix?")) return;
    try {
      const reply = await invoke<{ songs: number; folder_files: number; problems: { path: string; message: string }[] }>("undo_picture_batch", { batch });
      store(UNDO_KEY, null);
      fixNote = `Undone: ${reply.songs} songs have their old pictures back${reply.problems.length ? `; ${reply.problems.length} problems, the first: ${reply.problems[0].message}` : ""}.`;
    } catch (thrown) {
      fixNote = describeError(toApiError(thrown));
    }
    deps.picturesChanged();
    files = null;
    void loadGaps(root, () => renderArtwork(root));
  }

  // ---- Automatic covers (owner, 2026-11-05): in the background, however slowly it has to go, take the cover
  // database's 100% matches: first for albums with no cover, then for low-resolution ones (only when the found cover
  // is bigger). Each album is looked up once (remembered for 30 days); every change is journalled for an undo. ----
  const TRIED_KEY = "mediaverse.auto-covers-tried";
  const AUTO_BATCH_KEY = "mediaverse.auto-covers-batch";
  const RETRY_AFTER_MS = 30 * 24 * 3600 * 1000;
  type AutoState = { stoppedBusy?: boolean; running: boolean; stop: boolean; checked: number; total: number; added: number; busy: number; current: string; note: string };
  const auto: AutoState = { running: false, stop: false, checked: 0, total: 0, added: 0, busy: 0, current: "", note: "" };
  const triedMap = (): Record<string, number> => {
    try {
      return JSON.parse(stored(TRIED_KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  };
  const markTried = (folder: string): void => {
    const map = triedMap();
    map[folder] = Date.now();
    store(TRIED_KEY, JSON.stringify(map));
  };
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  let autoRoot: HTMLElement | null = null;
  const autoRefresh = (): void => {
    if (autoRoot && autoRoot.isConnected && !autoRoot.closest("[hidden]")) renderArtwork(autoRoot);
  };

  type Art = { mime: string; data_base64: string; width: number; height: number };
  /** One album: a 100% match's covers, saved; returns what happened, for the note. */
  async function autoAlbum(gap: AlbumGap, batch: string, replacing: boolean): Promise<"added" | "none" | "busy"> {
    const paths = gap.albumMp3Paths ?? gap.mp3Paths;
    if (paths.length === 0 || /^unknown album$/i.test(gap.album)) return "none";
    const found = await runJob<{ candidates: { release_id: string; release_group_id?: string; image_url?: string; match: number }[]; sure_match: number; problems: { source: string; message: string }[] }>("find_album_art", {
      artist: gap.albumArtist ?? gap.artist,
      album: gap.album,
      year: gap.year ?? undefined,
      tracks: gap.total,
      paths,
      previews: false,
    });
    const sure = found.candidates.filter((c) => c.match >= (found.sure_match ?? 95)).slice(0, 2);
    if (sure.length === 0) return found.problems.length > 0 ? "busy" : "none";
    for (const candidate of sure) {
      let full: Art & { back?: Art | null };
      try {
        full = await runJob<Art & { back?: Art | null }>("fetch_album_art", { release_id: candidate.release_id, release_group_id: candidate.release_group_id, image_url: candidate.image_url });
      } catch {
        continue; // no usable cover for this release: try the next sure match
      }
      // A low-resolution cover is replaced only by a bigger one.
      if (replacing && gap.coverSize && Math.min(full.width, full.height) <= Math.min(...gap.coverSize)) return "none";
      const front = blobFromBase64(full.data_base64, full.mime);
      const pictures: { kind: PictureKindName; base64: string }[] = [{ kind: "front_cover", base64: (await prepareImage(front)).base64 }];
      const folder: { kind: PictureKindName; base64: string }[] = [{ kind: "front_cover", base64: (await nativeCopy(front)).base64 }];
      // The back cover too when the songs have none yet.
      if (full.back) {
        const have = await invoke<Record<string, unknown>>("album_pictures", { paths }).catch(() => null);
        if (have && !have.back_cover) {
          const back = blobFromBase64(full.back.data_base64, full.back.mime);
          pictures.push({ kind: "back_cover", base64: (await prepareImage(back)).base64 });
          folder.push({ kind: "back_cover", base64: (await nativeCopy(back)).base64 });
        }
      }
      deps.beforePictureEdit(paths);
      const result = await invoke<{ results: FileResult[] }>("update_track_media", picturesRequest(paths, pictures, folder, batch));
      if (result.results.some((r) => !r.ok)) return "none";
      files = markSaved(files ?? [], paths, { frontCover: true, coverSize: [full.width, full.height], fixedKinds: pictures.map((p) => p.kind) });
      return "added";
    }
    return "none";
  }

  async function runAuto(): Promise<void> {
    if (auto.running || files === null) return;
    const tracks = deps.libraryTracks();
    const tried = triedMap();
    const fresh = (gap: AlbumGap): boolean => Date.now() - (tried[gap.folder] ?? 0) > RETRY_AFTER_MS;
    const queue: [AlbumGap, boolean][] = [
      ...albumsWithoutCover(files, tracks).filter(fresh).map((g) => [g, false] as [AlbumGap, boolean]),
      ...albumsWithLowCover(files, tracks, lowThreshold).filter(fresh).map((g) => [g, true] as [AlbumGap, boolean]),
    ];
    const batch = `auto-${Date.now()}`;
    let busyInARow = 0;
    Object.assign(auto, { stoppedBusy: false });
    Object.assign(auto, { running: true, stop: false, checked: 0, total: queue.length, added: 0, busy: 0, current: "", note: "" });
    store(AUTO_BATCH_KEY, batch);
    autoRefresh();
    for (const [gap, replacing] of queue) {
      if (auto.stop) break;
      auto.current = `${gap.album} — ${gap.albumArtist ?? gap.artist}`;
      autoRefresh();
      let outcome: "added" | "none" | "busy" = "busy";
      // The service busy or not answering: wait a minute and ask once more; still busy, the album is left for
      // another time (not remembered as looked up).
      for (let attempt = 0; attempt < 2 && outcome === "busy" && !auto.stop; attempt++) {
        if (attempt > 0) {
          auto.note = "The cover database is busy; waiting a minute before asking again.";
          autoRefresh();
          await pause(60_000);
          auto.note = "";
        }
        try {
          outcome = await autoAlbum(gap, batch, replacing);
        } catch {
          outcome = "busy";
        }
      }
      if (outcome === "busy") {
        auto.busy += 1;
        busyInARow += 1;
        // Still refused after three albums: MusicBrainz is limiting this program for now; stop rather than ask
        // over and over, and say so.
        if (busyInARow >= 3) {
          auto.stop = true;
          auto.stoppedBusy = true;
        }
      } else {
        busyInARow = 0;
        markTried(gap.folder);
      }
      if (outcome === "added") {
        auto.added += 1;
        deps.picturesChanged();
      }
      auto.checked += 1;
      autoRefresh();
      await pause(1500); // politely slow
    }
    auto.running = false;
    auto.current = "";
    const later = auto.busy > 0 ? ` ${auto.busy} could not be checked because the cover database was busy; Start again later to try them.` : "";
    auto.note = auto.stoppedBusy
      ? `Paused: MusicBrainz is not answering this program just now (it limits programs that ask a lot). ${auto.added} covers added so far. Start again in an hour or so; albums already looked up are skipped.`
      : (auto.stop ? `Stopped. ${auto.added} covers added so far.` : `Done: ${auto.checked} albums checked, ${auto.added} covers added.`) + later;
    autoRefresh();
  }

  async function undoAuto(root: HTMLElement): Promise<void> {
    const batch = stored(AUTO_BATCH_KEY);
    if (!batch || auto.running || !window.confirm("Remove the covers the automatic search added, and put back what was there before?")) return;
    try {
      const reply = await invoke<{ songs: number; problems: { message: string }[] }>("undo_picture_batch", { batch });
      store(AUTO_BATCH_KEY, null);
      store(TRIED_KEY, null);
      auto.note = `Undone: ${reply.songs} songs are as they were${reply.problems.length ? `; ${reply.problems.length} problems, the first: ${reply.problems[0].message}` : ""}.`;
    } catch (thrown) {
      auto.note = describeError(toApiError(thrown));
    }
    deps.picturesChanged();
    files = null;
    void loadGaps(root, () => renderArtwork(root));
  }

  function autoBox(root: HTMLElement): HTMLElement {
    autoRoot = root;
    const box = el("div", "auto-covers");
    const line = el("div", "row-actions");
    line.append(el("strong", undefined, "Automatic covers"));
    if (auto.running) {
      line.append(el("span", undefined, `${auto.checked} of ${auto.total} albums checked · ${auto.added} covers added${auto.current ? ` · now: ${auto.current}` : ""}`));
      line.append(button("Stop", () => (auto.stop = true)));
    } else {
      line.append(button("Start", () => void runAuto(), ""));
      if (stored(AUTO_BATCH_KEY)) line.append(button("Undo the automatic covers", () => void undoAuto(root)));
    }
    box.append(line, el("p", "field-hint", "Looks up missing covers first, then low-resolution ones, and takes only the cover database's 100% matches (a low-resolution cover only for a bigger one). It runs in the background, slowly, while the program is open; each album is looked up once."));
    if (auto.note) box.append(el("p", "field-hint", auto.note));
    return box;
  }

  // ---- Automatic lyrics (docs/lyrics-plan.md): in the background, LRCLIB's sure answers for songs without lyrics:
  // its exact match, or the artist's own version of the same length. Other versions and other artists are left for
  // the person (Find lyrics). Each song is asked about once (30 days); everything is journalled for an undo. ----
  const LYRICS_TRIED_KEY = "mediaverse.auto-lyrics-tried";
  const LYRICS_BATCH_KEY = "mediaverse.auto-lyrics-batch";
  // Songs looked up before likely matches were kept for review (owner, 2026-11-06) had those matches thrown away:
  // they are asked about once more, after the songs never asked about.
  const REVIEW_SINCE_KEY = "mediaverse.auto-lyrics-review-since";
  const reviewSince = ((): number => {
    const known = Number(stored(REVIEW_SINCE_KEY));
    if (Number.isFinite(known) && known > 0) return known;
    const now = Date.now();
    store(REVIEW_SINCE_KEY, String(now));
    return now;
  })();
  // The lookup learned to read "instrumental" answers and to ask again without a track number in front of the title
  // (owner, 2026-11-16). Songs asked about before that are asked once more, after the others.
  const LOOKUP_REV_KEY = "mediaverse.auto-lyrics-rev-since";
  const lookupRevSince = ((): number => {
    const known = Number(stored(LOOKUP_REV_KEY));
    if (Number.isFinite(known) && known > 0) return known;
    const now = Date.now();
    store(LOOKUP_REV_KEY, String(now));
    return now;
  })();
  /** Lookups made before this moment did not know the song's length from the library (2026-11-17, D120). */
  const LENGTH_REVISION = Date.UTC(2026, 10, 17, 12, 0, 0);
  const lyricsAuto = { running: false, stop: false, checked: 0, total: 0, added: 0, review: 0, instrumental: 0, current: "", note: "" };
  let lyricsRoot: HTMLElement | null = null;
  let lyricsView: "review" | "instrumental" = "review";
  // Songs LRCLIB says have no words: not "missing" (kept by the sidecar; one press puts a song back).
  type InstrumentalItem = { path: string; source: string; marked: number };
  let instrumentalItems: InstrumentalItem[] | null = null;
  let instrumental = new Set<string>();
  // Songs someone confirmed as instrumental (language tag "zxx"): off the list, still not counted as missing lyrics.
  let instrumentalConfirmed: InstrumentalItem[] = [];
  let showConfirmedInstrumental = false;
  /** The instrumental lists changed outside this page: read them again when next shown. */
  const instrumentalConfirmedStale = (): void => {
    instrumentalItems = null;
  };
  async function loadInstrumental(): Promise<void> {
    try {
      const reply = await invoke<{ items: InstrumentalItem[]; confirmed?: InstrumentalItem[] }>("list_lyrics_instrumental");
      instrumentalItems = reply.items;
      instrumentalConfirmed = reply.confirmed ?? [];
      instrumental = new Set([...instrumentalItems, ...instrumentalConfirmed].map((i) => i.path));
    } catch {
      instrumentalItems ??= [];
    }
  }
  let generalCount: number | null = null;
  let reviewCount: number | null = null;
  const lyricsReview = initLyricsReview({
    ...deps.lyricsPlayer,
    beforeEdit: (paths) => deps.beforePictureEdit(paths),
    saved: (path) => {
      files = markSaved(files ?? [], [path], { lyrics: true });
      deps.lyricsSaved(path);
    },
  });
  // The Lyric AI works through the songs: the list under the steps follows it (every few seconds, and never while a song is open for review).
  let liveRefresh: number | null = null;
  listen<{ kind?: string }>("job-progress", (event) => {
    if (event.payload.kind !== "lyric_ai_result") return;
    lyricsReview.invalidate();
    if (liveRefresh !== null) return;
    liveRefresh = window.setTimeout(() => {
      liveRefresh = null;
      if (lyricsView === "review" && lyricsRoot?.isConnected && !lyricsRoot.closest("[hidden]")) lyricsReview.refreshIfIdle();
    }, 8000);
  }).catch(() => undefined);
  /** Progress of the automatic lyrics: only the Step 1 card changes, so a song being reviewed stays open and nothing else flickers. */
  const lyricsRefresh = (): void => {
    if (!lyricsRoot || !lyricsRoot.isConnected || lyricsRoot.closest("[hidden]")) return;
    const card = lyricsRoot.querySelector(".lyrics-step-1");
    if (card) card.replaceWith(lyricsBox(lyricsRoot));
  };
  const lyricsTried = (): Record<string, number> => {
    try {
      return JSON.parse(stored(LYRICS_TRIED_KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  };

  type Found = { via: "exact" | "search" | "other_artists"; results: { synced: string | null; plain: string | null; instrumental?: boolean; other_version?: boolean; other_artist?: boolean; length_unknown?: boolean; confidence?: number }[] };
  /** The lyrics to take without asking: an exact match, or the artist's own version of the same length. */
  function sureLyrics(found: Found): string | null {
    const best = found.results[0];
    if (!best || found.via === "other_artists" || best.other_version || best.other_artist || (found.via === "search" && best.length_unknown)) return null;
    return best.synced?.trim() || best.plain?.trim() || null;
  }

  async function runAutoLyrics(): Promise<void> {
    if (lyricsAuto.running || files === null) return;
    await loadInstrumental();
    await lyricsReview.refreshCount().catch(() => 0);
    const inReview = lyricsReview.best();
    const tried = lyricsTried();
    const candidates = albumsWithoutLyrics(files, deps.libraryTracks(), instrumental)
      .flatMap((gap) => gap.tracks)
      .filter((t) => /\.mp3$/i.test(t.source_uri) && t.title && t.artist);
    const when = (t: GapTrack): number => tried[t.source_uri] ?? 0;
    const recent = (t: GapTrack): boolean => Date.now() - when(t) <= RETRY_AFTER_MS;
    const songs = [
      ...candidates.filter((t) => !recent(t)),
      // Asked about before likely matches were kept: once more, last.
      ...candidates.filter((t) => recent(t) && when(t) < reviewSince),
      // Asked about before instrumentals and track numbers were understood (and holding no likely lyrics): once more.
      ...candidates.filter((t) => recent(t) && when(t) >= reviewSince && askAgain(tried[t.source_uri], lookupRevSince, inReview.has(t.source_uri))),
    ];
    // Asked about before the library's song lengths and the wider artist search were used (D120): once more, the
    // likely ones first (their length may now settle them), then the songs LRCLIB did not know.
    const queued = new Set(songs.map((t) => t.source_uri));
    const older = candidates.filter((t) => !queued.has(t.source_uri) && recent(t) && when(t) < LENGTH_REVISION);
    songs.push(...older.filter((t) => inReview.has(t.source_uri)), ...older.filter((t) => !inReview.has(t.source_uri)));
    const batch = `lyrics-${Date.now()}`;
    Object.assign(lyricsAuto, { running: true, stop: false, checked: 0, total: songs.length, added: 0, review: 0, instrumental: 0, current: "", note: "" });
    store(LYRICS_BATCH_KEY, batch);
    let busyInARow = 0;
    lyricsRefresh();
    for (const song of songs) {
      if (lyricsAuto.stop) break;
      lyricsAuto.current = `${song.title} — ${song.artist}`;
      lyricsRefresh();
      try {
        const found = await runJob<Found>("lookup_lyrics", { path: song.source_uri, title: song.title, artist: song.artist, album: song.album, length_ms: song.length_ms ?? undefined });
        busyInARow = 0;
        const text = sureLyrics(found);
        if (sureInstrumental(found)) {
          // The same recording has no words: out of the missing list, listed under Instrumental (nothing is written to the song).
          await invoke("mark_lyrics_instrumental", { path: song.source_uri, source: "LRCLIB" });
          instrumental.add(song.source_uri);
          instrumentalItems = null;
          lyricsAuto.instrumental += 1;
        } else if (text) {
          deps.beforePictureEdit([song.source_uri]);
          const reply = await invoke<{ results: FileResult[] }>("update_track_media", { paths: [song.source_uri], lyrics: { text }, batch });
          if (reply.results[0]?.ok) {
            lyricsAuto.added += 1;
            // Likely lyrics kept earlier for this song are settled now: out of To review.
            if (inReview.has(song.source_uri)) {
              await invoke("remove_lyrics_review", { path: song.source_uri }).catch(() => undefined);
              if (reviewCount !== null && reviewCount > 0) reviewCount -= 1;
            }
            files = markSaved(files ?? [], [song.source_uri], { lyrics: true });
          }
        } else if (found.results.some((r) => r.plain?.trim() || r.synced?.trim())) {
          // Likely, not sure (owner, 2026-11-06): kept as their own file for the person to play, time and confirm.
          const kept = await invoke<{ kept: number }>("save_lyrics_review", { path: song.source_uri, title: song.title, artist: song.artist, album: song.album, candidates: found.results }).catch(() => ({ kept: 0 }));
          if (kept.kept > 0) {
            lyricsReview.invalidate();
            lyricsAuto.review += 1;
            if (reviewCount !== null) reviewCount += 1;
          }
        }
        const map = lyricsTried();
        map[song.source_uri] = Date.now();
        store(LYRICS_TRIED_KEY, JSON.stringify(map));
      } catch (thrown) {
        const error = toApiError(thrown);
        if (error.code === "lookup_disabled") {
          lyricsAuto.note = describeError(error);
          break;
        }
        if (error.code === "missing_details") {
          // Not something LRCLIB can be asked about (Fix tags first); not a sign that it is busy.
          lyricsAuto.checked += 1;
          continue;
        }
        busyInARow += 1;
        if (busyInARow >= 3) {
          lyricsAuto.note = `Paused: LRCLIB is not answering just now (${describeError(error)}). Start again later; songs already looked up are skipped.`;
          break;
        }
        await pause(30_000);
      }
      lyricsAuto.checked += 1;
      lyricsRefresh();
      await pause(1000); // LRCLIB asks for a pause between requests
    }
    lyricsAuto.running = false;
    lyricsAuto.current = "";
    lyricsReview.invalidate();
    if (!lyricsAuto.note) lyricsAuto.note = `${lyricsAuto.stop ? "Stopped" : "Done"}: ${lyricsAuto.checked} songs looked up, lyrics added to ${lyricsAuto.added}, likely lyrics kept for ${lyricsAuto.review} to review${lyricsAuto.instrumental ? `, ${lyricsAuto.instrumental} found to be instrumental` : ""}.`;
    lyricsRefresh();
    // The list under the steps catches up now that the run is over.
    if (lyricsRoot?.isConnected && !lyricsRoot.closest("[hidden]")) renderGaps(lyricsRoot, "lyrics");
  }

  const STEP1_INFO: InfoBlock[] = [
    {
      heading: "What it does",
      paragraphs: ["Asks LRCLIB (a free community lyrics database) about each song that has no lyrics. It is quick and does not listen to anything, so run it first."],
    },
    {
      heading: "What happens to the answers",
      items: [
        "Sure answers (the exact recording, or the artist's own version of the same length) are written straight into the song, time-stamped when LRCLIB has times.",
        "Likely answers (a live version, another album, a cover's original) are kept in General review with a confidence score, for you to play, time and confirm. Step 3 can then check them by listening.",
        "A song LRCLIB lists as instrumental moves to Suspected instrumental. Nothing is written to it.",
        "A track number in front of a title (\"14 Donut Dan\") is left off for a second try, so those songs are found anyway.",
      ],
    },
    {
      heading: "Good to know",
      items: ["It runs in the background while the program is open.", "Each song is asked about once; stop and start again as you like.", "Nothing is replaced: songs that already have lyrics are left alone."],
    },
  ];

  // No "Undo the automatic lyrics" button (owner, 2026-11-06): one click could take lyrics out of thousands of
  // songs at once. The run's batch id is still stored and the change journal kept, so it stays recoverable.
  function lyricsBox(root: HTMLElement): HTMLElement {
    lyricsRoot = root;
    const box = el("div", "lyrics-step lyrics-step-1");
    const title = el("div", "lyrics-step-title");
    title.append(el("strong", undefined, "Step 1 · Automatic lyrics (quick online lookup)"), infoButton("Step 1 · Automatic lyrics", STEP1_INFO));
    const controls = el("div", "lyrics-step-controls");
    if (lyricsAuto.running) controls.append(button("Stop", () => (lyricsAuto.stop = true)));
    else controls.append(button("Start", () => void runAutoLyrics(), ""));
    box.append(title, controls);
    if (lyricsAuto.running) {
      box.append(el("p", undefined, `${lyricsAuto.checked} of ${lyricsAuto.total} songs looked up · lyrics added to ${lyricsAuto.added} · ${lyricsAuto.review} to review · ${lyricsAuto.instrumental} instrumental${lyricsAuto.current ? ` · now: ${lyricsAuto.current}` : ""}`));
    }
    if (lyricsAuto.note) box.append(el("p", "field-hint", lyricsAuto.note));
    return box;
  }
  function renderArtwork(root: HTMLElement): void {
    if (files === null) return;
    const tracks = deps.libraryTracks();
    const missing = albumsWithoutCover(files, tracks);
    const low = albumsWithLowCover(files, tracks, lowThreshold);
    const oversized = (): AlbumGap[] => albumsWithLargeEmbedded(files ?? [], tracks).filter((g) => oversizedGroup(g) !== "over200");
    const large = oversized();
    root.replaceChildren();
    const chips = el("div", "view-links");
    for (const [view, label] of [["missing", `Missing (${missing.length})`], ["low", `Low resolution (${low.length})`], ["large", `Oversized images (${large.length})`]] as const) {
      const chip = button(label, () => {
        artView = view;
        renderArtwork(root);
      }, artView === view ? "view-link is-active" : "view-link");
      chip.setAttribute("aria-pressed", String(artView === view));
      chips.append(chip);
    }
    chips.append(rescanButton(root, () => renderArtwork(root)));
    root.append(chips);
    if (artView !== "large") root.append(autoBox(root));

    if (artView === "missing") {
      root.append(el("p", undefined, missing.length === 0 ? "Every album has a cover." : "Albums with no cover picture, neither inside the songs nor as a cover file in the album folder."));
      if (missing.length) root.append(gapTable(missing, [["Year", true, (g) => (g.year ? String(g.year) : "—")], ["Tracks", true, (g) => String(g.total ?? g.tracks.length)]], openButton("Add artwork")));
      return;
    }
    if (artView === "low") {
      const line = el("p");
      line.append(`Albums whose best cover is smaller than `);
      const select = el("select");
      for (const value of [500, 1000]) {
        const option = el("option", undefined, `${value} × ${value}`);
        option.value = String(value);
        option.selected = value === lowThreshold;
        select.append(option);
      }
      select.setAttribute("aria-label", "Smallest cover size wanted");
      select.addEventListener("change", () => {
        lowThreshold = Number(select.value) === 1000 ? 1000 : 500;
        store(LOW_KEY, String(lowThreshold));
        renderArtwork(root);
      });
      line.append(select, ` pixels. Nothing is wrong with them; a bigger cover looks better on a large screen.`);
      root.append(line);
      if (low.length === 0) root.append(el("p", undefined, "None: every cover is at least that size."));
      else root.append(gapTable(low, [["Year", true, (g) => (g.year ? String(g.year) : "—")], ["Cover now", true, (g) => (g.coverSize ? `${g.coverSize[0]} × ${g.coverSize[1]}` : "—")]], openButton("Replace artwork")));
      return;
    }
    // Oversized images (owner, 2026-11-05): pictures that need resizing, PNG pictures (convert, or find a better
    // cover), and JPEGs of 500 KB or more. JPEGs of 200 to 500 KB are not listed (owner: "get rid of" that group).
    root.append(el("p", undefined, "Pictures inside the songs are best as JPEG, at most 1000 × 1000 pixels and ideally under 200 KB. Fixing stores them again that way, never smaller than they are; the full-size picture is kept in the album folder."));
    const tools = el("div", "row-actions");
    if (fixing) {
      const current = fixing;
      tools.append(el("span", undefined, `Fixing: ${current.done} of ${current.total} albums…`), button("Stop", () => (current.stop = true)));
    } else if (stored(UNDO_KEY)) {
      tools.append(button("Undo the last fix", () => void undoLastFix(root)));
    }
    root.append(tools);
    if (fixNote) root.append(el("p", "field-hint", fixNote));
    const shown = oversized();
    if (shown.length === 0) {
      root.append(el("p", undefined, "None: every picture inside the songs is within the limits."));
      return;
    }
    const fixOne = (gap: AlbumGap): void => {
      if (fixing) return;
      const batch = `fix-${Date.now()}`;
      fixAlbum(gap, batch)
        .then((problem) => {
          fixNote = problem ? `${gap.album}: ${problem}` : `${gap.album}: fixed.`;
          if (!problem) store(UNDO_KEY, batch);
          deps.picturesChanged();
          renderArtwork(root);
        })
        .catch((thrown) => {
          fixNote = `${gap.album}: ${describeError(toApiError(thrown))}`;
          renderArtwork(root);
        });
    };
    for (const group of OVERSIZED_GROUPS) {
      const gaps = shown.filter((g) => oversizedGroup(g) === group);
      if (gaps.length === 0) continue;
      const head = el("div", "gap-group-head");
      head.append(el("h3", undefined, `${GROUP_TITLES[group]} (${gaps.length})`));
      if (!fixing) head.append(button(group === "png" ? `Convert all ${gaps.length} to JPEG` : `Fix these ${gaps.length}`, () => void fixAll(gaps, root), ""));
      root.append(head, el("p", "field-hint", GROUP_HINTS[group]));
      root.append(
        gapTable(gaps, [["Pictures in the songs", false, (g) => (g.issues ?? []).map(describeIssue).join("; ")]], (gap) => {
          const cell = el("span", "row-actions");
          cell.append(button(group === "png" ? "Convert to JPEG" : "Fix", () => fixOne(gap)));
          // A PNG, or a small cover, may be better replaced than converted (owner, 2026-11-05).
          if (group === "png" || (gap.coverSize && Math.min(...gap.coverSize) < 500)) cell.append(button("Find a better cover", () => deps.openAlbumPictures(gap)));
          return cell;
        }),
      );
    }
  }
  function renderGaps(root: HTMLElement, kind: "artwork" | "lyrics"): void {
    if (files === null) return;
    if (kind === "artwork") {
      renderArtwork(root);
      return;
    }
    renderLyrics(root);
  }

  const PAGE_INFO: InfoBlock[] = [
    {
      heading: "The order to work in",
      items: [
        "Step 1 first: it is quick and finds most lyrics online without listening to anything.",
        "Step 2: photograph the lyric pages of a CD booklet; the program reads them and sends the words to Step 5.",
        "Step 3: the Lyric AI listens and picks the lyrics that really fit the singing (matching). Run it on the songs still missing lyrics, then on the suggestions waiting in General review.",
        "Step 4: the Lyric AI times words that are already settled (the band's own lyrics in the file, or ones you confirmed). It never changes the words and can be run again and again, also on songs that already have timing.",
        "Step 5: General review for what is left (approve what is right), and Suspected instrumental for songs with no singing.",
      ],
    },
    {
      heading: "General review",
      paragraphs: ["Every song that still needs lyrics, in one list: songs with suggested lyrics first (best first), then songs with nothing found yet. Review opens the song: pick a suggestion from the drop-down, play it, move lines earlier or later (or Tap to time them), then confirm to save it into the song. Find lyrics searches for other lyrics. Songs from a recognised cover album say \"Cover of …\"."],
    },
    {
      heading: "Suspected instrumental",
      paragraphs: ["Songs LRCLIB lists as instrumental, or where the Lyric AI heard no singing. Play one to check, then Confirm instrumental: that writes the language \"zxx\" (no linguistic content) into the song and takes it off the list; the genre is not touched. Not instrumental sends the song back to General review."],
    },
  ];

  /** The Lyrics page keeps its two steps in place; only the tabs and the list under them change (no flicker, and a run keeps going). */
  type LyricsFrame = { root: HTMLElement; tabs: HTMLElement; body: HTMLElement };
  let lyricsFrame: LyricsFrame | null = null;
  const currentGaps = (): AlbumGap[] => albumsWithoutLyrics(files ?? [], deps.libraryTracks(), instrumental);

  function lyricsFrameFor(root: HTMLElement): LyricsFrame {
    if (lyricsFrame && lyricsFrame.root === root && lyricsFrame.body.isConnected) return lyricsFrame;
    lyricsRoot = root;
    const steps = el("div", "lyrics-steps");
    const showSettings = (): void => {
      document.querySelector<HTMLButtonElement>("[data-page=settings]")?.click();
      document.querySelector<HTMLButtonElement>("[data-settings-section=lyrics]")?.click();
    };
    const showReview = (): void => {
      lyricsView = "review";
      lyricsReview.invalidate();
      renderGaps(root, "lyrics");
      // Step 5 is further down this same page: bring it into view (the button seemed to do nothing when the list was already showing).
      root.querySelector(".lyrics-step-four")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    // The order to work in (owner, 2026-11-20), one under the other: 1 the quick online lookup, 2 the booklet photos (D161), 3 the Lyric AI
    // (D130; with the check of lyrics the songs already have, D152, folded in below it), 4 timing (D169), 5 review and approve (the tabs and list under the steps).
    const aiWrong = el("details", "lyrics-step lyrics-substep");
    aiWrong.append(el("summary", undefined, "Also check the lyrics already in your songs (a different job: it listens to songs that have lyrics and lists those that do not fit)"));
    aiWrong.append(
      lyricWrongBox({
        songs: () => deps.libraryTracks().filter((t) => /\.mp3$/i.test(t.source_uri)).map((t) => ({ path: t.source_uri, title: t.title, artist: t.artist, album: t.album })),
        play: (path) => {
          const track = byPath().get(path);
          if (track) deps.play([playable(track)], 0);
        },
        showSettings,
        beforeEdit: (paths) => deps.beforePictureEdit(paths),
        saved: (path) => {
          files = markSaved(files ?? [], [path], { lyrics: false });
          instrumental.add(path); // not "missing lyrics": it was marked instrumental
          instrumentalConfirmedStale();
          deps.lyricsSaved(path);
        },
      }),
    );
    steps.append(
      lyricsBox(root),
      lyricPhotosBox({
        songs: () => deps.libraryTracks().filter((t) => /\.mp3$/i.test(t.source_uri)).map((t) => ({ path: t.source_uri, title: t.title, artist: t.artist, album: t.album, number: t.track_number ?? null })),
        showReview,
        showSettings,
      }),
      lyricAiBox({
        songs: (scope) => {
          const wanted = scope === "missing" ? currentGaps().flatMap((g) => g.tracks) : deps.libraryTracks();
          return wanted.filter((t) => /\.mp3$/i.test(t.source_uri)).map((t) => ({ path: t.source_uri, title: t.title }));
        },
        finished: () => {
          lyricsReview.invalidate();
          files = null;
          if (root.isConnected) void loadGaps(root, () => renderGaps(root, "lyrics"));
        },
        showReview,
        showSettings,
      }),
      lyricTimeBox({
        songs: () => deps.libraryTracks().filter((t) => /\.mp3$/i.test(t.source_uri)).map((t) => ({ path: t.source_uri, title: t.title })),
        playlists: async () => (await invoke<{ playlists: { id: string; name: string; paths: string[] }[] }>("list_playlists")).playlists ?? [],
        finished: () => {
          lyricsReview.invalidate();
          files = null;
          if (root.isConnected) void loadGaps(root, () => renderGaps(root, "lyrics"));
        },
        showReview,
        showSettings,
      }),
      aiWrong,
    );
    const stepFour = el("div", "lyrics-step-four");
    stepFour.append(el("h3", undefined, "Step 5 · Review and approve"), el("p", "field-hint", "Everything the steps above found and could not settle by themselves waits here. Play a song, check the words and their timing, and approve; nothing is written into a song until you do."));
    const tabs = el("div", "view-links");
    const body = el("div");    root.replaceChildren(steps, stepFour, tabs, body);
    lyricsFrame = { root, tabs, body };
    return lyricsFrame;
  }

  function renderLyrics(root: HTMLElement): void {
    if (instrumentalItems === null) {
      void loadInstrumental().then(() => {
        if (root.isConnected && !root.closest("[hidden]") && !lyricsAuto.running) renderLyrics(root);
      });
    }
    const frame = lyricsFrameFor(root);
    // Songs with no lyrics that can hold them (MP3), not instrumental: the rows with "no lyrics found yet" in General review.
    const missing = currentGaps()
      .flatMap((g) => g.tracks)
      .filter((t) => /\.mp3$/i.test(t.source_uri));
    const tabs: HTMLElement[] = [];
    for (const [view, label] of [
      ["review", `General review (${(generalCount ?? missing.length).toLocaleString()})`],
      ["instrumental", `Suspected instrumental (${instrumentalItems === null ? "…" : instrumentalItems.length})`],
    ] as const) {
      const chip = button(label, () => {
        lyricsView = view;
        renderLyrics(root);
      }, lyricsView === view ? "view-link is-active" : "view-link");
      chip.dataset.view = view;
      chip.setAttribute("aria-pressed", String(lyricsView === view));
      tabs.push(chip);
    }
    tabs.push(rescanButton(root, () => {
      lyricsReview.invalidate();
      renderLyrics(root);
    }), infoButton("the Lyrics page", PAGE_INFO));
    frame.tabs.replaceChildren(...tabs);
    frame.body.replaceChildren();
    if (lyricsView === "instrumental") {
      frame.body.append(instrumentalList(root));
      return;
    }
    const holder = el("div");
    frame.body.append(holder);
    const extra = missing.map((t) => ({ path: t.source_uri, title: t.title, artist: t.artist, album: t.album }));
    void lyricsReview.render(holder, (count) => {
      generalCount = count;
      const chip = frame.tabs.querySelector<HTMLElement>("[data-view=review]");
      if (chip) chip.textContent = `General review (${count.toLocaleString()})`;
    }, extra);
  }
  const byPath = (): Map<string, GapTrack> => new Map(deps.libraryTracks().map((t) => [t.source_uri, t]));

  /** Songs LRCLIB lists as instrumental: no words to find. One press puts a song back among the missing ones. */
  function instrumentalList(root: HTMLElement): HTMLElement {
    const holder = el("div");
    const inLibrary = (list: InstrumentalItem[]): InstrumentalItem[] => list.filter((i) => byPath().has(i.path));
    const confirmedItems = inLibrary(instrumentalConfirmed);
    const items = showConfirmedInstrumental ? confirmedItems : inLibrary(instrumentalItems ?? []);
    const redraw = async (): Promise<void> => {
      await loadInstrumental();
      renderGaps(root, "lyrics");
    };
    if (showConfirmedInstrumental) {
      holder.append(el("p", undefined, `${items.length} song${items.length === 1 ? "" : "s"} confirmed as instrumental: their language tag says "zxx" (no linguistic content), the genre was left as it was. "Not instrumental" puts the language tag back and lists the song as missing lyrics again.`));
    } else {
      holder.append(el("p", undefined, items.length === 0 ? "No song is waiting to be confirmed as instrumental. The automatic lyrics and the Lyric AI move a song here when LRCLIB says that recording has no words, or no singing is heard in it." : `${items.length} song${items.length === 1 ? "" : "s"} found to be instrumental (LRCLIB lists the recording, or the Lyric AI heard no singing). Play a song to check, then "Confirm instrumental": that writes the language "zxx" (no linguistic content) into the song, which other programs understand too, and takes it off this list. The genre is not touched.`));
      const fromLrclib = items.filter((i) => i.source === "LRCLIB");
      if (fromLrclib.length > 0) {
        holder.append(
          button(`Confirm the ${fromLrclib.length} that LRCLIB lists as instrumental`, () => {
            void invoke("confirm_lyrics_instrumental", { paths: fromLrclib.map((i) => i.path).slice(0, 2000) })
              .catch(() => undefined)
              .then(redraw);
          }),
        );
      }
    }
    if (confirmedItems.length > 0 || showConfirmedInstrumental) {
      const toggle = button(showConfirmedInstrumental ? "Back to the songs waiting" : `Show the ${confirmedItems.length} confirmed`, () => {
        showConfirmedInstrumental = !showConfirmedInstrumental;
        renderGaps(root, "lyrics");
      }, "secondary");
      holder.append(toggle);
    }
    if (items.length === 0) return holder;
    const library = byPath();
    const table = el("table", "gap-table lyrics-missing-table");
    const head = el("tr");
    for (const label of ["", "Song", "Artist", "Album", ""]) head.append(el("th", undefined, label));
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    for (const item of items.slice(0, 300)) {
      const track = library.get(item.path)!;
      const row = el("tr");
      // Play on the left so each song can be checked; "Not instrumental" on the far right, away from where the pointer travels to the next song.
      const playCell = el("td");
      const play = button("▶", () => deps.play([playable(track)], 0), "secondary");
      play.title = "Play this song";
      play.setAttribute("aria-label", `Play ${track.title || "this song"}`);
      playCell.append(play);
      const action = el("td");
      action.style.textAlign = "right";
      if (!showConfirmedInstrumental) {
        action.append(
          button("Confirm instrumental", () => {
            void invoke("confirm_lyrics_instrumental", { paths: [item.path] })
              .catch(() => undefined)
              .then(redraw);
          }),
          document.createTextNode(" "),
        );
      }
      action.append(
        button("Not instrumental", () => {
          void invoke("unmark_lyrics_instrumental", { path: item.path })
            .catch(() => undefined)
            .then(redraw);
        }, "secondary"),
      );
      row.append(playCell, el("td", undefined, track.title || "—"), el("td", undefined, track.artist ?? "—"), el("td", undefined, track.album ?? "—"), action);
      body.append(row);
    }
    table.append(thead, body);
    holder.append(table);
    if (items.length > 300) holder.append(el("p", "field-hint", `${items.length - 300} more not shown.`));
    return holder;
  }

  // ---- Audio defects: a library-wide scan that runs in the background and a paged list (ADR 0008) ----
  const PROBLEMS_PAGE = 50;
  let libraryJob: string | null = null;
  let progress = { done: 0, total: 0 };
  let shownProblems = PROBLEMS_PAGE;
  let defectsVisible = false;
  type ProblemPage = { total: number; offset: number; items: DefectResult[]; scanned: number; good: number };
  type ScanStatus = { running: boolean; job_id?: string; tracks_done?: number; tracks_total?: number };

  listen<{ job_id: string; kind: string; tracks_done?: number; tracks_total?: number }>("job-progress", (event) => {
    if (event.payload.kind !== "library_defects") return;
    libraryJob ??= event.payload.job_id;
    progress = { done: event.payload.tracks_done ?? 0, total: event.payload.tracks_total ?? 0 };
    const bar = roots.defects.querySelector<HTMLProgressElement>(".library-scan-progress");
    const note = roots.defects.querySelector<HTMLElement>(".library-scan-note");
    if (bar && note) {
      bar.max = Math.max(1, progress.total);
      bar.value = progress.done;
      note.textContent = `Scanning: ${progress.done} of ${progress.total} songs done.`;
    } else if (defectsVisible) void renderDefects();
  }).catch(() => {});
  listen<{ job_id: string; ok: boolean; result?: { stopped?: boolean; scanned?: number; remaining?: number }; error?: { code: string; message: string } }>("job-finished", (event) => {
    if (libraryJob === null || event.payload.job_id !== libraryJob) return;
    libraryJob = null;
    lastOutcome = event.payload.ok
      ? event.payload.result?.stopped
        ? `Stopped. ${event.payload.result.scanned ?? 0} songs were scanned and kept; Continue picks up the ${event.payload.result.remaining ?? 0} left.`
        : `Scan finished: ${event.payload.result?.scanned ?? 0} songs scanned.`
      : describeError(event.payload.error ?? { code: "error", message: "The scan stopped." });
    if (defectsVisible) void renderDefects();
  }).catch(() => {});
  let lastOutcome = "";

  const scannable = (t: GapTrack): boolean => /\.(mp3|flac|wav)$/i.test(t.source_uri);

  /** Every stored scan result with no sound at all (the list is read a page at a time; they are among the worst, but not necessarily on the first page). */
  async function allSilent(): Promise<DefectResult[]> {
    const found: DefectResult[] = [];
    try {
      for (let offset = 0; offset < 10_000; offset += 500) {
        const page = await invoke<ProblemPage>("list_defect_problems", { offset, limit: 500 });
        found.push(...silentSongs(page.items));
        if (page.items.length === 0 || offset + page.items.length >= page.total) break;
      }
    } catch {
      // the list below still shows what it can
    }
    return found;
  }

  /**
   * The re-rip list (D175): the playlist "Needs re-ripping" with the songs that have no sound, and their discs flagged for a re-rip (Review > Missing & copies >
   * To re-rip). A playlist is on the TVs and the phone too (the Jellyfin sync), and a song leaves it with one click once its disc is ripped again.
   */
  function reripCard(silent: DefectResult[], byPath: Map<string, GapTrack>): HTMLElement {
    const songs = silent.flatMap((r) => {
      const t = byPath.get(r.path);
      return t ? [{ path: r.path, title: t.title, album: t.album ?? null, artist: t.artist ?? null }] : [];
    });
    const discs = discsOf(songs);
    const card = el("section", "library-scan");
    card.append(
      el("h3", undefined, `No sound at all: ${songs.length} song${songs.length === 1 ? "" : "s"} on ${discs.length} disc${discs.length === 1 ? "" : "s"}`),
      el("p", "field-hint", "These songs are silent from start to end. That is usually an empty rip (a scratched disc or a failed read) that needs ripping again; a few albums have a silent track on purpose, so listen first and press Mark as good on those. The playlist can be played to hear what is wrong, shows on the TVs and the phone through Jellyfin, and a song comes out of it with one click once its disc has been ripped again."),
    );
    const note = el("p", undefined, "");
    const playlistButton = el("button", undefined, `Put them in the playlist “${RERIP_PLAYLIST}”`);
    playlistButton.type = "button";
    playlistButton.addEventListener("click", () => {
      playlistButton.disabled = true;
      const paths = songs.map((s) => s.path);
      const existing = deps.playlists.all().find((p) => p.name === RERIP_PLAYLIST);
      (existing ? deps.playlists.add(existing.id, paths) : deps.playlists.save({ name: RERIP_PLAYLIST, paths }).then((p) => p.paths.length))
        .then((n) => {
          note.className = "result-ok";
          note.textContent = existing ? `${n} song${n === 1 ? "" : "s"} added to “${RERIP_PLAYLIST}” (the others were already in it).` : `The playlist “${RERIP_PLAYLIST}” was made with ${n} song${n === 1 ? "" : "s"}.`;
        })
        .catch((thrown) => {
          note.className = "result-warning";
          note.textContent = describeError(toApiError(thrown));
        })
        .finally(() => (playlistButton.disabled = false));
    });
    const flagButton = el("button", "secondary", `Flag their ${discs.length} disc${discs.length === 1 ? "" : "s"} for a re-rip`);
    flagButton.type = "button";
    flagButton.addEventListener("click", () => {
      flagButton.disabled = true;
      Promise.all(discs.map((d) => invoke("flag_rerip", { path: d.folder, album: d.album, artist: d.artist, reason: reripReason(d.titles) })))
        .then(() => {
          note.className = "result-ok";
          note.textContent = `${discs.length} disc${discs.length === 1 ? "" : "s"} flagged: they are listed under Review > Missing & copies > To re-rip.`;
        })
        .catch((thrown) => {
          note.className = "result-warning";
          note.textContent = describeError(toApiError(thrown));
        })
        .finally(() => (flagButton.disabled = false));
    });
    const actions = el("div", "row-actions");
    actions.append(playlistButton, flagButton);
    card.append(actions, note);
    return card;
  }

  async function renderDefects(): Promise<void> {
    const root = roots.defects;
    if (root.childElementCount === 0) root.append(el("p", undefined, "Loading scan results…"));
    let page: ProblemPage;
    let status: ScanStatus;
    try {
      [page, status] = await Promise.all([invoke<ProblemPage>("list_defect_problems", { offset: 0, limit: shownProblems }), invoke<ScanStatus>("library_scan_status")]);
    } catch (thrown) {
      root.replaceChildren(el("p", "result-warning", describeError(toApiError(thrown))));
      return;
    }
    if (status.running && status.job_id) {
      libraryJob = status.job_id;
      progress = { done: status.tracks_done ?? 0, total: status.tracks_total ?? 0 };
    }
    const tracks = deps.libraryTracks();
    const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
    const songs = tracks.filter(scannable).length;
    const scanned = Math.min(page.scanned, songs);
    const parts: HTMLElement[] = [
      el("p", undefined, "Songs where a scan found clicks, dropouts, stuck sounds or no sound at all. A scan is an aid, not a verdict: use Listen to hear the place yourself, then Mark as good if it is fine."),
      el("p", undefined, `${scanned} of ${songs} songs scanned; ${page.total} worth a listen${page.good > 0 ? `; ${page.good} marked as good` : ""}.`),
    ];
    const card = el("section", "library-scan");
    if (libraryJob) {
      const bar = el("progress", "library-scan-progress");
      bar.max = Math.max(1, progress.total);
      bar.value = progress.done;
      const stop = el("button", "secondary", "Stop (keeps what is done)");
      stop.type = "button";
      stop.addEventListener("click", () => {
        stop.disabled = true;
        if (libraryJob) void invoke("cancel_job", { job_id: libraryJob }).catch(() => {});
      });
      card.append(el("p", "library-scan-note", progress.total > 0 ? `Scanning: ${progress.done} of ${progress.total} songs done.` : "Getting the scan ready…"), bar, stop);
      card.append(el("p", "field-hint", "The scan keeps running if you go to another page. Each song's result is saved as soon as it is ready."));
    } else {
      const start = el("button", undefined, scanned < songs ? `Scan the ${songs - scanned} song${songs - scanned === 1 ? "" : "s"} not scanned yet` : "Check for new or changed songs");
      start.type = "button";
      start.addEventListener("click", () => {
        start.disabled = true;
        lastOutcome = "";
        invoke<{ job_id: string }>("scan_library_defects")
          .then((started) => {
            libraryJob = started.job_id;
            progress = { done: 0, total: 0 };
            void renderDefects();
          })
          .catch((thrown) => {
            start.disabled = false;
            card.append(el("p", "result-warning", describeError(toApiError(thrown))));
          });
      });
      if (lastOutcome) card.append(el("p", "result-ok", lastOutcome));
      card.append(start, el("p", "field-hint", "Runs in the background on a few processor cores. You can stop it at any time and continue later, also after closing the program."));
    }
    parts.push(card);
    const silent = await allSilent();
    if (silent.length > 0) parts.push(reripCard(silent, byPath));
    for (const result of page.items) {
      const track = byPath.get(result.path);
      if (!track) continue;
      const item = el("article", "review-card");
      item.append(el("h3", undefined, `${track.title} — ${track.artist ?? "Unknown artist"}`));
      item.append(
        el(
          "p",
          result.report.verdict === "suspect" ? "result-warning" : undefined,
          isSilentScan(result.report as never)
            ? "No sound at all: this song is silent from start to end (an empty rip, unless it is a silent track on purpose)."
            : `${result.report.verdict === "suspect" ? "Likely audible problems" : "A few things that may or may not be audible"} (${describeCounts(result.report.counts as never)}).`,
        ),
      );
      const list = el("ul", "scan-findings");
      for (const finding of groupFindings(result.report.findings.filter((f) => f.kind !== "clipping") as never).slice(0, 12)) {
        const row = el("li", undefined, `${describeFinding(finding)} `);
        const play = el("button", "secondary", "▶ Listen");
        play.type = "button";
        play.addEventListener("click", () => deps.listenToDefect([playable(track)], 0, finding.time_ms));
        row.append(play);
        list.append(row);
      }
      item.append(list);
      const markGood = el("button", "secondary", "✓ Mark as good");
      markGood.type = "button";
      markGood.addEventListener("click", () => {
        markGood.disabled = true;
        invoke("set_defect_reviewed", { path: track.source_uri, good: true })
          .then(() => void renderDefects())
          .catch((thrown) => {
            markGood.disabled = false;
            item.append(el("p", "result-warning", describeError(toApiError(thrown))));
          });
      });
      const actions = el("div", "row-actions");
      actions.append(markGood);
      item.append(actions);
      parts.push(item);
    }
    if (page.total > page.items.length) {
      const more = el("button", "secondary", `Show ${Math.min(PROBLEMS_PAGE, page.total - page.items.length)} more (${page.total - page.items.length} left)`);
      more.type = "button";
      more.addEventListener("click", () => {
        shownProblems += PROBLEMS_PAGE;
        void renderDefects();
      });
      parts.push(more);
    }
    root.replaceChildren(...parts);
  }

  return {
    showArtwork: () => {
      if (files === null) void loadGaps(roots.artwork, () => renderGaps(roots.artwork, "artwork"));
      else renderGaps(roots.artwork, "artwork");
    },
    showLyrics: () => {
      if (files === null) void loadGaps(roots.lyrics, () => renderGaps(roots.lyrics, "lyrics"));
      else renderGaps(roots.lyrics, "lyrics");
    },
    showDefects: () => {
      defectsVisible = true;
      void renderDefects();
    },
    /** Forget the gap scan so the next visit looks again. */
    invalidate: () => {
      files = null;
    },
    /** Pictures or lyrics were saved: the lists change at once, without reading the library again. */
    openLyricsEditor: (track) => lyricsReview.openSong(track),
    mediaSaved: (saved: { paths: string[] } & MediaChange) => {
      if (files === null) return;
      files = markSaved(files, saved.paths, saved);
      for (const [root, kind] of [[roots.artwork, "artwork"], [roots.lyrics, "lyrics"]] as const) {
        if (root.isConnected && !root.closest("[hidden]") && root.childElementCount > 0) renderGaps(root, kind);
      }
    },
  };
}
