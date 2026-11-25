// Review > Album IDs, "Compare": an album's own tags beside a MusicBrainz release, song by song (D111). Differences are
// marked; each can be ticked to take the release's value, and a disc whose song lengths are a little off can be flagged
// for a re-rip. The values written are journalled by the sidecar, so Fix tags' "Undo it" (or the Undo here) puts them back.
// Text is set with textContent.

import { invoke, listen, openExternal } from "./desktop-bridge";
import { el } from "./dom";
import { adoptArguments, adoptCount, clock, difference, differenceKeys, ripHint, ripReason, type Comparison, type CompareRow } from "./album-compare-logic";

export type CompareDeps = { path: string; name: string; artist: string; album: string; changed: (message: string) => void };

const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

const FIELD_LABEL: Record<string, string> = { album: "Album", album_artist: "Album artist", year: "Year", genre: "Genre" };

export function createCompareView(deps: CompareDeps): { element: HTMLElement; load: (releaseId: string) => Promise<void> } {
  const box = el("div", "cmp-box");
  let data: Comparison | null = null;
  let ticked = new Set<string>();
  let message: { text: string; bad: boolean } | null = null;
  let loading = "";
  let flagging = false;
  let undoBatch: number | null = null;
  let undoJob: string | null = null;
  let current = "";

  listen<{ job_id: string; ok: boolean; error?: { message: string } }>("job-finished", (event) => {
    if (!undoJob || event.payload.job_id !== undoJob) return;
    undoJob = null;
    undoBatch = null;
    message = event.payload.ok ? { text: "Put back as they were.", bad: false } : { text: `The undo stopped: ${event.payload.error?.message ?? "unknown error"}`, bad: true };
    if (event.payload.ok) deps.changed("Tag changes undone.");
    void load(current);
  }).catch(() => undefined);

  async function load(releaseId: string): Promise<void> {
    current = releaseId;
    loading = releaseId;
    data = null;
    ticked = new Set();
    flagging = false;
    draw();
    try {
      const result = await invoke<Comparison>("compare_album_release", { path: deps.path, release_id: releaseId });
      if (loading !== releaseId) return; // another release was chosen meanwhile
      data = result;
    } catch (error) {
      if (loading !== releaseId) return;
      message = { text: `Could not compare: ${errorText(error)}`, bad: true };
    }
    loading = "";
    draw();
  }

  async function adopt(): Promise<void> {
    if (!data) return;
    const count = adoptCount(data, ticked);
    if (count === 0) return;
    if (!confirm(`Write ${count} value${count === 1 ? "" : "s"} from “${data.release.title}” into the songs of “${deps.name}”?\n\nOnly the ticked ones are changed. You can undo this afterwards.`)) return;
    try {
      const result = await invoke<{ batch: number | null; files: number; fields: number; problems: { path: string; message: string }[] }>("adopt_release_values", adoptArguments(deps.path, data, ticked));
      undoBatch = result.batch;
      message = result.files
        ? { text: `Wrote ${result.fields} value${result.fields === 1 ? "" : "s"} into ${result.files} song${result.files === 1 ? "" : "s"}.${result.problems.length ? ` ${result.problems.length} could not be written: ${result.problems[0].message}` : ""}`, bad: result.problems.length > 0 }
        : { text: "Nothing needed writing.", bad: false };
      if (result.files) deps.changed("Tags taken from the release.");
      await load(current);
    } catch (error) {
      message = { text: `Could not write: ${errorText(error)}`, bad: true };
      draw();
    }
  }

  async function undo(): Promise<void> {
    if (undoBatch === null || !confirm("Put the values just written back as they were?")) return;
    try {
      const started = await invoke<{ job_id: string }>("undo_tag_repair", { batch: undoBatch });
      undoJob = started.job_id;
      message = { text: "Putting them back…", bad: false };
      draw();
    } catch (error) {
      message = { text: `Could not undo: ${errorText(error)}`, bad: true };
      draw();
    }
  }

  async function flag(reason: string): Promise<void> {
    try {
      await invoke("flag_rerip", { path: deps.path, album: deps.album, artist: deps.artist, reason });
      flagging = false;
      message = { text: "Flagged for a re-rip. The list is under Review > Missing & copies.", bad: false };
    } catch (error) {
      message = { text: `Could not flag it: ${errorText(error)}`, bad: true };
    }
    draw();
  }

  function tick(key: string, on: boolean): void {
    if (on) ticked.add(key);
    else ticked.delete(key);
    draw();
  }

  function draw(): void {
    box.replaceChildren();
    if (loading) {
      box.append(el("p", "field-hint", "Fetching the release from MusicBrainz…"));
    }
    if (message) box.append(el("p", message.bad ? "result-warning" : "field-hint", message.text));
    if (undoBatch !== null && !undoJob) {
      const back = button("Undo that");
      back.addEventListener("click", () => void undo());
      box.append(back);
    }
    if (!data) return;
    const c = data;
    const info = [c.release.date, c.release.country, c.release.label, c.release.catalog_number, c.release.barcode ? `Barcode ${c.release.barcode}` : "", `${c.release.tracks} tracks`].filter(Boolean).join(" · ");
    const head = el("div", "cmp-head");
    head.append(el("strong", undefined, `${c.release.artist} — ${c.release.title}`), el("span", "field-hint", info));
    const link = el("a", "ft-source", "View on MusicBrainz");
    link.href = `https://musicbrainz.org/release/${c.release.id}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openExternal(link.href);
    });
    head.append(link);
    box.append(head);

    const hint = ripHint(c.rows);
    box.append(el("p", hint.level === "suspect" ? "result-warning" : "field-hint", hint.text));

    // Album-wide values.
    const albumTable = el("table", "cmp-table");
    const albumHead = el("tr");
    for (const name of ["", "Your files", "This release"]) albumHead.append(el("th", undefined, name));
    albumTable.append(albumHead);
    for (const a of c.album) {
      const tr = el("tr");
      tr.append(el("td", undefined, FIELD_LABEL[a.field] ?? a.field), el("td", a.differs ? "cmp-diff" : undefined, a.yours || "—"));
      const cell = el("td");
      if (a.differs) cell.append(tickBox(`album:${a.field}`, `Use the release's ${FIELD_LABEL[a.field] ?? a.field} for every song`));
      cell.append(document.createTextNode(a.release || "—"));
      tr.append(cell);
      albumTable.append(tr);
    }
    box.append(albumTable);

    // Song by song.
    const wrap = el("div", "ft-table-wrap");
    const table = el("table", "cmp-table");
    const columns = el("tr");
    for (const name of ["#", "Your title", "Release title", "Your artist", "Release artist", "Your length", "Release length", "Δ"]) columns.append(el("th", undefined, name));
    table.append(columns);
    for (const row of c.rows) table.append(songRow(row));
    wrap.append(table);
    box.append(wrap);
    if (c.missing.length) {
      box.append(el("p", "result-warning", `On the release but not in your folder: ${c.missing.map((m) => `${m.number}. ${m.title}${m.length_ms ? ` (${clock(m.length_ms)})` : ""}`).join(", ")}.`));
    }

    const actions = el("div", "dialog-actions");
    const all = button("Tick all differences");
    all.addEventListener("click", () => {
      ticked = new Set(differenceKeys(c));
      draw();
    });
    const none = button("Clear ticks");
    none.addEventListener("click", () => {
      ticked = new Set();
      draw();
    });
    const count = adoptCount(c, ticked);
    const write = button(count ? `Use the release's values (${count})` : "Use the release's values", "");
    write.disabled = count === 0;
    write.title = "Writes the ticked release values into your songs. Nothing else changes. You can undo it.";
    write.addEventListener("click", () => void adopt());
    const rerip = button("Flag this disc for a re-rip…");
    rerip.addEventListener("click", () => {
      flagging = !flagging;
      draw();
    });
    actions.append(all, none, write, rerip);
    box.append(actions);
    if (flagging) {
      const form = el("div", "dialog-actions");
      const reason = el("input");
      reason.type = "text";
      reason.value = ripReason(hint);
      reason.placeholder = "Why (optional)";
      reason.setAttribute("aria-label", "Reason for the re-rip");
      reason.size = 60;
      const save = button("Flag it", "");
      save.addEventListener("click", () => void flag(reason.value.trim()));
      form.append(reason, save);
      box.append(form);
    }
  }

  function tickBox(key: string, label: string): HTMLInputElement {
    const input = el("input");
    input.type = "checkbox";
    input.checked = ticked.has(key);
    input.setAttribute("aria-label", label);
    input.title = label;
    input.addEventListener("change", () => tick(key, input.checked));
    return input;
  }

  function songRow(row: CompareRow): HTMLElement {
    const tr = el("tr");
    const differs = (field: string): boolean => row.differs.includes(field);
    const rel = row.release;
    const number = el("td", differs("track") ? "cmp-diff" : undefined);
    if (rel && differs("track")) number.append(tickBox(`song:${row.path}:track`, "Use the release's track number"));
    number.append(document.createTextNode(rel && differs("track") ? `${row.yours.track ?? "—"} → ${rel.number}` : String(row.yours.track ?? rel?.number ?? "")));
    tr.append(number);
    tr.append(el("td", differs("title") ? "cmp-diff" : undefined, row.yours.title || "—"));
    const title = el("td");
    if (rel && differs("title")) title.append(tickBox(`song:${row.path}:title`, "Use the release's title"));
    title.append(document.createTextNode(rel ? rel.title : "not on this release"));
    tr.append(title);
    tr.append(el("td", differs("artist") ? "cmp-diff" : undefined, row.yours.artist || "—"));
    const artist = el("td");
    if (rel && differs("artist")) artist.append(tickBox(`song:${row.path}:artist`, "Use the release's artist"));
    artist.append(document.createTextNode(rel ? rel.artist : ""));
    tr.append(artist);
    const off = row.diff_ms !== null && Math.abs(row.diff_ms) > 1500;
    tr.append(el("td", undefined, clock(row.yours.length_ms)), el("td", undefined, clock(rel?.length_ms ?? null)), el("td", off ? "cmp-diff" : undefined, difference(row.diff_ms)));
    return tr;
  }

  return { element: box, load };
}