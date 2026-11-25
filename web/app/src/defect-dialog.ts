// The defect scan dialog: scans the chosen library files in the background, in batches, and lists only the
// songs worth a listen (anything with findings, or that could not be read). Each listed song can be played
// from a place, or marked as good so it stops being listed (until the file changes). Closing the dialog
// stops the scan. All text is set with textContent; nothing from files or the sidecar is inserted as HTML.

import { invoke, listen } from "./desktop-bridge";
import { SCAN_BATCH, type TrackScan, batches, describeCounts, describeFinding, describeVerdict, groupFindings, listedFindings, worthListing } from "./defect-format";
import { el } from "./dom";
import { describeError, toApiError } from "./drive-format";
import type { PlayableTrack } from "./play-queue";

type Finished = { job_id: string; ok: true; result: { tracks: TrackScan[] } } | { job_id: string; ok: false; error: { code: string; message: string } };
type Progress = { job_id: string; kind: string; tracks_done?: number; tracks_total?: number };

export type ScanTarget = { label: string; tracks: PlayableTrack[] };

export function initDefectDialog(dialog: HTMLDialogElement, onListen: (tracks: PlayableTrack[], index: number, defectMs: number) => void, afterScan: () => void = () => {}): { open: (target: ScanTarget) => void } {
  const title = dialog.querySelector<HTMLElement>("#scan-title")!;
  const note = dialog.querySelector<HTMLElement>("#scan-note")!;
  const bar = dialog.querySelector<HTMLProgressElement>("#scan-progress")!;
  const results = dialog.querySelector<HTMLElement>("#scan-results")!;
  const closeButtons = dialog.querySelectorAll<HTMLButtonElement>("[data-scan-close]");
  let job: string | null = null;
  let target: ScanTarget = { label: "", tracks: [] };
  let ranges: [number, number][] = [];
  let next = 0; // index into `ranges` of the batch to start next
  let offset = 0; // first track of the batch that is running
  let stopped = false;
  let counts = { clean: 0, listed: 0, failed: 0, markedGood: 0 };

  let inBatch = 0; // songs finished in the batch that is running (from its progress events)

  function summary(running: boolean): void {
    const total = target.tracks.length;
    const scanned = counts.clean + counts.listed + counts.failed + (running ? inBatch : 0);
    const head = running ? `Scanning: ${scanned} of ${total} done.` : stopped ? `Stopped after ${scanned} of ${total} songs.` : `Scan finished: ${total} song${total === 1 ? "" : "s"}.`;
    const parts = [`${counts.clean} sounded clean`, `${counts.listed - counts.markedGood} worth a listen`];
    if (counts.failed > 0) parts.push(`${counts.failed} could not be read`);
    if (counts.markedGood > 0) parts.push(`${counts.markedGood} marked as good`);
    note.textContent = `${head} ${parts.join(", ")}.`;
    if (!running) note.append(" ", el("span", "field-hint", "This is an aid, not a verdict: listen to decide."));
  }

  function addResult(scan: TrackScan, index: number): void {
    if (!scan.ok || !scan.report) counts.failed += 1;
    else if (scan.report.verdict === "clean") counts.clean += 1;
    else counts.listed += 1;
    if (!worthListing(scan)) return;
    const track = target.tracks[index];
    const box = el("article", "scan-track");
    box.append(el("h3", undefined, track?.title ?? scan.path));
    if (track?.artist) box.append(el("p", "field-hint", [track.artist, track.album].filter(Boolean).join(" · ")));
    if (!scan.ok || !scan.report) {
      box.append(el("p", "result-warning", `Could not be scanned: ${scan.error ?? "unknown problem"}`));
    } else {
      const report = scan.report;
      box.append(el("p", report.verdict === "suspect" ? "result-warning" : undefined, `${describeVerdict(report)} (${describeCounts(report.counts)}).`));
      const list = el("ul", "scan-findings");
      for (const finding of groupFindings(listedFindings(report))) {
        const item = el("li", undefined, `${describeFinding(finding)} `);
        const button = el("button", "secondary", "▶ Listen (sample around it)");
        button.type = "button";
        button.addEventListener("click", () => onListen(target.tracks, index, finding.time_ms));
        item.append(button);
        list.append(item);
      }
      if (list.childElementCount > 0) box.append(list);
      if (report.truncated) box.append(el("p", "field-hint", "Only the most obvious findings are listed."));
      const good = el("button", "secondary", "✓ Mark as good (I listened; it is fine)");
      good.type = "button";
      good.addEventListener("click", () => {
        good.disabled = true;
        invoke("set_defect_reviewed", { path: scan.path, good: true })
          .then(() => {
            counts.markedGood += 1;
            box.remove();
            summary(job !== null);
            afterScan();
          })
          .catch((thrown) => {
            good.disabled = false;
            box.append(el("p", "result-warning", describeError(toApiError(thrown))));
          });
      });
      const actions = el("div", "row-actions");
      actions.append(good);
      box.append(actions);
    }
    results.append(box);
  }

  function finish(): void {
    job = null;
    bar.hidden = true;
    summary(false);
    if (counts.listed + counts.failed === 0 && !stopped) results.replaceChildren(el("p", "result-ok", "Nothing suspicious found."));
    afterScan();
  }

  function startNext(): void {
    if (stopped || next >= ranges.length) {
      finish();
      return;
    }
    const [start, end] = ranges[next++];
    offset = start;
    job = null;
    invoke<{ job_id: string }>("scan_defects", { paths: target.tracks.slice(start, end).map((t) => t.source_uri) })
      .then((started) => {
        job ??= started.job_id;
        if (stopped) void invoke("cancel_job", { job_id: started.job_id }).catch(() => {});
      })
      .catch((thrown) => {
        bar.hidden = true;
        note.textContent = describeError(toApiError(thrown));
      });
  }

  listen<Progress>("job-progress", (event) => {
    if (event.payload.kind !== "defects" || stopped || (job !== null && event.payload.job_id !== job)) return;
    job ??= event.payload.job_id;
    bar.max = Math.max(1, target.tracks.length);
    inBatch = event.payload.tracks_done ?? 0;
    bar.value = offset + inBatch;
    summary(true);
  }).catch(() => {});
  listen<Finished>("job-finished", (event) => {
    const outcome = event.payload;
    if (job === null || outcome.job_id !== job) return;
    if (!outcome.ok) {
      job = null;
      bar.hidden = true;
      if (outcome.error.code !== "cancelled") note.textContent = describeError(outcome.error);
      return;
    }
    inBatch = 0;
    outcome.result.tracks.forEach((scan, i) => addResult(scan, offset + i));
    startNext();
  }).catch(() => {});

  /** Stops the running batch (if any) and the ones after it. */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (job) void invoke("cancel_job", { job_id: job }).catch(() => {});
    if (job) summary(false);
  }
  for (const button of closeButtons) button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", stop); // also covers Escape

  return {
    open(nextTarget) {
      target = nextTarget;
      title.textContent = `Defect scan: ${nextTarget.label}`;
      results.replaceChildren();
      bar.hidden = false;
      bar.value = 0;
      bar.max = Math.max(1, nextTarget.tracks.length);
      counts = { clean: 0, listed: 0, failed: 0, markedGood: 0 };
      ranges = batches(nextTarget.tracks.length, SCAN_BATCH);
      next = 0;
      inBatch = 0;
      stopped = false;
      note.textContent = "Starting…";
      dialog.showModal();
      startNext();
    },
  };
}
