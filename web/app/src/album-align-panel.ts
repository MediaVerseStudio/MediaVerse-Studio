// Review > Match-up (D100): songs that do not agree with their own album. The scan lists albums where most songs say
// one Album / Album artist / Genre / Year (or have one cover) and a few say something else; one button per album makes
// the few match, with Undo. Compilations keep each song's own genre and year. Text is set with textContent.

import { type AlignAlbum, FIELD_LABELS, changesFor, songsToFix } from "./album-align";
import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { picturesRequest } from "./media-request";

export type AlbumAlignDeps = { changed: (message: string) => void; stopIfPlaying: (paths: string[]) => void };

type Problem = { path?: string; message: string };
type ScanResult = { stopped: boolean; checked: number; total: number; albums: AlignAlbum[] };
type CoverReply = { mime: string; data_base64: string } | null;

const PAGE = 8;
const MAX_COVER_BYTES = 500 * 1024;
const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);

export function initAlbumAlignPanel(root: HTMLElement, deps: AlbumAlignDeps): { show: () => void } {
  root.classList.add("album-align-panel");
  const note = el("div");
  const actions = el("div", "dialog-actions");
  const progress = el("p", "field-hint");
  const list = el("div", "album-ids-list");
  const pager = el("div", "dialog-actions");
  let result: ScanResult | null = null;
  let albums: AlignAlbum[] = [];
  let offset = 0;
  let scanJob: string | null = null;
  let lastFix: { tags?: string; pictures?: string; text: string } | null = null;
  let busy = false;

  const report = (text: string, problems: Problem[] = []): HTMLElement => {
    const box = el("div", problems.length ? "ft-report ft-report-warn" : "ft-report ft-report-good");
    box.append(el("p", undefined, text));
    if (problems.length) {
      const ul = el("ul", "ft-problems");
      for (const p of problems.slice(0, 8)) ul.append(el("li", undefined, `${p.path ? `${p.path.split(/[\\/]/).pop()}: ` : ""}${p.message}`));
      box.append(ul);
    }
    return box;
  };

  function draw(): void {
    actions.replaceChildren();
    if (scanJob) {
      const stop = button("Stop");
      stop.addEventListener("click", () => void invoke("cancel_job", { job_id: scanJob }).catch(() => undefined));
      actions.append(stop);
    } else {
      const scan = button(result ? "Look again" : "Look for songs that do not match their album", "");
      scan.disabled = busy;
      scan.addEventListener("click", () => void startScan());
      actions.append(scan);
    }
    if (lastFix) {
      const undo = button(`Undo: ${lastFix.text}`);
      undo.disabled = busy;
      undo.addEventListener("click", () => void undoLast());
      actions.append(undo);
    }
    list.replaceChildren();
    if (result) {
      list.append(
        el("p", undefined, albums.length ? `${plural(result.total, "album")} ${result.total === 1 ? "has" : "have"} songs that do not match${result.total > albums.length ? ` (the ${albums.length} with the most are shown)` : ""}.` : "Every album agrees with itself."),
      );
      for (const album of albums.slice(offset, offset + PAGE)) list.append(card(album));
    }
    pager.replaceChildren();
    if (albums.length > PAGE) {
      const prev = button("Previous");
      prev.disabled = offset === 0;
      prev.addEventListener("click", () => {
        offset = Math.max(0, offset - PAGE);
        draw();
      });
      const next = button("Next");
      next.disabled = offset + PAGE >= albums.length;
      next.addEventListener("click", () => {
        offset += PAGE;
        draw();
      });
      pager.append(prev, el("span", "field-hint", `${offset + 1}–${Math.min(offset + PAGE, albums.length)} of ${albums.length}`), next);
    }
  }

  function card(album: AlignAlbum): HTMLElement {
    // Laid out like Fix tags: a card per album, then each song's current value beside what it would be changed to.
    const box = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const text = el("div", "ft-card-text");
    text.append(el("div", "ft-card-title", album.name), el("div", "ft-card-folder", `${album.folder} · ${plural(album.songs, "song")} · ${plural(songsToFix(album), "song")} to change`));
    const fix = button(`Make ${plural(songsToFix(album), "song")} match`, "");
    fix.disabled = busy;
    fix.addEventListener("click", () => void fixAlbum(album));
    const leave = button("Leave alone");
    leave.addEventListener("click", () => {
      albums = albums.filter((a) => a !== album);
      draw();
    });
    const actionBox = el("div", "ft-actions");
    actionBox.append(fix, leave);
    head.append(text, actionBox);

    const rows: { song: string; tag: string; now: string; next: string }[] = [];
    for (const issue of album.fields) {
      for (const s of issue.songs) rows.push({ song: fileName(s.path), tag: FIELD_LABELS[issue.field], now: s.value ?? "(none)", next: issue.majority });
    }
    for (const path of album.cover?.missing ?? []) rows.push({ song: fileName(path), tag: "Cover", now: "(none)", next: "the album's cover" });
    const wrap = el("div", "ma-table-wrap");
    const table = el("table", "ma-table");
    const headRow = el("tr");
    for (const label of ["Song", "Tag", "Now", "Will become"]) headRow.append(el("th", undefined, label));
    const thead = el("thead");
    thead.append(headRow);
    const body = el("tbody");
    for (const r of rows) {
      const row = el("tr");
      row.append(el("td", "ft-name", r.song), el("td", undefined, r.tag), el("td", "ft-old", r.now), el("td", "ft-new", r.next));
      body.append(row);
    }
    table.append(thead, body);
    wrap.append(table);
    const summary = el("p", "field-hint");
    summary.style.margin = "0.4rem 0.9rem 0.7rem";
    summary.textContent = [...album.fields.map((f) => `${FIELD_LABELS[f.field]}: ${plural(f.count, "song")} say “${f.majority}”`), ...(album.cover ? [`Cover: ${album.cover.have} of ${album.songs} songs have it`] : [])].join(" · ");
    box.append(head, summary, wrap);
    return box;
  }

  async function startScan(): Promise<void> {
    try {
      const started = await invoke<{ job_id: string }>("scan_album_align", {});
      scanJob = started.job_id;
      note.replaceChildren();
      draw();
    } catch (error) {
      note.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  async function fixAlbum(album: AlignAlbum): Promise<void> {
    if (busy) return;
    const songs = songsToFix(album);
    if (!confirm(`Make ${plural(songs, "song")} in “${album.name}” match the rest of the album?\n\nOnly those songs' ${album.fields.map((f) => f.field.replace("_", " ")).join(", ")}${album.cover ? " and cover" : ""} change. You can undo this.`)) return;
    busy = true;
    draw();
    const stamp = Date.now();
    const problems: Problem[] = [];
    const fixed: { tags?: string; pictures?: string } = {};
    let message = "";
    try {
      const changes = changesFor(album);
      deps.stopIfPlaying([...changes.map((c) => c.path), ...(album.cover?.missing ?? [])]);
      if (changes.length) {
        const batch = `align-${stamp}`;
        const reply = await invoke<{ songs: number; problems: Problem[] }>("align_album", { changes, batch });
        problems.push(...reply.problems);
        if (reply.songs) fixed.tags = batch;
        message = `${plural(reply.songs, "song")} ${reply.songs === 1 ? "now matches" : "now match"}`;
      }
      if (album.cover?.source && album.cover.missing.length) {
        const cover = await invoke<CoverReply>("track_cover", { path: album.cover.source });
        if (!cover || (cover.mime !== "image/jpeg" && cover.mime !== "image/png")) problems.push({ message: "The album's cover could not be read, so it was not copied." });
        else if (cover.data_base64.length * 0.75 > MAX_COVER_BYTES) problems.push({ message: "The album's cover is too large to embed as it is; use Review > Artwork." });
        else {
          const batch = `align-pic-${stamp}`;
          const reply = await invoke<{ results: { path: string; ok: boolean; error?: string }[] }>("update_track_media", picturesRequest(album.cover.missing, [{ kind: "front_cover", base64: cover.data_base64 }], [], batch));
          const ok = reply.results.filter((r) => r.ok).length;
          problems.push(...reply.results.filter((r) => !r.ok).map((r) => ({ path: r.path, message: r.error ?? "it failed" })));
          if (ok) fixed.pictures = batch;
          message += `${message ? "; " : ""}${plural(ok, "song")} got the cover`;
        }
      }
      lastFix = fixed.tags || fixed.pictures ? { ...fixed, text: `${album.name}` } : null;
      if (fixed.tags || fixed.pictures) albums = albums.filter((a) => a !== album);
      note.replaceChildren(report(message ? `${album.name}: ${message}.` : "Nothing needed changing.", problems));
      if (fixed.tags || fixed.pictures) deps.changed(`Songs in ${album.name} now match their album.`);
    } catch (error) {
      note.replaceChildren(report(`Could not change it: ${errorText(error)}`, problems));
    } finally {
      busy = false;
      draw();
    }
  }

  async function undoLast(): Promise<void> {
    if (!lastFix || busy) return;
    const fix = lastFix;
    busy = true;
    draw();
    try {
      let songs = 0;
      const problems: Problem[] = [];
      if (fix.tags) {
        const reply = await invoke<{ songs: number; problems: Problem[] }>("undo_album_align", { batch: fix.tags });
        songs += reply.songs;
        problems.push(...reply.problems);
      }
      if (fix.pictures) {
        const reply = await invoke<{ songs: number; problems: Problem[] }>("undo_picture_batch", { batch: fix.pictures });
        songs += reply.songs;
        problems.push(...reply.problems);
      }
      lastFix = null;
      note.replaceChildren(report(`Put ${plural(songs, "song")} back as they were.`, problems));
      deps.changed("Match-up undone.");
    } catch (error) {
      note.replaceChildren(report(`Could not undo: ${errorText(error)}`));
    } finally {
      busy = false;
      draw();
    }
  }

  listen<{ kind?: string; done?: number; total?: number; current?: string }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind !== "album_align") return;
    progress.textContent = `Checked ${p.done ?? 0} of ${p.total ?? 0}${p.current ? ` · ${p.current}` : ""}`;
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: ScanResult; error?: { message: string } }>("job-finished", (event) => {
    if (event.payload.job_id !== scanJob) return;
    scanJob = null;
    progress.textContent = "";
    if (!event.payload.ok || !event.payload.result) note.replaceChildren(report(`Stopped: ${event.payload.error?.message ?? "unknown error"}`));
    else {
      result = event.payload.result;
      albums = result.albums;
      offset = 0;
    }
    draw();
  }).catch(() => undefined);

  root.append(
    el("h3", undefined, "Match-up"),
    el("p", "field-hint", "A song re-tagged by hand, a bonus track or a stray rip can say a different Genre, Year or Album than the rest of its album, or have no cover when the others do. This finds them. When most of an album agrees, one button makes the few songs match it. Compilations keep each song's own genre and year. Nothing changes until you press a button, and there is an Undo."),
    note,
    actions,
    progress,
    list,
    pager,
  );
  draw();

  return { show: () => draw() };
}
