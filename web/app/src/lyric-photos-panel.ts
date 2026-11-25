// Review > Lyrics > "Add lyrics from booklet photos" (owner, 2026-11-20): photos of a CD booklet's lyric pages are read on this computer, split
// into one panel per song, matched to the album's songs by their titles, and the words are sent to To review, where each song is played,
// corrected and confirmed like any other doubtful lyrics. Nothing is written into a song here. Text is set with textContent.

import { choosePictures, invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { type EditorSong, lineCount, openLyricEditor } from "./lyric-editor-dialog";
import { type InfoBlock, infoButton } from "./info-popup";
import {
  type Assignment,
  type PhotoAlbum,
  type PhotoSong,
  type ReadResult,
  albumsOf,
  assign,
  findAlbums,
  initialAssignment,
  megabytes,
  panelLabel,
  panelPicture,
  reviewEntry,
  stepText,
  tidyWords,
  turned,
  unusedPanels,
} from "./lyric-photos-format";

export type LyricPhotosDeps = {
  /** Every song in the library that lyrics can be saved into. */
  songs: () => PhotoSong[];
  /** Opens Review > Lyrics > To review. */
  showReview: () => void;
  /** The Lyric AI settings (ONNX Runtime is set up there). */
  showSettings: () => void;
};

type VisionStatus = { supported: boolean; installed: boolean; folder: string; download_mb: number; full_mb: number; update: boolean; model_ready: boolean; licence: string; source: string; runtime_source: string };
type Status = { installed: boolean; folder: string; missing: string[]; download_mb: number; licence: string; source: string; runtime_ready: boolean; vision: VisionStatus };

const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const fileName = (path: string): string => path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);

export const PHOTOS_INFO: InfoBlock[] = [
  {
    heading: "What it does",
    paragraphs: [
      "You photograph the lyric pages of a CD booklet (one page, or several pages at once; they do not need to be cropped) and the program reads the words on this computer. Each song's page is found by its heading, matched to the album's songs, and the words are sent to Review > Lyrics > To review.",
      "Nothing is saved into a song from here. In To review you play the song, check and correct the words, time the lines, and confirm.",
    ],
  },
  {
    heading: "Good to know",
    items: [
      "The reading is good but not perfect, especially with decorative lettering: expect a few wrong or missing letters, and check every song. The program repairs many mistakes (capitals, apostrophes, look-alike letters) with a word list counted from the lyrics already in your library (the first run learns it, which takes a short while).",
      "It needs a separate download of about 3 GB, once: the Qwen3-VL vision model (Alibaba Cloud's Qwen team, Apache-2.0 licence) and the llama.cpp program that runs it (MIT licence). They are kept on this computer, and your photos never leave it. After a program update only the small program part is fetched again when it has changed; the model stays.",
      "Turn each photo so the words read upright (the rotate buttons beside each photo): the reader does much better that way, and a page photographed sideways is easy to spot.",
      "Photos taken square-on and in good light read best. A shadow or a bent page costs a few words. Credits and other pages without a song's heading are listed but not used unless you give them to a song.",
    ],
  },
];

