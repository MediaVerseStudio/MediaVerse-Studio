// Review > Fix tags (ADR 0009): album folders with missing or "Unknown" tags, recognised by the read-only library
// scan (sidecar `scan_tag_repair`), shown 4 albums to a page with the best matches first, in a compact
// Explorer-like table: the proposed value in colour with the current one struck through beneath. Only empty or
// placeholder values are ever proposed. Apply writes the ticked suggestions on the page the person is looking at
// (owner, 2026-11-04: "let me be the one to verify what I'm seeing on each page and press Apply"), and the last
// batch can be undone.

import { invoke, listen, openExternal } from "./desktop-bridge";
import { el } from "./dom";
import { coverUrl } from "./cover-art";
import { COPY_FIELDS, editsFromAlbum, editsFromFound, libraryAlbums, withDifferences, type CopyField, type FoundAlbum, type LibraryAlbum, type SourceSong } from "./fix-tags-logic";
import { coverage, describeHeard, editsFromHeard, type Heard } from "./audio-check-logic";
import { NAME_FIELDS, compilePattern, detectPattern, editsFromNames, fitPattern } from "./filename-pattern";
import { describeLengthFit, type LengthFit } from "./rip-format";

type Field = "title" | "artist" | "album" | "album_artist" | "genre" | "year" | "track" | "disc";
type Tags = { title: string | null; artist: string | null; album: string | null; album_artist: string | null; genre: string | null; year: number | null; track: number | null; disc: number | null };
type FileRow = { path: string; stem: string; tags: Tags; length_ms: number; missing: Field[] };
/**
 * `album`: the value follows what the album's other tracks already say. `cleanup`: a tidied title (it replaces a
 * real value, so it is written only if the title is still what the scan saw).
 */
type Change = { field: Field; from: string | number | null; to: string; album?: boolean; hint?: "library" | "musicbrainz" | null; cleanup?: boolean; confirm?: boolean };
/** `extra`: the file is not on this release (a bonus track); only album-wide values are suggested for it. */
type FileProposal = { path: string; track: number; changes: Change[]; differences?: Change[]; fit: number; extra?: boolean };
type Evidence = { kind: "good" | "info" | "warn"; text: string };
type Proposal = { release_id: string; artist: string; album: string; edition: string; barcode: string; catalog_number: string; source?: string; url?: string; confidence: number; evidence: Evidence[]; files: FileProposal[] };
type FolderResult = { folder: string; clues: { artist: string | null; album: string | null }; files: FileRow[]; unreadable: { path: string; message: string }[]; method?: string; proposals?: Proposal[]; note?: string };
type FolderEntry = { path: string; status: "identified" | "no_match" | "too_few" | "error" | "complete" | "left_alone"; confidence: number; result: FolderResult };
type Summary = { ready: number; choose: number; none: number; complete: number; applied?: number; left_alone?: number; scanned: number };
type Batch = { id: number; at: number; albums: number; files: number };
type Page = { summary: Summary; total: number; offset: number; folders: FolderEntry[]; last_batch?: Batch | null; genres?: string[] };
type WriteResult = { batch?: number | null; albums?: number; files: number; fields?: number; confirmed?: number; problems: { path: string; message: string }[]; skipped?: { path: string; message: string }[] };
type Status = { running: boolean; total?: number; done?: number; identified?: number; unmatched?: number; current?: string };
type Filter = "all" | "ready" | "choose" | "none" | "left_alone";

/** A result of "Search other sources by name" for an album nothing identified. */
type FoundCandidate = { album: FoundAlbum & { source: string; release?: { date?: string; label?: string; country?: string; catalog_number?: string } | null }; sources: string[]; length_fit?: LengthFit | null };
type Tool = "search" | "copy" | "names" | "listen";
type Finder = {
  tool: Tool | null;
  artist: string;
  album: string;
  job: string | null;
  status: string;
  candidates: FoundCandidate[];
  files: string[];
  picked: number;
  // Copy tags from another album of the library.
  copyQuery: string;
  copyPicked: number;
  copyFields: Set<CopyField>;
  // Tags from file names: the pattern chosen (or typed).
  pattern: string;
  note: string;
  // Identify by listening (AcoustID): the running job and what it heard.
  listenJob: string | null;
  heard: Heard | null;
};
const SOURCE_NAMES: Record<string, string> = { musicbrainz: "MusicBrainz", discogs: "Data provided by Discogs", itunes: "iTunes catalogue", deezer: "Deezer catalogue" };

const PAGE_SIZE = 4;
const FIELDS: { field: Field; label: string }[] = [
  { field: "title", label: "Title" },
  { field: "artist", label: "Contributing artists" },
  { field: "album", label: "Album" },
  { field: "album_artist", label: "Album artist" },
  { field: "genre", label: "Genre" },
  { field: "year", label: "Year" },
  { field: "track", label: "#" },
  { field: "disc", label: "Disc" },
];

/** The table's columns, in order. */
const COLUMNS: Field[] = ["disc", "track", "title", "artist", "album", "album_artist", "genre", "year"];

/** What the person has chosen for one album: whether it is included, which edition, and which files and fields. */
type Choice = { checked: boolean; edition: number; skipFiles: Set<string>; skipFields: Set<Field>; open: boolean; editionsOpen: boolean; edits: Map<string, Map<Field, string>> };

/** Fields shared by a whole album: one box above the table sets them for every file. */
const ALBUM_FIELDS: Field[] = ["album", "album_artist", "artist", "genre", "year"];

