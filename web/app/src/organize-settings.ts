// Settings > Organise (issue #9, first part): a preview of how the library's files would be named and placed by a rule, and the songs that look like
// duplicates. It only shows; nothing is moved, renamed or deleted. All text is set with textContent.

import { invoke } from "./desktop-bridge";
import { el } from "./dom";
import { runJob } from "./jobs";
import { createProgress, progressCounts } from "./progress-bar";
import { CHOICES_KEY, DEFAULT_RULE, RULES, readChoices, ruleOf } from "./organize-choices";

/** What is known of one file, to choose which of two to keep. */
type FileFacts = { path: string; path_short: string; artist?: string | null; title?: string | null; album: string | null; year: number | null; track?: number | null; size: number; bitrate_kbps: number | null; length_ms: number | null; created?: number | null; modified?: number | null };
type Row = { from_short?: string; to_short?: string; path_short?: string; why?: string; other_short?: string | null; identical?: boolean; from_file?: FileFacts; other_file?: FileFacts | null };
type Dup = { title: string | null; artist: string | null; identical_size: boolean; files: FileFacts[] };
type Preview = {
  pattern: string;
  songs: number;
  already_right: number;
  moves_total: number;
  moves: Row[];
  skipped_total: number;
  skipped: Row[];
  conflicts_total: number;
  conflicts_identical: number;
  conflicts: Row[];
  compilations: number;
  duplicate_groups_total: number;
  duplicate_groups: Dup[];
};

type Applied = {
  moved: number;
  lyrics: number;
  art_moved: number;
  art_copied: number;
  folders_removed: number;
  failed_total: number;
  failed: { path: string; why: string }[];
  references: { what: string; changed: number }[];
  moved_pairs?: [string, string][];
};

const QUEUE_KEY = "mediaverse.player.v1";

/** The saved play queue names songs by path; after a move it is pointed at the new places so it still plays. */
export function repointQueue(pairs: [string, string][], storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage): number {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    if (!raw || !pairs.length) return 0;
    const key = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
    const map = new Map(pairs.map(([from, to]) => [key(from), to]));
    const saved = JSON.parse(raw) as { items?: { source_uri?: string }[] };
    let changed = 0;
    for (const item of saved.items ?? []) {
      const to = typeof item.source_uri === "string" ? map.get(key(item.source_uri)) : undefined;
      if (to) {
        item.source_uri = to;
        changed += 1;
      }
    }
    if (changed) storage.setItem(QUEUE_KEY, JSON.stringify(saved));
    return changed;
  } catch {
    return 0;
  }
}

const when = (seconds: number): string => new Date(seconds * 1000).toLocaleString();


