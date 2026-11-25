// Review > Lyrics > Step 2 · Lyric AI (docs/lyric-ai-plan.md): listens to songs, finds or checks their lyrics and times them. The results that are certain can
// be written into the songs by themselves (journalled under one batch id, so they can be recovered); the rest wait in General review with their doubtful lines
// marked. There is deliberately no one-click "undo the whole run" button (owner, 2026-11-06, for the automatic lyrics). The long explanation lives in an
// info window (owner, 2026-11-18), not on the page. Text is set with textContent.

import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { type InfoBlock, infoButton } from "./info-popup";
import { type Live, classify } from "./lyric-ai-counts";

export type AiSong = { path: string; title: string };

export type LyricAiDeps = {
  /** The songs to work on for a scope: the ones with no lyrics, or every MP3 (their timing is checked, plain lyrics timed, missing lyrics found). */
  songs: (scope: "missing" | "all") => AiSong[];
  /** A run ended (or lyrics were written): the page reads the lyrics state of the library again. */
  finished: () => void;
  /** Somewhere to go for the songs that need a person. */
  showReview: () => void;
  /** The Lyric AI settings, when it is not set up yet. */
  showSettings: () => void;
};

type Status = { ready: boolean; missing: string[]; separator: string; reader: string };
const MAX_SAME_FAILURES = 10; // the same number as the program's (`MAX_SAME_FAILURES` in lyric_ai.rs)
type Summary = { aborted?: string | null; songs: number; sure: number; applied: number; review: number; nothing: number; failed: number; stopped: boolean; covers?: number; cover_applied?: number };

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);

export const STEP2_INFO: InfoBlock[] = [
  {
    heading: "What it does",
    paragraphs: [
      "The Lyric AI listens to each song and works out which lyrics belong to it. For a song with no lyrics it looks on LRCLIB under every likely spelling of the artist and title, lets the AI pick the record that fits the singing, and times it line by line. Songs with no singing are listed as suspected instrumental.",
    ],
  },
  {
    heading: "Work on",
    items: [
      "Only songs with no lyrics (recommended): the songs still missing lyrics after Steps 1 and 2.",
      "Songs nothing was found for: for songs nobody has lyrics for (they are not on LRCLIB), Whisper (a speech-recognition model, a separate download) writes down what it hears; the music model then checks how well those words fit the singing and times them. The draft goes to General review marked as a draft, with a match percentage that follows how well it fits (good drafts have about one word in five wrong). Look through it, correct the words with the pencil next to each line, and confirm. Drafts are never written into a song by themselves, and a draft that does not fit the singing is not kept.",
      "The To review list: the suggestions already waiting in General review (from Step 1). For each song the AI listens, picks the suggestion that fits best, checks and corrects its timing, and searches again if none fits. Only suggestions at 60% or more are used.",
      "The whole To review list, below 60% too: the same, but also for weaker suggestions. The AI's own judgement decides, and it can find covers under the original band.",
      "Every song: slower; also checks the timing of lyrics you already have and times plain lyrics the program found. Untimed lyrics from the band, or that you confirmed, are left to Step 4 (timing).",
    ],
  },
  {
    heading: "Write the results that are certain",
    paragraphs: [
      "Ticked: when the words are certain and few lines are doubtful, the lyrics are written into the song, time-stamped. Every write is journalled under one batch id, so a run can be recovered if something looks wrong.",
      "Unticked: nothing is written into any song. Every result, certain or not, waits in General review with the AI's pick first, so you can play it and confirm it. A good way to try it first.",
    ],
  },
  {
    heading: "What you will see",
    items: [
      "Written into: songs whose lyrics were saved.",
      "Ready to check: songs with a timed result waiting in General review.",
      "Nothing found or nothing to do: no lyrics fit the singing, or the song already fits.",
      "Instrumental: songs with no singing; they appear under Suspected instrumental.",
    ],
  },
  {
    heading: "Cover albums",
    paragraphs: ["When most lyrics found for an album belong to one other artist (a tribute or cover album), the AI says so while it works, trusts picks by that artist, and searches under that artist for the songs where nothing fitted. Those songs show \"Cover of …\" in General review."],
  },
  {
    heading: "Good to know",
    items: ["You can stop at any time; what was settled is kept.", "A song judged in the last 30 days is skipped when you run it again.", "Ripping a CD while this runs is fine; it runs at low priority."],
  },
];

