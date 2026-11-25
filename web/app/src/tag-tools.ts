// Settings > Tags & files (owner, 2026-11-04; PC only): convert non-MP3 songs to MP3, give every MP3 tag the same
// ID3 version (v2.3, or v2.4 when chosen under Advanced), and the advanced choice itself. Each job runs in the
// background, can be stopped, and reports what it changed and what it could not.

import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";

type ConvertSurvey = { files: number; kinds: Record<string, number>; originals: string };
type Id3Survey = { files: number; versions: Record<string, number>; to_change: number; target: string };
type Problem = { path: string; message: string };
type JobResult = { stopped?: boolean; converted?: number; changed?: number; total?: number; problems?: Problem[]; originals?: string };
type Kind = "convert" | "id3" | "untagged";
type Running = { job: string; kind: Kind; done: number; total: number; current?: string };

export function initTagTools(root: HTMLElement, onLibraryChanged: () => void): { refresh: () => Promise<void> } {
  let convert: ConvertSurvey | null = null;
  let id3: Id3Survey | null = null;
  let v24 = false;
  let running: Running | null = null;
  const reports: Partial<Record<Kind, { text: string; problems: Problem[] }>> = {};

  listen<{ job_id: string; kind?: string; done?: number; total?: number; current?: string }>("job-progress", (event) => {
    if (!running || event.payload.job_id !== running.job) return;
    running.done = event.payload.done ?? running.done;
    running.total = event.payload.total ?? running.total;
    running.current = event.payload.current;
    render();
  }).catch(() => undefined);
  listen<{ job_id: string; ok: boolean; result?: JobResult; error?: { message: string } }>("job-finished", (event) => {
    if (!running || event.payload.job_id !== running.job) return;
    const kind = running.kind;
    running = null;
    const result = event.payload.result;
    if (!event.payload.ok || !result) {
      reports[kind] = { text: `Stopped: ${event.payload.error?.message ?? "unknown error"}`, problems: [] };
    } else if (kind === "convert") {
      reports.convert = {
        text: `${result.stopped ? "Stopped. " : ""}Converted ${result.converted ?? 0} of ${result.total ?? 0} songs to MP3. The originals are in ${result.originals ?? "the originals folder"}.`,
        problems: result.problems ?? [],
      };
    } else if (kind === "untagged") {
      reports.untagged = { text: `${result.stopped ? "Stopped. " : ""}Gave ${result.changed ?? 0} of ${result.total ?? 0} songs a tag from their file and folder names. Fix tags can now look them up.`, problems: result.problems ?? [] };
    } else {
      reports.id3 = { text: `${result.stopped ? "Stopped. " : ""}Rewrote ${result.changed ?? 0} of ${result.total ?? 0} tags.`, problems: result.problems ?? [] };
    }
    onLibraryChanged();
    void refresh();
  }).catch(() => undefined);

  async function start(command: "convert_to_mp3" | "standardize_id3" | "tag_untagged", kind: Kind, total: number): Promise<void> {
    try {
      const { job_id } = await invoke<{ job_id: string }>(command);
      running = { job: job_id, kind, done: 0, total };
      delete reports[kind];
      render();
    } catch (error) {
      alert(`Could not start: ${(error as { message?: string }).message ?? String(error)}`);
    }
  }

  function report(kind: Kind): HTMLElement | null {
    const r = reports[kind];
    if (!r) return null;
    const box = el("div", r.problems.length ? "ft-report ft-report-warn" : "ft-report ft-report-good");
    box.append(el("p", undefined, r.text));
    if (r.problems.length) {
      const list = el("ul", "ft-problems");
      for (const p of r.problems.slice(0, 25)) list.append(el("li", undefined, `${p.path.split(/[\\/]/).pop()}: ${p.message}`));
      if (r.problems.length > 25) list.append(el("li", undefined, `…and ${r.problems.length - 25} more.`));
      box.append(list);
    }
    return box;
  }

  function progress(kind: Kind): HTMLElement | null {
    if (running?.kind !== kind) return null;
    const box = el("div", "ft-progress");
    box.append(el("div", "ft-progress-text", running.total ? `${running.done} of ${running.total}…` : "Starting…"));
    const bar = el("div", "ft-bar");
    const fill = el("div", "ft-bar-fill");
    fill.style.width = running.total ? `${Math.round((100 * running.done) / running.total)}%` : "0%";
    bar.append(fill);
    box.append(bar);
    if (running.current) box.append(el("div", "ft-progress-current", running.current));
    const stop = el("button", "secondary", "Stop");
    stop.type = "button";
    const job = running.job;
    stop.addEventListener("click", () => void invoke("cancel_job", { job_id: job }).catch(() => undefined));
    box.append(stop);
    return box;
  }

  function render(): void {
    // ---- Convert to MP3 ----
    const convertBlock = el("div", "settings-block");
    convertBlock.append(el("h3", undefined, "Convert to MP3"));
    if (!convert) {
      convertBlock.append(el("p", "field-hint", "Choose a music folder first."));
    } else if (convert.files === 0) {
      convertBlock.append(el("p", undefined, "Every song in your library is an MP3."));
    } else {
      const kinds = Object.entries(convert.kinds).map(([k, n]) => `${n} ${k}`).join(", ");
      convertBlock.append(
        el("p", undefined, `${convert.files} songs in your library are not MP3s (${kinds}).`),
        el("p", "field-hint", `Each becomes an MP3 (LAME V0) beside it with the same tags and pictures, using Windows' own decoders. The original is then moved out of your library to “${convert.originals}”, keeping its folders, so nothing appears twice and nothing is lost. AAC (M4A) and WMA are already compressed: converting them loses a little quality, usually not audible at V0.`),
      );
      const go = el("button", undefined, `Convert ${convert.files} songs to MP3`);
      go.type = "button";
      go.disabled = running !== null;
      go.addEventListener("click", () => {
        if (confirm(`Convert ${convert!.files} songs to MP3 and move the originals to\n${convert!.originals}?`)) void start("convert_to_mp3", "convert", convert!.files);
      });
      convertBlock.append(go);
    }
    for (const extra of [progress("convert"), report("convert")]) if (extra) convertBlock.append(extra);

    // ---- One tag version ----
    const id3Block = el("div", "settings-block");
    const target = v24 ? "ID3v2.4" : "ID3v2.3";
    id3Block.append(el("h3", undefined, `Make every MP3 tag ${target}`));
    if (id3) {
      const versions = Object.entries(id3.versions).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ");
      id3Block.append(el("p", undefined, `${id3.files.toLocaleString()} MP3s: ${versions}.`));
      if (id3.to_change > 0) {
        id3Block.append(el("p", "field-hint", `Rewrites the ${id3.to_change.toLocaleString()} tags that are not ${target}. Only the version changes: every value, picture and lyric stays. Each file is written to a copy and checked before it replaces the original.`));
        const go = el("button", undefined, `Rewrite ${id3.to_change.toLocaleString()} tags as ${target}`);
        go.type = "button";
        go.disabled = running !== null;
        go.addEventListener("click", () => {
          if (confirm(`Rewrite ${id3!.to_change} MP3 tags as ${target}?`)) void start("standardize_id3", "id3", id3!.to_change);
        });
        id3Block.append(go);
      } else {
        id3Block.append(el("p", undefined, `Every tagged MP3 is already ${target}.`));
      }
    } else {
      id3Block.append(el("p", "field-hint", "Choose a music folder first."));
    }
    for (const extra of [progress("id3"), report("id3")]) if (extra) id3Block.append(extra);

    // ---- Songs with no tag at all ----
    const untagged = id3?.versions["no tag"] ?? 0;
    const untaggedBlock = el("div", "settings-block");
    if (untagged > 0 || reports.untagged || running?.kind === "untagged") {
      untaggedBlock.append(el("h3", undefined, "Tag the untagged songs"));
      if (untagged > 0) {
        untaggedBlock.append(
          el("p", undefined, `${untagged} MP3s have no tag at all.`),
          el("p", "field-hint", `Each gets a ${target} tag made from its file and folder names: title and track number from the file name, artist, album, year and disc from the folders. Review › Fix tags can then look them up and fill in the rest.`),
        );
        const go = el("button", undefined, `Tag ${untagged} songs`);
        go.type = "button";
        go.disabled = running !== null;
        go.addEventListener("click", () => {
          if (confirm(`Give ${untagged} untagged MP3s a tag from their file and folder names?`)) void start("tag_untagged", "untagged", untagged);
        });
        untaggedBlock.append(go);
      }
      for (const extra of [progress("untagged"), report("untagged")]) if (extra) untaggedBlock.append(extra);
    }

    // ---- Advanced ----
    const advanced = el("details", "settings-block");
    advanced.append(el("summary", undefined, "Advanced"));
    const label = el("label", "lib-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = v24;
    box.addEventListener("change", async () => {
      try {
        await invoke("set_tag_settings", { id3v24: box.checked });
        v24 = box.checked;
        await refresh();
      } catch (error) {
        box.checked = v24;
        alert(`Could not save: ${(error as { message?: string }).message ?? String(error)}`);
      }
    });
    label.append(box, document.createTextNode(" Write MP3 tags as ID3v2.4 instead of ID3v2.3"));
    advanced.append(label, el("p", "field-hint", "ID3v2.3 is read by nearly everything, including older players such as the iPod Classic, which misread ID3v2.4. Choose ID3v2.4 only if something you use needs it."));
    advanced.open = v24;

    root.replaceChildren(convertBlock, id3Block, ...(untaggedBlock.childElementCount ? [untaggedBlock] : []), advanced);
  }

  async function refresh(): Promise<void> {
    try {
      [convert, id3, { id3v24: v24 }] = await Promise.all([
        invoke<ConvertSurvey>("convert_survey").catch(() => null),
        invoke<Id3Survey>("id3_survey").catch(() => null),
        invoke<{ id3v24: boolean }>("get_tag_settings").catch(() => ({ id3v24: false })),
      ]);
    } finally {
      render();
    }
  }

  render();
  return { refresh };
}
