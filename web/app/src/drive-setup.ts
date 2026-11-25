// The "Drive setup" page: lists optical drives, runs the guided calibration check as a background
// job with progress and cancel, and shows what is known about each drive (ADR 0004).
// All text is set with textContent; nothing from the sidecar or helper is inserted as HTML.

import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { type DriveHistory, historyLines } from "./drive-history";
import {
  type ApiError,
  type CalibrationReport,
  type DriveEntry,
  STEP_COUNT,
  describeCache,
  describeError,
  describeOffset,
  describeOffsetOutcome,
  describeRepeatReads,
  describeTransfer,
  driveName,
  formatDevice,
  progressFor,
  toApiError,
} from "./drive-format";

type JobProgress = { job_id: string; step: string; done: number; total: number };
type JobFinished =
  | { job_id: string; ok: true; result: CalibrationReport }
  | { job_id: string; ok: false; error: ApiError };

const element = el;

export function initDriveSetup(root: HTMLElement): { refresh: () => Promise<void> } {
  const refreshButton = root.querySelector<HTMLButtonElement>("#drives-refresh")!;
  const statusLine = root.querySelector<HTMLElement>("#drives-status")!;
  const list = root.querySelector<HTMLElement>("#drives-list")!;
  const progressBox = root.querySelector<HTMLElement>("#drive-progress")!;
  const progressLabel = root.querySelector<HTMLElement>("#drive-progress-label")!;
  const progressBar = root.querySelector<HTMLProgressElement>("#drive-progress-bar")!;
  const cancelButton = root.querySelector<HTMLButtonElement>("#drive-cancel")!;
  const resultBox = root.querySelector<HTMLElement>("#drive-result")!;

  let drives: DriveEntry[] = [];
  let busy = false;
  let currentJob: string | null = null;
  let currentDrive = "";

  function setStatus(message: string): void {
    statusLine.textContent = message;
  }

  function setBusy(value: boolean): void {
    busy = value;
    refreshButton.disabled = value;
    progressBox.hidden = !value;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = value;
    }
  }

  function row(term: string, detail: string): [HTMLElement, HTMLElement] {
    return [element("dt", undefined, term), element("dd", undefined, detail)];
  }

  function renderDrives(): void {
    list.replaceChildren();
    if (drives.length === 0) {
      list.append(element("p", "empty-note", "No optical drives were found."));
      return;
    }

    for (const drive of drives) {
      const card = element("article", "drive-card");
      card.append(element("h3", undefined, driveName(drive)));
      const details = [formatDevice(drive.device), drive.revision ? `firmware ${drive.revision.trim()}` : ""].filter(Boolean);
      card.append(element("p", "drive-meta", details.join(" · ")));

      if (drive.error) {
        card.append(element("p", "drive-error", `This drive can’t be used: ${drive.error}`));
        list.append(card);
        continue;
      }

      const facts = element("dl", "drive-facts");
      facts.append(
        ...row("Read offset", describeOffset(drive.profile)),
        ...row("Drive cache", describeCache(drive.profile)),
        ...row("Largest single read", describeTransfer(drive.profile)),
        ...row("Repeat reads agree", describeRepeatReads(drive.profile)),
      );
      card.append(facts);

      const hintId = `drive-hint-${drives.indexOf(drive)}`;
      const button = element("button", undefined, drive.profile ? "Check this drive again" : "Check this drive");
      button.type = "button";
      button.setAttribute("aria-describedby", hintId);
      button.disabled = busy;
      button.addEventListener("click", () => void startCalibration(drive));
      card.append(button);
      const hint = element("p", "drive-hint", "Put an audio CD in this drive first. The check only reads the disc and takes about half a minute.");
      hint.id = hintId;
      card.append(hint);
      list.append(card);
    }
  }

  // Each drive's track record: how its rips checked out over time (D104).
  const historyBox = element("section", "drive-history");
  list.after(historyBox);

  async function renderHistory(): Promise<void> {
    let records: DriveHistory[] = [];
    try {
      records = await invoke<DriveHistory[]>("drive_history");
    } catch {
      // The record is a convenience; the page works without it.
    }
    historyBox.replaceChildren();
    if (records.length === 0) {
      historyBox.append(element("p", "field-hint", "Drive history: nothing yet. Each disc you rip adds to a record of how well this drive reads, so a drive that is getting worse shows up."));
      return;
    }
    historyBox.append(element("h3", undefined, "Drive history"));
    for (const record of records) {
      const card = element("article", "drive-card");
      card.append(element("h4", undefined, record.name));
      const facts = element("ul", "drive-history-facts");
      for (const line of historyLines(record)) facts.append(element("li", undefined, line));
      card.append(facts);
      const hasConcern = record.notes.some((n) => !n.startsWith("Nothing worrying") && !n.startsWith("No discs"));
      for (const note of record.notes) card.append(element("p", hasConcern && note === record.notes[0] ? "result-warning" : "field-hint", note));
      historyBox.append(card);
    }
    const clear = element("button", "secondary", "Clear drive history");
    clear.type = "button";
    clear.addEventListener("click", () => {
      invoke("clear_drive_history").then(() => void renderHistory()).catch(() => {});
    });
    historyBox.append(clear);
  }

  async function refresh(): Promise<void> {
    setStatus("Looking for optical drives…");
    void renderHistory();
    try {
      drives = await invoke<DriveEntry[]>("list_drives");
      renderDrives();
      setStatus(drives.length === 1 ? "1 optical drive found." : `${drives.length} optical drives found.`);
    } catch (thrown) {
      drives = [];
      renderDrives();
      setStatus(describeError(toApiError(thrown)));
    }
  }

  function showResult(report: CalibrationReport): void {
    resultBox.replaceChildren();
    resultBox.hidden = false;
    const outcome = describeOffsetOutcome(report.offset);

    const heading = element("h3", undefined, outcome.verified ? "Drive check finished" : "Drive check finished with a warning");
    heading.tabIndex = -1;
    resultBox.append(heading);
    resultBox.append(element("p", outcome.verified ? "result-ok" : "result-warning", outcome.text));
    resultBox.append(element("p", undefined, "The drive’s settings were saved."));

    if (report.warnings.length > 0) {
      const warnings = element("ul", "result-warnings");
      for (const warning of report.warnings) {
        warnings.append(element("li", undefined, warning));
      }
      resultBox.append(warnings);
    }
    heading.focus();
  }

  function showFailure(error: ApiError): void {
    resultBox.replaceChildren();
    resultBox.hidden = false;
    const heading = element("h3", undefined, error.code === "cancelled" ? "Drive check cancelled" : "Drive check did not finish");
    heading.tabIndex = -1;
    resultBox.append(heading, element("p", "result-warning", describeError(error)));
    heading.focus();
  }

  async function startCalibration(drive: DriveEntry): Promise<void> {
    if (busy) {
      return;
    }
    currentDrive = driveName(drive);
    currentJob = null;
    resultBox.hidden = true;
    cancelButton.disabled = true;
    progressBar.value = 0;
    progressLabel.textContent = `Starting the check on ${currentDrive}…`;
    setBusy(true);
    setStatus(`Checking ${currentDrive}…`);
    try {
      const started = await invoke<{ job_id: string }>("calibrate_drive", { device: drive.device });
      // Events can arrive before this response; only adopt the id if none was adopted yet.
      if (busy) {
        currentJob ??= started.job_id;
        cancelButton.disabled = false;
      }
    } catch (thrown) {
      finish();
      const error = toApiError(thrown);
      showFailure(error);
      setStatus(describeError(error));
    }
  }

  function finish(): void {
    currentJob = null;
    setBusy(false);
    renderDrives();
  }

  function onProgress(progress: JobProgress): void {
    if (!busy || (currentJob !== null && progress.job_id !== currentJob)) {
      return;
    }
    currentJob ??= progress.job_id;
    const view = progressFor(progress.step, progress.done, progress.total);
    progressBar.value = view.percent;
    progressBar.setAttribute("aria-valuetext", `${view.percent} percent`);
    progressLabel.textContent = `Step ${view.stepNumber} of ${STEP_COUNT}: ${view.label}`;
  }

  async function onFinished(outcome: JobFinished): Promise<void> {
    if (!busy || (currentJob !== null && outcome.job_id !== currentJob)) {
      return;
    }
    finish();
    if (outcome.ok) {
      showResult(outcome.result);
      setStatus(`Finished checking ${currentDrive}.`);
      await refresh();
    } else {
      showFailure(outcome.error);
      setStatus(describeError(outcome.error));
    }
  }

  cancelButton.addEventListener("click", () => {
    if (currentJob === null) {
      return;
    }
    cancelButton.disabled = true;
    progressLabel.textContent = "Cancelling…";
    invoke("cancel_job", { job_id: currentJob }).catch(() => {
      // The job may have just finished; its own event reports the outcome.
    });
  });
  refreshButton.addEventListener("click", () => void refresh());

  listen<JobProgress>("job-progress", (event) => onProgress(event.payload)).catch(() => {
    setStatus("Progress updates are unavailable in this build.");
  });
  listen<JobFinished>("job-finished", (event) => void onFinished(event.payload)).catch(() => {});

  return { refresh };
}


