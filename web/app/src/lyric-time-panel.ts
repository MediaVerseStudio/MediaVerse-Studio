// Review > Lyrics > Step 4 · Time the lyrics (owner, 2026-11-22; D169). Step 3 matches words to songs; this step only times words that are already settled (the band's
// own lyrics in the file, ones the person confirmed, optionally ones the program found) and can be run as often as wanted, also on songs that already have timing.
// It never changes the words; it replaces the song's time-stamped lyrics, and Undo puts the old timing back. Text is set with textContent only.

import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { type InfoBlock, infoButton } from "./info-popup";

export type TimeSong = { path: string; title: string };
export type TimePlaylist = { id: string; name: string; paths: string[] };

export type LyricTimeDeps = {
  /** Every MP3 of the library. */
  songs: () => TimeSong[];
  playlists: () => Promise<TimePlaylist[]>;
  finished: () => void;
  showReview: () => void;
  showSettings: () => void;
};

export const STEP4_INFO: InfoBlock[] = [
  {
    heading: "What it does",
    paragraphs: [
      "Step 3 decides which words belong to a song. This step takes words that are already settled and times them line by line against the singing. It never changes the words: the lyrics text in the song stays exactly as it is (labels such as [Chorus] and the band's layout included); only the time-stamped lyrics are replaced, and Undo puts the old timing back.",
    ],
  },
  {
    heading: "Which songs",
    items: [
      "Untimed lyrics from the band or that you confirmed: lyrics that were already in the MP3 when the program first saw it, or that you confirmed in Review.",
      "Also untimed lyrics the program found: found online, never confirmed by you. The words are checked against the singing first; a poor fit goes to General review instead of being written.",
      "Re-time songs that already have timing: for fine-tuning after you fixed a song by hand, or after the timing AI has improved. It replaces the timing; the words are never touched.",
      "Limit to a playlist: a good way to try it on a few songs first.",
    ],
  },
  {
    heading: "What is written",
    paragraphs: [
      "A timing is written into the song when at least 80% of its lines could be placed in the singing and at most 25% are doubtful (Step 3 is stricter, because it also has to be sure of the words). Anything else waits in General review, already timed, so you can play it and fix the lines. A run can be repeated at any time; every write is journalled under one batch, and Undo last run restores the timing the songs had.",
    ],
  },
];

type Summary = { songs: number; written: number; review: number; skipped: number; failed: number; aborted?: string | null; stopped: boolean };
type Live = { path?: string; task?: string; verdict?: string; need?: string; applied?: boolean; has_timing?: boolean };

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);

const run = {
  running: false,
  job: null as string | null,
  total: 0,
  done: 0,
  skipped: 0,
  current: "",
  written: 0,
  review: 0,
  quiet: 0,
  failed: 0,
  failedWhy: "",
  note: "",
  chosen: "",
  batch: null as string | null,
  summary: null as Summary | null,
};
let redraw: () => void = () => undefined;
let onFinished: () => void = () => undefined;
let listening = false;

function listenOnce(): void {
  if (listening) return;
  listening = true;
  listen<{ kind?: string; done?: number; total?: number; current?: string; skipped?: number; result?: Live }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind === "lyric_time") {
      run.done = p.done ?? run.done;
      run.total = p.total ?? run.total;
      run.skipped = p.skipped ?? run.skipped;
      run.current = p.current ?? "";
    } else if (p.kind === "lyric_time_result" && p.result) {
      if (p.result.applied) run.written += 1;
      else if (p.result.task === "error") {
        run.failed += 1;
        if (!run.failedWhy && p.result.verdict) run.failedWhy = p.result.verdict;
      } else if (p.result.has_timing) run.review += 1;
      else run.quiet += 1; // almost no singing was heard: nothing was timed, so nothing waits in review
    } else return;
    redraw();
  }).catch(() => undefined);
  listen<{ job_id: string; ok: boolean; result?: Summary; error?: { message: string } }>("job-finished", (event) => {
    if (event.payload.job_id !== run.job) return;
    run.running = false;
    run.job = null;
    run.current = "";
    if (event.payload.ok && event.payload.result) {
      run.summary = event.payload.result;
      run.done = run.summary.songs;
      run.note = run.summary.aborted
        ? `Stopped by itself after the same failure kept repeating: ${run.summary.aborted} Nothing was lost; fix that and run it again.`
        : run.summary.stopped
          ? "Stopped. What was written so far is kept (Undo last run takes it back)."
          : "Finished.";
    } else {
      run.note = `Stopped: ${event.payload.error?.message ?? "unknown error"}`;
    }
    redraw();
    onFinished();
  }).catch(() => undefined);
}

