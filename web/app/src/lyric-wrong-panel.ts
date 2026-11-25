// Review > Lyrics > "Check the lyrics already in your songs" (D152): listens to every song that has lyrics and lists the ones whose words do not fit the singing
// (an instrumental with lyrics, another song's words). It never changes or removes anything: the list only says which songs to look at. Text is set with textContent.

import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { INSTRUMENTAL_QUESTION, flagInstrumental } from "./instrumental-flag";
import { type InfoBlock, infoButton } from "./info-popup";

export type WrongSong = { path: string; title: string; artist: string | null; album: string | null };

export type LyricWrongDeps = {
  /** Every MP3 in the library. */
  songs: () => WrongSong[];
  /** Plays one song so it can be listened to. */
  play: (path: string) => void;
  /** The Lyric AI settings, when it is not set up yet. */
  showSettings: () => void;
  /** A song's file is about to be changed (stop it playing first). */
  beforeEdit?: (paths: string[]) => void;
  /** Lyrics were taken out of this song: the lists and Now Playing change. */
  saved?: (path: string) => void;
};

type Found = { path: string; title?: string; artist?: string; album?: string; fit?: number | null; verdict: string; words?: number };
type Summary = { songs: number; checked: number; wrong: number; no_singing: number; no_lyrics: number; skipped: number; failed: number; aborted?: string | null; stopped: boolean };
type Status = { ready: boolean; missing: string[]; reader_model?: string };

const MAX_SAME_FAILURES = 10;
const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);

export const WRONG_INFO: InfoBlock[] = [
  {
    heading: "What it does",
    paragraphs: [
      "The Lyric AI listens to every song that already has lyrics and checks whether those words are what is sung. Songs whose lyrics do not fit the singing (an instrumental that has lyrics, another song's words, a sample-based track) are listed here for you to look at.",
      "It never changes or removes anything. You play a song, decide, and fix it yourself (for example by removing the lyrics in Fix tags, or looking for the right ones in Step 1 or 3).",
    ],
  },
  {
    heading: "Good to know",
    items: [
      "Songs without lyrics are skipped; they are the work of Steps 1 to 3.",
      "Songs marked instrumental are left out unless you tick “Include songs marked as instrumental”: lyrics on a song you have marked instrumental are exactly what this check can catch, but you may also want to leave those alone.",
      "“The lyrics are fine” keeps a song off the list; it comes back only if a later check gives a different verdict.",
      "It needs the music-lyrics model (Settings > Lyrics > Lyric AI). A fit of -2.8 or worse is listed; the lyrics that were wrong in our own check all scored that badly and the right ones did not. A song with live-version differences may rarely be listed by mistake, which is why a person decides.",
      "A song checked in the last 30 days is skipped unless “Also redo songs checked before” is ticked. You can stop at any time.",
    ],
  },
];

const run = {
  running: false,
  job: null as string | null,
  total: 0,
  done: 0,
  current: "",
  found: [] as Found[],
  note: "",
  summary: null as Summary | null,
};
let redraw: () => void = () => undefined;
let listening = false;

function listenOnce(): void {
  if (listening) return;
  listening = true;
  listen<{ kind?: string; done?: number; total?: number; current?: string; result?: Found }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind === "lyric_wrong") {
      run.done = p.done ?? run.done;
      run.total = p.total ?? run.total;
      run.current = p.current ?? "";
    } else if (p.kind === "lyric_wrong_found" && p.result) {
      if (!run.found.some((f) => f.path === p.result?.path)) run.found.push(p.result);
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
        ? `Stopped by itself after ${MAX_SAME_FAILURES} songs in a row failed with the same reason: ${run.summary.aborted} Nothing was lost; fix that and run it again.`
        : run.summary.stopped
          ? "Stopped. What was checked so far is kept; run it again to carry on (songs checked in the last 30 days are skipped)."
          : "Finished.";
    } else {
      run.note = `Stopped: ${event.payload.error?.message ?? "unknown error"}`;
    }
    redraw();
  }).catch(() => undefined);
}

const why = (f: Found): string =>
  f.verdict === "no singing"
    ? "Almost no singing was heard, yet the song has lyrics"
    : `The lyrics do not fit the singing${typeof f.fit === "number" ? ` (fit ${f.fit.toFixed(2)}; -2.8 or worse is listed)` : ""}`;

