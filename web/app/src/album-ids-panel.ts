// Review > Album IDs (D99): MusicBrainz release IDs written into the songs, so an album is known for certain (an orphan
// song can be brought back in line with its album, Navidrome, Jellyfin and Picard agree with us).
// A check asks MusicBrainz about every album folder and files it as: ready (one edition fits exactly), album only
// (several editions fit alike; the album is certain), set aside (missing tracks, another count, other names, no
// match) or already tagged. Writing touches only the first two kinds, and has Undo. The albums set aside are a short
// list with the reason and a choice of the closest releases, never a wall of songs. Text is set with textContent.

import { invoke, listen } from "./desktop-bridge";
import { describeCounts, type Counts } from "./album-ids";
import { el } from "./dom";
import { createCompareView } from "./album-compare";

export type AlbumIdsDeps = { changed: (message: string) => void };


type Candidate = { release_id: string; release_group_id: string; edition: string; confidence: number; artist: string; album: string };
type Evidence = { kind: "good" | "info" | "warn"; text: string };
type Row = { path: string; name: string; reason: string; songs: number; artist: string; album: string; candidates: Candidate[]; edition: string; method: string; release_id: string; release_group_id: string; evidence: Evidence[] };
type Filter = "review" | "ready" | "album_only" | "applied";
const FILTERS: [Filter, string][] = [["review", "Set aside"], ["ready", "Ready"], ["album_only", "Album only"], ["applied", "Written"]];
const METHOD_TEXT: Record<string, string> = {
  "disc layout": "Found by the disc ID: the song lengths added up to a disc MusicBrainz knows.",
  names: "Found by names: the disc ID (song lengths) matched nothing, so the album and artist names were searched.",
};
type Listing = { counts: Counts; filter: string; total: number; rows: Row[] };
type Problem = { path?: string; message: string };

const PAGE = 10;
const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);

