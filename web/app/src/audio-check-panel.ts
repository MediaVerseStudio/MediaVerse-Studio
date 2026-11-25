// Review > Audio check: AcoustID listens to a sample of each album already in the library and says whether the songs are
// what their tags say. A report: nothing changes unless the person ticks songs and presses "Use AcoustID's titles", which is
// journalled so Fix tags' Undo puts the old titles back. Files are never moved or deleted from here.

import { invoke, listen, showInFolder } from "./desktop-bridge";
import { el } from "./dom";
import { changes, coverage, describeHeard, titlesToWrite, type Heard, type Summary } from "./audio-check-logic";

type Filter = "problems" | "named" | "unknown" | "failed" | "agrees" | "dismissed";
type Listing = { summary: Summary; total: number; offset: number; folders: Heard[] };
const PAGE = 6;

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

const FILTERS: [Filter, string, keyof Summary][] = [
  ["problems", "Different songs", "problems"],
  ["named", "Untitled songs named", "named"],
  ["unknown", "Not in AcoustID", "unknown"],
  ["failed", "Could not be checked", "failed"],
  ["agrees", "Agree with their tags", "agrees"],
  ["dismissed", "Left as they are", "dismissed"],
];

function tail(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ");
}

export function initAudioCheckPanel(root: HTMLElement, deps: { changed: (message: string) => void }): { show: () => void } {
  root.classList.add("audit-panel");
  let filter: Filter = "problems";
  let offset = 0;
  let listing: Listing | null = null;
  let message = "";
  let job: { id: string; kind: "scan" | "folder" | "write"; path?: string } | null = null;
  let progress = "";
  // Songs ticked to take AcoustID's title, per album folder (by track number).
  const ticked = new Map<string, Set<number>>();

  async function load(): Promise<void> {
    try {
      listing = await invoke<Listing>("list_audio_check", { filter, offset, limit: PAGE });
    } catch (error) {
      message = `Could not read the results: ${(error as { message?: string }).message ?? String(error)}`;
    }
    draw();
  }

  async function start(kind: "scan" | "folder" | "write", command: string, args: Record<string, unknown>, path?: string): Promise<void> {
    try {
      const started = await invoke<{ job_id: string; already_running?: boolean }>(command, args);
      job = { id: started.job_id, kind, path };
      progress = kind === "scan" ? "Starting…" : kind === "folder" ? "Listening to every song…" : "Writing…";
      message = "";
    } catch (error) {
      message = (error as { message?: string }).message ?? String(error);
    }
    draw();
  }

  function draw(): void {
    const intro = el("p", undefined, "AcoustID can tell what a song is by listening to it. This listens to a few songs of each album and says whether they are the songs their tags name. It changes nothing by itself: you decide, album by album. It needs AcoustID switched on in Settings, and takes a while on a big library (about three songs a second at best).");
    const controls = el("div", "dialog-actions");
    const scan = button(job?.kind === "scan" ? "Checking…" : "Check the albums not checked yet", "");
    scan.disabled = job !== null;
    scan.addEventListener("click", () => void start("scan", "scan_audio_check", { again: false }));
    const again = button("Check everything again");
    again.disabled = job !== null;
    again.addEventListener("click", () => void start("scan", "scan_audio_check", { again: true }));
    controls.append(scan, again);
    if (job) {
      const stop = button("Stop");
      stop.addEventListener("click", () => void invoke("cancel_job", { job_id: job!.id }).catch(() => undefined));
      controls.append(stop, el("span", "field-hint", progress));
    }

    const chips = el("div", "dialog-actions");
    for (const [value, label, key] of FILTERS) {
      const chip = button(`${label} (${listing?.summary[key] ?? 0})`, value === filter ? "" : "secondary");
      chip.addEventListener("click", () => {
        filter = value;
        offset = 0;
        void load();
      });
      chips.append(chip);
    }
    const blurb: Record<Filter, string> = {
      problems: "Songs that sound like different songs than their titles. Look at each: an alternate title or a live version is fine (“It is fine”); a different song means the tags, or the file, are wrong.",
      named: "Songs with no real title that AcoustID recognised. Tick the ones to take its title.",
      unknown: "Albums AcoustID does not know (rare, new or private recordings). Nothing to compare.",
      failed: "Albums that could not be listened to (a file type or sample rate this cannot read, or AcoustID did not answer).",
      agrees: "Albums whose sampled songs are what their tags say.",
      dismissed: "Albums you said are fine as they are.",
    };

    const list = el("div", "audit-list");
    const rows = listing?.folders ?? [];
    if (!rows.length) list.append(el("p", "field-hint", listing && listing.summary.checked === 0 ? "Nothing has been checked yet. Press “Check the albums not checked yet”." : "Nothing to show here."));
    for (const row of rows) list.append(card(row));

    const pager = el("div", "dialog-actions");
    const total = listing?.total ?? 0;
    if (total > PAGE) {
      const previous = button("Previous");
      previous.disabled = offset === 0;
      previous.addEventListener("click", () => {
        offset = Math.max(0, offset - PAGE);
        void load();
      });
      const next = button("Next");
      next.disabled = offset + PAGE >= total;
      next.addEventListener("click", () => {
        offset += PAGE;
        void load();
      });
      pager.append(previous, el("span", "field-hint", `${offset + 1}–${Math.min(total, offset + PAGE)} of ${total}`), next);
    }
    root.replaceChildren(intro, controls, el("p", message ? "result-warning" : "field-hint", message || (listing ? `${listing.summary.checked} albums checked so far.` : "")), chips, el("p", "field-hint", blurb[filter]), list, pager);
  }

  function card(result: Heard): HTMLElement {
    const folder = result.folder ?? "";
    const section = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const text = el("div", "ft-card-text");
    text.append(
      el("div", "ft-card-title", [result.artist, result.album].filter(Boolean).join(" — ") || tail(folder)),
      el("div", "ft-card-folder", `${result.headline} ${coverage(result)}`),
      el("div", "ft-card-folder", folder),
    );
    if (result.album_hint) text.append(el("div", "ft-ev ft-ev-info", `AcoustID's best guess for the album: “${result.album_hint.title}”${result.album_hint.artist ? ` by ${result.album_hint.artist}` : ""} (${result.album_hint.tracks} of the ${result.album_hint.of} recognised songs).`));
    const actions = el("div", "ft-actions");
    const open = button("Show in folder");
    open.addEventListener("click", () => void showInFolder(result.files[0]?.path ?? folder));
    actions.append(open);
    if (result.asked < result.total) {
      const every = button(job?.kind === "folder" && job.path === folder ? "Listening…" : "Listen to every song");
      every.disabled = job !== null;
      every.title = "Asks AcoustID about all of this album's songs, not just a sample.";
      every.addEventListener("click", () => void start("folder", "check_folder_audio", { path: folder }, folder));
      actions.append(every);
    }
    const fine = button(result.dismissed ? "Show it again" : "It is fine");
    fine.title = result.dismissed ? "Puts this album back in the lists." : "These songs are right as they are (an alternate title, a live version). Take this album out of the list.";
    fine.addEventListener("click", () => {
      void invoke("dismiss_audio_check", { path: folder, undo: result.dismissed === true })
        .catch(() => undefined)
        .then(load);
    });
    actions.append(fine);
    head.append(text, actions);
    section.append(head);

    const table = el("table", "ft-table");
    const header = el("tr");
    const wanted = changes(result);
    if (wanted.length) header.append(el("th"));
    for (const name of ["Song", "Its title says", "AcoustID says"]) header.append(el("th", undefined, name));
    table.append(header);
    const mine = ticked.get(folder) ?? new Set<number>();
    ticked.set(folder, mine);
    for (const track of result.tracks) {
      const file = result.files.find((f) => f.number === track.number);
      const row = el("tr");
      if (wanted.length) {
        const cell = el("td");
        if (wanted.some((c) => c.track.number === track.number)) {
          const box = el("input");
          box.type = "checkbox";
          box.checked = mine.has(track.number);
          box.setAttribute("aria-label", "Use AcoustID's title for this song");
          box.addEventListener("change", () => {
            if (box.checked) mine.add(track.number);
            else mine.delete(track.number);
            draw();
          });
          cell.append(box);
        }
        row.append(cell);
      }
      row.append(el("td", "ft-name", file?.name ?? String(track.number)), el("td", undefined, file?.title ?? "(no title)"), el("td", track.state === "other" ? "result-warning" : undefined, describeHeard(track, result.files)));
      table.append(row);
    }
    section.append(table);
    if (wanted.length) {
      const write = button(job?.kind === "write" && job.path === folder ? "Writing…" : `Use AcoustID's titles for the ${mine.size} ticked song${mine.size === 1 ? "" : "s"}`, "");
      write.disabled = mine.size === 0 || job !== null;
      write.title = "Writes the ticked titles into those songs. Review > Fix tags can undo it.";
      write.addEventListener("click", () => {
        const titles = titlesToWrite(result, mine);
        void invoke<{ files: number; problems: unknown[] }>("apply_audio_names", { path: folder, titles })
          .then((done) => {
            ticked.delete(folder);
            message = done.files > 0 ? `Titles written to ${done.files} song${done.files === 1 ? "" : "s"}. Review > Fix tags can undo it.` : "Nothing was written.";
            deps.changed(message);
            return load();
          })
          .catch((error) => {
            message = (error as { message?: string }).message ?? String(error);
            draw();
          });
      });
      section.append(write);
    }
    return section;
  }

  listen<{ kind?: string; job_id?: string; done?: number; total?: number; current?: string }>("job-progress", (event) => {
    if (!job || event.payload.kind !== "audio_check_scan" || event.payload.job_id !== job.id) return;
    progress = `${event.payload.done ?? 0} of ${event.payload.total ?? "?"} albums${event.payload.current ? ` · ${tail(event.payload.current)}` : ""}`;
    if (root.isConnected && !root.closest("[hidden]")) draw();
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: { checked?: number; skipped?: number; stopped?: boolean }; error?: { message: string } }>("job-finished", (event) => {
    if (!job || event.payload.job_id !== job.id) return;
    const was = job;
    job = null;
    if (!event.payload.ok) message = event.payload.error?.message === "Stopped." ? "Stopped." : `It stopped: ${event.payload.error?.message ?? "unknown error"}`;
    else if (was.kind === "scan") message = `${event.payload.result?.stopped ? "Stopped. " : ""}Checked ${event.payload.result?.checked ?? 0} albums${event.payload.result?.skipped ? ` (${event.payload.result.skipped} were already checked)` : ""}.`;
    else message = "";
    if (root.isConnected && !root.closest("[hidden]")) void load();
  }).catch(() => undefined);

  return { show: () => void load() };
}