// One run at a time for the whole page; the card is drawn again from this state whenever it is shown.
const run = {
  running: false,
  job: null as string | null,
  total: 0,
  done: 0,
  current: "",
  applied: 0,
  ready: 0,
  nothing: 0,
  instrumental: 0,
  failed: 0,
  failedWhy: "",
  note: "",
  summary: null as Summary | null,
  covers: [] as string[],
  skipped: 0,
  /** What was chosen when Start was pressed, shown while it runs and after. */
  chosen: "",
};
let redraw: () => void = () => undefined;
let onFinished: () => void = () => undefined;
let listening = false;

function listenOnce(): void {
  if (listening) return;
  listening = true;
  listen<{ kind?: string; done?: number; total?: number; current?: string; result?: Live; album?: string; original?: string }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind === "lyric_ai") {
      run.done = p.done ?? run.done;
      run.total = p.total ?? run.total;
      run.current = p.current ?? "";
      run.skipped = (p as { skipped?: number }).skipped ?? run.skipped;
    } else if (p.kind === "lyric_ai_result" && p.result) {
      const counted = classify(p.result);
      if (counted === "applied") run.applied += 1;
      else if (counted === "instrumental") run.instrumental += 1;
      else if (counted === "failed") {
        run.failed += 1;
        if (!run.failedWhy && p.result.verdict) run.failedWhy = p.result.verdict;
      }
      else if (counted === "ready") run.ready += 1;
      else run.nothing += 1;
    } else if (p.kind === "lyric_ai_cover" && p.original) {
      const text = `${p.album || "an album"} (songs of ${p.original})`;
      if (!run.covers.includes(text)) run.covers.push(text);
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
      const settled = run.summary.cover_applied ? ` ${plural(run.summary.cover_applied, "song")} settled by recognising a cover album.` : "";
      run.note = run.summary.aborted
        ? `Stopped by itself after ${MAX_SAME_FAILURES} songs in a row failed with the same reason: ${run.summary.aborted} Nothing was lost; fix that and run it again.`
        : (run.summary.stopped ? "Stopped. What was settled so far is kept; run it again to carry on (songs already judged are skipped)." : "Finished.") + settled;
    } else {
      run.note = `Stopped: ${event.payload.error?.message ?? "unknown error"}`;
    }
    redraw();
    onFinished();
  }).catch(() => undefined);
}

