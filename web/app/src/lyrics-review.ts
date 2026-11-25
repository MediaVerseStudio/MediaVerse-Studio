// Review › Lyrics › To review (owner, 2026-11-06): the songs the automatic lyrics found only likely matches for.
// A compact list, best confidence first; Review opens the song's candidates under its row: play the song, move each
// line earlier or later (or time plain words line by line with Tap), then confirm (saved into the song, time-stamped
// when every line has a time) or reject the candidate and try the next one. All text is set with textContent.

import { el } from "./dom";
import { invoke } from "./desktop-bridge";
import { describeError, toApiError } from "./drive-format";
import { runJob } from "./jobs";
import { type LyricsLookup, lengthGap, lengthText, lookupSummary, textToUse, yourSong } from "./lyrics-lookup-format";
import type { FileResult } from "./media-request";
import type { PlayableTrack } from "./play-queue";
import { INSTRUMENTAL_QUESTION, flagInstrumental } from "./instrumental-flag";
import { clickRow } from "./lyrics-select";
import { createTimingEditor } from "./lyric-timing-editor";
import { pagerBar } from "./pager";
import { pageCount } from "./pager-pages";
import { type ReviewCandidate, type SyncLine, aiRequest, candidateKind, carryTimes, clearTimes, lineAt, linesOf, nextUntimed, sameSungWords, shiftAll, stamp, stampText, takeAiTimes, textToSave, timedCount, withoutLabels } from "./lyrics-sync";

export type LyricsReviewDeps = {
  play: (track: PlayableTrack, startSeconds: number) => void;
  pause: () => void;
  /** Carries on with the loaded song after a pause, moves within it (seconds) and sets its speed: the editor's own playback controls (the player bar is out of reach behind its window). */
  resume: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
  state: () => { paused: boolean; duration: number; rate: number };
  now: () => { track: PlayableTrack; seconds: number } | null;
  onTime: (listener: (ms: number) => void) => void;
  beforeEdit: (paths: string[]) => void;
  /** Lyrics were saved into this song: the lists and Now Playing change. */
  saved: (path: string) => void;
  /** The window the lyrics editor opens in when it is opened for one song from anywhere (a flag, the library, Now Playing). */
  dialog: HTMLDialogElement;
};

/** A song with no lyrics and no suggestions yet: listed with the others, reviewed by searching. */
export type ExtraRow = { path: string; title: string | null; artist: string | null; album: string | null };

type ListItem = { key: string; path: string; title: string | null; artist: string | null; album: string | null; duration: number | null; cover_of?: string | null; candidates: ReviewCandidate[] };
type FullCandidate = ReviewCandidate & { plain: string | null; synced: string | null };
type Entry = Omit<ListItem, "candidates"> & { candidates: FullCandidate[] };

const SHIFT_MS = 500;
const PAGE = 100;

/** The lyrics a song has now, as the one candidate the editor starts from. When they are the song's own words (its tag), approving only the timing keeps them as they are. */
async function ownEntry(item: ListItem): Promise<Entry> {
  const reply = await invoke<{ plain: string | null; synced: boolean; lines?: { ms: number; text: string }[]; source?: string }>("track_lyrics", { path: item.path }).catch(() => null);
  const timedLines = reply?.lines ?? [];
  if (!reply || (!reply.plain?.trim() && timedLines.length === 0)) return { ...item, candidates: [] };
  const synced = reply.synced && timedLines.length > 0 ? timedLines.map((l) => `[${stampText(l.ms)}]${l.text}`).join("\n") : null;
  // What the editor shows: the timed lines, else the words without the band's section labels (those are not sung, so they are not timed).
  const shown = timedLines.length > 0 ? timedLines.map((l) => l.text).join("\n") : withoutLabels(reply.plain);
  return {
    ...item,
    candidates: [{ track: item.title, artist: item.artist, album: item.album, duration: item.duration, confidence: 100, synced, plain: shown, source: "file", band_words: reply.source === "tag" }],
  };
}

