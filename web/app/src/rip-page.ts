// The "Rip a CD" page: choose a drive, look up the disc, pick the album, choose what to make, rip.
// The folder rules (archive folder chosen, nothing duplicated into the music library) are enforced
// by the sidecar before the disc is read; this page also explains them up front and blocks the button.
// All text is set with textContent; nothing from the sidecar or services is inserted as HTML.

import { blobFromBase64 } from "./cover-util";
import { invoke, listen, musicbrainzAddRelease, openExternal } from "./desktop-bridge";
import { type ShareDetails, attachUrl, detailsFromCandidate, detailsFromManual, gnudbArgs, musicbrainzRelease, shareOptions } from "./rip-share";
import { el } from "./dom";
import { type AlbumEdit, blankAlbum, describeDifferences, differences, discLengths, editProblem, fromCandidate, toCandidate, withAlbumArtist, withPastedTitles } from "./rip-album-edit";
import { createSourceStatus } from "./source-status";
import { type DriveEntry, describeError, driveName, formatDevice, toApiError } from "./drive-format";
import {
  type ArchiveView,
  type LookupCandidate,
  type LookupResult,
  type RipChoices,
  type RipProgress,
  type RipResult,
  buildRipRequest,
  editionsOfOneAlbum,
  releaseLines,
  describeAudio,
  describeRead,
  describeRetry,
  describeVerification,
  overallPercent,
  readyProblem,
  stageLabel,
  summarizeResult,
  describeLengthFit,
  lengthFitStrong,
  busyRetryDelay,
} from "./rip-format";

type JobFinished<T> = { job_id: string; ok: true; result: T } | { job_id: string; ok: false; error: { code: string; message: string } };

