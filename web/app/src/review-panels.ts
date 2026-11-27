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
import { nativeCopy, prepareImage } from "./image-prep";
import { initArtworkFill, pictureFaults, problemList, runPictureRun } from "./artwork-fill-panel";
import type { FillProblem } from "./artwork-fill";
import { describeEnd, history, modeButtons, onRunChange, runView, runningTitle, startRun, undoBar } from "./run-controller";
import type { RunMode } from "./timed-run";
import { ART_NAMES, type AlbumPlan, type ArtworkPlan, type FolderArt, PICTURE_KIND, type PngFolder, albumsLackingFront, planArtwork, planResize, pngFolderPictures, songsToWrite } from "./artwork-plan";
import { type FileResult, type PictureKindName, picturesRequest } from "./media-request";
import {
  type AlbumGap,
  type DefectResult,
  type MediaChange,
  type GapFile,
  type GapTrack,
  albumsWithLowCover,
  albumsWithoutLyrics,
  checkProblem,
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
  /** Review > Artists' free artist photos, shown with the artwork too. */
  artistPhotos?: { element: HTMLElement; show: () => void; redraw: () => void };
};

const playable = (t: GapTrack): PlayableTrack => ({ title: t.title, artist: t.artist, source_uri: t.source_uri, album: t.album });