export function lyricWrongBox(deps: LyricWrongDeps): HTMLElement {
  listenOnce();
  const box = el("div", "lyrics-step lyric-ai-box lyric-wrong-box");
  redraw = () => {
    if (box.isConnected) void draw();
  };
  const instrumental = el("input");
  instrumental.type = "checkbox";
  const again = el("input");
  again.type = "checkbox";

  async function start(): Promise<void> {
    const songs = deps.songs();
    if (!songs.length) {
      run.note = "There are no songs to check.";
      redraw();
      return;
    }
    Object.assign(run, { running: true, total: songs.length, done: 0, current: "", note: "", summary: null });
    redraw();
    try {
      const reply = await invoke<{ job_id: string }>("lyric_ai_wrong_check", {
        paths: songs.map((s) => s.path),
        include_instrumental: instrumental.checked,
        again: again.checked,
      });
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
    let list: { items: Found[]; checked: number } = { items: [], checked: 0 };
    try {
      list = await invoke<{ items: Found[]; checked: number }>("lyric_ai_wrong_results", {});
    } catch {
      /* the list stays empty */
    }
    const title = el("div", "lyrics-step-title");
    title.append(el("strong", undefined, "Check the lyrics already in your songs"), infoButton("Check the lyrics already in your songs", WRONG_INFO));
    const rows: HTMLElement[] = [title];
    if (!status?.ready) {
      rows.push(el("p", "field-hint", `Not set up yet${status?.missing?.length ? `: missing ${status.missing.join("; ")}` : ""}. This check needs the Lyric AI and its music-lyrics model.`));
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
        controls.append(stop, el("span", undefined, `${run.done.toLocaleString()} of ${run.total.toLocaleString()}${run.current ? ` · ${run.current}` : ""}`));
        rows.push(controls);
      } else {
        const go = el("button", undefined, "Start the check");
        go.type = "button";
        go.addEventListener("click", () => void start());
        controls.append(go);
        rows.push(controls);
        const options = el("div", "lyrics-step-options");
        const a = el("label", "check");
        a.append(instrumental, el("span", undefined, "Include songs marked as instrumental"));
        const b = el("label", "check");
        b.append(again, el("span", undefined, "Also redo songs checked before"));
        options.append(a, b);
        rows.push(options);
      }
      if (run.summary) {
        const s = run.summary;
        rows.push(el("p", undefined, `Checked ${plural(s.checked, "song")} with lyrics · listed: ${(s.wrong + s.no_singing).toLocaleString()} · no lyrics: ${s.no_lyrics.toLocaleString()} · skipped: ${s.skipped.toLocaleString()}${s.failed ? ` · could not be read: ${s.failed.toLocaleString()}` : ""}`));
      }
      if (run.note) rows.push(el("p", "field-hint", run.note));
      rows.push(el("p", "field-hint", list.checked ? `${plural(list.checked, "song")} checked so far; ${plural(list.items.length, "song")} to look at.` : "Nothing checked yet."));
      if (list.items.length) {
        const table = el("table", "gap-table lyrics-missing-table");
        const head = el("tr");
        for (const label of ["", "Song", "Artist", "Why", ""]) head.append(el("th", undefined, label));
        const thead = el("thead");
        thead.append(head);
        const body = el("tbody");
        for (const item of list.items.slice(0, 300)) {
          const row = el("tr");
          const playCell = el("td");
          const play = el("button", "secondary", "▶");
          play.type = "button";
          play.title = "Play this song";
          play.setAttribute("aria-label", `Play ${item.title || "this song"}`);
          play.addEventListener("click", () => deps.play(item.path));
          playCell.append(play);
          const action = el("td");
          action.style.textAlign = "right";
          const keep = el("button", "secondary", "The lyrics are fine");
          keep.type = "button";
          keep.addEventListener("click", () => {
            void invoke("lyric_ai_wrong_dismiss", { path: item.path })
              .catch(() => undefined)
              .then(() => redraw());
          });
          const nothingSung = el("button", "secondary", "It is instrumental");
          nothingSung.type = "button";
          nothingSung.title = "Nothing is sung: remove the lyrics and mark the song instrumental";
          nothingSung.addEventListener("click", () => {
            if (!window.confirm(INSTRUMENTAL_QUESTION(item.title || "this song"))) return;
            deps.beforeEdit?.([item.path]);
            flagInstrumental(item.path, null)
              .then(() => {
                run.note = `“${item.title || "The song"}” was marked instrumental and its lyrics were removed.`;
                deps.saved?.(item.path);
              })
              .catch((error) => {
                run.note = `Not marked: ${errorText(error)}`;
              })
              .then(() => redraw());
          });
          action.append(nothingSung, keep);
          row.append(playCell, el("td", undefined, item.title || "(no title)"), el("td", undefined, item.artist || ""), el("td", undefined, why(item)), action);
          body.append(row);
        }
        table.append(thead, body);
        rows.push(table);
        if (list.items.length > 300) rows.push(el("p", "field-hint", `Showing the 300 worst of ${list.items.length.toLocaleString()}.`));
      }
    }
    box.replaceChildren(...rows);
  }
  void draw();
  return box;
}