export function initRipPage(root: HTMLElement): { refresh: () => Promise<void> } {
  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const statusLine = q("#rip-status");
  const driveSelect = q<HTMLSelectElement>("#rip-drive");
  const driveNote = q("#rip-drive-note");
  const lookupButton = q<HTMLButtonElement>("#rip-lookup");
  const lookupNote = q("#rip-lookup-note");
  // How the online services are doing (busy, not answering, next try), right under the lookup.
  lookupNote.parentElement?.after(createSourceStatus());
  const candidateBox = q("#rip-candidates");
  const manualToggle = q<HTMLInputElement>("#rip-manual-toggle");
  // How many tracks the disc in the drive has (from the disc probe).
  let discTracks: number | null = null;
  // The album as the person sees and edits it (the table below the choices), whether it came from a release or is typed by hand.
  let edit: AlbumEdit | null = null;
  // What was shown before the last choice of release, to mark what the choice changed.
  let previousEdit: AlbumEdit | null = null;
  let differenceNote = "";
  const trackBox = q("#rip-tracks");
  const searchBox = q("#rip-search");
  const searchArtist = q<HTMLInputElement>("#rip-search-artist");
  const searchAlbum = q<HTMLInputElement>("#rip-search-album");
  const searchButton = q<HTMLButtonElement>("#rip-search-go");
  const archiveBox = q<HTMLInputElement>("#rip-archive");
  const archiveNote = q("#rip-archive-note");
  const mp3Box = q<HTMLInputElement>("#rip-mp3");
  const qualitySelect = q<HTMLSelectElement>("#rip-quality");
  const keepWavBox = q<HTMLInputElement>("#rip-keep-wav");
  const problemLine = q("#rip-problem");
  const ripButton = q<HTMLButtonElement>("#rip-start");
  const progressBox = q("#rip-progress");
  const progressLabel = q("#rip-progress-label");
  const progressBar = q<HTMLProgressElement>("#rip-progress-bar");
  const cancelButton = q<HTMLButtonElement>("#rip-cancel");
  const resultBox = q("#rip-result");

  let drives: DriveEntry[] = [];
  let archiveView: ArchiveView | null = null;
  let lookup: LookupResult | null = null;
  let chosen: LookupCandidate | null = null;
  const selectedTracks = new Set<number>();
  let busy: "lookup" | "rip" | null = null;
  let currentJob: string | null = null;
  let laterSteps = 0;

  const setStatus = (message: string): void => {
    statusLine.textContent = message;
  };

  function choices(): RipChoices {
    return {
      device: driveSelect.value,
      // The table is always what is ripped: the chosen release with the person's edits, or the album typed by hand.
      candidate: edit ? toCandidate(edit, manualToggle.checked ? null : (chosen?.album ?? null)) : null,
      manual: { album: "", artist: "" },
      tracks: [...selectedTracks],
      archive: archiveBox.checked,
      mp3: mp3Box.checked,
      mp3Quality: qualitySelect.value === "cbr320" ? "cbr320" : "v0",
      keepWav: keepWavBox.checked,
    };
  }

  function hasAlbum(): boolean {
    return edit !== null && editProblem(edit) === null;
  }

  // A match that is not this exact disc (found by track layout or by name) is only a guess until the person has compared it
  // with the case, so the rip does not start until they say so.
  let confirmed = false;
  // A source that was busy is asked again by itself (a growing pause, a few times); see busyRetryDelay.
  let retryTimer: number | undefined;
  let retryAttempt = 0;
  let retrying = false;
  let lastRequest: "lookup" | "search" = "lookup";
  const stopRetrying = (): void => {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  /** A request the person made (not one this page repeated) starts the count again. */
  const startedByPerson = (kind: "lookup" | "search"): void => {
    stopRetrying();
    if (!retrying) retryAttempt = 0;
    retrying = false;
    lastRequest = kind;
  };
  const needsConfirmation = (): boolean => !manualToggle.checked && chosen !== null && chosen.album.quality !== "exact" && !confirmed;

  // Set once the share panel below exists (updateControls can be called from anywhere, so it must not need the panel yet).
  let shareUpdater: () => void = () => {};

  function updateControls(): void {
    shareUpdater();
    const current = choices();
    const typedProblem = edit !== null ? editProblem(edit) : null;
    const problem = busy ? null : needsConfirmation() ? "Check the album details against your case, then tick “These details match my disc”." : (typedProblem ?? readyProblem(current, archiveView, hasAlbum()));
    problemLine.textContent = problem ?? "";
    if (problem !== null && /Settings|music folder/.test(problem)) {
      const go = el("button", "secondary", /Settings/.test(problem) ? "Open Settings" : "Open Library");
      go.type = "button";
      go.addEventListener("click", () => document.querySelector<HTMLButtonElement>(/Settings/.test(problem) ? "[data-page=settings]" : "[data-page=library]")?.click());
      problemLine.append(" ", go);
    }
    problemLine.hidden = problem === null || busy !== null;
    ripButton.disabled = busy !== null || problem !== null;
    lookupButton.disabled = busy !== null || !driveSelect.value;
    searchButton.disabled = busy !== null || !driveSelect.value || (searchAlbum.value.trim() === "" && searchArtist.value.trim() === "");
    searchBox.hidden = manualToggle.checked;
    driveSelect.disabled = busy !== null;
    qualitySelect.disabled = !mp3Box.checked || busy !== null;
    archiveNote.textContent = archiveView?.archive_dir
      ? `Archive folder: ${archiveView.archive_dir}`
      : "No archive folder is chosen yet (Settings).";
    candidateBox.hidden = manualToggle.checked;
    trackBox.hidden = edit === null && !manualToggle.checked;
  }

  function renderDrives(): void {
    const previous = driveSelect.value;
    driveSelect.replaceChildren();
    const usable = drives.filter((d) => !d.error);
    for (const drive of usable) {
      const option = el("option", undefined, `${driveName(drive)} (${formatDevice(drive.device)})`);
      option.value = drive.device;
      driveSelect.append(option);
    }
    if (usable.some((d) => d.device === previous)) {
      driveSelect.value = previous;
    }
    const drive = usable.find((d) => d.device === driveSelect.value);
    if (usable.length === 0) {
      driveNote.textContent = "No usable optical drive was found.";
    } else if (!drive?.profile?.read_offset) {
      driveNote.textContent = "This drive has not been checked yet. Run its check under Drive setup, just above, before ripping.";
      document.querySelector<HTMLDetailsElement>("#drive-setup-details")?.setAttribute("open", "");
    } else {
      driveNote.textContent = "Put the audio CD in this drive.";
    }
    updateControls();
  }

  function renderCandidates(): void {
    candidateBox.replaceChildren();
    if (lookup === null) {
      return;
    }
    if (lookup.candidates.length === 0) {
      candidateBox.append(el("p", "empty-note", lookup.searched ? "Nothing with this disc's number of tracks was found for that name. Try other spellings, or enter the details by hand below." : "No album was found for this disc. Search by name below (the album may be listed, just not this exact pressing), or enter the details by hand."));
    } else if (!lookup.searched && lookup.candidates.every((c) => c.album.quality !== "exact")) {
      candidateBox.append(el("p", "result-warning", "None of these is this exact disc. They only have a similar track layout and may be different albums. Compare with your case, or search by name below."));
    }
    if (lookup.candidates.length === 0 && !lookup.sources_tried.includes("discogs")) {
      candidateBox.append(el("p", "field-hint", "Small or new releases are often on Discogs rather than MusicBrainz. You can switch Discogs on in Settings with your own free Discogs access token, and the name search will use it too."));
    }
    if (editionsOfOneAlbum(lookup.candidates.map((c) => c.album))) {
      candidateBox.append(el("p", "result-warning", `This disc matches ${lookup.candidates.length} releases of the same album. Pick the one that matches your copy (the cover, the date, the label and the barcode on the case) so every tag is right from the start.`));
    }
    lookup.candidates.forEach((candidate, index) => {
      const label = el("label", "rip-candidate");
      const input = el("input");
      input.type = "radio";
      input.name = "rip-candidate";
      input.checked = chosen === candidate;
      input.addEventListener("change", () => choose(candidate));
      const info = candidate.album;
      const cover = el("img", "rip-cover");
      cover.alt = "";
      cover.width = 96;
      cover.height = 96;
      cover.hidden = true;
      void coverFor(info.cover_art_release).then((url) => {
        if (url) {
          cover.src = url;
          cover.hidden = false;
        }
      });
      const text = el("span", "rip-candidate-text");
      const year = info.year ? ` (${info.year})` : "";
      text.append(el("strong", undefined, `${info.album_artist}: ${info.album}${year}`));
      for (const line of releaseLines(info)) text.append(el("span", "field-hint", line));
      const facts = [`${info.tracks.length} tracks`, info.quality === "exact" ? "this exact disc is listed" : (lookup?.searched ? "found by name; this disc is not listed for it" : "similar track layout only, may be a different album; this disc is not listed"), info.genre ?? "", candidate.sources.map((s) => (s === "discogs" ? "Data provided by Discogs (discogs.com)" : s === "itunes" ? "from the iTunes catalogue (Apple)" : s === "deezer" ? "from the Deezer catalogue" : s.startsWith("ctdb:") ? `CUETools Database (${s.slice(5)})` : s)).join(", ")].filter(Boolean).join(" · ");
      text.append(el("span", "field-hint", facts));
      const lengths = describeLengthFit(candidate.length_fit);
      if (lengths) text.append(el("span", lengths.kind === "warn" ? "result-warning" : "field-hint", lengths.text));
      label.append(input, cover, text);
      candidateBox.append(label);
      if (lookup?.automatic_choice === index && chosen === candidate) {
        text.append(el("span", "rip-auto", "best match"));
      }
    });
    for (const error of lookup.errors) {
      candidateBox.append(el("p", "result-warning", `${error.source}: ${error.message}`));
    }
  }

  function choose(candidate: LookupCandidate): void {
    // What the choice changes is marked in the table: the table as it was (with the person's edits) against the release now chosen.
    previousEdit = edit;
    chosen = candidate;
    edit = fromCandidate(candidate.album);
    differenceNote = previousEdit && !manualToggle.checked ? describeDifferences(differences(previousEdit, edit)) : "";
    // Choosing an album whose track lengths all agree with the disc starts the "matches my disc" check ticked (the
    // person can untick it); any other inexact match must be ticked by hand.
    confirmed = lengthFitStrong(candidate.length_fit);
    selectedTracks.clear();
    for (const track of candidate.album.tracks) selectedTracks.add(track.number);
    renderTracks();
    updateControls();
  }

  /** The person switched between a release from the lookup and an album typed by hand. */
  function onManualToggle(): void {
    previousEdit = null;
    differenceNote = "";
    selectedTracks.clear();
    if (manualToggle.checked) {
      const count = discTracks ?? lookup?.toc?.track_starts.length ?? 0;
      edit = count > 0 ? blankAlbum(count) : null;
      for (let number = 1; number <= count; number++) selectedTracks.add(number);
    } else {
      edit = chosen ? fromCandidate(chosen.album) : null;
      for (const track of chosen?.album.tracks ?? []) selectedTracks.add(track.number);
    }
    renderTracks();
    updateControls();
  }

  /** A text box for the album table; `onType` gets every change. */
  function textBox(value: string, label: string, onType: (value: string) => void): HTMLInputElement {
    const input = el("input");
    input.value = value;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => {
      onType(input.value);
      updateControls();
    });
    return input;
  }

  function renderTracks(): void {
    trackBox.replaceChildren();
    if (!edit) {
      if (manualToggle.checked) trackBox.append(el("p", "empty-note", "Put the disc in the drive first: the number of tracks comes from the disc."));
      return;
    }
    const album = edit;
    if (!manualToggle.checked && chosen && chosen.album.quality !== "exact") {
      const sure = el("label", "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = confirmed;
      box.addEventListener("change", () => {
        confirmed = box.checked;
        updateControls();
      });
      sure.append(box, el("span", undefined, `These details match my disc (I compared the title, tracks and edition with the case). This disc is not listed for this album, so the tags are only as good as that check.${lengthFitStrong(chosen.length_fit) ? " The track lengths agree with your disc, so this starts ticked; untick it if the case says otherwise." : ""}`));
      trackBox.append(sure);
    }
    trackBox.append(el("h4", undefined, "Album details and tracks to rip"));
    trackBox.append(el("p", "field-hint", "Everything here is editable and is what gets saved in the files. Changing the album artist carries down to the tracks that had it."));
    const diff = previousEdit && !manualToggle.checked ? differences(previousEdit, album) : null;
    if (differenceNote) trackBox.append(el("p", "rip-differs", differenceNote));

    // The album-level boxes.
    const header = el("div", "rip-album-fields");
    const field = (label: string, key: "album" | "albumArtist" | "year" | "genre", extra?: string): HTMLInputElement => {
      const wrap = el("label", "rip-album-field");
      wrap.append(el("span", "field-hint", label));
      const input = textBox(album[key], label, (value) => {
        if (key === "albumArtist") {
          const next = withAlbumArtist(album, value);
          album.albumArtist = next.albumArtist;
          next.rows.forEach((row, i) => {
            album.rows[i]!.artist = row.artist;
            const box = artistBoxes[i];
            if (box && box.value !== row.artist) box.value = row.artist;
          });
        } else {
          album[key] = value;
        }
      });
      if (extra) input.setAttribute("inputmode", extra);
      if (diff?.fields.includes(key)) {
        input.classList.add("rip-changed");
        input.title = `Before: ${previousEdit?.[key] || "(empty)"}`;
      }
      wrap.append(input);
      header.append(wrap);
      return input;
    };
    const artistBoxes: HTMLInputElement[] = [];
    field("Album", "album");
    field("Album artist", "albumArtist");
    field("Genre", "genre");
    field("Year", "year", "numeric");
    trackBox.append(header);

    const bulk = el("div", "rip-bulk");
    for (const [label, all] of [["Select all", true], ["Select none", false]] as const) {
      const button = el("button", "secondary", label);
      button.type = "button";
      button.addEventListener("click", () => {
        selectedTracks.clear();
        if (all) for (const row of album.rows) selectedTracks.add(row.number);
        renderTracks();
        updateControls();
      });
      bulk.append(button);
    }
    trackBox.append(bulk);

    const lengths = lookup?.toc ? discLengths(lookup.toc.track_starts, lookup.toc.leadout) : [];
    const table = el("table", "rip-album-table");
    const head = el("tr");
    head.append(el("th", undefined, "Rip"), el("th", undefined, "#"), el("th", undefined, "Title"), el("th", undefined, "Artist"));
    if (lengths.length > 0) head.append(el("th", undefined, "Length"));
    table.append(head);
    album.rows.forEach((row, index) => {
      const tr = el("tr");
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = selectedTracks.has(row.number);
      tick.setAttribute("aria-label", `Rip track ${row.number}`);
      tick.addEventListener("change", () => {
        if (tick.checked) selectedTracks.add(row.number);
        else selectedTracks.delete(row.number);
        updateControls();
      });
      const tickCell = el("td");
      tickCell.append(tick);
      const title = textBox(row.title, `Title of track ${row.number}`, (value) => {
        row.title = value;
      });
      const artist = textBox(row.artist, `Artist of track ${row.number}`, (value) => {
        row.artist = value;
      });
      artistBoxes[index] = artist;
      if (diff?.titles.includes(row.number)) {
        title.classList.add("rip-changed");
        title.title = `Before: ${previousEdit?.rows.find((r) => r.number === row.number)?.title || "(empty)"}`;
      }
      if (diff?.artists.includes(row.number)) {
        artist.classList.add("rip-changed");
        artist.title = `Before: ${previousEdit?.rows.find((r) => r.number === row.number)?.artist || "(empty)"}`;
      }
      const titleCell = el("td");
      titleCell.append(title);
      const artistCell = el("td");
      artistCell.append(artist);
      tr.append(tickCell, el("td", "rip-album-number", String(row.number).padStart(2, "0")), titleCell, artistCell);
      if (lengths.length > 0) tr.append(el("td", "rip-album-length", lengths[index] ?? ""));
      table.append(tr);
    });
    trackBox.append(table);

    // Titles from a booklet or a web page can be pasted all at once.
    const paste = el("details", "rip-paste");
    paste.append(el("summary", undefined, "Paste all the track titles at once"));
    const area = el("textarea");
    area.rows = 6;
    area.setAttribute("aria-label", "Track titles, one per line");
    const fill = el("button", "secondary", "Fill the titles in");
    fill.type = "button";
    fill.addEventListener("click", () => {
      if (!edit) return;
      edit = withPastedTitles(edit, area.value);
      renderTracks();
      updateControls();
    });
    paste.append(el("p", "field-hint", "One title per line, in disc order. A number in front of each line is dropped."), area, fill);
    trackBox.append(paste);
  }

  async function refresh(): Promise<void> {
    setStatus("Looking for optical drives…");
    try {
      drives = await invoke<DriveEntry[]>("list_drives");
      archiveView = await invoke<ArchiveView>("get_archive_settings");
      archiveBox.checked = archiveView.archive_enabled;
      setStatus(drives.length === 1 ? "1 optical drive found." : `${drives.length} optical drives found.`);
    } catch (thrown) {
      drives = [];
      setStatus(describeError(toApiError(thrown)));
    }
    renderDrives();
  }

  // A drive that is stuck on a scratch or a speck of dirt can sit on one spot for many minutes, and Cancel could not break in (D157). The page says so instead of
  // looking frozen, and says when a cancel is taking long (the program ends the CD helper itself after 15 seconds).
  let lastLabel = "";
  let lastProgressAt = Date.now();
  let cancelRequestedAt: number | null = null;
  let stallTimer: number | undefined;
  const STALL_HINT_MS = 150_000;
  const STILL_STOPPING_MS = 20_000;

  function setProgress(percent: number, label: string): void {
    progressBar.value = percent;
    progressBar.setAttribute("aria-valuetext", `${percent} percent`);
    lastLabel = label;
    lastProgressAt = Date.now();
    progressLabel.textContent = cancelRequestedAt === null ? label : "Cancelling…";
  }

  function watchForStall(): void {
    if (stallTimer !== undefined) return;
    stallTimer = window.setInterval(() => {
      if (busy !== "rip") {
        window.clearInterval(stallTimer);
        stallTimer = undefined;
        return;
      }
      const now = Date.now();
      if (cancelRequestedAt !== null) {
        if (now - cancelRequestedAt > STILL_STOPPING_MS) progressLabel.textContent = "Still stopping: the drive is busy with a read it cannot break off. The program is ending the CD helper; tracks already ripped are kept.";
      } else if (now - lastProgressAt > STALL_HINT_MS) {
        const minutes = Math.floor((now - lastProgressAt) / 60_000);
        progressLabel.textContent = `${lastLabel}: nothing new for ${minutes} minute${minutes === 1 ? "" : "s"}. The drive is probably struggling with a scratch or a speck of dirt. Cancel stops it and keeps the tracks already ripped.`;
      }
    }, 5000);
  }

  async function startLookup(): Promise<void> {
    startedByPerson("lookup");
    busy = "lookup";
    currentJob = null;
    lookup = null;
    chosen = null;
    edit = null;
    previousEdit = null;
    differenceNote = "";
    candidateBox.replaceChildren();
    trackBox.replaceChildren();
    lookupNote.textContent = "Looking up the disc…";
    updateControls();
    try {
      const started = await invoke<{ job_id: string }>("lookup_disc", { device: driveSelect.value });
      currentJob ??= started.job_id;
    } catch (thrown) {
      busy = null;
      lookupNote.textContent = describeError(toApiError(thrown));
      updateControls();
    }
  }

  async function startSearch(): Promise<void> {
    startedByPerson("search");
    busy = "lookup";
    currentJob = null;
    lookup = null;
    chosen = null;
    edit = null;
    previousEdit = null;
    differenceNote = "";
    candidateBox.replaceChildren();
    trackBox.replaceChildren();
    lookupNote.textContent = "Searching MusicBrainz…";
    updateControls();
    try {
      const started = await invoke<{ job_id: string }>("search_albums", { device: driveSelect.value, artist: searchArtist.value, album: searchAlbum.value });
      currentJob ??= started.job_id;
    } catch (thrown) {
      busy = null;
      lookupNote.textContent = describeError(toApiError(thrown));
      updateControls();
    }
  }

  // A new disc in the drive refreshes the album choices and the track list by itself (the drive is asked which disc it
  // holds every few seconds while this page is showing and nothing else is using the drive).
  let lastDisc: string | null | undefined;
  async function probeDisc(): Promise<void> {
    const calibrating = document.querySelector<HTMLElement>("#drive-progress")?.hidden === false;
    if (busy !== null || calibrating || !driveSelect.value || root.offsetParent === null) return;
    try {
      const found = await invoke<{ present: boolean; id: string | null; tracks?: number }>("disc_probe", { device: driveSelect.value });
      if (busy !== null) return;
      discTracks = found.present && found.tracks ? found.tracks : null;
      updateControls();
      const id = found.present ? (found.id ?? "data-disc") : null;
      if (id === lastDisc) return;
      lastDisc = id;
      stopRetrying();
      retryAttempt = 0;
      lookup = null;
      chosen = null;
      edit = null;
      previousEdit = null;
      differenceNote = "";
      confirmed = false;
      candidateBox.replaceChildren();
      trackBox.replaceChildren();
      resultBox.hidden = true;
      if (found.present && found.id) {
        void startLookup();
      } else {
        lookupNote.textContent = found.present ? "This disc is not an audio CD." : "No disc in the drive.";
        updateControls();
      }
    } catch {
      // The drive may be busy or the page closing; try again at the next tick.
    }
  }
  window.setInterval(() => void probeDisc(), 5000);

  // ---- Share this disc (D107): MusicBrainz attach link, MusicBrainz Add Release form, gnudb submission ----
  const shareBox = q<HTMLDetailsElement>("#rip-share");
  const shareBody = q("#rip-share-body");
  const shareNote = el("p", "field-hint");
  const shareStatus = el("p", undefined);
  shareStatus.setAttribute("role", "status");
  const attachButton = el("button", "secondary", "Attach this disc to a MusicBrainz release…");
  const addReleaseButton = el("button", "secondary", "Add this album to MusicBrainz…");
  const emailField = el("input");
  emailField.type = "email";
  emailField.id = "share-email";
  emailField.autocomplete = "email";
  const emailLabel = el("label", undefined, "Your own email address (gnudb requires it and uses it to tell you if an entry is rejected)");
  emailLabel.htmlFor = "share-email";
  const categorySelect = el("select");
  for (const name of ["", "rock", "reggae", "jazz", "blues", "classical", "country", "folk", "newage", "soundtrack", "misc"]) {
    const option = el("option", undefined, name === "" ? "Pick the category for me" : name);
    option.value = name;
    categorySelect.append(option);
  }
  const gnudbButton = el("button", "secondary", "Send to gnudb…");
  const gnudbConfirm = el("div");
  gnudbConfirm.hidden = true;
  for (const button of [attachButton, addReleaseButton, gnudbButton]) button.type = "button";
  try {
    emailField.value = window.localStorage.getItem("mediaverse.gnudbEmail") ?? "";
  } catch {
    // No saved address; the box just starts empty.
  }
  shareBody.append(
    el("p", "field-hint", "The big free databases only know a disc when someone adds it. If you add yours, the next person (and your own re-rip) finds it at once. Only the album details you confirmed above are used, and nothing is sent until you press a button and confirm."),
    shareNote,
    el("h4", undefined, "MusicBrainz (needs a free MusicBrainz account; your browser opens)"),
    attachButton,
    addReleaseButton,
    el("p", "field-hint", "Use “Attach” when the album is already on MusicBrainz (it asks you to pick the release). Use “Add” when it is not: your browser opens MusicBrainz's form with the album, tracks and lengths filled in, and you press Enter edit there yourself. Attach the disc ID afterwards."),
    el("h4", undefined, "gnudb (free; your own email address is required)"),
    emailLabel,
    emailField,
    el("label", undefined, "Category"),
    categorySelect,
    gnudbButton,
    gnudbConfirm,
    shareStatus,
  );

  /** The confirmed details to share, or the reason there are none yet. */
  function shareDetails(): ShareDetails | string {
    if (manualToggle.checked) {
      if (!edit) return "Put the disc in the drive first.";
      if (edit.album.trim() === "" || edit.albumArtist.trim() === "") return "Type the album and the artist first.";
      if (edit.rows.some((row) => row.title.trim() === "")) return `Type all ${edit.rows.length} track titles first.`;
      return detailsFromCandidate(toCandidate(edit, null));
    }
    if (!chosen) return "Choose the album above first.";
    if (needsConfirmation()) return "Tick “These details match my disc” above first.";
    return detailsFromCandidate(edit ? toCandidate(edit, chosen.album) : chosen.album);
  }

  function updateShare(): void {
    const options = shareOptions(lookup);
    shareBox.hidden = options.toc === null || (!options.musicbrainz && !options.gnudb);
    if (shareBox.hidden) return;
    const details = shareDetails();
    const ready = typeof details !== "string";
    shareNote.textContent = ready ? `Will use: ${details.artist} - ${details.album}, ${details.tracks.length} tracks.` : details;
    attachButton.hidden = !options.musicbrainz;
    addReleaseButton.hidden = !options.musicbrainz;
    addReleaseButton.disabled = !ready;
    for (const part of [emailLabel, emailField, categorySelect, gnudbButton]) part.hidden = !options.gnudb;
    gnudbButton.disabled = !ready;
    if (!ready) gnudbConfirm.hidden = true;
  }

  shareUpdater = updateShare;

  attachButton.addEventListener("click", () => {
    const toc = shareOptions(lookup).toc;
    if (toc) void openExternal(attachUrl(toc));
  });
  addReleaseButton.addEventListener("click", () => {
    const toc = shareOptions(lookup).toc;
    const details = shareDetails();
    if (!toc || typeof details === "string") return;
    shareStatus.textContent = "Opening MusicBrainz in your browser…";
    void musicbrainzAddRelease(musicbrainzRelease(details, toc)).then((reply) => {
      shareStatus.textContent = reply.ok ? "MusicBrainz is open in your browser. Log in, check the details and press Enter edit; then use “Attach” to add this disc's ID to the release." : `Could not open it: ${reply.message ?? "unknown problem"}`;
    });
  });
  gnudbButton.addEventListener("click", () => {
    const toc = shareOptions(lookup).toc;
    const details = shareDetails();
    if (!toc || typeof details === "string") return;
    const email = emailField.value.trim();
    gnudbConfirm.replaceChildren();
    gnudbConfirm.hidden = false;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      gnudbConfirm.append(el("p", "result-warning", "Type your own email address first: gnudb requires it."));
      return;
    }
    const send = el("button", undefined, "Yes, send it to gnudb");
    send.type = "button";
    gnudbConfirm.append(
      el("p", undefined, `This sends to gnudb (a public database): ${details.artist} / ${details.album}, ${details.tracks.length} track titles, the disc's layout, and your email address ${email}. It cannot be taken back.`),
      send,
    );
    send.addEventListener("click", () => {
      send.disabled = true;
      shareStatus.textContent = "Sending to gnudb…";
      invoke<{ message: string; category: string }>("submit_gnudb", gnudbArgs(details, toc, email, categorySelect.value))
        .then((reply) => {
          shareStatus.textContent = `gnudb accepted it (${reply.category}): ${reply.message} It usually appears in lookups within about ten minutes.`;
          gnudbConfirm.hidden = true;
          try {
            window.localStorage.setItem("mediaverse.gnudbEmail", email);
          } catch {
            // Not remembered; fine.
          }
        })
        .catch((thrown) => {
          shareStatus.textContent = describeError(toApiError(thrown));
          send.disabled = false;
        });
    });
  });

  async function startRip(): Promise<void> {
    const current = choices();
    const all = (current.candidate?.tracks ?? []).map((t) => t.number);
    laterSteps = Number(current.archive) + Number(current.mp3);
    busy = "rip";
    currentJob = null;
    resultBox.hidden = true;
    resultBox.replaceChildren();
    progressBox.hidden = false;
    cancelButton.disabled = true;
    setProgress(0, "Starting…");
    setStatus("Ripping…");
    updateControls();
    try {
      const started = await invoke<{ job_id: string }>("rip_disc", buildRipRequest(current, all));
      currentJob ??= started.job_id;
      cancelButton.disabled = false;
    } catch (thrown) {
      finishRip();
      showFailure(toApiError(thrown));
    }
  }

  function finishRip(): void {
    busy = null;
    currentJob = null;
    progressBox.hidden = true;
    updateControls();
  }

  function showFailure(error: { code: string; message: string }): void {
    resultBox.hidden = false;
    resultBox.replaceChildren();
    const heading = el("h3", undefined, error.code === "cancelled" ? "Rip cancelled" : "The rip did not finish");
    heading.tabIndex = -1;
    resultBox.append(heading, el("p", "result-warning", describeError(error)));
    if (error.code === "archive_folder_required" || error.code === "invalid_archive_location") {
      resultBox.append(el("p", undefined, "Open Settings to choose a Media Library Archive folder, or switch the FLAC archive off."));
    }
    setStatus(describeError(error));
    heading.focus();
  }

  function showResult(result: RipResult): void {
    const summary = summarizeResult(result);
    resultBox.hidden = false;
    resultBox.replaceChildren();
    const heading = el("h3", undefined, summary.heading);
    heading.tabIndex = -1;
    resultBox.append(heading);
    const list = el("ul", "result-lines");
    for (const line of summary.lines) list.append(el("li", undefined, line));
    resultBox.append(list);

    // A disc that did not read cleanly comes first, before anything else.
    if (summary.health && summary.health.state !== "good") {
      const box = el("div", `rip-health rip-health-${summary.health.state}`);
      box.setAttribute("role", "alert");
      box.append(el("strong", undefined, summary.health.state === "damaged" ? "This disc has damage" : "Some tracks are worth a listen"), el("p", undefined, summary.health.headline));
      const items = el("ul");
      for (const t of summary.health.tracks.filter((x) => x.state === "damaged" || x.state === "suspect")) items.append(el("li", undefined, `Track ${t.number}: ${t.reasons.join(" ")}`));
      box.append(items);
      if (summary.health.advice.length) {
        box.append(el("p", undefined, "What to do:"));
        const advice = el("ul");
        for (const line of summary.health.advice) advice.append(el("li", undefined, line));
        box.append(advice);
      }
      resultBox.append(box);
    } else if (summary.health) {
      resultBox.append(el("p", "rip-health rip-health-good", summary.health.headline));
    }

    const table = el("table", "rip-table");
    const head = el("tr");
    for (const name of ["Track", "AccurateRip", "Disc read", ...(result.audio_check ? ["Audio (AcoustID)"] : [])]) head.append(el("th", undefined, name));
    table.append(head);
    for (const track of result.tracks) {
      const row = el("tr");
      row.append(el("td", undefined, String(track.number).padStart(2, "0")), el("td", track.verification.kind === "no_match" && !track.pressing_shift ? "result-warning" : undefined, describeVerification(track.verification, track.pressing_shift)), el("td", result.disc_health?.tracks.some((h) => h.number === track.number && (h.state === "damaged" || h.state === "suspect")) ? "result-warning" : undefined, describeRead(result.disc_health, track.number)));
      if (result.audio_check) {
        const audio = describeAudio(result.audio_check, track.number);
        row.append(el("td", audio.warn ? "result-warning" : undefined, audio.text));
      }
      table.append(row);
    }
    resultBox.append(table);

    if (summary.warnings.length > 0) {
      resultBox.append(el("h4", undefined, "Things to know"));
      const warnings = el("ul", "result-warnings");
      for (const warning of summary.warnings) warnings.append(el("li", undefined, warning));
      resultBox.append(warnings);
    }
    setStatus(summary.heading + ".");
    heading.focus();
  }

  /** Small covers of the releases the lookup found, fetched once each (blob URLs; none when the release has no cover). */
  const coverUrls = new Map<string, Promise<string | null>>();
  function coverFor(release: string | null | undefined): Promise<string | null> {
    if (!release) return Promise.resolve(null);
    let found = coverUrls.get(release);
    if (!found) {
      found = invoke<{ mime: string; data_base64: string } | null>("cover_preview", { release })
        .then((reply) => (reply && (reply.mime === "image/jpeg" || reply.mime === "image/png") ? URL.createObjectURL(blobFromBase64(reply.data_base64, reply.mime)) : null))
        .catch(() => null);
      coverUrls.set(release, found);
    }
    return found;
  }

  let lastPercent = 0;
  function onProgress(progress: RipProgress): void {
    if (busy === null || (currentJob !== null && progress.job_id !== currentJob)) return;
    currentJob ??= progress.job_id;
    if (progress.kind === "lookup") {
      lookupNote.textContent = progress.source && progress.source !== "done" ? `Asking ${progress.source}…` : "Looking up the disc…";
      return;
    }
    if (busy !== "rip") return;
    watchForStall();
    if (progress.kind === "rip_retry") {
      setProgress(lastPercent, describeRetry(progress));
      return;
    }
    if (progress.kind === "audio_check") {
      setProgress(lastPercent, `${stageLabel(progress.kind)} (track ${progress.track ?? "?"} of ${progress.tracks_total ?? "?"})`);
      return;
    }
    const track = progress.track ? ` (track ${progress.track})` : "";
    lastPercent = overallPercent(progress.kind, progress, laterSteps);
    setProgress(lastPercent, `${stageLabel(progress.kind)}${track}`);
  }

  function onFinished(outcome: JobFinished<unknown>): void {
    if (busy === null || (currentJob !== null && outcome.job_id !== currentJob)) return;
    cancelRequestedAt = null;
    if (busy === "lookup") {
      busy = null;
      currentJob = null;
      try {
        if (outcome.ok) {
          lookup = outcome.result as LookupResult;
          lookupNote.textContent = lookup.candidates.length === 0 ? "No match found." : `${lookup.candidates.length} possible match${lookup.candidates.length === 1 ? "" : "es"}.`;
          // Several releases of one album: the first is ticked so a rip can start, but the person is asked to check it against the case.
          const sameAlbum = editionsOfOneAlbum(lookup.candidates.map((c) => c.album));
          const automatic = lookup.automatic_choice !== null ? lookup.candidates[lookup.automatic_choice] : sameAlbum && !lookup.searched ? lookup.candidates[0] : null;
          if (automatic) chosen = automatic;
          renderCandidates();
          if (automatic) choose(automatic);
          // A source said it was busy: ask again by itself, unless the person has already picked an album.
          const delay = chosen === null ? busyRetryDelay(lookup.errors, retryAttempt) : null;
          if (delay !== null) {
            lookupNote.textContent = `${lookupNote.textContent} A source is busy; asking again in ${delay} seconds.`;
            retryTimer = window.setTimeout(() => {
              retryTimer = undefined;
              if (busy !== null || chosen !== null) return;
              retryAttempt += 1;
              retrying = true;
              void (lastRequest === "search" ? startSearch() : startLookup());
            }, delay * 1000);
          } else if (!lookup.errors.some((e) => e.code === "rate_limited")) {
            retryAttempt = 0;
          }
        } else {
          lookupNote.textContent = describeError(outcome.error);
        }
      } finally {
        updateControls();
      }
      return;
    }
    finishRip();
    if (outcome.ok) showResult(outcome.result as RipResult);
    else showFailure(outcome.error);
  }

  manualToggle.addEventListener("change", onManualToggle);
  for (const control of [driveSelect, manualToggle, archiveBox, mp3Box, qualitySelect, keepWavBox]) {
    control.addEventListener("input", () => {
      if (control === driveSelect) renderDrives();
      updateControls();
    });
    control.addEventListener("change", updateControls);
  }
  lookupButton.addEventListener("click", () => void startLookup());
  searchButton.addEventListener("click", () => void startSearch());
  for (const field of [searchArtist, searchAlbum]) {
    field.addEventListener("input", updateControls);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !searchButton.disabled) void startSearch();
    });
  }
  ripButton.addEventListener("click", () => void startRip());
  cancelButton.addEventListener("click", () => {
    if (currentJob === null) return;
    cancelButton.disabled = true;
    cancelRequestedAt = Date.now();
    progressLabel.textContent = "Cancelling…";
    invoke("cancel_job", { job_id: currentJob }).catch(() => {
      // The job may have just finished; its own event reports the outcome.
    });
  });
  listen<RipProgress>("job-progress", (event) => onProgress(event.payload)).catch(() => setStatus("Progress updates are unavailable in this build."));
  listen<JobFinished<unknown>>("job-finished", (event) => onFinished(event.payload)).catch(() => {});

  return { refresh };
}