const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;
const clock = (ms: number | null | undefined): string => (ms ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}` : "");
const day = (seconds: number | null | undefined): string => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "");

/** Opens the folder of a file in Windows Explorer with the file selected. */
function showInFolder(path: string): void {
  void (window.mediaVerse as { showInFolder?: (p: string) => Promise<unknown> } | undefined)?.showInFolder?.(path);
}

/** Files side by side with the things that tell them apart (tags, size, bitrate, length, when made and changed), each with a button that opens its folder. */
export function compareTable(files: FileFacts[], names: string[] = []): HTMLElement {
  const table = el("table", "organize-compare");
  const head = el("tr");
  for (const h of ["", "File", "Title", "Album", "Year", "Size", "Bitrate", "Length", "Created", "Changed", ""]) head.append(el("th", undefined, h));
  table.append(head);
  files.forEach((f, i) => {
    const row = el("tr");
    const cells = [names[i] ?? "", f.path_short, f.title ?? "", f.album ?? "", f.year ? String(f.year) : "", f.size ? megabytes(f.size) : "", f.bitrate_kbps ? `${f.bitrate_kbps} kbps` : "", clock(f.length_ms), day(f.created), day(f.modified)];
    cells.forEach((text, c) => {
      const cell = el("td", c === 1 ? "organize-path" : undefined, text);
      if (c === 1) cell.title = f.path;
      row.append(cell);
    });
    const show = el("button", "secondary", "Show in folder");
    show.type = "button";
    show.addEventListener("click", () => showInFolder(f.path));
    const last = el("td");
    last.append(show);
    row.append(last);
    table.append(row);
  });
  return table;
}

function section(title: string, total: number, shown: number, rows: HTMLElement[], open = false): HTMLElement {
  const box = el("details", "organize-list");
  box.open = open;
  box.append(el("summary", undefined, `${title}: ${total}${total > shown ? ` (the first ${shown} are listed)` : ""}`));
  for (const row of rows.slice(0, 200)) box.append(row);
  if (rows.length > 200) box.append(el("p", "field-hint", `${rows.length - 200} more are not shown here.`));
  return box;
}

export function renderOrganizeSettings(root: HTMLElement): void {
  root.className = "settings-block";
  root.replaceChildren(el("h3", undefined, "Organise the library"));
  root.append(
    el(
      "p",
      "field-hint",
      "Shows how your files would be named and placed by a rule, and which songs look like duplicates. The preview changes nothing. If you then choose to make the changes, each song takes its lyrics file with it, covers follow their songs, every playlist, heart, flag and list is updated, and the whole thing can be undone.",
    ),
  );
  const choices = readChoices();
  const save = (): void => {
    try {
      window.localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
    } catch {
      // kept until the window closes
    }
  };
  const field = el("div", "field");
  const label = el("label", "field-label");
  label.textContent = "How should the files be named and placed?";
  const pick = el("select");
  pick.setAttribute("aria-label", "Naming rule");
  for (const r of RULES) pick.append(new Option(r.label, r.id, false, r.id === choices.rule));
  pick.append(new Option("My own rule…", "custom", false, choices.rule === "custom"));
  const rule = el("input");
  rule.type = "text";
  rule.value = choices.custom;
  rule.hidden = choices.rule !== "custom";
  rule.setAttribute("aria-label", "My own naming rule");
  const example = el("p", "field-hint");
  const showExample = (): void => {
    example.textContent = `The rule: ${ruleOf(choices)}`;
  };
  pick.addEventListener("change", () => {
    choices.rule = pick.value;
    rule.hidden = pick.value !== "custom";
    showExample();
    save();
  });
  rule.addEventListener("input", () => {
    choices.custom = rule.value;
    showExample();
    save();
  });
  showExample();
  const hint = el("p", "field-hint", "A rule of your own can use {albumartist} (the artist when there is none), {artist}, {album}, {title}, {track}, {disc} (only for disc 2 and up), {year} and {file} (the file's own name). A slash starts a folder. Songs with no artist, album or title are left out.");
  const comp = el("label", "check");
  const compBox = el("input");
  compBox.type = "checkbox";
  compBox.checked = choices.compilations;
  compBox.addEventListener("change", () => {
    choices.compilations = compBox.checked;
    save();
  });
  const compText = el("span");
  compText.append(el("strong", undefined, "Keep compilation albums together under Various Artists"), el("span", "field-hint", " An album is a compilation when its tags say so, or when one folder holds one album by three or more different artists and no album artist is set."));
  comp.append(compBox, compText);
  const run = el("button", undefined, "Preview");
  run.type = "button";
  const status = el("p", "field-hint");
  const results = el("div", "organize-results");
  field.append(label, pick, rule, example, hint, comp, run, status);
  const undoBox = el("div", "field");
  root.append(field, results, undoBox);

  async function showUndo(): Promise<void> {
    undoBox.replaceChildren();
    try {
      const reply = await invoke<{ last: { at: number; moved: number } | null }>("organize_last");
      if (!reply.last) return;
      undoBox.append(el("h4", undefined, "The last reorganisation"));
      undoBox.append(el("p", "field-hint", `${reply.last.moved} songs were moved on ${when(reply.last.at)}. Undo puts the songs, their lyrics files and covers back where they were, and every playlist, heart, flag and list follows them back.`));
      const undo = el("button", "secondary", "Undo it");
      undo.type = "button";
      const note = el("p", "field-hint");
      undo.addEventListener("click", () => {
        undo.disabled = true;
        note.textContent = "Putting everything back…";
        void invoke<Applied>("organize_undo")
          .then((back) => {
            note.textContent = `Put back ${back.moved} songs${back.failed_total ? `; ${back.failed_total} could not be put back (they were moved again by hand?)` : ""}. Reload the library to see it.`;
            document.querySelector<HTMLButtonElement>("#rescan-collection")?.click();
            void showUndo().then(() => undoBox.append(note));
          })
          .catch((thrown) => {
            note.textContent = `Could not undo: ${(thrown as { message?: string })?.message ?? "something went wrong"}`;
            undo.disabled = false;
          });
      });
      undoBox.append(undo, note);
    } catch {
      // not the Windows program: nothing to undo
    }
  }
  void showUndo();

  /** What was asked at the preview, so the changes made are the changes shown. */
  let asked = { pattern: DEFAULT_RULE, keep_compilations: true };

  /** The step that makes the changes: spelled out, then confirmed with a second press. */
  function applyBox(preview: Preview): HTMLElement {
    const box = el("div", "organize-apply");
    const go = el("button", undefined, `Make these ${preview.moves_total} changes…`);
    go.type = "button";
    const sure = el("div", "organize-sure");
    sure.hidden = true;
    sure.append(
      el(
        "p",
        undefined,
        `${preview.moves_total} songs will be moved or renamed inside your library folder. Each song takes its lyrics file with it, a folder's cover pictures follow their songs, and every playlist, heart, flag, pin and list is updated to the new places. Nothing is overwritten or deleted, folders are removed only when empty, and you can undo the whole thing afterwards. Close anything that is playing from a network share, and do not start a rip while this runs.`,
      ),
    );
    const yes = el("button", undefined, `Yes, move ${preview.moves_total} songs`);
    const no = el("button", "secondary", "Cancel");
    yes.type = no.type = "button";
    const progress = el("p", "field-hint");
    sure.append(yes, no);
    go.addEventListener("click", () => {
      sure.hidden = false;
      go.hidden = true;
    });
    no.addEventListener("click", () => {
      sure.hidden = true;
      go.hidden = false;
    });
    yes.addEventListener("click", () => {
      yes.disabled = no.disabled = true;
      progress.textContent = "";
      const bar = createProgress("Working");
      progress.append(bar.element);
      void runJob<Applied>("organize_apply", { pattern: asked.pattern, keep_compilations: asked.keep_compilations, expected: preview.moves_total, confirm: true }, (p) => {
        const { done, total } = progressCounts(p);
        bar.set(done, total);
        // first the songs are read again (to be sure nothing changed since the preview), then they are moved
        bar.element.dataset.step = p.kind ?? "";
      })
        .then((done) => {
          bar.stop();
          const pointed = repointQueue(done.moved_pairs ?? []);
          sure.hidden = true;
          const lines = [
            `Moved ${done.moved} songs${done.lyrics ? `, ${done.lyrics} lyrics files` : ""}${done.art_moved || done.art_copied ? `, ${done.art_moved} cover pictures moved and ${done.art_copied} copied` : ""}${done.folders_removed ? `; ${done.folders_removed} empty folders removed` : ""}.`,
            done.references.length ? `References updated: ${done.references.map((r) => `${r.what} (${r.changed})`).join(", ")}.` : "",
            pointed ? `${pointed} songs in the saved play queue were pointed at their new places.` : "",
            done.failed_total ? `${done.failed_total} could not be moved and were left as they were: ${done.failed.slice(0, 5).map((f) => `${f.path.split(/[\\/]/).pop()} (${f.why})`).join("; ")}.` : "",
            "The library is being read again. The Undo button below puts everything back.",
          ].filter(Boolean);
          progress.replaceChildren(...lines.map((l) => el("p", "field-hint", l)));
          results.replaceChildren(progress);
          document.querySelector<HTMLButtonElement>("#rescan-collection")?.click();
          void showUndo();
        })
        .catch((thrown) => {
          bar.stop();
          progress.textContent = `Nothing was changed: ${(thrown as { message?: string })?.message ?? "the move could not start"}`;
          yes.disabled = no.disabled = false;
        });
    });
    box.append(go, sure, progress);
    return box;
  }

  run.addEventListener("click", () => {
    run.disabled = true;
    results.replaceChildren();
    status.textContent = "";
    const reading = createProgress("Reading the tags of every song");
    results.append(reading.element);
    asked = { pattern: ruleOf(choices), keep_compilations: choices.compilations };
    void runJob<Preview>("organize_preview", asked, (p) => {
      const { done, total } = progressCounts(p);
      reading.set(done, total);
    })
      .then((preview) => {
        reading.stop();
        results.replaceChildren();
        status.textContent = `${preview.songs} songs read${preview.compilations ? ` (${preview.compilations} on compilation albums)` : ""}. ${preview.already_right} are already where the rule puts them.`;
        const moves = preview.moves.map((m) => el("p", "organize-row", `${m.from_short}  →  ${m.to_short}`));
        const conflicts = preview.conflicts.map((c) => {
          const group = el("div", "organize-dup");
          group.append(el("strong", undefined, `${c.from_short}  →  ${c.to_short}`));
          group.append(el("p", "field-hint", `${c.why}${c.identical ? ": the same size and length, probably the very same file twice" : ""}. Open the folders to keep the better one and remove or retag the other, then preview again.`));
          const files = [c.from_file, c.other_file].filter((f): f is FileFacts => !!f);
          const names = c.from_file && c.other_file ? ["Wants to move", "In the way"] : ["Wants to move"];
          if (files.length) group.append(compareTable(files, names));
          if (!c.other_file) group.append(el("p", "field-hint", `The place is taken by a file that is not a song of the library: ${c.other_short ?? c.to_short ?? ""}`));
          return group;
        });
        const skipped = preview.skipped.map((s) => el("p", "organize-row", `${s.path_short}  (${s.why})`));
        const dups = preview.duplicate_groups.map((g) => {
          const group = el("div", "organize-dup");
          group.append(el("strong", undefined, `${g.artist ?? "Unknown artist"} – ${g.title ?? "Unknown title"}${g.identical_size ? " (identical sizes: probably the same file)" : ""}`));
          group.append(compareTable(g.files));
          return group;
        });
        if (preview.moves_total > 0) results.append(applyBox(preview));
        results.append(
          section("Songs that would move or be renamed", preview.moves_total, preview.moves.length, moves, true),
          section(`Songs that cannot be placed, because another file is in the way${preview.conflicts_identical ? ` (${preview.conflicts_identical} look like the very same file)` : ""}`, preview.conflicts_total, preview.conflicts.length, conflicts, preview.conflicts_total > 0),
          section("Songs left alone (not enough tags)", preview.skipped_total, preview.skipped.length, skipped),
          section("The same song twice in one folder", preview.duplicate_groups_total, preview.duplicate_groups.length, dups, true),
        );
      })
      .catch(() => {
        reading.stop();
        results.replaceChildren();
        status.textContent = "The preview could not be made. Is a music folder chosen under Library?";
      })
      .finally(() => {
        run.disabled = false;
      });
  });
}