export function initAlbumIdsPanel(root: HTMLElement, deps: AlbumIdsDeps): { show: () => void } {
  root.classList.add("album-ids-panel");
  const note = el("div");
  const summary = el("p");
  const actions = el("div", "dialog-actions");
  const progress = el("p", "field-hint");
  const list = el("div", "album-ids-list");
  const pager = el("div", "dialog-actions");
  let counts: Counts | null = null;
  let offset = 0;
  let filter: Filter = "review";
  let scanJob: string | null = null;
  let writeJob: string | null = null;
  let lastBatch: string | null = null;
  let refreshTimer: number | undefined;

  const report = (text: string, problems: Problem[] = []): HTMLElement => {
    const box = el("div", problems.length ? "ft-report ft-report-warn" : "ft-report ft-report-good");
    box.append(el("p", undefined, text));
    if (problems.length) {
      const ul = el("ul", "ft-problems");
      for (const p of problems.slice(0, 8)) ul.append(el("li", undefined, `${p.path ? `${p.path.split(/[\\/]/).slice(-2).join("/")}: ` : ""}${p.message}`));
      if (problems.length > 8) ul.append(el("li", undefined, `…and ${problems.length - 8} more.`));
      box.append(ul);
    }
    return box;
  };

  async function load(): Promise<void> {
    try {
      const listing = await invoke<Listing>("list_mb_ids", { filter, offset, limit: PAGE });
      counts = listing.counts;
      draw(listing);
    } catch (error) {
      note.replaceChildren(report(`Could not read the results: ${errorText(error)}`));
    }
  }

  function draw(listing: Listing): void {
    const c = counts!;
    summary.textContent = describeCounts(c);
    actions.replaceChildren();
    const busy = scanJob !== null || writeJob !== null;
    if (scanJob) {
      const stop = button("Stop checking");
      stop.addEventListener("click", () => void invoke("cancel_job", { job_id: scanJob }).catch(() => undefined));
      actions.append(stop);
    } else {
      const scan = button(c.total ? "Check for changes" : "Check the library", "");
      scan.disabled = busy;
      scan.addEventListener("click", () => void startScan(false));
      actions.append(scan);
    }
    const writable = c.ready + c.album_only;
    const write = button(writable ? `Write IDs into ${plural(writable, "album")}` : "Write IDs", "");
    write.disabled = busy || writable === 0;
    write.addEventListener("click", () => void writeAll(c));
    actions.append(write);
    if (lastBatch) {
      const undo = button("Undo the last write");
      undo.disabled = busy;
      undo.addEventListener("click", () => void undoLast());
      actions.append(undo);
    }
    list.replaceChildren();
    const chips = el("div", "dialog-actions");
    const countOf: Record<Filter, number> = { review: c.review, ready: c.ready, album_only: c.album_only, applied: c.applied };
    for (const [value, label] of FILTERS) {
      const chip = button(`${label} (${countOf[value]})`, value === filter ? "" : "secondary");
      chip.addEventListener("click", () => {
        filter = value;
        offset = 0;
        void load();
      });
      chips.append(chip);
    }
    list.append(chips);
    const blurb: Record<Filter, string> = {
      review: "These are not an exact match, often another edition of the album, a missing song or different song names. Choose the release that is yours, or leave the album alone.",
      ready: "One edition fits these albums exactly. This is what will be written, with the evidence behind each match.",
      album_only: "The album is certain, but several editions fit alike, so only the album's ID will be written. Choose an edition if you know it.",
      applied: "IDs already written into these albums.",
    };
    list.append(el("p", "field-hint", blurb[filter]));
    for (const row of listing.rows) list.append(rowCard(row));
    pager.replaceChildren();
    if (listing.total > PAGE) {
      const prev = button("Previous");
      prev.disabled = offset === 0;
      prev.addEventListener("click", () => {
        offset = Math.max(0, offset - PAGE);
        void load();
      });
      const next = button("Next");
      next.disabled = offset + PAGE >= listing.total;
      next.addEventListener("click", () => {
        offset += PAGE;
        void load();
      });
      pager.append(prev, el("span", "field-hint", `${offset + 1}–${Math.min(offset + PAGE, listing.total)} of ${listing.total}`), next);
    }
  }

  function rowCard(row: Row): HTMLElement {
    const card = el("div", "album-ids-row");
    card.append(el("strong", undefined, row.name), el("p", "field-hint", `${plural(row.songs, "song")}${row.reason ? ` · ${row.reason}` : ""}`));
    if (filter !== "review" && row.artist) card.append(el("p", undefined, `Matched to ${row.artist} — ${row.album}${row.edition ? ` (${row.edition})` : ""}`));
    card.append(el("p", "field-hint", METHOD_TEXT[row.method] ?? "How this album was matched was not recorded by the earlier check."));
    if (row.evidence?.length) {
      const marks = { good: "✓", info: "•", warn: "⚠" } as const;
      const ul = el("ul", "ft-problems");
      for (const e of row.evidence) ul.append(el("li", undefined, `${marks[e.kind] ?? "•"} ${e.text}`));
      card.append(ul);
    }
    const select = el("select");
    select.setAttribute("aria-label", "Closest releases");
    for (const [i, candidate] of row.candidates.entries()) {
      const option = el("option", undefined, `${candidate.artist} — ${candidate.album} · ${candidate.edition || "edition unknown"} · ${candidate.confidence}%`);
      option.value = String(i);
      select.append(option);
    }
    const use = button("Use this release");
    use.addEventListener("click", () => {
      const chosen = row.candidates[Number(select.value)];
      if (chosen) void writeChosen(row, chosen);
    });
    const leave = button("Leave alone");
    leave.addEventListener("click", async () => {
      await invoke("dismiss_mb_ids", { path: row.path }).catch(() => undefined);
      void load();
    });
    if (row.candidates.length) card.append(select, use);
    if (row.candidates.length) {
      // Compare: the album's own tags beside the chosen release, song by song; the dropdown cycles through the releases.
      const compareView = createCompareView({ path: row.path, name: row.name, artist: row.artist || row.candidates[0].artist, album: row.album || row.candidates[0].album, changed: deps.changed });
      let open = false;
      const toggle = button("Compare with my files");
      const show = (): void => {
        const chosen = row.candidates[Number(select.value)];
        if (chosen?.release_id) void compareView.load(chosen.release_id);
      };
      toggle.addEventListener("click", () => {
        open = !open;
        toggle.textContent = open ? "Hide comparison" : "Compare with my files";
        compareView.element.hidden = !open;
        if (open) show();
      });
      select.addEventListener("change", () => {
        if (open) show();
      });
      compareView.element.hidden = true;
      card.append(toggle, compareView.element);
    }
    if (filter === "review") card.append(leave);
    return card;
  }

  async function startScan(again: boolean): Promise<void> {
    try {
      const started = await invoke<{ job_id: string }>("scan_mb_ids", { again });
      scanJob = started.job_id;
      note.replaceChildren(report("Checking your albums with MusicBrainz. It asks about one a second, so a large library takes a while; you can stop and carry on later, and nothing is asked twice."));
      await load();
    } catch (error) {
      note.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  async function startWrite(command: string, args: Record<string, unknown>): Promise<void> {
    try {
      const started = await invoke<{ job_id: string }>(command, args);
      writeJob = started.job_id;
      await load();
    } catch (error) {
      note.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  async function writeAll(c: Counts): Promise<void> {
    if (!confirm(`Write MusicBrainz IDs into ${plural(c.ready + c.album_only, "album")}?\n\nOnly songs without an ID get one, and nothing else in the tags changes. You can undo this afterwards.`)) return;
    const batch = `mbids-${Date.now()}`;
    lastBatch = batch;
    await startWrite("apply_mb_ids", { batch });
  }

  async function writeChosen(row: Row, chosen: Candidate): Promise<void> {
    if (!confirm(`Tag the ${plural(row.songs, "song")} in “${row.name}” as:\n${chosen.artist} — ${chosen.album} (${chosen.edition || "edition unknown"})?`)) return;
    const batch = `mbids-${Date.now()}`;
    lastBatch = batch;
    await startWrite("apply_mb_ids", { batch, albums: [{ path: row.path, ...chosen }] });
  }

  async function undoLast(): Promise<void> {
    if (!lastBatch || !confirm("Take the IDs written by the last write out of the songs again?")) return;
    await startWrite("undo_mb_ids", { batch: lastBatch });
    lastBatch = null;
  }

  listen<{ kind?: string; done?: number; total?: number; current?: string; job_id?: string }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind !== "mb_ids" && p.kind !== "mb_ids_write") return;
    progress.textContent = `${p.kind === "mb_ids" ? "Checked" : "Written"} ${p.done ?? 0} of ${p.total ?? 0}${p.current ? ` · ${p.current}` : ""}`;
    if (p.kind === "mb_ids" && root.isConnected && !root.closest("[hidden]") && refreshTimer === undefined) {
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void load();
      }, 10_000);
    }
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: { songs?: number; albums?: number; restored?: number; left_alone?: number; stopped?: boolean; problems?: Problem[]; skipped?: Problem[] }; error?: { message: string } }>("job-finished", (event) => {
    const { job_id, ok, result, error } = event.payload;
    if (job_id !== scanJob && job_id !== writeJob) return;
    const wasWrite = job_id === writeJob;
    scanJob = null;
    writeJob = null;
    progress.textContent = "";
    if (!ok || !result) {
      note.replaceChildren(report(`Stopped: ${error?.message ?? "unknown error"}`));
    } else if (!wasWrite) {
      note.replaceChildren(report(result.stopped ? "Stopped. Press “Check for changes” to carry on where it ended." : "The check is finished."));
    } else if (result.restored !== undefined) {
      note.replaceChildren(report(`Undone: ${plural(result.restored, "tag")} taken out${result.left_alone ? `, ${result.left_alone} left because they changed since` : ""}.`, result.problems ?? []));
      deps.changed("MusicBrainz IDs taken out.");
    } else {
      const problems = [...(result.problems ?? []), ...(result.skipped ?? [])];
      note.replaceChildren(report(result.songs ? `IDs written into ${plural(result.songs ?? 0, "song")} in ${plural(result.albums ?? 0, "album")}.` : "Nothing needed writing.", problems));
      if (result.songs) deps.changed("MusicBrainz IDs written.");
    }
    void load();
  }).catch(() => undefined);

  root.append(
    el("h3", undefined, "Album IDs (MusicBrainz)"),
    el("p", "field-hint", "A MusicBrainz ID in each song says exactly which album it belongs to. It is what Picard, Navidrome and Jellyfin read, and it lets this program bring a stray song back in line with its album (genre, year, cover). Only albums that fit exactly are tagged automatically: the same songs, the same names and lengths, none missing. Other editions of the same album still get the album's ID. Anything else waits in a short list below for you."),
    note,
    summary,
    actions,
    progress,
    list,
    pager,
  );

  return {
    show: () => {
      offset = 0;
      void load();
    },
  };
}