function current(tags: Tags, field: Field): string | null {
  const value = tags[field];
  return value === null || value === undefined ? null : String(value);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function confidenceClass(value: number): string {
  return value >= 90 ? "ft-high" : value >= 70 ? "ft-mid" : "ft-low";
}

export type FixTagsDeps = { songs: () => SourceSong[] };

export function initFixTags(root: HTMLElement, deps: FixTagsDeps): { show: () => void } {
  let filter: Filter = "all";
  let offset = 0;
  let page: Page | null = null;
  let status: Status = { running: false };
  let loading = false;
  const choices = new Map<string, Choice>();
  // Writing (Apply or Undo): the running job, its progress, and the last outcome to report.
  let writing: { job: string; undo: boolean; done: number; total: number } | null = null;
  let report: { text: string; problems: { path: string; message: string }[]; kind: "good" | "warn" } | null = null;
  // Off by default: Apply only fills empty tags. On: values the release spells differently are replaced too (the
  // old values are journalled, so Undo puts them back).
  let replaceDiffering = false;

  const finders = new Map<string, Finder>();
  const finderFor = (entry: FolderEntry): Finder => {
    let finder = finders.get(entry.path);
    if (!finder) {
      const clues = entry.result.clues;
      finder = {
        tool: null, artist: clues.artist ?? "", album: clues.album ?? "", job: null, status: "", candidates: [], files: [], picked: 0,
        copyQuery: [clues.artist, clues.album].filter(Boolean).join(" "), copyPicked: 0, copyFields: new Set(["title", "artist", "track", "disc", "album", "album_artist", "year", "genre"] as CopyField[]),
        pattern: "", note: "", listenJob: null, heard: null,
      };
      finders.set(entry.path, finder);
    }
    return finder;
  };

  const choiceFor = (entry: FolderEntry): Choice => {
    let choice = choices.get(entry.path);
    if (!choice) {
      choice = { checked: entry.status === "identified" && entry.confidence >= 90, edition: 0, skipFiles: new Set(), skipFields: new Set(), open: false, editionsOpen: false, edits: new Map() };
      choices.set(entry.path, choice);
    }
    return choice;
  };

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      [page, status] = await Promise.all([invoke<Page>("list_tag_repair", { filter, offset, limit: PAGE_SIZE }), invoke<Status>("tag_repair_status")]);
      // Past the end (the last albums of a group were just fixed): go to the last page that has any.
      if (!page.folders.length && offset > 0 && page.total > 0) {
        offset = Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        page = await invoke<Page>("list_tag_repair", { filter, offset, limit: PAGE_SIZE });
      }
      // The first album on the first page opens by itself, so the table is seen at once.
      const first = page.folders[0];
      if (first && offset === 0 && !choices.has(first.path)) choiceFor(first).open = true;
    } catch (error) {
      root.replaceChildren(el("p", "error", `Could not read the tag repair results: ${(error as { message?: string }).message ?? String(error)}`));
      loading = false;
      return;
    }
    loading = false;
    render();
  }

  /** Writes the ticked suggestions on this page, after the person confirms. */
  async function applySelection(albums: number, files: number): Promise<void> {
    if (!page || writing) return;
    const chosen = page.folders
      .filter((entry) => choiceFor(entry).checked && entry.result.proposals?.[choiceFor(entry).edition])
      .map((entry) => {
        const choice = choiceFor(entry);
        let edits: Record<string, Record<string, string>> = {};
        for (const [path, fields] of choice.edits) edits[path] = Object.fromEntries(fields);
        // "Also replace differing values": the release's spelling goes in as if it had been typed, unless the person
        // typed something else there.
        if (replaceDiffering) edits = withDifferences(edits, entry.result.proposals?.[choice.edition]?.files ?? [], choice.skipFiles, choice.skipFields);
        return { path: entry.path, edition: choice.edition, skip_files: [...choice.skipFiles], skip_fields: [...choice.skipFields], edits };
      });
    if (!chosen.length) return;
    const rule = replaceDiffering
      ? "Empty or “Unknown” tags are filled, and values the release spells differently are replaced."
      : "Only empty or “Unknown” tags are filled.";
    if (!confirm(`Write the ticked suggestions into ${files} files (${albums} albums)?\n\n${rule} You can undo this afterwards.`)) return;
    try {
      const { job_id } = await invoke<{ job_id: string }>("apply_tag_repair", { albums: chosen });
      writing = { job: job_id, undo: false, done: 0, total: files };
      report = null;
      render();
    } catch (error) {
      alert(`Could not start writing: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  async function undoBatch(batch: Batch): Promise<void> {
    if (writing) return;
    if (!confirm(`Put the ${batch.files} files from the last Apply back as they were?`)) return;
    try {
      const { job_id } = await invoke<{ job_id: string }>("undo_tag_repair", { batch: batch.id });
      writing = { job: job_id, undo: true, done: 0, total: batch.files };
      report = null;
      render();
    } catch (error) {
      alert(`Could not undo: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  /** Sets albums aside ("leave as it is") or takes them back into the checks. */
  async function leaveAlone(paths: string[], leave: boolean): Promise<void> {
    try {
      await invoke(leave ? "leave_albums_alone" : "stop_leaving_alone", { paths });
      for (const path of paths) choices.delete(path);
      report = {
        text: leave
          ? `${paths.length === 1 ? "That album is" : `${paths.length} albums are`} left as ${paths.length === 1 ? "it is" : "they are"}: not listed here and not checked again. They are under “Left alone”, where you can take them back.`
          : "Taken back: the next “Check for changes” reads it again.",
        problems: [],
        kind: "good",
      };
      await load();
    } catch (error) {
      alert(`Could not save that: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  async function startScan(again = false): Promise<void> {
    try {
      await invoke("scan_tag_repair", { again });
      status = { running: true, done: 0, total: 0 };
      render();
    } catch (error) {
      alert(`The scan could not start: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  let refreshTimer: number | undefined;
  listen<Status & { kind?: string }>("job-progress", (event) => {
    if (event.payload.kind !== "tag_repair") return;
    status = { ...event.payload, running: true };
    if (!root.isConnected || root.closest("[hidden]")) return;
    renderProgress();
    // New results come in as the scan goes: refresh the list now and then, not on every folder.
    if (refreshTimer === undefined) {
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void load();
      }, 15_000);
    }
  }).catch(() => undefined);
  listen<{ job_id: string; done?: number; total?: number; kind?: string }>("job-progress", (event) => {
    if (event.payload.kind !== "tag_write" || !writing || event.payload.job_id !== writing.job) return;
    writing.done = event.payload.done ?? 0;
    writing.total = event.payload.total ?? 0;
    if (root.isConnected && !root.closest("[hidden]")) render();
  }).catch(() => undefined);
  // The answer to "Search other sources by name" for an album.
  listen<{ job_id: string; ok: boolean; result?: { candidates: FoundCandidate[]; errors: { source: string; message: string }[]; files: string[] }; error?: { message: string } }>("job-finished", (event) => {
    const finder = [...finders.values()].find((f) => f.job !== null && f.job === event.payload.job_id);
    if (!finder) return;
    finder.job = null;
    if (!event.payload.ok || !event.payload.result) {
      finder.status = `The search stopped: ${event.payload.error?.message ?? "unknown error"}`;
    } else {
      const { candidates, errors, files } = event.payload.result;
      finder.candidates = candidates;
      finder.files = files;
      finder.picked = 0;
      const problems = errors.map((e) => `${SOURCE_NAMES[e.source] ?? e.source}: ${e.message}`).join(" ");
      finder.status = candidates.length ? `${candidates.length} possible album${candidates.length === 1 ? "" : "s"} with ${files.length} tracks.${problems ? ` ${problems}` : ""}` : `Nothing with ${files.length} tracks was found for that name.${problems ? ` ${problems}` : ""} Try other spellings, or type the details by hand in the table.`;
    }
    if (root.isConnected && !root.closest("[hidden]")) render();
  }).catch(() => undefined);

  // The answer to "Identify by listening".
  listen<{ job_id: string; ok: boolean; result?: Heard; error?: { message: string } }>("job-finished", (event) => {
    const finder = [...finders.values()].find((f) => f.listenJob !== null && f.listenJob === event.payload.job_id);
    if (!finder) return;
    finder.listenJob = null;
    if (!event.payload.ok || !event.payload.result) {
      finder.note = `Listening stopped: ${event.payload.error?.message ?? "unknown error"}`;
    } else {
      finder.heard = event.payload.result;
      finder.note = "";
    }
    if (root.isConnected && !root.closest("[hidden]")) render();
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: WriteResult; error?: { message: string } }>("job-finished", (event) => {
    if (writing && event.payload.job_id === writing.job) {
      const undo = writing.undo;
      writing = null;
      const result = event.payload.result;
      if (!event.payload.ok || !result) {
        report = { text: `${undo ? "Undo" : "Applying"} stopped: ${event.payload.error?.message ?? "unknown error"}`, problems: [], kind: "warn" };
      } else {
        const problems = [...result.problems, ...(result.skipped ?? [])];
        const confirmed = result.confirmed ?? 0;
        const kept = confirmed > 0 ? ` ${confirmed} ${confirmed === 1 ? "tag was" : "tags were"} confirmed as right (such as a song called “Untitled”) and will not be listed again.` : "";
        const text = undo
          ? `Undone: ${result.files} files put back as they were.`
          : result.files > 0
            ? `Fixed ${result.fields ?? 0} tags in ${result.files} files (${result.albums ?? 0} albums).${kept} The next albums are shown below.`
            : confirmed > 0
              ? `Nothing needed writing.${kept}`
              : "Nothing was written.";
        report = { text, problems, kind: problems.length ? "warn" : "good" };
      }
      if (!undo) for (const entry of page?.folders ?? []) choices.delete(entry.path);
      void load();
      return;
    }
    if (status.running) {
      status = { running: false };
      void load();
    }
  }).catch(() => undefined);

  const progressBox = el("div", "ft-progress");

  function renderProgress(): void {
    progressBox.replaceChildren();
    if (status.running) {
      const done = status.done ?? 0;
      const total = status.total ?? 0;
      progressBox.append(el("div", "ft-progress-text", total ? `Identifying in the background: ${done} of ${total} folders` : "Looking through your library…"));
      const bar = el("div", "ft-bar");
      const fill = el("div", "ft-bar-fill");
      fill.style.width = total ? `${Math.round((100 * done) / total)}%` : "0%";
      bar.append(fill);
      progressBox.append(bar);
      if (status.current) progressBox.append(el("div", "ft-progress-current", status.current));
    } else {
      const scan = el("button", "secondary", page && page.summary.scanned > 0 ? "Check for changes" : "Scan my library");
      scan.type = "button";
      scan.title = "Reads your files and asks MusicBrainz about the albums with missing tags. Nothing is written to your files.";
      scan.addEventListener("click", () => void startScan(false));
      progressBox.append(scan);
    }
  }

  function render(): void {
    if (!page) return;
    const { summary } = page;
    const header = el("div", "ft-head");
    const intro = el("div", "ft-intro");
    const needing = summary.ready + summary.choose + summary.none;
    intro.append(
      el("p", undefined, page.summary.scanned === 0 ? "Scan your library to find albums with missing or “Unknown” tags." : `${needing} album folders have missing or “Unknown” tags. Best matches first: check them, then apply.${summary.applied ? ` ${summary.applied} fixed so far.` : ""}`),
    );
    renderProgress();
    header.append(intro, progressBox);

    const chips = el("div", "ft-chips");
    const filters: [Filter, string][] = [
      ["all", `All ${needing}`],
      ["ready", `Ready, 90% or more (${summary.ready})`],
      ["choose", `Check or choose an edition (${summary.choose})`],
      ["none", `Not identified (${summary.none})`],
    ];
    if ((summary.left_alone ?? 0) > 0 || filter === "left_alone") filters.push(["left_alone", `Left alone (${summary.left_alone ?? 0})`]);
    for (const [value, label] of filters) {
      const chip = el("button", value === filter ? "ft-chip is-on" : "ft-chip", label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        filter = value;
        offset = 0;
        void load();
      });
      chips.append(chip);
    }

    const bar = el("div", "ft-bar-sticky");
    const all = el("label", "ft-check");
    const allBox = el("input");
    allBox.type = "checkbox";
    const selectable = page.folders.filter((f) => f.status === "identified" && f.confidence >= 70);
    allBox.checked = selectable.length > 0 && selectable.every((f) => choiceFor(f).checked);
    allBox.addEventListener("change", () => {
      for (const f of selectable) choiceFor(f).checked = allBox.checked;
      render();
    });
    all.append(allBox, document.createTextNode(" Select all on this page"));
    let albums = 0;
    let files = 0;
    for (const entry of page.folders) {
      const choice = choiceFor(entry);
      const proposal = entry.result.proposals?.[choice.edition];
      if (!choice.checked || !proposal) continue;
      // A file counts when a suggestion (not unticked, not left empty) or something typed will be written.
      const byPath = new Map(proposal.files.map((f) => [f.path, f]));
      const count = entry.result.files.filter((file) => {
        if (choice.skipFiles.has(file.path)) return false;
        if ([...(choice.edits.get(file.path)?.values() ?? [])].some((v) => v.trim() !== "")) return true;
        if (replaceDiffering && (byPath.get(file.path)?.differences ?? []).some((d) => !choice.skipFields.has(d.field) && !choice.edits.get(file.path)?.has(d.field))) return true;
        return (byPath.get(file.path)?.changes ?? []).some((c) => !choice.skipFields.has(c.field) && valueFor(choice, file.path, c).trim() !== "");
      }).length;
      if (count) {
        albums += 1;
        files += count;
      }
    }
    const apply = el("button", undefined, writing && !writing.undo ? `Writing ${writing.done} of ${writing.total || "…"} files…` : `Apply suggested fixes (${files})`);
    apply.type = "button";
    apply.disabled = files === 0 || writing !== null || status.running;
    apply.title = status.running ? "Wait for the library check to finish." : "Writes the ticked suggestions on this page into your files. You can undo it afterwards.";
    apply.addEventListener("click", () => void applySelection(albums, files));
    const replace = el("label", "ft-check");
    const replaceBox = el("input");
    replaceBox.type = "checkbox";
    replaceBox.checked = replaceDiffering;
    replaceBox.addEventListener("change", () => {
      replaceDiffering = replaceBox.checked;
      render();
    });
    replace.title = "Off (the safe way): only empty tags and “Unknown …” or “Track N” values are filled. On: a tag that already has a real value but is spelled differently on the release (the yellow ones) is replaced by the release's spelling too. Untick a field under “Write these fields” to keep it, or type your own. Undo puts the old values back.";
    replace.append(replaceBox, document.createTextNode(" Also replace values that differ from the release"));
    bar.append(
      all,
      el("span", "ft-selection", `${albums} albums, ${files} files selected.`),
      el("span", "ft-rule", replaceDiffering ? "Fills missing tags and replaces tags the release spells differently. Undo puts them back." : "Fills only missing tags and “Unknown …” or “Track N” values. Tags that already have a real value are left alone."),
      replace,
      apply,
    );
    const notice = el("div", "ft-notice");
    if (writing?.undo) notice.append(el("p", "ft-testing", `Undoing: ${writing.done} of ${writing.total || "…"} files…`));
    if (report) {
      const box = el("div", `ft-report ft-report-${report.kind}`);
      box.append(el("p", undefined, report.text));
      if (report.problems.length) {
        const list = el("ul", "ft-problems");
        for (const problem of report.problems.slice(0, 20)) list.append(el("li", undefined, `${fileName(problem.path)}: ${problem.message}`));
        if (report.problems.length > 20) list.append(el("li", undefined, `…and ${report.problems.length - 20} more.`));
        box.append(list);
      }
      notice.append(box);
    }
    const last = page.last_batch;
    if (last && !writing) {
      const undoBox = el("div", "ft-undo");
      const when = new Date(last.at * 1000).toLocaleString();
      undoBox.append(el("span", undefined, `Last applied ${when}: ${last.files} files in ${last.albums} albums.`));
      const undo = el("button", "secondary", "Undo it");
      undo.type = "button";
      undo.disabled = status.running;
      undo.addEventListener("click", () => void undoBatch(last));
      undoBox.append(undo);
      notice.append(undoBox);
    }
    const testing = notice;

    const list = el("div", "ft-list");
    if (!page.folders.length) list.append(el("p", "ft-empty", summary.scanned === 0 ? "Nothing scanned yet." : "Nothing in this group."));
    for (const entry of page.folders) list.append(albumCard(entry));

    const genres = el("datalist");
    genres.id = "ft-genres";
    for (const genre of page.genres ?? []) {
      const option = el("option");
      option.value = genre;
      genres.append(option);
    }
    root.replaceChildren(header, chips, testing, pager(), bar, list, pager(), genres);
  }

  /** Page buttons; shown above and below the albums so they are always within reach. */
  function pager(): HTMLElement {
    const total = page?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const at = Math.floor(offset / PAGE_SIZE) + 1;
    const goTo = (target: number): void => {
      offset = (Math.min(Math.max(target, 1), pages) - 1) * PAGE_SIZE;
      void load().then(() => root.scrollIntoView({ block: "start" }));
    };
    const button = (label: string, target: number, disabled: boolean): HTMLButtonElement => {
      const b = el("button", "secondary", label);
      b.type = "button";
      b.disabled = disabled;
      b.addEventListener("click", () => goTo(target));
      return b;
    };
    const box = el("div", "ft-pager");
    const buttons = el("div", "ft-pager-buttons");
    buttons.append(button("First", 1, at <= 1), button("Previous", at - 1, at <= 1), button("Next page", at + 1, at >= pages), button("Last", pages, at >= pages));
    box.append(el("span", undefined, `Page ${at} of ${pages} · ${PAGE_SIZE} albums per page`), buttons);
    return box;
  }

  function albumCard(entry: FolderEntry): HTMLElement {
    const choice = choiceFor(entry);
    const result = entry.result;
    const proposal = result.proposals?.[choice.edition];
    const card = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const box = el("input");
    box.type = "checkbox";
    box.checked = choice.checked;
    box.disabled = !proposal;
    box.setAttribute("aria-label", "Include this album");
    box.addEventListener("change", () => {
      choice.checked = box.checked;
      render();
    });
    const titleText = proposal ? `${proposal.artist} — ${proposal.album}` : [result.clues.artist, result.clues.album].filter(Boolean).join(" — ") || "Not identified yet";
    const initial = el("div", "ft-initial", (proposal?.artist ?? result.clues.artist ?? "?").slice(0, 2).toUpperCase());
    // The album's own cover, when its files have one: the quickest way to see whether a match is right.
    const firstFile = result.files[0]?.path;
    if (firstFile) {
      void coverUrl(firstFile).then((url) => {
        if (!url) return;
        const image = el("img", "ft-cover");
        image.alt = "";
        image.src = url;
        initial.replaceChildren(image);
      });
    }
    const text = el("div", "ft-card-text");
    text.append(el("div", "ft-card-title", titleText), el("div", "ft-card-folder", `${result.folder} · ${result.files.length} files${result.method ? ` · found by ${result.method}` : ""}`));
    const evidence = el("div", "ft-evidence");
    for (const item of proposal?.evidence ?? []) evidence.append(el("span", `ft-ev ft-ev-${item.kind}`, item.text));
    if (!proposal && result.note) evidence.append(el("span", "ft-ev ft-ev-warn", result.note));
    for (const bad of result.unreadable) evidence.append(el("span", "ft-ev ft-ev-warn", `Could not read ${fileName(bad.path)}`));
    text.append(evidence);
    // Where the suggestion comes from, with a link to it. Discogs' API terms require exactly this notice, linked to
    // the Discogs page holding the data, directly beside it.
    if (proposal?.url) {
      const source = el("a", "ft-source", proposal.source === "discogs" ? "Data provided by Discogs" : "View on MusicBrainz");
      source.href = proposal.url;
      source.addEventListener("click", (event) => {
        event.preventDefault();
        void openExternal(proposal.url!);
      });
      text.append(source);
    }
    const score = el("div", "ft-score");
    const fromNames = proposal?.source === "folder";
    score.append(
      el("div", `ft-score-value ${fromNames ? "ft-low" : confidenceClass(proposal?.confidence ?? 0)}`, proposal && !fromNames ? `${proposal.confidence}%` : "—"),
      el("div", "ft-score-label", fromNames ? "No release found: check and edit" : proposal ? (proposal.confidence >= 90 ? "Ready to apply" : proposal.confidence >= 70 ? "Check before applying" : "Doubtful") : entry.status === "too_few" ? "Too few files" : entry.status === "error" ? "Lookup failed" : "Not found"),
    );
    const actions = el("div", "ft-actions");
    const proposals = result.proposals ?? [];
    if (proposals.length > 1) {
      const editions = el("button", "secondary", choice.editionsOpen ? "Hide editions" : `Other editions (${proposals.length - 1})`);
      editions.type = "button";
      editions.addEventListener("click", () => {
        choice.editionsOpen = !choice.editionsOpen;
        render();
      });
      actions.append(editions);
    }
    const toggle = el("button", "secondary", choice.open ? "Hide files" : "Show files");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      choice.open = !choice.open;
      render();
    });
    actions.append(toggle);
    // "Leave as it is": the person has looked at this album and its tags are right (a demo whose songs really are
    // "Track 1" to "Track 11"); it stops coming back, whatever the checks learn later.
    if (entry.status === "left_alone") {
      const back = el("button", "secondary", "Check it again");
      back.type = "button";
      back.title = "Takes this album back into the checks; the next “Check for changes” reads it again.";
      back.addEventListener("click", () => void leaveAlone([entry.path], false));
      actions.append(back);
    } else {
      const leave = el("button", "secondary", "Leave as it is");
      leave.type = "button";
      leave.title = "Its tags are right as they are: do not list this album again, and do not check it again. You can take it back under “Left alone”.";
      leave.addEventListener("click", () => void leaveAlone([entry.path], true));
      actions.append(leave);
    }
    head.append(box, initial, text, score, actions);
    card.append(head);
    // An album nothing identified: more ways to tag it where it is (search by name across the sources, or type below).
    if (!proposal || proposal.source === "folder") {
      const finder = finderFor(entry);
      const tools: [Tool, string, string, string][] = [
        ["search", "Search other sources by name…", "Hide search", "Looks for this album by name on MusicBrainz, Discogs (if you switched it on), iTunes and Deezer, and fills the details in below for you to check. Your files stay where they are."],
        ["copy", "Copy tags from another album…", "Hide copy", "Types tags from another album of your library (another edition, or the same album kept elsewhere) into this one for you to check."],
        ["names", "Tags from file names…", "Hide file names", "Reads track numbers, titles and artists out of the file names with a pattern, and types them into the table for you to check."],
        ["listen", "Identify by listening…", "Hide listening", "AcoustID listens to every song and says what it is (it needs AcoustID switched on in Settings). Only the audio's fingerprint is sent. The names it finds are typed into the table for you to check."],
      ];
      for (const [tool, label, hide, title] of tools) {
        const open = el("button", "secondary", finder.tool === tool ? hide : label);
        open.type = "button";
        open.title = title;
        open.addEventListener("click", () => {
          finder.tool = finder.tool === tool ? null : tool;
          render();
        });
        actions.append(open);
      }
      if (finder.tool === "search") card.append(finderPanel(entry, choice, finder));
      if (finder.tool === "copy") card.append(copyPanel(entry, choice, finder));
      if (finder.tool === "names") card.append(namesPanel(entry, choice, finder));
      if (finder.tool === "listen") card.append(listenPanel(entry, choice, finder));
    }

    if (choice.editionsOpen && proposals.length > 1) {
      const list = el("div", "ft-editions");
      list.append(el("p", "field-hint", "Releases that fit these files. The track lengths and names decide the score; pick another edition if you know yours."));
      proposals.forEach((option, index) => {
        const label = el("label", "ft-edition");
        const radio = el("input");
        radio.type = "radio";
        radio.name = `edition-${entry.path}`;
        radio.checked = index === choice.edition;
        radio.addEventListener("change", () => {
          choice.edition = index;
          render();
        });
        label.append(radio, el("strong", confidenceClass(option.confidence), `${option.confidence}%`), el("span", undefined, option.edition || "(no details)"), el("span", "ft-edition-extra", [option.catalog_number, option.barcode].filter(Boolean).join(" · ")));
        list.append(label);
      });
      card.append(list);
    }

    if (choice.open) {
      if (proposal) {
        const fields = el("div", "ft-fields");
        fields.append(el("span", undefined, "Write these fields:"));
        for (const { field, label } of FIELDS) {
          if (!proposal.files.some((f) => f.changes.some((c) => c.field === field) || (replaceDiffering && (f.differences ?? []).some((d) => d.field === field)))) continue;
          const item = el("label", "ft-check");
          const input = el("input");
          input.type = "checkbox";
          input.checked = !choice.skipFields.has(field);
          input.addEventListener("change", () => {
            if (input.checked) choice.skipFields.delete(field);
            else choice.skipFields.add(field);
            render();
          });
          item.append(input, document.createTextNode(` ${label === "#" ? "Track number" : label}`));
          fields.append(item);
        }
        card.append(fields, albumBoxes(entry, choice, proposal));
      }
    } else if (proposal) {
      // Album-wide values some songs still lack (often the genre or the year) have their boxes on the card, so
      // they can be filled without opening the files.
      const lacking = ALBUM_FIELDS.filter((field) => entry.result.files.some((file) => !effective(choice, proposal, file, field).trim()));
      if (lacking.length) card.append(albumBoxes(entry, choice, proposal, lacking));
    }
    if (choice.open) {
      card.append(fileTable(entry, choice, proposal));
    }
    return card;
  }

  /** Search by name for an album, and fill in the details of the result picked (nothing is written until Apply). */
  function finderPanel(entry: FolderEntry, choice: Choice, finder: Finder): HTMLElement {
    const panel = el("div", "ft-finder");
    const form = el("div", "dialog-actions");
    const artist = el("input", "ft-input");
    artist.type = "text";
    artist.placeholder = "Artist";
    artist.value = finder.artist;
    artist.setAttribute("aria-label", "Artist to search for");
    const album = el("input", "ft-input");
    album.type = "text";
    album.placeholder = "Album title";
    album.value = finder.album;
    album.setAttribute("aria-label", "Album to search for");
    const search = el("button", undefined, finder.job ? "Searching…" : "Search");
    search.type = "button";
    search.disabled = finder.job !== null;
    const run = async (): Promise<void> => {
      finder.artist = artist.value.trim();
      finder.album = album.value.trim();
      if (!finder.artist && !finder.album) {
        finder.status = "Type an album title or an artist to search for.";
        render();
        return;
      }
      try {
        const started = await invoke<{ job_id: string }>("search_folder_album", { path: entry.path, artist: finder.artist, album: finder.album });
        finder.job = started.job_id;
        finder.status = "Searching MusicBrainz, Discogs, iTunes and Deezer…";
      } catch (error) {
        finder.status = `Could not search: ${(error as { message?: string }).message ?? String(error)}`;
      }
      render();
    };
    search.addEventListener("click", () => void run());
    for (const input of [artist, album]) input.addEventListener("keydown", (event) => { if (event.key === "Enter") void run(); });
    form.append(artist, album, search);
    panel.append(form);
    if (finder.status) panel.append(el("p", "field-hint", finder.status));
    finder.candidates.forEach((candidate, index) => {
      const label = el("label", "ft-edition");
      const radio = el("input");
      radio.type = "radio";
      radio.name = `found-${entry.path}`;
      radio.checked = index === finder.picked;
      radio.addEventListener("change", () => {
        finder.picked = index;
      });
      const info = candidate.album;
      const edition = [info.release?.date, info.release?.country, info.release?.label, info.release?.catalog_number].filter(Boolean).join(" · ");
      const lengths = describeLengthFit(candidate.length_fit);
      const text = el("span");
      text.append(el("strong", undefined, `${info.album_artist} — ${info.album}${info.year ? ` (${info.year})` : ""}`), document.createTextNode(` ${[edition, candidate.sources.map((s) => SOURCE_NAMES[s] ?? s).join(", ")].filter(Boolean).join(" · ")}`));
      if (lengths) text.append(el("span", lengths.kind === "warn" ? "result-warning" : "field-hint", ` ${lengths.text}`));
      label.append(radio, text);
      panel.append(label);
    });
    if (finder.candidates.length) {
      const use = el("button", undefined, "Use these details");
      use.type = "button";
      use.title = "Types this album's details into the table below (every song). Check them, change what is wrong, then press Apply.";
      use.addEventListener("click", () => {
        const picked = finder.candidates[finder.picked];
        if (!picked) return;
        const edits = editsFromFound(finder.files, picked.album);
        choice.edits = new Map(Object.entries(edits).map(([path, fields]) => [path, new Map(Object.entries(fields) as [Field, string][])]));
        choice.open = true;
        choice.checked = true;
        finder.status = "The details are filled in below. Check them against your files, change what is wrong, then press Apply.";
        render();
      });
      panel.append(use);
    }
    return panel;
  }

  /** The folder's files in track order: disc, then the track tag, then the file name. */
  function orderedFiles(entry: FolderEntry): FileRow[] {
    return [...entry.result.files].sort((a, b) => (a.tags.disc ?? 1) - (b.tags.disc ?? 1) || (a.tags.track ?? 999) - (b.tags.track ?? 999) || a.stem.localeCompare(b.stem, undefined, { numeric: true }));
  }

  /** Types the edits into the table (nothing is written until Apply). */
  function fill(choice: Choice, edits: Record<string, Record<string, string>>): void {
    choice.edits = new Map(Object.entries(edits).map(([path, fields]) => [path, new Map(Object.entries(fields) as [Field, string][])]));
    choice.open = true;
    choice.checked = Object.keys(edits).length > 0;
  }

  /** Identify by listening: AcoustID names the songs; the names are typed into the table, or the album is searched by the name it suggests. */
  function listenPanel(entry: FolderEntry, choice: Choice, finder: Finder): HTMLElement {
    const panel = el("div", "ft-finder");
    const go = el("button", undefined, finder.listenJob ? "Listening…" : finder.heard ? "Listen again" : "Listen to the songs");
    go.type = "button";
    go.disabled = finder.listenJob !== null;
    go.addEventListener("click", () => {
      void invoke<{ job_id: string }>("check_folder_audio", { path: entry.path })
        .then((started) => {
          finder.listenJob = started.job_id;
          finder.heard = null;
          finder.note = "Listening to every song and asking AcoustID. This takes a few seconds per song…";
          render();
        })
        .catch((error) => {
          finder.note = (error as { message?: string }).message ?? String(error);
          render();
        });
    });
    panel.append(el("div", "dialog-actions"));
    (panel.firstElementChild as HTMLElement).append(go);
    if (finder.note) panel.append(el("p", "field-hint", finder.note));
    const heard = finder.heard;
    if (!heard) return panel;
    panel.append(el("p", undefined, `${heard.headline} ${coverage(heard)}`));
    const table = el("table", "ft-table");
    const head = el("tr");
    for (const name of ["Song", "Its title says", "AcoustID says"]) head.append(el("th", undefined, name));
    table.append(head);
    for (const track of heard.tracks) {
      const file = heard.files.find((f) => f.number === track.number);
      const row = el("tr");
      row.append(el("td", "ft-name", file?.name ?? String(track.number)), el("td", undefined, file?.title ?? "(no title)"), el("td", track.state === "other" ? "result-warning" : undefined, describeHeard(track, heard.files)));
      table.append(row);
    }
    panel.append(table);
    const buttons = el("div", "dialog-actions");
    const edits = editsFromHeard(heard, (path) => entry.result.files.find((f) => f.path === path)?.tags.artist ?? null);
    const use = el("button", undefined, "Use these song names");
    use.type = "button";
    use.disabled = Object.keys(edits).length === 0;
    use.title = "Types the names AcoustID found into the table below. Check them, then press Apply.";
    use.addEventListener("click", () => {
      fill(choice, edits);
      finder.note = "The names are filled in below. Check them against your files, then press Apply.";
      render();
    });
    buttons.append(use);
    if (heard.album_hint) {
      const hint = heard.album_hint;
      const search = el("button", "secondary", `Search for “${hint.title}”`);
      search.type = "button";
      search.title = `AcoustID thinks most of these songs are on “${hint.title}”${hint.artist ? ` by ${hint.artist}` : ""} (${hint.tracks} of ${hint.of}). Searches MusicBrainz, Discogs, iTunes and Deezer for it.`;
      search.addEventListener("click", () => {
        finder.artist = hint.artist;
        finder.album = hint.title;
        finder.tool = "search";
        render();
      });
      buttons.append(search);
    }
    panel.append(buttons);
    return panel;
  }

  /** Copy tags from another album of the library. */
  function copyPanel(entry: FolderEntry, choice: Choice, finder: Finder): HTMLElement {
    const panel = el("div", "ft-finder");
    const files = orderedFiles(entry);
    const form = el("div", "dialog-actions");
    const query = el("input", "ft-input");
    query.type = "text";
    query.placeholder = "Artist and/or album words";
    query.value = finder.copyQuery;
    query.setAttribute("aria-label", "Words of the artist or album to look for in your library");
    const find = el("button", undefined, "Find");
    find.type = "button";
    const run = (): void => {
      finder.copyQuery = query.value.trim();
      finder.copyPicked = 0;
      render();
    };
    find.addEventListener("click", run);
    query.addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
    form.append(query, find);
    panel.append(form);
    const albums: LibraryAlbum[] = libraryAlbums(deps.songs(), finder.copyQuery, entry.path, files.length);
    if (!finder.copyQuery.trim()) panel.append(el("p", "field-hint", "Type some words of the artist or album to find in your library."));
    else if (albums.length === 0) panel.append(el("p", "field-hint", "No other album in your library matches those words."));
    albums.forEach((album, index) => {
      const label = el("label", "ft-edition");
      const radio = el("input");
      radio.type = "radio";
      radio.name = `copy-${entry.path}`;
      radio.checked = index === finder.copyPicked;
      radio.addEventListener("change", () => {
        finder.copyPicked = index;
        render();
      });
      const same = album.songs.length === files.length;
      label.append(radio, el("strong", undefined, `${album.artist} — ${album.album}${album.year ? ` (${album.year})` : ""}`), el("span", same ? "field-hint" : "result-warning", ` ${album.songs.length} songs${same ? "" : ` (this folder has ${files.length}: titles and numbers are not copied)`}`), el("span", "ft-edition-extra", album.folder));
      panel.append(label);
    });
    const picked = albums[finder.copyPicked];
    if (picked) {
      const fields = el("div", "ft-fields");
      fields.append(el("span", undefined, "Copy:"));
      for (const { field, label, perSong } of COPY_FIELDS) {
        const item = el("label", "ft-check");
        const input = el("input");
        input.type = "checkbox";
        input.checked = finder.copyFields.has(field);
        input.disabled = perSong && picked.songs.length !== files.length;
        input.addEventListener("change", () => {
          if (input.checked) finder.copyFields.add(field);
          else finder.copyFields.delete(field);
        });
        item.append(input, document.createTextNode(` ${label}`));
        fields.append(item);
      }
      const use = el("button", undefined, "Use these tags");
      use.type = "button";
      use.title = "Types the ticked tags into the table below, song for song in track order. Check them, then press Apply.";
      use.addEventListener("click", () => {
        fill(choice, editsFromAlbum(files.map((f) => f.path), picked, finder.copyFields));
        finder.note = "The tags are filled in below. Check them against your files, change what is wrong, then press Apply.";
        render();
      });
      panel.append(fields, use);
      if (finder.note) panel.append(el("p", "field-hint", finder.note));
    }
    return panel;
  }

  /** Tags from file names with a pattern: used straight away when exactly one pattern fits every file, otherwise the person chooses. */
  function namesPanel(entry: FolderEntry, choice: Choice, finder: Finder): HTMLElement {
    const panel = el("div", "ft-finder");
    const files = orderedFiles(entry);
    const stems = files.map((f) => f.stem);
    const detection = detectPattern(stems);
    if (!finder.pattern && detection.obvious) finder.pattern = detection.obvious;
    panel.append(
      el("p", "field-hint", detection.obvious ? `The file names all follow one pattern: ${detection.obvious}. Check the preview, or choose another below.` : detection.choices.length ? "More than one pattern could fit these file names (or only most of them). Choose the one that is right, or type your own." : "These file names do not follow a usual pattern. Type one that describes them."),
    );
    const list = el("div", "ft-editions");
    for (const fit of detection.choices) {
      const label = el("label", "ft-edition");
      const radio = el("input");
      radio.type = "radio";
      radio.name = `pattern-${entry.path}`;
      radio.checked = finder.pattern === fit.pattern;
      radio.addEventListener("change", () => {
        finder.pattern = fit.pattern;
        render();
      });
      const example = fit.sample[0] ? Object.entries(fit.sample[0]).map(([k, v]) => `${k}: ${v}`).join(" · ") : "";
      label.append(radio, el("strong", undefined, fit.pattern), el("span", fit.matched === fit.total ? "field-hint" : "result-warning", ` fits ${fit.matched} of ${fit.total} files`), el("span", "ft-edition-extra", example));
      list.append(label);
    }
    panel.append(list);

    const form = el("div", "dialog-actions");
    const custom = el("input", "ft-input");
    custom.type = "text";
    custom.placeholder = "Your own pattern, e.g. %track% - %artist% - %title%";
    custom.value = finder.pattern;
    custom.setAttribute("aria-label", "Pattern for the file names");
    const check = el("button", "secondary", "Preview");
    check.type = "button";
    const preview = (): void => {
      finder.pattern = custom.value.trim();
      render();
    };
    check.addEventListener("click", preview);
    custom.addEventListener("keydown", (event) => { if (event.key === "Enter") preview(); });
    form.append(custom, check);
    panel.append(form, el("p", "field-hint", `Fields: ${NAME_FIELDS.map((f) => `%${f.field}%`).join(" ")}. Underscores in a name without spaces read as spaces.`));

    if (finder.pattern) {
      const compiled = compilePattern(finder.pattern);
      if ("error" in compiled) {
        panel.append(el("p", "result-warning", compiled.error));
      } else {
        const fit = fitPattern(finder.pattern, stems);
        const edits = editsFromNames(files, finder.pattern);
        const table = el("table", "ft-table");
        const head = el("tr");
        for (const name of ["File", ...compiled.fields.map((f) => NAME_FIELDS.find((n) => n.field === f)?.label ?? f)]) head.append(el("th", undefined, name));
        table.append(head);
        for (const file of files.slice(0, 6)) {
          const row = el("tr");
          const read = edits[file.path];
          row.append(el("td", "ft-name", file.stem), ...compiled.fields.map((f) => el("td", read ? undefined : "result-warning", read?.[f] ?? "does not fit")));
          table.append(row);
        }
        panel.append(table);
        if (files.length > 6) panel.append(el("p", "field-hint", `…and ${files.length - 6} more.`));
        if (fit && fit.matched < fit.total) panel.append(el("p", "result-warning", `${fit.total - fit.matched} of the ${fit.total} files do not fit this pattern and will be left as they are.`));
        const use = el("button", undefined, "Use these");
        use.type = "button";
        use.disabled = Object.keys(edits).length === 0;
        use.title = "Types these values into the table below. Check them, then press Apply.";
        use.addEventListener("click", () => {
          fill(choice, edits);
          finder.note = "The values are filled in below. Check them against your files, then press Apply.";
          render();
        });
        panel.append(use);
        if (finder.note) panel.append(el("p", "field-hint", finder.note));
      }
    }
    return panel;
  }
  /** The value that will be written for a suggestion: what the person typed, else the suggestion. */
  function valueFor(choice: Choice, path: string, change: Change): string {
    return choice.edits.get(path)?.get(change.field) ?? change.to;
  }

  /** What a file's field will hold after Apply: what was typed, else the suggestion, else its current value. */
  function effective(choice: Choice, proposal: Proposal, file: FileRow, field: Field): string {
    const typed = choice.edits.get(file.path)?.get(field);
    if (typed !== undefined) return typed;
    const suggestion = proposal.files.find((f) => f.path === file.path);
    const change = suggestion?.changes.find((c) => c.field === field && !choice.skipFields.has(c.field));
    if (change) return change.to;
    const difference = pendingDifference(choice, suggestion, field);
    if (difference) return difference.to;
    return current(file.tags, field) ?? "";
  }

  /** With "Also replace values that differ" on: the release's spelling that Apply will put in this field. */
  function pendingDifference(choice: Choice, suggestion: FileProposal | undefined, field: Field): Change | undefined {
    return replaceDiffering && !choice.skipFields.has(field) ? suggestion?.differences?.find((c) => c.field === field) : undefined;
  }

  /** Remembers a typed value; typing back what was there before forgets it. */
  function setValue(choice: Choice, path: string, field: Field, value: string, before: string): void {
    let fields = choice.edits.get(path);
    if (!fields) choice.edits.set(path, (fields = new Map()));
    if (value === before) fields.delete(field);
    else fields.set(field, value);
  }

  /** What a cell shows before anything is typed: the suggestion, else the current value. */
  function baseline(proposed: FileProposal | undefined, file: FileRow, field: Field, choice: Choice): string {
    const change = proposed?.changes.find((c) => c.field === field && !choice.skipFields.has(c.field));
    return change ? change.to : pendingDifference(choice, proposed, field)?.to ?? current(file.tags, field) ?? "";
  }

  /**
   * One box per album-wide field (album, album artist, contributing artist, genre, year): typing there sets the
   * value for every song of the album at once (owner, 2026-11-04: "enter album properties and have them propagate
   * to all the songs in that album or folder").
   */
  function albumBoxes(entry: FolderEntry, choice: Choice, proposal: Proposal, only: Field[] = ALBUM_FIELDS): HTMLElement {
    const box = el("div", "ft-album-boxes");
    const files = entry.result.files.filter((f) => !choice.skipFiles.has(f.path));
    const byPath = new Map(proposal.files.map((f) => [f.path, f]));
    for (const field of only) {
      const values = new Set(files.map((file) => effective(choice, proposal, file, field)));
      // A compilation's artist differs per song: typing one for all is still possible, but not offered first.
      const label = el("label", "ft-album-box");
      const input = el("input", "ft-input");
      input.type = "text";
      input.value = values.size === 1 ? [...values][0] : "";
      input.placeholder = values.size > 1 ? "(differs per song)" : field === "genre" ? "Type or pick a genre" : field === "year" ? "Year" : "";
      const changed = files.flatMap((file) => (byPath.get(file.path)?.changes ?? []).filter((c) => c.field === field));
      const hint = changed.find((c) => c.hint)?.hint;
      const followed = !hint && changed.length > 0 && changed.every((c) => c.album);
      input.title = hint === "library"
        ? "The genre most of this artist's other songs have in your library. Type to change it for every song of the album."
        : hint === "musicbrainz"
          ? "MusicBrainz's genre for this artist. Type to change it for every song of the album."
          : "Type to set it for every song of the album.";
      if (field === "genre") input.setAttribute("list", "ft-genres");
      if (changed.length) input.classList.add("ft-new");
      else input.classList.add("ft-plain");
      input.addEventListener("change", () => {
        const value = input.value.trim();
        for (const file of files) setValue(choice, file.path, field, value, baseline(byPath.get(file.path), file, field, choice));
        render();
      });
      label.append(el("span", undefined, FIELDS.find((f) => f.field === field)?.label ?? field), input);
      if (hint) label.append(el("span", "ft-follows", hint === "library" ? "from your library" : "from MusicBrainz"));
      else if (followed && input.value) label.append(el("span", "ft-follows", "matches album"));
      box.append(label);
    }
    return box;
  }

  /**
   * The songs, every tag a text box (owner, 2026-11-04: "I should be able to change or type over any of the
   * tags"): suggestions in orange with the old value struck through beneath, current values in white, values the
   * release spells differently in yellow (its spelling offered as you type). Typed values turn blue.
   */
  function fileTable(entry: FolderEntry, choice: Choice, proposal: Proposal | undefined): HTMLElement {
    const wrap = el("div", "ft-table-wrap");
    const table = el("table", "ft-table");
    const head = el("tr");
    for (const name of ["", "Name", "Disc", "#", "Title", "Contributing artists", "Album", "Album artist", "Genre", "Year", "Match"]) head.append(el("th", undefined, name));
    const thead = el("thead");
    thead.append(head);
    const body = el("tbody");
    const proposed = new Map((proposal?.files ?? []).map((p) => [p.path, p]));
    for (const file of entry.result.files) {
      const suggestion = proposed.get(file.path);
      const tr = el("tr");
      const included = !choice.skipFiles.has(file.path);
      if (!included) tr.classList.add("is-skipped");
      const cell = el("td");
      if (proposal) {
        const box = el("input");
        box.type = "checkbox";
        box.checked = included;
        box.setAttribute("aria-label", `Include ${fileName(file.path)}`);
        box.addEventListener("change", () => {
          if (box.checked) choice.skipFiles.delete(file.path);
          else choice.skipFiles.add(file.path);
          render();
        });
        cell.append(box);
      }
      tr.append(cell, el("td", "ft-name", file.stem));
      for (const field of COLUMNS) {
        const td = el("td");
        const change = suggestion?.changes.find((c) => c.field === field && !choice.skipFields.has(c.field));
        const differs = suggestion?.differences?.find((c) => c.field === field);
        const now = current(file.tags, field);
        if (!proposal || !included) {
          // Nothing can be written here (no suggestion at all, or the song is unticked): show what is there.
          const value = el("span", change ? "ft-new" : differs ? "ft-same ft-differs" : "ft-same", (change ? change.to : now) ?? "—");
          if (differs) value.title = `This release says: ${differs.to}`;
          td.append(value);
          tr.append(td);
          continue;
        }
        const before = baseline(suggestion, file, field, choice);
        const input = el("input", "ft-input");
        input.type = "text";
        input.value = choice.edits.get(file.path)?.get(field) ?? before;
        input.setAttribute("aria-label", `${field} for ${fileName(file.path)}`);
        if (field === "genre") input.setAttribute("list", "ft-genres");
        if (change) {
          input.classList.add("ft-new");
          input.title = change.confirm
            ? "Looks like a placeholder, but the release has it too: Apply confirms it as the song's real name (nothing is written)"
            : change.cleanup ? `Tidied from: ${change.from ?? ""}` : change.album ? "Same as the album's other tracks" : "Suggested value: type to change it";
        } else if (pendingDifference(choice, suggestion, field)) {
          input.classList.add("ft-new");
          input.title = `Replaces “${now ?? ""}” with the release's spelling (“Also replace values that differ” is on). Type to change it.`;
        } else if (differs) {
          // The release's spelling, offered in a list as you type, for taking it with one click.
          input.classList.add("ft-differs");
          input.title = `This release says: ${differs.to}`;
          const list = el("datalist");
          list.id = `ft-d-${Math.random().toString(36).slice(2)}`;
          const option = el("option");
          option.value = differs.to;
          list.append(option);
          input.setAttribute("list", list.id);
          td.append(list);
        } else {
          input.classList.add("ft-plain");
        }
        if (input.value !== before) input.classList.add("is-edited");
        input.addEventListener("input", () => {
          setValue(choice, file.path, field, input.value.trim(), before);
          input.classList.toggle("is-edited", input.value.trim() !== before);
        });
        // The count of files to write follows what was typed.
        input.addEventListener("change", () => render());
        td.append(input);
        if (change?.confirm && input.value === before) td.append(el("span", "ft-confirm", "same as release: confirm"));
        else if (change) td.append(el("span", "ft-old", change.from === null || change.from === undefined || change.from === "" ? "(empty)" : String(change.from)));
        else if (pendingDifference(choice, suggestion, field)) td.append(el("span", "ft-old", now ?? "(empty)"));
        tr.append(td);
      }
      if (suggestion?.extra) {
        const note = el("td", "ft-extra", "Not on release");
        note.title = "This file is not on the release. Only the album's own values (genre, year…) are suggested for it.";
        tr.append(note);
      } else {
        tr.append(el("td", suggestion && proposal?.source !== "folder" ? confidenceClass(suggestion.fit) : undefined, suggestion && proposal?.source !== "folder" ? `${suggestion.fit}%` : ""));
      }
      body.append(tr);
    }
    table.append(thead, body);
    wrap.append(table);
    return wrap;
  }

  return {
    show: () => {
      void load();
    },
  };
}