export function initReviewPanels(
  roots: { artwork: HTMLElement; lyrics: HTMLElement; defects: HTMLElement },
  deps: ReviewPanelDeps,
): { showArtwork: () => void; showLyrics: () => void; showDefects: () => void; invalidate: () => void; openLyricsEditor: (track: PlayableTrack) => void; mediaSaved: (saved: { paths: string[] } & MediaChange) => void } {
  let files: GapFile[] | null = null;
  /** Each album folder's picture files, from the same check. */
  let folderArt: Record<string, FolderArt> = {};
  let scanning = false;

  async function loadGaps(root: HTMLElement, rerender: () => void): Promise<void> {
    if (files !== null || scanning) return;
    scanning = true;
    const checking = createProgress("Checking your library");
    root.replaceChildren(checking.element);
    try {
      const reply = await runJob<{ files: GapFile[]; folders?: Record<string, FolderArt> }>("library_gaps", {}, (p) => {
        const { done, total } = progressCounts(p);
        checking.set(done, total);
      });
      checking.stop();
      folderArt = reply.folders ?? {};
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

  /** Shows why there is nothing to report, in place of the page, when the check could not compare any song. */
  function nothingChecked(root: HTMLElement, rerender: () => void): boolean {
    const problem = checkProblem(files ?? [], deps.libraryTracks());
    if (!problem) return false;
    root.replaceChildren(el("p", "result-warning", problem), rescanButton(root, rerender));
    return true;
  }

  /** Pictures were saved: the changed songs are read again behind the page, which then shows what is really in them. */
  let rechecking = false;
  let recheckAgain = false;
  async function recheckArtwork(): Promise<void> {
    if (rechecking) {
      recheckAgain = true;
      return;
    }
    rechecking = true;
    redrawArtwork();
    try {
      do {
        recheckAgain = false;
        const reply = await runJob<{ files: GapFile[]; folders?: Record<string, FolderArt> }>("library_gaps", {});
        folderArt = reply.folders ?? {};
        files = reply.files;
      } while (recheckAgain);
    } catch {
      files = null; // the next visit checks again
    }
    rechecking = false;
    redrawArtwork();
  }
  const redrawArtwork = (): void => {
    const root = roots.artwork;
    if (root.isConnected && !root.closest("[hidden]")) renderArtwork(root);
  };
  const fill = initArtworkFill({
    beforePictureEdit: (paths) => deps.beforePictureEdit(paths),
    redraw: () => redrawArtwork(),
    changed: () => {
      deps.picturesChanged();
      redrawArtwork();
    },
  });
  const artworkPlan = () => planArtwork(files ?? [], deps.libraryTracks(), folderArt, fill.picks());

  // ---- Artwork: songs without their pictures, a low-resolution cover, or pictures too large inside the songs ----
  type ArtView = "missing" | "low" | "large";
  let artView: ArtView = "missing";
  let fixNote = "";
  const LOW_KEY = "mediaverse.low-res-threshold";
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

  // ---- Oversized images: every picture inside a song that breaks the rules, and PNG picture files in album folders ----
  let oversizedProblems: FillProblem[] = [];
  let oversizedShown = 100;

  function fixPictures(albums: AlbumPlan[], mode: RunMode): void {
    fixNote = "";
    oversizedProblems = [];
    runPictureRun(albums, mode, { title: "Fixing oversized pictures", history: "Oversized pictures fixed", question: "Store the pictures properly in" }, deps.beforePictureEdit, (note, problems) => {
      fixNote = note;
      oversizedProblems = problems;
      deps.picturesChanged();
      redrawArtwork();
    });
  }

  /** Saves each folder's picture as a full-size JPEG; the PNG (and any file it replaces) is moved aside, with Undo. */
  function convertFolderPictures(list: PngFolder[], mode: RunMode): void {
    if (!window.confirm(`Save the pictures of ${list.length} album folder${list.length === 1 ? "" : "s"} as JPEG, at their full size?\n\nThe PNG files are moved into the program's data folder, not deleted. You can undo this.`)) return;
    const id = `jpg-${Date.now()}`;
    let done = 0;
    const problems: FillProblem[] = [];
    fixNote = "";
    oversizedProblems = [];
    void startRun({
      title: "Saving folder pictures as JPEG",
      unit: "folders",
      mode,
      items: list.map((item, index) => ({ item, batch: `${id}-${index}` })),
      label: ({ item }) => item.folder,
      step: async ({ item, batch }) => {
        try {
          const picture = await invoke<{ mime: string; data_base64: string }>("art_source", { kind: item.kind, path: item.path, file: item.file });
          const full = await nativeCopy(blobFromBase64(picture.data_base64, picture.mime));
          history.add(id, "Folder pictures saved as JPEG", batch);
          const reply = await invoke<{ folder: { ok: boolean; error?: string }[] }>("update_track_media", picturesRequest([item.path], [], [{ kind: PICTURE_KIND[item.kind], base64: full.base64 }], batch));
          const failed = reply.folder.find((f) => !f.ok);
          if (failed) throw new Error(failed.error ?? "it failed");
          done += 1;
          return "ok";
        } catch (thrown) {
          problems.push({ path: `${item.folder}/${item.file}`, message: describeError(toApiError(thrown)) });
          return "failed";
        }
      },
    }).then((report) => {
      if (!report) return;
      fixNote = `${done} folder picture${done === 1 ? "" : "s"} saved as JPEG. ${describeEnd(report, `${report.left} folders`)}`;
      oversizedProblems = problems;
      deps.picturesChanged();
      redrawArtwork();
    });
  }

  function renderOversized(root: HTMLElement, albums: AlbumPlan[], pngs: PngFolder[]): void {
    root.append(el("p", undefined, "Every picture inside a song is to be a JPEG of at most 1000 × 1000 pixels and under 500 KB. Fixing stores each one that way, in the songs that have it; a larger original is kept at full size, as a JPEG, in the album folder."));
    if (fixNote) root.append(el("p", "field-hint", fixNote));
    if (oversizedProblems.length) root.append(problemList(oversizedProblems));
    if (rechecking) {
      root.append(el("p", "field-hint", "Checking the changed songs…"));
      return;
    }
    const others = (files ?? []).filter((f) => f.embed_issues?.some((i) => i.kind === "other")).length;
    if (others) root.append(el("p", "result-warning", `${others} songs also carry another kind of picture (a leaflet or disc scan, say) that breaks these limits; this does not change those.`));
    root.append(el("h3", undefined, `Pictures inside the songs (${albums.length} album${albums.length === 1 ? "" : "s"})`));
    if (albums.length === 0) root.append(el("p", undefined, "None: every front cover, rear cover and artist photo inside the songs is a JPEG within the limits."));
    else {
      root.append(modeButtons(`Fix ${albums.length} album${albums.length === 1 ? "" : "s"} (${songsToWrite(albums).toLocaleString("en-US")} songs):`, (mode) => fixPictures(albums, mode)));
      const table = el("table", "gap-table");
      const head = el("tr");
      for (const label of ["Album", "Album artist", "Songs", "What is wrong", ""]) head.append(el("th", label === "Songs" ? "num" : undefined, label));
      const thead = el("thead");
      thead.append(head);
      const body = el("tbody");
      for (const album of albums.slice(0, oversizedShown)) {
        const row = el("tr");
        const what = el("td");
        // Pictures that read the same (an album with a slightly different one on every song) are one line.
        const faults = new Map<string, number>();
        for (const { kind, target, paths } of album.kinds) {
          const text = `${ART_NAMES[kind]} ${target.width} × ${target.height}, ${target.bytes ? `${Math.round(target.bytes / 1024).toLocaleString("en-US")} KB, ` : ""}${pictureFaults(target)}`;
          faults.set(text, (faults.get(text) ?? 0) + paths.length);
        }
        for (const [text, count] of faults) what.append(el("div", undefined, `${text} (${count} song${count === 1 ? "" : "s"})`));
        const actions = el("span", "row-actions");
        const one = button("Fix", () => fixPictures([album], "all"));
        one.disabled = runningTitle() !== null;
        actions.append(one);
        if (album.kinds.some((k) => Math.min(k.target.width, k.target.height) < 500)) actions.append(button("Find a better cover", () => deps.openAlbumPictures(album.gap)));
        const cell = el("td");
        cell.append(actions);
        row.append(el("td", undefined, album.gap.album), el("td", undefined, album.gap.artist), el("td", "num", String(songsToWrite([album]))), what, cell);
        body.append(row);
      }
      table.append(thead, body);
      root.append(table);
      if (albums.length > oversizedShown) root.append(button(`Show more (${albums.length - oversizedShown} not shown)`, () => ((oversizedShown += 100), redrawArtwork())));
    }
    root.append(el("h3", undefined, `PNG picture files in album folders (${pngs.length})`));
    if (pngs.length === 0) root.append(el("p", undefined, "None: the folder pictures are JPEG."));
    else {
      root.append(el("p", "field-hint", "Saved again as JPEG at the same size, for players that only read JPEG and to take less room."), modeButtons(`Save ${pngs.length} as JPEG:`, (mode) => convertFolderPictures(pngs, mode)));
      const list = el("ul", "ft-problems art-problems");
      for (const p of pngs) list.append(el("li", undefined, `${p.folder.split(/[\\/]/).slice(-2).join("\\")} (${ART_NAMES[p.kind].toLowerCase()})`));
      root.append(list);
    }
  }
  // ---- Automatic covers (owner, 2026-11-05): in the background, however slowly it has to go, take the cover
  // database's 100% matches: first for albums with no cover anywhere, then for low-resolution ones (only when the found
  // cover is bigger), then rear covers for albums with none. Albums that already have a picture in the library are
  // completed from it above, never from the internet. Each album is looked up once (remembered for 30 days); every
  // change is journalled for an undo. ----
  type Wanted = "front" | "replace" | "back";
  const TRIED_KEY = "mediaverse.auto-covers-tried";
  const RETRY_AFTER_MS = 30 * 24 * 3600 * 1000;
  /** Unattended, how long to leave MusicBrainz alone when it is refusing, and how often before giving up. */
  const REFUSED_WAIT_MS = 15 * 60 * 1000;
  const REFUSED_WAITS = 8;
  let autoNote = "";
  let autoFailed: string[] = [];  const triedMap = (): Record<string, number> => {
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
  type Art = { mime: string; data_base64: string; width: number; height: number };
  /** One album: a 100% match's covers, saved; returns what happened, for the note. */
  async function autoAlbum(gap: AlbumGap, wanted: Wanted, runId: string, batch: string): Promise<"added" | "none" | "busy"> {
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
      if (wanted === "replace" && gap.coverSize && Math.min(full.width, full.height) <= Math.min(...gap.coverSize)) return "none";
      if (wanted === "back" && !full.back) continue;
      const pictures: { kind: PictureKindName; base64: string }[] = [];
      const folder: { kind: PictureKindName; base64: string }[] = [];
      const add = async (kind: PictureKindName, art: Art): Promise<void> => {
        const picture = blobFromBase64(art.data_base64, art.mime);
        pictures.push({ kind, base64: (await prepareImage(picture)).base64 });
        folder.push({ kind, base64: (await nativeCopy(picture)).base64 });
      };
      if (wanted !== "back") await add("front_cover", full);
      // The back cover too when the songs have none yet.
      if (full.back) {
        const have = await invoke<Record<string, unknown>>("album_pictures", { paths }).catch(() => null);
        if (have && !have.back_cover) await add("back_cover", full.back);
      }
      if (pictures.length === 0) return "none";
      deps.beforePictureEdit(paths);
      history.add(runId, "Automatic covers", batch);
      const result = await invoke<{ results: FileResult[] }>("update_track_media", picturesRequest(paths, pictures, folder, batch));
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length) autoFailed.push(`${gap.album}: ${failed.length} of ${paths.length} songs could not be written (${failed[0].error ?? "it failed"})`);
      return failed.length < paths.length ? "added" : "none";
    }
    return "none";
  }

  const triedKey = (gap: AlbumGap, wanted: Wanted): string => (wanted === "back" ? `back|${gap.folder}|${gap.album}` : gap.folder);
  /** The albums still to be looked up online. */
  function autoQueue(plan: ArtworkPlan): [AlbumGap, Wanted][] {
    const tried = triedMap();
    return (
      [
        ...plan.none.front.map((g) => [g, "front"]),
        ...albumsWithLowCover(files ?? [], deps.libraryTracks(), lowThreshold).map((g) => [g, "replace"]),
        ...plan.none.back.map((g) => [g, "back"]),
      ] as [AlbumGap, Wanted][]
    ).filter(([g, wanted]) => Date.now() - (tried[triedKey(g, wanted)] ?? 0) > RETRY_AFTER_MS);
  }

  function runAuto(queue: [AlbumGap, Wanted][], mode: RunMode): void {
    const id = `auto-${Date.now()}`;
    let added = 0;
    let busy = 0;
    let busyInARow = 0;
    let waits = 0;
    autoNote = "";
    autoFailed = [];
    void startRun({
      title: "Automatic covers",
      unit: "albums",
      mode,
      items: queue.map(([gap, wanted], index) => ({ gap, wanted, batch: `${id}-${index}` })),
      label: ({ gap }) => `${gap.album} — ${gap.albumArtist ?? gap.artist}`,
      step: async ({ gap, wanted, batch }, tools) => {
        let outcome: "added" | "none" | "busy" = "busy";
        // The service busy or not answering: wait a minute and ask once more; still busy, the album is left for
        // another time (not remembered as looked up).
        for (let attempt = 0; attempt < 2 && outcome === "busy" && !tools.stopped(); attempt++) {
          if (attempt > 0) await tools.wait(60_000, "The cover database is busy.");
          if (tools.stopped()) break;
          try {
            outcome = await autoAlbum(gap, wanted, id, batch);
          } catch {
            outcome = "busy";
          }
        }
        if (outcome === "busy") {
          if (tools.stopped()) return "failed";
          busy += 1;
          busyInARow += 1;
          // Refused three albums running: MusicBrainz is limiting this program. Unattended, it is left alone for a
          // while and asked again; otherwise the run ends and says so.
          if (busyInARow >= 3) {
            if (mode !== "all" || waits >= REFUSED_WAITS) return "halt";
            waits += 1;
            busyInARow = 0;
            await tools.wait(REFUSED_WAIT_MS, "MusicBrainz is not answering this program just now.");
          }
          return "ok";
        }
        busyInARow = 0;
        markTried(triedKey(gap, wanted));
        if (outcome === "added") added += 1;
        await pause(1500); // politely slow
        return "ok";
      },
    }).then((report) => {
      if (!report) return;
      const refused = report.reason === "halted" ? " MusicBrainz is not answering this program just now (it limits programs that ask a lot); try again in an hour or so." : "";
      autoNote = `${added} ${added === 1 ? "album" : "albums"} got covers. ${describeEnd(report, `${report.left} albums`)}${refused}${busy ? ` ${busy} could not be checked because the cover database was busy.` : ""}`;
      if (added) deps.picturesChanged();
      redrawArtwork();
    });
  }

  function autoBox(plan: ArtworkPlan): HTMLElement {
    const box = el("div", "auto-covers");
    const queue = autoQueue(plan);
    box.append(el("h3", undefined, "Automatic covers (online)"), el("p", "field-hint", "For albums with no picture anywhere in your library: looks up missing front covers first, then bigger ones for low-resolution covers, then missing rear covers. It takes only the cover database's 100% matches and asks slowly; each album is looked up once."));
    if (rechecking) box.append(el("p", "field-hint", "Checking the changed songs…"));
    else if (queue.length) box.append(modeButtons(`${queue.length.toLocaleString("en-US")} albums to look up:`, (mode) => runAuto(queue, mode)));
    else box.append(el("p", "field-hint", "Nothing left to look up."));
    if (autoNote) box.append(el("p", "field-hint", autoNote));
    for (const failure of autoFailed.slice(-20)) box.append(el("p", "result-warning", failure));
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
    if (files === null || nothingChecked(root, () => renderArtwork(root))) return;
    const tracks = deps.libraryTracks();
    const plan = artworkPlan();
    const low = albumsWithLowCover(files, tracks, lowThreshold);
    const resize = planResize(files, tracks, folderArt);
    const pngs = pngFolderPictures(files, folderArt);
    root.replaceChildren();
    const chips = el("div", "view-links");
    for (const [view, label] of [["missing", `In every song (${albumsLackingFront(plan)} to do)`], ["low", `Low resolution (${low.length})`], ["large", `Oversized images (${resize.length + pngs.length})`]] as const) {
      const chip = button(label, () => {
        artView = view;
        renderArtwork(root);
      }, artView === view ? "view-link is-active" : "view-link");
      chip.setAttribute("aria-pressed", String(artView === view));
      chips.append(chip);
    }
    chips.append(rescanButton(root, () => renderArtwork(root)));
    root.append(chips, runView(), undoBar((run) => {
      // Covers taken out again may be looked up again.
      if (run.label === "Automatic covers") store(TRIED_KEY, null);
      deps.picturesChanged();
    }));

    if (artView === "missing") {
      root.insertBefore(el("p", undefined, albumsLackingFront(plan) === 0 && plan.choices.length === 0 ? "Every MP3 has a front cover inside it." : "Every song should carry its album's front cover inside it, with the rear cover and artist photo where there is one. A picture file in the folder does not count."), chips.nextSibling);
      root.append(fill.render(plan, rechecking), autoBox(plan));
      const missing = plan.none.front;
      root.append(el("h3", undefined, `No front cover anywhere (${missing.length})`));
      if (missing.length) root.append(gapTable(missing, [["Year", true, (g) => (g.year ? String(g.year) : "—")], ["Tracks", true, (g) => String(g.total ?? g.tracks.length)]], openButton("Add artwork")));
      root.append(el("p", "field-hint", `No rear cover anywhere: ${plan.none.back.length} albums. No artist photo anywhere: ${plan.none.artist.length} albums (look for free photos below).`));
      if (deps.artistPhotos) root.append(deps.artistPhotos.element);
      return;
    }
    if (artView === "low") {
      root.append(autoBox(plan));
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
    renderOversized(root, resize, pngs);
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
    if (files !== null && nothingChecked(root, () => renderLyrics(root))) return;
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

  // When any long job ends, wherever it was started, the songs are checked again before anything else is offered.
  onRunChange(() => {
    if (!runningTitle() && files !== null) void recheckArtwork();
    else redrawArtwork();
    deps.artistPhotos?.redraw();
  });

  return {
    showArtwork: () => {
      deps.artistPhotos?.show();
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
      if (saved.frontCover !== undefined || saved.fixedKinds?.length) void recheckArtwork();
      for (const [root, kind] of [[roots.artwork, "artwork"], [roots.lyrics, "lyrics"]] as const) {
        if (root.isConnected && !root.closest("[hidden]") && root.childElementCount > 0) renderGaps(root, kind);
      }
    },
  };
}