export function lyricTimeBox(deps: LyricTimeDeps): HTMLElement {
  listenOnce();
  onFinished = deps.finished;
  const box = el("div", "lyrics-step lyric-time-box");
  redraw = () => {
    if (box.isConnected) void draw();
  };

  const checkbox = (checked: boolean, text: string, hint?: string): { label: HTMLElement; input: HTMLInputElement } => {
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    const label = el("label", "check");
    label.append(input, el("span", undefined, text));
    if (hint) label.title = hint;
    return { label, input };
  };
  const band = checkbox(true, "Untimed lyrics that came from the band or that I confirmed", "Lyrics already in the MP3 when the program first saw it, and lyrics you confirmed in Review");
  const found = checkbox(false, "Also untimed lyrics the program found (not confirmed by me)", "Found online or by the AI and written earlier; checked against the singing first");
  const retime = checkbox(false, "Re-time songs that already have timing", "The timing is replaced, the words are never touched; Undo last run puts it back");
  const apply = checkbox(true, "Write the timings that are good enough into the songs", "Unticked: nothing is written; every result waits in General review");
  const limit = el("select");
  limit.setAttribute("aria-label", "Songs to time");
  let playlists: TimePlaylist[] = [];
  const fillLimit = (): void => {
    const keep = limit.value;
    limit.replaceChildren();
    const whole = el("option", undefined, "The whole library");
    whole.value = "";
    limit.append(whole);
    for (const p of playlists) {
      const option = el("option", undefined, `Playlist: ${p.name} (${p.paths.length.toLocaleString()})`);
      option.value = p.id;
      limit.append(option);
    }
    limit.value = playlists.some((p) => p.id === keep) ? keep : "";
  };
  void deps.playlists().then((list) => {
    playlists = list;
    fillLimit();
  }).catch(() => undefined);
  fillLimit();

  async function start(): Promise<void> {
    const wanted = limit.value ? new Set(playlists.find((p) => p.id === limit.value)?.paths ?? []) : null;
    const songs = deps.songs().filter((s) => !wanted || wanted.has(s.path));
    if (!songs.length) {
      run.note = "There are no songs to work on.";
      redraw();
      return;
    }
    if (!band.input.checked && !found.input.checked && !retime.input.checked) {
      run.note = "Tick at least one kind of song to time.";
      redraw();
      return;
    }
    const where = limit.selectedOptions[0]?.textContent ?? "";
    const kinds = [band.input.checked ? "the band's or confirmed lyrics" : "", found.input.checked ? "lyrics the program found" : "", retime.input.checked ? "songs that already have timing" : ""].filter(Boolean).join(", ");
    Object.assign(run, { chosen: `${where}: ${kinds}. Write the good timings: ${apply.input.checked ? "yes" : "no"}.`, running: true, total: songs.length, done: 0, skipped: 0, current: "", written: 0, review: 0, quiet: 0, failed: 0, failedWhy: "", note: "", summary: null });
    run.batch = apply.input.checked ? `lyrictime-${Date.now()}` : null;
    redraw();
    try {
      const reply = await invoke<{ job_id: string }>("lyric_ai_time", {
        paths: songs.map((s) => s.path),
        include_found: found.input.checked,
        retime: retime.input.checked,
        apply: apply.input.checked,
        ...(run.batch ? { batch: run.batch } : {}),
      });
      run.job = reply.job_id;
    } catch (error) {
      run.running = false;
      run.note = `Could not start: ${errorText(error)}`;
    }
    redraw();
  }

  async function undo(): Promise<void> {
    if (!run.batch || run.running) return;
    if (!window.confirm(`Put back the timing ${plural(run.written, "song")} had before the last run? The words are not touched.`)) return;
    try {
      const reply = await invoke<{ songs: number; problems: { message: string }[] }>("undo_picture_batch", { batch: run.batch });
      run.note = `Undone: ${plural(reply.songs, "song")} got back their earlier timing.${reply.problems.length ? ` ${plural(reply.problems.length, "song")} could not be put back: ${reply.problems[0]?.message ?? ""}` : ""}`;
      run.batch = null;
      run.written = 0;
    } catch (error) {
      run.note = `Could not undo: ${errorText(error)}`;
    }
    deps.finished();
    redraw();
  }

  async function draw(): Promise<void> {
    let status: { ready: boolean; missing: string[] } | null = null;
    try {
      status = await invoke<{ ready: boolean; missing: string[] }>("lyric_ai_status", {});
    } catch {
      status = null;
    }
    const title = el("div", "lyrics-step-title");
    title.append(el("strong", undefined, "Step 4 · Time the lyrics (Lyric AI)"), infoButton("Step 4 · Time the lyrics", STEP4_INFO));
    const rows: HTMLElement[] = [title, el("p", "field-hint", "Times words that are already settled; never changes them. Run it as often as you like, also on songs that already have timing.")];
    if (!status?.ready) {
      rows.push(el("p", "field-hint", `Not set up yet${status?.missing?.length ? `: missing ${status.missing.join("; ")}` : ""}. Settings > Lyrics explains where the models go.`));
      const open = el("button", "secondary", "Open the Lyric AI settings");
      open.type = "button";
      open.addEventListener("click", deps.showSettings);
      rows.push(open);
      box.replaceChildren(...rows);
      return;
    }
    if (run.running) {
      const stop = el("button", "secondary", "Stop");
      stop.type = "button";
      stop.addEventListener("click", () => {
        if (run.job) void invoke("cancel_job", { job_id: run.job }).catch(() => undefined);
        run.note = "Stopping after this song…";
        redraw();
      });
      const controls = el("div", "lyrics-step-controls");
      controls.append(stop, el("span", undefined, `${run.done.toLocaleString()} of ${run.total.toLocaleString()}${run.skipped ? ` (${run.skipped.toLocaleString()} left out: no lyrics to time)` : ""}${run.current ? ` · ${run.current}` : ""}`));
      rows.push(controls);
    } else {
      const options = el("div", "lyrics-step-options");
      options.append(band.label, found.label, retime.label, apply.label);
      const which = el("label", "check");
      which.append(el("span", undefined, "Songs: "), limit);
      const go = el("button", undefined, "Start");
      go.type = "button";
      go.addEventListener("click", () => void start());
      const controls = el("div", "lyrics-step-controls");
      controls.append(go, which);
      rows.push(options, controls);
    }
    if (run.chosen && (run.running || run.summary || run.done)) rows.push(el("p", "field-hint", `You chose: ${run.chosen}`));
    if (run.running || run.summary || run.done) {
      rows.push(el("p", undefined, `Written into ${plural(run.written, "song")} · waiting in General review, timed: ${run.review.toLocaleString()}${run.quiet ? ` · almost no singing heard (not timed): ${run.quiet.toLocaleString()}` : ""}${run.failed ? ` · could not be read: ${run.failed.toLocaleString()}${run.failedWhy ? ` (${run.failedWhy})` : ""}` : ""}`));
    }
    if (run.note) rows.push(el("p", "field-hint", run.note));
    if (!run.running) {
      const actions = el("div", "row-actions");
      if (run.review > 0) {
        const see = el("button", "secondary", `See the ${run.review.toLocaleString()} waiting in General review`);
        see.type = "button";
        see.addEventListener("click", deps.showReview);
        actions.append(see);
      }
      if (run.batch && run.written > 0) {
        const back = el("button", "secondary", "Undo last run");
        back.type = "button";
        back.title = "Put back the timing the songs had before; the words are not touched";
        back.addEventListener("click", () => void undo());
        actions.append(back);
      }
      if (actions.childElementCount) rows.push(actions);
    }
    box.replaceChildren(...rows);
  }
  void draw();
  return box;
}