export function lyricAiBox(deps: LyricAiDeps): HTMLElement {
  listenOnce();
  onFinished = deps.finished;
  const box = el("div", "lyrics-step lyric-ai-box");
  redraw = () => {
    if (box.isConnected) void draw();
  };
  const scope = el("select");
  scope.setAttribute("aria-label", "Work on");
  for (const [value, label] of [
    ["missing", "Only songs with no lyrics (recommended)"],
    ["draft", "Songs nothing was found for: write a draft by listening (Whisper)"],
    ["review", "The To review list (suggestions at 60% or more)"],
    ["review-all", "The whole To review list, below 60% too"],
    ["all", "Every song (slower, for later)"],
  ] as const) {
    const option = el("option", undefined, label);
    option.value = value;
    scope.append(option);
  }
  const apply = el("input");
  apply.type = "checkbox";
  apply.checked = true;
  const again = el("input");
  again.type = "checkbox";

  async function start(): Promise<void> {
    // "review": the sidecar reads the To review list itself and judges each song's suggestions against the singing (nothing is passed in).
    const judging = scope.value === "review" || scope.value === "review-all";
    const drafting = scope.value === "draft";
    const songs = judging ? [] : deps.songs(drafting ? "missing" : (scope.value as "missing" | "all"));
    if (!judging && !songs.length) {
      run.note = "There are no songs to work on.";
      redraw();
      return;
    }
    const chosen = `Work on: ${scope.selectedOptions[0]?.textContent ?? scope.value}. Write the results that are certain into the songs: ${apply.checked ? "yes" : "no"}. Also redo songs checked before: ${again.checked ? "yes" : "no"}.`;
    Object.assign(run, { chosen, running: true, total: songs.length, done: 0, current: "", applied: 0, ready: 0, nothing: 0, instrumental: 0, failed: 0, failedWhy: "", note: "", summary: null, covers: [], skipped: 0 });
    redraw();
    try {
      const batch = apply.checked ? { batch: `lyricai-${Date.now()}` } : {};
      const reply = drafting
        ? await invoke<{ job_id: string }>("lyric_ai_draft", { paths: songs.map((s) => s.path), again: again.checked })
        : judging
        ? await invoke<{ job_id: string }>("lyric_ai_judge", { min_confidence: scope.value === "review-all" ? 0 : 60, apply_sure: apply.checked, again: again.checked, ...batch })
        : await invoke<{ job_id: string }>("lyric_ai_analyse", { paths: songs.map((s) => s.path), apply_sure: apply.checked, again: again.checked, ...batch });
      run.job = reply.job_id;
    } catch (error) {
      run.running = false;
      run.note = `Could not start: ${errorText(error)}`;
    }
    redraw();
  }

  async function draw(): Promise<void> {
    let status: Status | null = null;
    try {
      status = await invoke<Status>("lyric_ai_status", {});
    } catch {
      status = null;
    }
    const title = el("div", "lyrics-step-title");
    title.append(el("strong", undefined, "Step 3 · Match lyrics to songs (Lyric AI)"), infoButton("Step 3 · Match lyrics to songs", STEP2_INFO));
    const rows: HTMLElement[] = [title];
    if (!status?.ready) {
      rows.push(el("p", "field-hint", `Not set up yet${status?.missing?.length ? `: missing ${status.missing.join("; ")}` : ""}. The AI needs its models and ONNX Runtime; Settings > Lyrics explains where they go.`));
      const open = el("button", "secondary", "Open the Lyric AI settings");
      open.type = "button";
      open.addEventListener("click", deps.showSettings);
      rows.push(open);
    } else {
      const controls = el("div", "lyrics-step-controls");
      if (run.running) {
        const stop = el("button", "secondary", "Stop");
        stop.type = "button";
        stop.addEventListener("click", () => {
          if (run.job) void invoke("cancel_job", { job_id: run.job }).catch(() => undefined);
          run.note = "Stopping after this song…";
          redraw();
        });
        controls.append(stop, el("span", undefined, `${run.done.toLocaleString()} of ${run.total.toLocaleString()}${run.skipped ? ` (${run.skipped.toLocaleString()} already checked earlier, skipped)` : ""}${run.current ? ` · ${run.current}` : ""}`));
      } else {
        const go = el("button", undefined, "Start");
        go.type = "button";
        go.addEventListener("click", () => void start());
        const which = el("label", "check");
        which.append(el("span", undefined, "Work on: "), scope);
        const label = el("label", "check");
        label.append(apply, el("span", undefined, "Write the results that are certain into the songs"));
        const redo = el("label", "check");
        redo.append(again, el("span", undefined, "Also redo songs checked before"));
        redo.title = "Ticked: every song is checked again. Unticked: a song checked in the last 30 days is skipped.";
        controls.append(go, which);
        rows.push(controls);
        const options = el("div", "lyrics-step-options");
        options.append(label, redo, el("span", "field-hint", "Songs checked in the last 30 days are skipped unless “Also redo songs checked before” is ticked."));
        rows.push(options);
      }
      if (run.running) rows.push(controls);
      if (run.chosen && (run.running || run.summary || run.done)) rows.push(el("p", "field-hint", `You chose: ${run.chosen}`));
      if (run.running || run.summary || run.done) {
        rows.push(el("p", undefined, `Written into ${plural(run.applied, "song")} · ready to check: ${run.ready.toLocaleString()} · nothing found or nothing to do: ${run.nothing.toLocaleString()} · instrumental: ${run.instrumental.toLocaleString()}${run.failed ? ` · could not be read: ${run.failed.toLocaleString()}${run.failedWhy ? ` (${run.failedWhy})` : ""}` : ""}`));
      }
      if (run.covers.length) rows.push(el("p", "field-hint", `Cover albums recognised: ${run.covers.join("; ")}.`));
      if (run.note) rows.push(el("p", "field-hint", run.note));
      if (!run.running && run.ready > 0) {
        const see = el("button", "secondary", `See the ${run.ready.toLocaleString()} ready to check`);
        see.type = "button";
        see.addEventListener("click", deps.showReview);
        rows.push(see);
      }
    }
    box.replaceChildren(...rows);
  }
  void draw();
  return box;
}