export function lyricPhotosBox(deps: LyricPhotosDeps): HTMLElement {
  const box = el("div", "lyrics-step lyric-ai-box lyric-photos-box");
  let status: Status | null = null;
  let download: { running: boolean; job: string | null; done: number; total: number; note: string } = { running: false, job: null, done: 0, total: 0, note: "" };
  let typed = "";
  let album: PhotoAlbum | null = null;
  let photos: string[] = [];
  /** How far each photo is turned clockwise (0, 90, 180, 270) so its words read upright. */
  let turns: number[] = [];
  const previews = new Map<string, string>();
  let reading: { running: boolean; job: string | null; step: string; done: number; total: number } = { running: false, job: null, step: "", done: 0, total: 0 };
  let result: ReadResult | null = null;
  let assignment: Assignment = [];
  /** The words of each panel as the person has edited them. */
  const edited = new Map<number, string>();
  /** Songs the person has finished checking (paths), and songs already sent to To review. Both are kept with the saved work. */
  const checked = new Set<string>();
  const sent = new Set<string>();
  let note = "";
  let saveTimer: number | undefined;

  const redraw = (): void => {
    if (box.isConnected) void draw();
  };

  /** Keeps the work on this album (the photos read, which page is which song, the corrected words, the ticks) so it can be carried on later,
   * even after the program is closed. */
  async function saveSession(): Promise<boolean> {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!album || !result) return false;
    try {
      await invoke("lyric_photos_session_save", {
        album: album.key,
        state: { photos, turns, result, assignment, edited: Object.fromEntries(edited), checked: [...checked], sent: [...sent] },
      });
      return true;
    } catch {
      return false;
    }
  }
  /** Saves a moment after the last change (typing does not save on every key). */
  const scheduleSave = (): void => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveSession(), 2500);
  };

  /** Brings back the saved work on the chosen album, if there is any. */
  async function loadSession(): Promise<void> {
    if (!album) return;
    try {
      const saved = await invoke<{ saved: number; state: { photos?: string[]; turns?: number[]; result?: ReadResult; assignment?: Assignment; edited?: Record<string, string>; checked?: string[]; sent?: string[] } } | null>("lyric_photos_session_load", { album: album.key });
      if (!saved?.state?.result) return;
      photos = saved.state.photos ?? [];
      turns = photos.map((_, i) => saved.state.turns?.[i] ?? 0);
      result = saved.state.result;
      assignment = saved.state.assignment ?? initialAssignment(result);
      edited.clear();
      for (const [panel, words] of Object.entries(saved.state.edited ?? {})) edited.set(Number(panel), words);
      checked.clear();
      for (const path of saved.state.checked ?? []) checked.add(path);
      sent.clear();
      for (const path of saved.state.sent ?? []) sent.add(path);
      note = `Carrying on with the work saved on ${new Date(saved.saved * 1000).toLocaleString()}: ${checked.size} of ${plural(album.songs.length, "song")} checked, ${sent.size} sent to To review.`;
    } catch {
      /* nothing saved, or it could not be read: start fresh */
    }
  }

  listen<{ kind?: string; done?: number; total?: number; step?: string }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind === "lyric_photos_download") {
      download.done = p.done ?? download.done;
      download.total = p.total ?? download.total;
    } else if (p.kind === "lyric_photos") {
      reading.step = p.step ?? reading.step;
      reading.done = p.done ?? reading.done;
      reading.total = p.total ?? reading.total;
    } else return;
    redraw();
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: unknown; error?: { message: string } }>("job-finished", (event) => {
    const p = event.payload;
    if (p.job_id === download.job) {
      download = { running: false, job: null, done: 0, total: 0, note: p.ok ? "The photo reader is ready." : `The download stopped: ${p.error?.message ?? "unknown error"}` };
      redraw();
    } else if (p.job_id === reading.job) {
      reading = { running: false, job: null, step: "", done: 0, total: 0 };
      if (p.ok && p.result) {
        result = p.result as ReadResult;
        assignment = initialAssignment(result);
        edited.clear();
        checked.clear();
        sent.clear();
        const matched = assignment.filter((a) => a !== null).length;
        note = `Read ${plural(result.panels.length, "page")} from ${plural(result.photos.length, "photo")}; ${matched} of ${plural(result.tracks.length, "song")} matched. Check each one below; your work is saved as you go.`;
        void saveSession();
      } else {
        note = `Not finished: ${p.error?.message ?? "unknown error"}`;
      }
      redraw();
    }
  }).catch(() => undefined);

  async function startDownload(): Promise<void> {
    download = { running: true, job: null, done: 0, total: 0, note: "" };
    redraw();
    try {
      const reply = await invoke<{ job_id: string }>("lyric_photos_download", {});
      download.job = reply.job_id;
    } catch (error) {
      download = { running: false, job: null, done: 0, total: 0, note: `Could not start: ${errorText(error)}` };
    }
    redraw();
  }

  async function startReading(): Promise<void> {
    if (!album || photos.length === 0) return;
    reading = { running: true, job: null, step: "Starting", done: 0, total: photos.length };
    result = null;
    note = "";
    redraw();
    try {
      const reply = await invoke<{ job_id: string }>("lyric_photos_read", {
        photos,
        rotations: photos.map((_, i) => turns[i] ?? 0),
        tracks: album.songs.map((s) => ({ path: s.path, title: s.title })),
      });
      reading.job = reply.job_id;
    } catch (error) {
      reading = { running: false, job: null, step: "", done: 0, total: 0 };
      note = `Could not start: ${errorText(error)}`;
    }
    redraw();
  }

  async function send(): Promise<void> {
    if (!album || !result) return;
    let kept = 0;
    let failed = 0;
    for (let i = 0; i < album.songs.length; i++) {
      const song = album.songs[i]!;
      const panel = assignment[i];
      if (panel === null || panel === undefined || !checked.has(song.path)) continue;
      const words = tidyWords(edited.get(panel) ?? result.panels[panel]?.text ?? "");
      if (!words) continue;
      try {
        const reply = await invoke<{ kept: number }>("save_lyrics_review", reviewEntry(song, words));
        if (reply.kept > 0) {
          kept += 1;
          sent.add(song.path);
        } else failed += 1;
      } catch {
        failed += 1;
      }
    }
    await saveSession();
    note = `${plural(kept, "song")} sent to To review${failed ? `; ${plural(failed, "song")} could not be sent` : ""}. Approve them in Step 5 below.`;
    redraw();
  }

  async function draw(): Promise<void> {
    try {
      status = await invoke<Status>("lyric_photos_status", {});
    } catch {
      status = null;
    }
    const title = el("div", "lyrics-step-title");
    title.append(el("strong", undefined, "Step 2 · Add lyrics from booklet photos"), infoButton("Step 2 · Add lyrics from booklet photos", PHOTOS_INFO));
    const rows: HTMLElement[] = [title];

    // 1. the reader: the vision reader (a separate download), or the older line-by-line reader where that is already installed
    if (!status) {
      rows.push(el("p", "field-hint", "The photo reader is not available in this version of the program."));
      box.replaceChildren(...rows);
      return;
    }
    const vision = status.vision;
    const older = status.installed && status.runtime_ready;
    if (!vision.installed) {
      const blocking = !older;
      if (blocking && !vision.supported) {
        rows.push(el("p", "field-hint", "The photo reader is not available for this system yet."));
        box.replaceChildren(...rows);
        return;
      }
      rows.push(...downloadRows(vision, blocking));
      if (blocking) {
        box.replaceChildren(...rows);
        return;
      }
    }

    // 2. the album
    const albums = albumsOf(deps.songs());
    const find = el("input");
    find.type = "search";
    find.placeholder = "Type part of the artist or album";
    find.value = typed;
    find.setAttribute("aria-label", "Find the album");
    const select = el("select");
    select.setAttribute("aria-label", "Album");
    const fill = (): void => {
      const matches = findAlbums(albums, typed);
      select.replaceChildren();
      const none = el("option", undefined, matches.length === 0 ? "No album matches" : `Choose the album (${matches.length.toLocaleString()} match${matches.length === 1 ? "" : "es"})`);
      none.value = "";
      select.append(none);
      for (const candidate of matches.slice(0, 300)) {
        const option = el("option", undefined, candidate.label);
        option.value = candidate.key;
        select.append(option);
      }
      select.value = album && matches.some((a) => a.key === album?.key) ? album.key : "";
    };
    fill();
    find.addEventListener("input", () => {
      typed = find.value;
      fill();
    });
    select.addEventListener("change", () => {
      void saveSession();
      album = albums.find((a) => a.key === select.value) ?? null;
      result = null;
      photos = [];
      turns = [];
      note = "";
      void loadSession().then(redraw);
      redraw();
    });
    const albumRow = el("div", "lyrics-step-controls");
    albumRow.append(find, select);
    rows.push(el("p", "field-hint", "1. Choose the album the booklet belongs to."), albumRow);

    // 3. the photos
    const pick = el("button", "secondary", photos.length ? "Choose other photos…" : "Choose the photos…");
    pick.type = "button";
    pick.addEventListener("click", () => {
      void choosePictures("Choose the photos of the lyric pages").then((paths) => {
        if (paths.length > 0) {
          photos = paths;
          turns = paths.map(() => 0);
          result = null;
          note = "";
          redraw();
        }
      });
    });
    rows.push(el("p", "field-hint", "2. Choose one photo or several (a photo may show several song pages; they do not need cropping)."), pick);
    if (photos.length) {
      rows.push(el("p", "field-hint", `${plural(photos.length, "photo")}. Turn any photo whose words run sideways or upside down so they read upright (the reader does much better that way). If you turn a photo after it was read, read the photos again.`));
      const list = el("div", "lyric-photo-list");
      photos.forEach((path, index) => list.append(photoRow(path, index)));
      rows.push(list);
    }

    // 4. read
    if (reading.running) {
      const stop = el("button", "secondary", "Stop");
      stop.type = "button";
      stop.addEventListener("click", () => {
        if (reading.job) void invoke("cancel_job", { job_id: reading.job }).catch(() => undefined);
      });
      const bar = el("div", "lyrics-step-controls");
      bar.append(stop, el("span", undefined, stepText(reading.step, reading.done, reading.total)));
      rows.push(bar);
    } else {
      const go = el("button", undefined, "Read the photos");
      go.type = "button";
      go.disabled = !album || photos.length === 0;
      go.addEventListener("click", () => void startReading());
      rows.push(el("p", "field-hint", "3. Read the photos (about 10 seconds a photo; the first time also learns the words from your library's lyrics)."), go);
    }
    if (note) rows.push(el("p", undefined, note));

    // 5. what was read
    if (result && album && !reading.running) rows.push(...resultRows(result, album));
    box.replaceChildren(...rows);
  }

  /** The download (or update) of the vision reader: what it is, how big, and a button; the progress while it runs. */
  function downloadRows(vision: VisionStatus, blocking: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (vision.update) {
      out.push(el("p", "field-hint", `The photo reader has a newer version after the program update. Only what changed is fetched: ${vision.download_mb} MB${vision.model_ready ? " (the model it already has stays as it is)" : ""}.`));
    } else if (blocking) {
      out.push(el("p", "field-hint", `The photo reader is a separate download of about ${vision.download_mb} MB, once: the Qwen3-VL vision model (${vision.licence} licence) and the llama.cpp program that runs it (MIT licence), kept on this computer in ${vision.folder}. Your photos never leave this computer. If the download stops it carries on from where it was.`));
    } else {
      out.push(el("p", "field-hint", `A better photo reader is available (${vision.download_mb} MB, once): it reads whole photos, decorative lettering and print over pictures much better than the one in use now.`));
    }
    if (download.running) {
      const percent = download.total > 0 ? Math.round((download.done / download.total) * 100) : 0;
      const progress = el("progress");
      progress.max = 100;
      progress.value = percent;
      out.push(progress, el("p", "field-hint", `Downloading… ${megabytes(download.done)} of ${megabytes(download.total)}`));
      const stop = el("button", "secondary", "Stop");
      stop.type = "button";
      stop.addEventListener("click", () => {
        if (download.job) void invoke("cancel_job", { job_id: download.job }).catch(() => undefined);
      });
      out.push(stop);
    } else {
      const go = el("button", blocking ? undefined : "secondary", `${vision.update ? "Update" : "Download"} the photo reader (${vision.download_mb} MB)`);
      go.type = "button";
      go.addEventListener("click", () => void startDownload());
      out.push(go);
    }
    if (download.note) out.push(el("p", "field-hint", download.note));
    return out;
  }

  /** One photo in the list: a small picture as it will be read, its name, and buttons to turn it. */
  function photoRow(path: string, index: number): HTMLElement {
    const row = el("div", "lyric-photo-row");
    const turn = turns[index] ?? 0;
    const picture = el("img", "lyric-photo-thumb");
    picture.alt = `Photo ${index + 1}, turned ${turn} degrees`;
    const key = `${path}|${turn}`;
    const cached = previews.get(key);
    if (cached) picture.src = `data:image/jpeg;base64,${cached}`;
    else {
      void invoke<{ picture: string }>("lyric_photos_preview", { path, turn })
        .then((reply) => {
          previews.set(key, reply.picture);
          picture.src = `data:image/jpeg;base64,${reply.picture}`;
        })
        .catch(() => undefined);
    }
    const button = (label: string, direction: 1 | -1, aria: string): HTMLButtonElement => {
      const b = el("button", "secondary", label);
      b.type = "button";
      b.setAttribute("aria-label", `${aria}: ${fileName(path)}`);
      b.addEventListener("click", () => {
        turns[index] = turned(turns[index] ?? 0, direction);
        scheduleSave();
        redraw();
      });
      return b;
    };
    const name = el("span", undefined, fileName(path));
    const enlarge = el("button", "lyric-photo-thumb-button");
    enlarge.type = "button";
    enlarge.title = "Click to see the photo larger";
    enlarge.setAttribute("aria-label", `See ${fileName(path)} larger`);
    enlarge.append(picture);
    enlarge.addEventListener("click", () => openPhotoPreview(path, index));
    row.append(enlarge, name, button("↺ Turn left", -1, "Turn anticlockwise"), button("↻ Turn right", 1, "Turn clockwise"));
    return row;
  }

  /** The photo large enough to read, with the turn buttons still at hand. */
  function openPhotoPreview(path: string, index: number): void {
    const dialog = el("dialog", "photo-preview");
    const picture = el("img", "photo-preview-image");
    const show = (): void => {
      const turn = turns[index] ?? 0;
      picture.alt = `${fileName(path)}, turned ${turn} degrees`;
      void invoke<{ picture: string }>("lyric_photos_preview", { path, turn, max_side: 1800 })
        .then((reply) => {
          picture.src = `data:image/jpeg;base64,${reply.picture}`;
        })
        .catch(() => undefined);
    };
    const turnBy = (direction: 1 | -1): void => {
      turns[index] = turned(turns[index] ?? 0, direction);
      scheduleSave();
      show();
    };
    const left = el("button", "secondary", "↺ Turn left");
    left.type = "button";
    left.addEventListener("click", () => turnBy(-1));
    const right = el("button", "secondary", "↻ Turn right");
    right.type = "button";
    right.addEventListener("click", () => turnBy(1));
    const close = el("button", undefined, "Done");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    const bar = el("div", "photo-preview-bar");
    bar.append(el("strong", undefined, fileName(path)), left, right, el("span", "field-hint", "Turn it until the words read upright."), close);
    dialog.append(bar, picture);
    dialog.addEventListener("close", () => {
      dialog.remove();
      redraw();
    });
    document.body.append(dialog);
    dialog.showModal();
    show();
  }

  function resultRows(read: ReadResult, current: PhotoAlbum): HTMLElement[] {
    const out: HTMLElement[] = [el("p", "field-hint", "4. Check which page is which song. Edit opens the words beside the picture of the page. Tick a song when you have finished it. Your work is saved as you go, so you can close the program and carry on later: choose this album again.")];
    const table = el("table", "gap-table lyric-photos-table");
    const head = el("tr");
    for (const label of ["Checked", "Song", "Page from the photos", "Words", ""]) head.append(el("th", undefined, label));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    current.songs.forEach((song, index) => {
      const row = el("tr");
      const select = el("select");
      select.setAttribute("aria-label", `Page for ${song.title}`);
      const none = el("option", undefined, "No lyrics for this song");
      none.value = "";
      select.append(none);
      read.panels.forEach((panel, panelIndex) => {
        const option = el("option", undefined, panelLabel(panel, panelIndex + 1));
        option.value = String(panelIndex);
        select.append(option);
      });
      const chosen = assignment[index];
      select.value = chosen === null || chosen === undefined ? "" : String(chosen);
      select.addEventListener("change", () => {
        assignment = assign(assignment, index, select.value === "" ? null : Number(select.value));
        scheduleSave();
        redraw();
      });
      const tickCell = el("td");
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = checked.has(song.path);
      tick.disabled = chosen === null || chosen === undefined;
      tick.setAttribute("aria-label", `${song.title} is checked`);
      tick.addEventListener("change", () => {
        if (tick.checked) checked.add(song.path);
        else checked.delete(song.path);
        scheduleSave();
        redraw();
      });
      tickCell.append(tick);
      const nameCell = el("td", undefined, `${song.number ? String(song.number).padStart(2, "0") + "  " : ""}${song.title}`);
      const pageCell = el("td");
      pageCell.append(select);
      const wordsCell = el("td");
      const actionCell = el("td");
      const panel = chosen === null || chosen === undefined ? null : read.panels[chosen];
      if (panel) {
        const words = edited.get(chosen!) ?? panel.text;
        const doubtful = panel.score < 0.8;
        const state = sent.has(song.path) ? ", sent to To review" : "";
        wordsCell.textContent = `${lineCount(words)} lines${edited.has(chosen!) ? ", edited" : ""}${doubtful ? ", doubtful reading" : ""}${state}`;
        if (doubtful) wordsCell.classList.add("result-warning");
        const edit = el("button", "secondary", "Edit…");
        edit.type = "button";
        edit.addEventListener("click", () => openEditor(read, current, index));
        actionCell.append(edit);
      } else {
        wordsCell.textContent = "—";
      }
      row.append(tickCell, nameCell, pageCell, wordsCell, actionCell);
      tbody.append(row);
    });
    table.append(thead, tbody);
    out.push(table);
    const spare = unusedPanels(assignment, read.panels.length);
    if (spare.length > 0) out.push(el("p", "field-hint", `Not used: ${spare.map((i) => `page ${i + 1} (${read.panels[i]?.title || "no heading"})`).join(", ")}. Choose one of them for a song above if it belongs to one.`));
    const count = current.songs.filter((s, i) => checked.has(s.path) && assignment[i] !== null && assignment[i] !== undefined).length;
    const saveButton = el("button", undefined, "Save progress");
    saveButton.type = "button";
    saveButton.addEventListener("click", () => {
      void saveSession().then((ok) => {
        note = ok ? `Saved. You can close the program and carry on later: choose “${current.label}” again here.` : "Could not save.";
        redraw();
      });
    });
    const sendButton = el("button", "secondary", `Send the ${plural(count, "checked song")} to To review`);
    sendButton.type = "button";
    sendButton.disabled = count === 0;
    sendButton.addEventListener("click", () => void send());
    const open = el("button", "secondary", "Go to Step 5: approve");
    open.type = "button";
    open.addEventListener("click", deps.showReview);
    const buttons = el("div", "lyrics-step-controls");
    buttons.append(saveButton, sendButton, open);
    out.push(buttons);
    return out;
  }

  /** The editor window over the songs that have a page, starting at song `at`. */
  function openEditor(read: ReadResult, current: PhotoAlbum, at: number): void {
    const songs: EditorSong[] = [];
    const songIndexes: number[] = [];
    let start = 0;
    current.songs.forEach((song, index) => {
      const panelIndex = assignment[index];
      const panel = panelIndex === null || panelIndex === undefined ? null : read.panels[panelIndex];
      if (!panel) return;
      if (index === at) start = songs.length;
      songs.push({
        title: `${song.number ? String(song.number).padStart(2, "0") + "  " : ""}${song.title}`,
        words: edited.get(panelIndex!) ?? panel.text,
        picture: panelPicture(read, panel),
        source: panelLabel(panel, panelIndex! + 1),
      });
      songIndexes.push(panelIndex!);
    });
    openLyricEditor(
      songs,
      start,
      (n, words) => {
        edited.set(songIndexes[n]!, words);
        scheduleSave();
      },
      () => {
        void saveSession();
        redraw();
      },
    );
  }

  void draw();
  return box;
}
