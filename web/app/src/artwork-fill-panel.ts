// Review > Artwork > In every song (owner, 2026-11-26): every song carries its album's front cover, the same on all of
// them, and the rear cover and artist photo wherever there is one. Shows what the pictures already in the library can
// complete (nothing is written until the person says so, and it can be undone), asks where a choice is needed, and
// lists what could not be written. All text is set with textContent.

import { fillAlbum, type FillProblem, sourceArgs, type StoredPicture } from "./artwork-fill";
import { type AlbumPlan, ART_KINDS, ART_NAMES, type ArtChoice, type ArtKind, type ArtOption, type ArtworkPlan, LEAVE, type Picks, songsToWrite } from "./artwork-plan";
import { blobFromBase64 } from "./cover-util";
import { invoke } from "./desktop-bridge";
import { el } from "./dom";
import { nativeCopy, prepareImage } from "./image-prep";
import { button, describeEnd, history, modeButtons, runningTitle, startRun } from "./run-controller";
import type { RunMode } from "./timed-run";

export type ArtworkFillDeps = {
  /** Before pictures are written: stops the songs if they are playing. */
  beforePictureEdit: (paths: string[]) => void;
  /** Draws the page again (a choice was made, or a run moved on). */
  redraw: () => void;
  /** Songs were changed: they are checked again and the covers read again. */
  changed: () => void;
};

const PICKS_KEY = "mediaverse.artwork-picks";
const PAGE = 50;

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
const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const errorText = (thrown: unknown): string => (thrown as { message?: string })?.message ?? String(thrown);
const fileName = (path: string): string => path.split(/[\\/]/).slice(-2).join("\\");

const io = {
  invoke,
  prepare: async (picture: StoredPicture): Promise<string> => {
    const prepared = await prepareImage(blobFromBase64(picture.data_base64, picture.mime));
    URL.revokeObjectURL(prepared.previewUrl);
    return prepared.base64;
  },
  fullSize: async (picture: StoredPicture): Promise<string> => (await nativeCopy(blobFromBase64(picture.data_base64, picture.mime))).base64,
};

/** What is wrong with a picture, in words. */
export function pictureFaults(o: ArtOption): string {
  const faults: string[] = [];
  if (Math.max(o.width, o.height) > 1000) faults.push("over 1000 pixels");
  if ((o.bytes ?? 0) > 500 * 1024) faults.push("over 500 KB");
  if (!o.ok && faults.length === 0) faults.push(o.width ? "not a JPEG" : "cannot be read");
  if (o.relabel) faults.push("a JPEG labelled as something else");
  return faults.join(", ");
}

export type PictureRunText = { title: string; history: string; question: string };

/** Writes the planned pictures, five minutes' worth or all of them, with one Undo; `finished` gets the outcome. */
export function runPictureRun(albums: AlbumPlan[], mode: RunMode, text: PictureRunText, beforePictureEdit: (paths: string[]) => void, finished: (note: string, problems: FillProblem[]) => void): void {
  if (albums.length === 0) return;
  const songs = songsToWrite(albums);
  const question = `${text.question} ${mode === "chunk" ? "five minutes' worth of " : ""}${plural(songs, "song")} (${plural(albums.length, "album")})?\n\nOnly the pictures in those songs change; the sound is not touched. You can undo this from here. Phones that keep these songs will see them as changed.${mode === "all" ? " Leave the program open; the computer is kept awake until it finishes." : ""}`;
  if (!window.confirm(question)) return;
  const id = `fill-${Date.now()}`;
  let written = 0;
  const problems: FillProblem[] = [];
  void startRun({
    title: text.title,
    unit: "songs",
    mode,
    items: albums.map((album, index) => ({ album, batch: `${id}-${index}` })),
    size: ({ album }) => songsToWrite([album]),
    label: ({ album }) => `${album.gap.album} — ${album.gap.artist}`,
    step: async ({ album, batch }, tools) => {
      // Remembered before anything is written, so a run cut short can still be undone.
      history.add(id, text.history, batch);
      beforePictureEdit(album.kinds.flatMap((k) => k.paths));
      const result = await fillAlbum(album, batch, io, tools.advance, tools.stopped);
      written += result.songs;
      problems.push(...result.problems);
      // An album cut short by Stop is not counted as done.
      if (tools.stopped()) return "failed";
      return result.songs === 0 && result.problems.length > 0 ? "failed" : "ok";
    },
  }).then((report) => {
    if (!report) return;
    finished(`${plural(written, "song")} changed. ${describeEnd(report, plural(report.left, "album"))}${problems.length ? ` ${plural(problems.length, "problem")}, listed below.` : ""}`, problems);
  });
}