const button = (label: string, run: (event: MouseEvent) => void, kind = "secondary", title?: string): HTMLButtonElement => {
  const b = el("button", kind, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", run);
  return b;
};

export function initLyricsReview(deps: LyricsReviewDeps): {
  /** Draws the list: the songs with suggestions, then `extra` (songs with none yet). `fresh` reads the sidecar again; otherwise the last read is used (quick tab switches). */
  render: (root: HTMLElement, onCount: (count: number) => void, extra?: ExtraRow[], fresh?: boolean) => Promise<void>;
  /** Songs with likely lyrics to review, and their best confidence (from the last load). */
  best: () => Map<string, number>;
  count: () => number | null;
  refreshCount: () => Promise<number>;
  /** The sidecar's list changed (a run finished, lyrics were saved): the next draw reads it again. */
  invalidate: () => void;
  /** Draws the list again from the sidecar when no song is open for review (the Lyric AI is working through the songs), keeping the page where it is scrolled. */
  refreshIfIdle: () => void;
  /** Opens the editor, in its own window, for one song: its lyrics now, with playback and timing, and a search for others (from a flag, the library or Now Playing). */
  openSong: (track: PlayableTrack) => void;
} {
  let last: { root: HTMLElement; onCount: (count: number) => void; extra: ExtraRow[] } | null = null;
  let items: ListItem[] | null = null;
  let stale = true;
  // Songs ticked for "Approve and save to songs", by entry key; they stay ticked while the list refreshes itself.
  const selected = new Set<string>();
  let anchor: number | null = null;
  let approving = false;
  let approveNote = "";

  /** Saves the first suggestion (the AI's pick comes first) of every ticked song into the song, as one journalled batch. */
  async function approveSelected(redraw: () => void, setProgress: (text: string) => void): Promise<void> {
    if (approving || selected.size === 0) return;
    const keys = [...selected];
    const entries = (items ?? []).filter((i) => selected.has(i.key));
    const plain = entries.filter((i) => !i.candidates[0]?.synced).length;
    const others = entries.filter((i) => i.candidates[0]?.source !== "lyric-ai").length;
    const question = `Save the first suggestion of ${keys.length} song${keys.length === 1 ? "" : "s"} into the song${keys.length === 1 ? "" : "s"}?` +
      `${plain ? `\n\n${plain} of them have words without times (saved as plain words).` : ""}` +
      `${others ? `\n${others} of them were not checked by the Lyric AI.` : ""}` +
      "\n\nEvery save is recorded under one batch so it can be recovered. Songs that cannot be saved are left in the list.";
    if (!window.confirm(question)) return;
    note = "";
    approving = true;
    const batch = `approve-${Date.now()}`;
    let saved = 0;
    const problems: string[] = [];
    for (const [n, entry] of entries.entries()) {
      setProgress(`Saving ${n + 1} of ${entries.length}: ${entry.title ?? entry.path}`);
      try {
        const full = await invoke<Entry>("get_lyrics_review", { key: entry.key });
        const first = full.candidates[0];
        let text = first?.synced?.trim() || first?.plain?.trim();
        // The first suggestion has no times but another suggestion has the same words timed: take that timing, when it covers every line.
        const donor = first && !first.synced ? full.candidates.find((other) => other !== first && other.synced) : undefined;
        if (first && donor) {
          const taken = carryTimes(linesOf(null, first.plain), linesOf(donor.synced, donor.plain));
          if (taken.total > 0 && taken.carried === taken.total) text = textToSave(taken.lines).text;
        }
        if (!text) {
          problems.push(`${entry.title ?? entry.path}: no words`);
          continue;
        }
        deps.beforeEdit([entry.path]);
        // A timing result for the band's own words replaces only the timing: the words and labels stay as the band wrote them (D169).
        const reply = await invoke<{ results: FileResult[] }>("update_track_media", { paths: [entry.path], lyrics: { text }, batch, ...(first?.band_words && first.synced ? { keep_words: true } : {}) });
        if (!reply.results[0]?.ok) {
          problems.push(`${entry.title ?? entry.path}: ${reply.results[0]?.error ?? "not saved"}`);
          continue;
        }
        await invoke("remove_lyrics_review", { key: entry.key });
        selected.delete(entry.key);
        saved += 1;
        deps.saved(entry.path);
      } catch (thrown) {
        problems.push(`${entry.title ?? entry.path}: ${describeError(toApiError(thrown))}`);
      }
    }
    approving = false;
    stale = true;
    approveNote = `${saved} song${saved === 1 ? "" : "s"} saved with their lyrics.${problems.length ? ` ${problems.length} could not be saved and stay in the list: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""}` : ""}`;
    redraw();
  }
  let page = 0; // the page of the list shown, from 0
  let openKey: string | null = null;
  let note = "";
  // The editor open now, told where the song is while it plays.
  let active: { path: string; time: (ms: number) => void } | null = null;
  deps.onTime((ms) => {
    const now = deps.now();
    if (active && now && now.track.source_uri === active.path) active.time(ms);
  });

  async function load(fresh = true): Promise<ListItem[]> {
    // Reading the list means the sidecar opens every kept entry (about two thousand files in a big library): only when something changed.
    if (!fresh && !stale && items !== null) return items;
    items = (await invoke<{ items: ListItem[] }>("list_lyrics_review")).items;
    stale = false;
    return items;
  }

  /** A song with no suggestions (or any song opened from a flag, the library or Now Playing) as the editor's item. */
  const itemOf = (row: ExtraRow): ListItem => ({ key: "", path: row.path, title: row.title, artist: row.artist, album: row.album, duration: null, candidates: [] });

  /**
   * The editor: the lines of a candidate, played and timed, edited like a document, saved into the song. `own`: it works on the lyrics the
   * song has now (and what is found online), not on a review entry, so it opens from anywhere (owner, 2026-11-22: one lyric editor, with
   * playback and timing, wherever lyrics are reviewed or fixed).
   */
  function editor(item: ListItem, close: () => void, reload: () => void, own = false): HTMLElement {
    const box = el("div", "lyrics-editor");
    box.tabIndex = -1;
    box.append(el("p", undefined, "Loading the lyrics…"));
    let entry: Entry | null = null;
    let choice = 0;
    let lines: SyncLine[] = [];
    const song: PlayableTrack = { title: item.title ?? "", artist: item.artist, album: item.album, source_uri: item.path };
    const nowMs = (): number | null => {
      const now = deps.now();
      return now && now.track.source_uri === item.path ? Math.round(now.seconds * 1000) : null;
    };

    const status = el("p", "field-hint");
    const clock = el("span", "sync-clock", "");
    const message = el("p", "field-hint");
    // The editor works like a word processor (D169): select, copy, cut and paste lines between others, Enter, Backspace, Ctrl+Z, spell checking, and a time with a "now" button on every line.
    const te = createTimingEditor({
      nowMs,
      playFrom: (ms) => deps.play(song, Math.max(0, ms / 1000 - 2)),
      changed: (next) => {
        lines = next;
        drawStatus();
      },
    });
    const list = te.element;

    function setLines(next: SyncLine[]): void {
      lines = next;
      drawLines();
    }

    function drawStatus(): void {
      const { timed, total } = timedCount(lines);
      status.textContent =
        timed === total && total > 0
          ? `All ${total} lines have a time: saved as time-stamped lyrics. Play the song and press now on any line that is off, as it starts; a line's time plays from just before it.`
          : timed === 0
            ? `${total} lines without times. Saved as they are (plain words), or play the song and press Tap (or the T key) as each line starts to time them.`
            : `${timed} of ${total} lines have a time. Tap (or T) times the next one; saved as plain words until every line has a time.`;
    }

    /** The editor shows the lines of the candidate: drawn once per candidate; timing a line afterwards changes only that row's time (owner, 2026-11-06). */
    function drawLines(): void {
      te.set(lines);
      drawStatus();
    }

    /** New times for the same lines: the time buttons change in place; the list stays where it is scrolled. */
    function retime(next: SyncLine[]): void {
      lines = next;
      te.setTimes(next);
      drawStatus();
    }

    // The editor's own playback controls: the window hides the player bar, and timing a song means going back a few seconds again and again (owner, 2026-11-23).
    const playButton = button("▶ Play", () => toggle(), "", "Play or pause the song (Space, when the cursor is not in the words)");
    const seekBar = el("input", "sync-seek");
    seekBar.type = "range";
    seekBar.min = "0";
    seekBar.step = "0.1";
    seekBar.value = "0";
    seekBar.setAttribute("aria-label", "Place in the song");
    let scrubbing = false;
    const speed = el("select", "sync-speed");
    speed.setAttribute("aria-label", "Playing speed");
    for (const [value, label] of [["1", "Normal speed"], ["0.75", "¾ speed"], ["0.5", "½ speed"]] as const) {
      const option = el("option", undefined, label);
      option.value = value;
      speed.append(option);
    }
    speed.title = "Slower playing makes it easier to hit a line as it starts; the pitch stays the same";
    // Loading a song puts the speed back to normal, so the chosen speed is set again after a load; and it only touches the player while this song is in it.
    const applyRate = (): number => window.setTimeout(() => deps.setRate(Number(speed.value)), 0);
    speed.addEventListener("change", () => {
      if (nowMs() !== null) deps.setRate(Number(speed.value));
    });

    const songLength = (): number => deps.state().duration || item.duration || 0;
    const clockText = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

    /** Plays the song from `seconds` (loading it first when another song is in the player). */
    function seekTo(seconds: number): void {
      const at = Math.max(0, Math.min(seconds, songLength() || seconds));
      if (nowMs() === null) {
        deps.play(song, at);
        applyRate();
      } else deps.seek(at);
    }

    function toggle(): void {
      if (nowMs() === null) {
        deps.play(song, 0);
        applyRate();
      } else if (deps.state().paused) deps.resume();
      else deps.pause();
      window.setTimeout(refreshTransport, 50);
    }

    function skip(seconds: number): void {
      const here = nowMs();
      seekTo(Math.max(0, (here ?? 0) / 1000 + seconds));
    }

    function refreshTransport(): void {
      const here = nowMs();
      const playing = here !== null;
      const state = deps.state();
      playButton.textContent = playing && !state.paused ? "❚❚ Pause" : "▶ Play";
      const length = songLength();
      seekBar.max = String(length || 1);
      seekBar.disabled = length === 0;
      if (!scrubbing) seekBar.value = String((here ?? 0) / 1000);
      seekBar.style.setProperty("--fill", `${length ? Math.min(100, ((scrubbing ? Number(seekBar.value) : (here ?? 0) / 1000) / length) * 100) : 0}%`);
      clock.textContent = `${clockText((here ?? 0) / 1000)} / ${length ? clockText(length) : "–:––"}`;
      if (playing) speed.value = ["1", "0.75", "0.5"].includes(String(state.rate)) ? String(state.rate) : "1";
    }
    seekBar.addEventListener("input", () => {
      scrubbing = true;
      clock.textContent = `${clockText(Number(seekBar.value))} / ${clockText(songLength())}`;
    });
    seekBar.addEventListener("change", () => {
      scrubbing = false;
      seekTo(Number(seekBar.value));
    });
    // The play button's label follows pauses made elsewhere (and the window being closed ends this).
    let wasShown = false;
    const refresher = window.setInterval(() => {
      if (box.isConnected) {
        wasShown = true;
        refreshTransport();
      } else if (wasShown) window.clearInterval(refresher);
    }, 300);

    function time(ms: number): void {
      te.highlight(lineAt(lines, ms), true);
      refreshTransport();
    }

    // The Lyric AI times the song while the person listens: lines timed by hand stay where they are, the AI places the rest between them, and either can go again.
    type AiAnswer = { lines: { ms: number; placed: boolean; flags: string[] }[]; placed: number; doubtful: number; anchored: number; words_fit: boolean };
    let beforeAi: SyncLine[] | null = null;
    let aiRunning = false;
    const aiButton = button("Lyric AI: time the lines", (event) => void aiTime(event.shiftKey), "", "The Lyric AI listens to the song and times the lines. Lines you timed by hand (marked) stay exactly where you put them, and the AI places the others between them. Press it again after fixing a few lines. Shift-click: time every line again, ignoring your own.");
    const undoAi = button("Undo the AI's timing", () => {
      if (!beforeAi) return;
      retime(beforeAi);
      beforeAi = null;
      undoAi.hidden = true;
      message.textContent = "The AI's timing was taken back.";
    }, "secondary");
    undoAi.hidden = true;

    async function aiTime(all: boolean): Promise<void> {
      if (aiRunning) return;
      const request = aiRequest(lines, all);
      if (request.lines.length < 2) {
        message.textContent = "There are no words to time yet: type or paste the lyrics, or press Search online.";
        return;
      }
      const mine = request.lines.filter((l) => l.mine).length;
      aiRunning = true;
      aiButton.disabled = true;
      message.textContent = `The Lyric AI is listening to the song${mine ? `, keeping the ${mine} line${mine === 1 ? "" : "s"} you timed` : ""}… The first time on a song takes about a minute; after that it is quick.`;
      try {
        const answer = await runJob<AiAnswer>("lyric_ai_time_lines", { path: item.path, lines: request.lines });
        const before = lines;
        const result = takeAiTimes(lines, request.at, request.lines, answer.lines, all);
        beforeAi = before;
        undoAi.hidden = false;
        retime(result.lines);
        const unplaced = answer.lines.filter((l) => !l.placed).length;
        message.textContent =
          `The Lyric AI timed ${result.taken} line${result.taken === 1 ? "" : "s"}${result.kept ? ` around the ${result.kept} you timed` : ""}.` +
          `${unplaced ? ` ${unplaced} could not be placed and have the time of the line above.` : ""}` +
          `${answer.doubtful ? ` ${answer.doubtful} look doubtful: check those first.` : ""}` +
          `${answer.words_fit ? "" : " These words fit the singing poorly, so they may be the wrong lyrics."}` +
          " Play the song, fix any line that is off with now, then press the button again: the lines you fixed stay where you put them.";
      } catch (thrown) {
        message.textContent = describeError(toApiError(thrown));
      } finally {
        aiRunning = false;
        aiButton.disabled = false;
      }
    }

    function tap(): void {
      const ms = nowMs();
      const index = nextUntimed(lines);
      if (ms === null || index < 0) return;
      retime(stamp(lines, index, ms));
    }

    async function save(): Promise<void> {
      const result = textToSave(lines);
      const { timed, total } = timedCount(lines);
      if (total === 0) {
        message.textContent = "There are no words to save yet: type or paste the lyrics, or press Search online.";
        return;
      }
      if (!result.synced && timed > 0 && !window.confirm(`Only ${timed} of ${total} lines have a time. Save the words without times?`)) return;
      // The band's own words, timed by Step 4 and not changed here: only the timing is saved, so their labels and layout stay (D169).
      const picked = entry?.candidates[choice];
      const keepWords = picked?.band_words === true && sameSungWords(lines, picked.plain);
      if (keepWords && !result.synced) {
        message.textContent = "These are the band's own words. Give every line a time to save the timing; the words themselves are kept as they are.";
        return;
      }
      message.textContent = "Saving…";
      try {
        deps.beforeEdit([item.path]);
        const reply = await invoke<{ results: FileResult[] }>("update_track_media", { paths: [item.path], lyrics: { text: result.text }, ...(keepWords ? { keep_words: true, batch: `review-timing-${Date.now()}` } : {}) });
        const outcome = reply.results[0];
        if (!outcome?.ok) {
          message.textContent = `Not saved: ${outcome?.error ?? "it failed"}`;
          return;
        }
        if (item.key) await invoke("remove_lyrics_review", { key: item.key });
        // The person looked at these words and confirmed them: they are settled for good, and only their timing is left to Step 4 (D169).
        await invoke("lyric_ai_confirm_words", { path: item.path }).catch(() => undefined);
        stale = true;
        note = `“${item.title}”: ${result.synced ? "time-stamped lyrics" : "lyrics"} saved into the song.`;
        deps.saved(item.path);
        close();
        reload();
      } catch (thrown) {
        message.textContent = describeError(toApiError(thrown));
      }
    }

    async function reject(): Promise<void> {
      try {
        const reply = await invoke<{ left: number }>("reject_lyrics_candidate", { key: item.key, index: choice });
        if (reply.left === 0) {
          note = `“${item.title}”: no suggestion left; it stays in the list with no lyrics.`;
          stale = true;
          close();
          reload();
          return;
        }
        choice = 0;
        await fill();
        message.textContent = "Rejected. The next candidate is shown.";
      } catch (thrown) {
        message.textContent = describeError(toApiError(thrown));
      }
    }

    async function instrumental(): Promise<void> {
      if (!window.confirm(INSTRUMENTAL_QUESTION(item.title ?? "this song"))) return;
      message.textContent = "Saving…";
      try {
        deps.beforeEdit([item.path]);
        await flagInstrumental(item.path, item.key);
        stale = true;
        note = `“${item.title}”: marked instrumental; the lyrics and suggestions were removed.`;
        deps.saved(item.path);
        close();
        reload();
      } catch (thrown) {
        message.textContent = `Not marked: ${describeError(toApiError(thrown))}`;
      }
    }

    async function fill(): Promise<void> {
      entry = own ? await ownEntry(item) : await invoke<Entry>("get_lyrics_review", { key: item.key });
      draw();
    }

    /** Looks for lyrics online (LRCLIB). What is found is added to the candidates and the best is shown; nothing is saved until the person saves. */
    async function searchOnline(): Promise<void> {
      if (!entry) return;
      message.textContent = "Asking LRCLIB…";
      try {
        const found = await runJob<LyricsLookup>("lookup_lyrics", { path: item.path, title: item.title ?? "", artist: item.artist ?? "", album: item.album, follow_works: true });
        const first = entry.candidates.length;
        for (const c of found.results) {
          if (textToUse(c) === null) continue;
          entry.candidates.push({ track: c.track, artist: c.artist, album: c.album, duration: c.duration, confidence: found.via === "exact" ? 90 : 60, synced: c.synced, plain: c.plain, source: "lrclib", other_version: c.other_version, other_artist: c.other_artist });
        }
        if (entry.candidates.length > first) choice = first;
        draw();
        message.textContent = `${yourSong(item.title ?? "Unknown song", item.artist, item.album, found.song_duration)}. ${lookupSummary(found)}`;
      } catch (thrown) {
        message.textContent = describeError(toApiError(thrown));
      }
    }

    /** Takes the lyrics out of the song (after asking). */
    async function removeLyrics(): Promise<void> {
      if (!window.confirm(`Remove the lyrics from “${item.title ?? "this song"}”?`)) return;
      message.textContent = "Removing…";
      try {
        deps.beforeEdit([item.path]);
        const reply = await invoke<{ results: FileResult[] }>("update_track_media", { paths: [item.path], lyrics: { clear: true } });
        if (!reply.results[0]?.ok) {
          message.textContent = `Not removed: ${reply.results[0]?.error ?? "it failed"}`;
          return;
        }
        deps.saved(item.path);
        close();
      } catch (thrown) {
        message.textContent = describeError(toApiError(thrown));
      }
    }

    /**
     * The lines of a candidate. One with no times borrows them from a timed candidate of the same song, line by line: the Lyric AI times the words read from a booklet
     * photo as a separate candidate, and the untimed photo version is listed first (owner, 2026-11-22: "the timing was not applied to the photo version").
     */
    function linesFor(c: FullCandidate): { lines: SyncLine[]; note: string } {
      const own = linesOf(c.synced, c.plain);
      if (timedCount(own).timed > 0 || !entry) return { lines: own, note: "" };
      const donor = entry.candidates.find((other) => other !== c && other.synced);
      if (!donor) return { lines: own, note: "" };
      const taken = carryTimes(own, linesOf(donor.synced, donor.plain));
      if (taken.carried === 0) return { lines: own, note: "" };
      return { lines: taken.lines, note: `${taken.carried} of ${taken.total} lines took their times from the timed candidate (${candidateKind(donor)}). Play the song and check them; press now on any line that has none.` };
    }

    function draw(): void {
      if (!entry) return;
      const shown = entry;
      const chooser = el("select", "sync-choice");
      chooser.setAttribute("aria-label", "Lyrics candidate");
      shown.candidates.forEach((c, i) => {
        const gap = lengthGap(c.duration, item.duration);
        const where = [c.album, lengthText(c.duration), gap && gap !== "same length" ? `${gap} than your song` : gap].filter(Boolean).join(", ");
        const option = el(
          "option",
          undefined,
          c.source === "file"
            ? `The lyrics now in the song${c.synced ? " · timed" : " · no times yet"}`
            : `${c.confidence}% · ${c.artist ?? "?"} — ${c.track ?? "?"}${where ? ` (${where})` : ""} · ${candidateKind(c)}${c.synced ? " · timed" : ""}`,
        );
        option.value = String(i);
        option.selected = i === choice;
        chooser.append(option);
      });
      const mine = el("p", "field-hint", yourSong(item.title ?? "Unknown song", item.artist, item.album, item.duration));
      const label = el("strong", undefined, shown.candidates.length === 0 ? "No lyrics yet" : own ? "Lyrics" : `Candidate ${choice + 1} of ${shown.candidates.length}`);
      chooser.addEventListener("change", () => {
        choice = Number(chooser.value);
        if (!own) label.textContent = `Candidate ${choice + 1} of ${entry?.candidates.length ?? 0}`;
        message.textContent = "";
        const c = entry?.candidates[choice];
        if (c) {
          const taken = linesFor(c);
          setLines(taken.lines);
          message.textContent = taken.note;
        }
      });
      const c = shown.candidates[choice];
      // A song with no lyrics yet starts with one empty line to type or paste into.
      const first = c ? linesFor(c) : { lines: own ? [{ text: "", ms: null }] : [], note: "" };
      lines = first.lines;

      const head = el("div", "row-actions");
      head.append(label, mine, chooser);
      const transport = el("div", "row-actions sync-transport");
      transport.append(
        playButton,
        seekBar,
        clock,
        speed,
      );
      const tools = el("div", "row-actions");
      tools.append(
        button("Tap: time the next line", () => tap(), "secondary", "Press as each line starts (or the T key)"),
        aiButton,
        undoAi,
        button("All earlier", (e) => retime(shiftAll(lines, -(e.shiftKey ? 1000 : SHIFT_MS))), "secondary", "Every line half a second earlier (Shift: a second)"),
        button("All later", (e) => retime(shiftAll(lines, e.shiftKey ? 1000 : SHIFT_MS)), "secondary", "Every line half a second later (Shift: a second)"),
        button("Clear times", () => {
          beforeAi = null;
          undoAi.hidden = true;
          retime(clearTimes(lines));
        }),
      );
      const foot = el("div", "row-actions");
      foot.append(button(own ? "Save to the song" : "Confirm and save to the song", () => void save(), ""));
      if (!own) foot.append(button("Not a match: reject", () => void reject()));
      foot.append(
        button("Search online", () => void searchOnline(), "secondary", "Looks for lyrics for this song online (LRCLIB); each one found is added to the list above"),
        button("This song is instrumental", () => void instrumental(), "secondary", "There is nothing sung: remove the lyrics and suggestions, and mark the song instrumental"),
      );
      if (own && shown.candidates.some((candidate) => candidate.source === "file")) foot.append(button("Remove the lyrics", () => void removeLyrics(), "secondary"));
      foot.append(button("Close", () => close()));
      const hint = el("p", "field-hint", "Click in the words to edit them like a document: select several lines to copy, cut or paste them between other lines (pasted lines have no time yet: press now on each one). Enter splits a line, Backspace joins two, Ctrl+Z undoes, and Ctrl+Enter times the line the cursor is in as it starts. Misspelled words are underlined; right-click one for suggestions. Space plays or pauses (outside the words) and Alt+Left or Right jumps 5 seconds (with Shift, 1). Lines you time by hand are marked: the Lyric AI keeps those where they are and times the others around them.");
      box.replaceChildren(head, transport, tools, status, hint, list, message, foot);
      drawLines();
      refreshTransport();
      if (first.note) message.textContent = first.note;
    }

    box.addEventListener("keydown", (event) => {
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        skip((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 5));
        return;
      }
      const typing = event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || (event.target instanceof Element && event.target.closest(".te"));
      if (event.key === " " && !typing) {
        event.preventDefault();
        toggle();
        return;
      }
      if ((event.key === "t" || event.key === "T") && !(event.target instanceof HTMLSelectElement) && !(event.target instanceof HTMLInputElement) && !(event.target instanceof Element && event.target.closest(".te"))) {
        event.preventDefault();
        tap();
      }
    });
    active = { path: item.path, time };
    fill().catch((thrown) => box.replaceChildren(el("p", "result-warning", describeError(toApiError(thrown)))));
    return box;
  }

  async function render(root: HTMLElement, onCount: (count: number) => void, extra: ExtraRow[] = [], fresh = false): Promise<void> {
    last = { root, onCount, extra };
    let list: ListItem[];
    try {
      list = await load(fresh);
    } catch (thrown) {
      root.replaceChildren(el("p", "result-warning", describeError(toApiError(thrown))));
      return;
    }
    const withSuggestions = new Set(list.map((i) => i.path));
    const bare = extra.filter((row) => !withSuggestions.has(row.path));
    const total = list.length + bare.length;
    onCount(total);
    const redraw = (): void => void render(root, onCount, extra, true);
    root.replaceChildren(
      el(
        "p",
        undefined,
        total === 0
          ? "Nothing to review: every song has lyrics, or is listed as instrumental."
          : `${total.toLocaleString()} song${total === 1 ? "" : "s"} to review: ${list.length.toLocaleString()} with suggested lyrics (best first), ${bare.length.toLocaleString()} with no lyrics found yet. Nothing is written into a song until you confirm.`,
      ),
    );
    if (note) root.append(el("p", "result-ok", note));
    if (total === 0) return;
    const table = el("table", "gap-table lyrics-review-table");
    const head = el("tr");
    const everyBox = el("input");
    everyBox.type = "checkbox";
    everyBox.title = "Tick or untick every song with suggestions that is shown";
    everyBox.setAttribute("aria-label", "Select every shown song with suggestions");
    const pickAll = el("th");
    pickAll.append(everyBox);
    head.append(pickAll);
    for (const label of ["", "Song", "Artist", "Album", "Suggestion", "Others"]) head.append(el("th", label === "Others" ? "num" : undefined, label));
    // The keys of the rows that can be ticked, in the order shown (a shift-click ticks everything between two rows).
    const order: string[] = [];
    const boxes = new Map<string, HTMLInputElement>();
    let toolbarUpdate = (): void => undefined;
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    /** One row; its editor opens under it. */
    const addRow = (
      path: string,
      cells: (string | HTMLElement)[],
      editorFor: (close: () => void) => HTMLElement,
      key: string,
      pickable = false,
    ): void => {
      const row = el("tr");
      const pick = el("td");
      if (pickable) {
        const box = el("input");
        box.type = "checkbox";
        box.checked = selected.has(key);
        box.setAttribute("aria-label", `Select ${cells[0] instanceof HTMLElement ? "this song" : String(cells[0])}`);
        const index = order.push(key) - 1;
        boxes.set(key, box);
        box.addEventListener("click", (event) => {
          const outcome = clickRow(selected, order, anchor, index, box.checked, event.shiftKey);
          anchor = outcome.anchor;
          selected.clear();
          for (const k of outcome.selected) selected.add(k);
          for (const [k, b] of boxes) b.checked = selected.has(k);
          toolbarUpdate();
        });
        pick.append(box);
      }
      row.append(pick);
      const cell = el("td");
      row.append(cell);
      for (const content of cells) {
        const td = el("td");
        if (typeof content === "string") td.textContent = content;
        else td.append(content);
        row.append(td);
      }
      const editorRow = el("tr", "lyrics-editor-row");
      const editorCell = el("td");
      editorCell.colSpan = 7;
      editorRow.append(editorCell);
      const close = (): void => {
        editorRow.remove();
        if (openKey === key) openKey = null;
        if (active?.path === path) active = null;
      };
      const open = (): void => {
        body.querySelector(".lyrics-editor-row")?.remove();
        openKey = key;
        note = "";
        editorCell.replaceChildren(editorFor(close));
        row.after(editorRow);
        editorRow.querySelector<HTMLElement>(".lyrics-editor")?.focus({ preventScroll: true });
      };
      cell.append(button("Review", () => (openKey === key && editorRow.isConnected ? close() : open())));
      body.append(row);
    };
    // One page of the songs with suggestions followed by the songs with none: the page is cut from the two lists together.
    const lastPage = pageCount(total, PAGE) - 1;
    if (page > lastPage) page = lastPage;
    const from = page * PAGE;
    const goTo = (target: number): void => {
      page = target;
      void render(root, onCount, extra, false).then(() => root.scrollIntoView({ block: "start" }));
    };
    for (const item of list.slice(from, from + PAGE)) {
      const best = item.candidates[0];
      const song = el("span", undefined, item.title ?? "—");
      if (item.cover_of) {
        const badge = el("span", "cover-badge", `Cover of ${item.cover_of}`);
        badge.title = "The Lyric AI recognised this album as songs of another artist";
        song.append(badge);
      }
      addRow(
        item.path,
        [song, item.artist ?? "—", item.album ?? "—", best ? `${best.confidence}% · ${candidateKind(best)}${best.other_artist && best.artist ? ` (${best.artist})` : ""}${best.synced ? " · timed" : ""}` : "—", String(Math.max(0, item.candidates.length - 1))],
        (close) => editor(item, close, redraw),
        item.key,
        true,
      );
    }
    for (const row of bare.slice(Math.max(0, from - list.length), Math.max(0, from + PAGE - list.length))) {
      addRow(row.path, [row.title ?? "—", row.artist ?? "—", row.album ?? "—", "No lyrics found yet", ""], (close) => editor(itemOf(row), close, redraw, true), row.path);
    }
    const toolbar = el("div", "row-actions review-toolbar");
    const count = el("span", undefined, "");
    const approve = button("Approve and save to songs", () => void approveSelected(redraw, (text) => (count.textContent = text)), "", "Saves the first suggestion of every ticked song into the song");
    const clear = button("Clear", () => {
      selected.clear();
      for (const b of boxes.values()) b.checked = false;
      toolbarUpdate();
    });
    const topPicks = button("Tick the AI-checked at 90% or more on this page", () => {
      for (const item of list) {
        const best = item.candidates[0];
        if (best?.source === "lyric-ai" && best.confidence >= 90 && boxes.has(item.key)) selected.add(item.key);
      }
      for (const [k, b] of boxes) b.checked = selected.has(k);
      toolbarUpdate();
    }, "secondary", "Ticks the songs on this page whose first suggestion the Lyric AI checked against the singing and scored 90% or more. Songs ticked on other pages stay ticked.");
    toolbarUpdate = (): void => {
      count.textContent = selected.size === 0 ? "No song ticked. Tick one, then shift-click another to tick everything between." : `${selected.size.toLocaleString()} song${selected.size === 1 ? "" : "s"} ticked`;
      approve.disabled = selected.size === 0 || approving;
      clear.disabled = selected.size === 0;
      everyBox.checked = order.length > 0 && order.every((k) => selected.has(k));
    };
    everyBox.addEventListener("click", () => {
      for (const k of order) {
        if (everyBox.checked) selected.add(k);
        else selected.delete(k);
      }
      for (const [k, b] of boxes) b.checked = selected.has(k);
      toolbarUpdate();
    });
    toolbar.append(approve, clear, topPicks, count);
    toolbarUpdate();
    if (approveNote) {
      root.append(el("p", "result-ok", approveNote));
      approveNote = "";
    }
    if (order.length > 0) root.append(toolbar);
    table.append(thead, body);
    root.append(pagerBar(page, PAGE, total, "song", goTo), table, pagerBar(page, PAGE, total, "song", goTo));
  }
  return {
    render,
    best: () => new Map((items ?? []).map((i) => [i.path, i.candidates[0]?.confidence ?? 0])),
    count: () => items?.length ?? null,
    refreshCount: async () => (await load(false).catch(() => [])).length,
    invalidate: () => {
      stale = true;
    },
    refreshIfIdle: () => {
      // Not while a song is open or ticked: rows moving under the person's clicks (a shift-click range) would be worse than a list that is a little behind.
      if (openKey !== null || selected.size > 0 || approving || !last || !last.root.isConnected) return;
      const y = window.scrollY;
      void render(last.root, last.onCount, last.extra, true).then(() => window.scrollTo(0, y));
    },
    openSong: (track) => {
      const item = itemOf({ path: track.source_uri, title: track.title, artist: track.artist ?? null, album: track.album ?? null });
      const close = (): void => {
        if (active?.path === item.path) active = null;
        if (deps.dialog.open) deps.dialog.close();
      };
      const body = editor(item, close, () => undefined, true);
      deps.dialog.replaceChildren(el("h2", undefined, `Lyrics: ${track.title}${track.artist ? ` — ${track.artist}` : ""}`), body);
      if (!deps.dialog.open) deps.dialog.showModal();
      deps.dialog.addEventListener("close", () => { if (active?.path === item.path) active = null; }, { once: true });
    },
  };
}