/** The songs that could not be written, each with why. */
export function problemList(problems: FillProblem[]): HTMLElement {
  const box = el("div", "ft-report ft-report-warn");
  box.append(el("p", undefined, "These could not be written:"));
  const list = el("ul", "ft-problems art-problems");
  for (const p of problems) list.append(el("li", undefined, `${fileName(p.path)}: ${p.message}`));
  box.append(list);
  return box;
}

export function initArtworkFill(deps: ArtworkFillDeps) {
  let note = "";
  let problems: FillProblem[] = [];  let readyShown = PAGE;
  let choicesShown = 10;
  const thumbs = new Map<string, Promise<string>>();

  const picks = (): Picks => {
    try {
      return JSON.parse(stored(PICKS_KEY) ?? "{}") as Picks;
    } catch {
      return {};
    }
  };
  const pick = (key: string, value: string): void => {
    store(PICKS_KEY, JSON.stringify({ ...picks(), [key]: value }));
    deps.redraw();
  };

  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watcher.unobserve(entry.target);
      (entry.target as HTMLElement).dispatchEvent(new Event("seen"));
    }
  });

  /** A small view of a picture, read only when it scrolls into sight. */
  function thumb(kind: ArtKind, option: ArtOption): HTMLElement {
    const image = el("img", "art-thumb");
    // No wording until the picture is there: an unread picture with a description shows as a broken one.
    image.alt = "";
    image.setAttribute("aria-label", ART_NAMES[kind]);
    image.addEventListener("seen", () => {
      const key = `${kind}|${option.hash}`;
      let url = thumbs.get(key);
      if (!url) {
        url = invoke<StoredPicture>("art_source", sourceArgs(kind, option.source)).then((p) => URL.createObjectURL(blobFromBase64(p.data_base64, p.mime)));
        thumbs.set(key, url);
      }
      url.then((found) => {
        image.alt = ART_NAMES[kind];
        image.src = found;
      }).catch(() => {
        thumbs.delete(key); // asked again the next time it is shown
        image.alt = "The picture could not be read";
      });
    });
    watcher.observe(image);
    return image;
  }

  const describe = (o: ArtOption): string => {
    const where = o.from === "folder" ? `file in the folder (${o.source.file})` : o.from === "artist" ? "from another album by this artist" : `in ${plural(o.songs, "song")}`;
    return `${o.width ? `${o.width} × ${o.height}, ` : ""}${where}`;
  };

  function run(albums: AlbumPlan[], mode: RunMode): void {
    problems = [];
    note = "";
    runPictureRun(albums, mode, { title: "Adding pictures to songs", history: "Pictures added to songs", question: "Put pictures into" }, deps.beforePictureEdit, (text, found) => {
      note = text;
      problems = found;
      deps.changed();
    });
  }
  const fitNote = (o: ArtOption): string => (!o.ok ? "; stored as a JPEG of at most 1000 pixels" : o.relabel ? "; its label is corrected" : "");

  function readyTable(albums: AlbumPlan[]): HTMLElement {
    const table = el("table", "gap-table");
    const head = el("tr");
    for (const label of ["Album", "Album artist", "Songs", "What goes in", ""]) head.append(el("th", label === "Songs" ? "num" : undefined, label));
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    for (const album of albums.slice(0, readyShown)) {
      const row = el("tr");
      const what = el("td");
      for (const kind of album.kinds) {
        const line = el("div", "art-line");
        line.append(thumb(kind.kind, kind.target), el("span", undefined, `${ART_NAMES[kind.kind]} into ${plural(kind.paths.length, "song")}: ${describe(kind.target)}${fitNote(kind.target)}`));
        what.append(line);
      }
      const action = el("td");
      const add = button("Add to this album", () => run([album], "all"));
      add.disabled = runningTitle() !== null;
      action.append(add);
      row.append(el("td", undefined, album.gap.album), el("td", undefined, album.gap.artist), el("td", "num", String(songsToWrite([album]))), what, action);
      body.append(row);
    }
    table.append(thead, body);
    return table;
  }

  function choiceCard(choice: ArtChoice): HTMLElement {
    const card = el("div", "art-choice");
    card.append(el("strong", undefined, `${choice.gap.album} — ${choice.gap.artist}: ${ART_NAMES[choice.kind].toLowerCase()}`), el("p", "field-hint", `${choice.reason}${choice.without ? ` ${plural(choice.without, "song")} of ${choice.gap.total} have none.` : ""}`));
    const options = el("div", "art-options");
    for (const option of choice.options) {
      const box = el("figure", "art-option");
      box.append(thumb(choice.kind, option), el("figcaption", undefined, `${describe(option)}${fitNote(option)}`), button("Use this one", () => pick(choice.key, option.hash)));
      options.append(box);
    }
    card.append(options, button("Leave this album as it is", () => pick(choice.key, LEAVE)));
    return card;
  }

  /** `checking`: the changed songs are still being read again, so the list is not yet to be acted on. */
  function render(plan: ArtworkPlan, checking: boolean): HTMLElement {
    const box = el("div", "art-fill");
    const counts = ART_KINDS.map((k) => `${plan.have[k].toLocaleString()} ${k === "front" ? "a front cover" : k === "back" ? "a rear cover" : "an artist photo"}`);
    box.append(el("p", undefined, `Of ${plural(plan.songs, "MP3 song")}, inside the song itself: ${counts.join(", ")}.`));
    if (note) box.append(el("p", "field-hint", note));
    if (problems.length) box.append(problemList(problems));
    box.append(el("h3", undefined, `Ready from pictures you already have (${plan.albums.length})`));
    box.append(el("p", "field-hint", plan.albums.length ? "Try one or two albums first and look at them; then run the rest. Nothing is written until you press a button." : "Nothing to add from the pictures already in the library."));
    if (checking) box.append(el("p", "field-hint", "Checking the changed songs…"));
    else if (plan.albums.length) box.append(modeButtons(`Add to ${plural(plan.albums.length, "album")} (${plural(songsToWrite(plan.albums), "song")}):`, (mode) => run(plan.albums, mode)));    if (plan.albums.length && !checking) {
      box.append(readyTable(plan.albums));
      if (plan.albums.length > readyShown) box.append(button(`Show more (${plan.albums.length - readyShown} not shown)`, () => ((readyShown += PAGE), deps.redraw())));
    }
    if (plan.choices.length) {
      box.append(el("h3", undefined, `Need your choice (${plan.choices.length})`));
      for (const choice of plan.choices.slice(0, choicesShown)) box.append(choiceCard(choice));
      if (plan.choices.length > choicesShown) box.append(button(`Show more (${plan.choices.length - choicesShown} not shown)`, () => ((choicesShown += 10), deps.redraw())));
    }
    if (Object.keys(picks()).length) box.append(button("Ask me again about the choices I made", () => (store(PICKS_KEY, null), deps.redraw())));
    return box;
  }

  return { render, picks };
}
