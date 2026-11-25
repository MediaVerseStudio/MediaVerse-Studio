// Pure logic for the "Rip a CD" page: what blocks a rip, what request to send, and how to describe
// progress and results in plain language. No DOM access, so it is unit tested with `npm run test:unit`.

export type CandidateTrack = { number: number; title: string; artist?: string | null };

/** One source's description of the album. This is what `rip_disc` takes as `candidate`. */
export type Candidate = {
  source: string;
  source_id?: string;
  album: string;
  album_artist: string;
  year?: number | null;
  genre?: string | null;
  tracks: CandidateTrack[];
  /** "exact": this release has this very disc's disc ID; "inexact": the same album by name and track count. */
  quality?: "exact" | "inexact";
  /** MusicBrainz release id whose front cover can be shown. */
  cover_art_release?: string | null;
  /** Which edition this is (date, country, label, catalogue number, barcode, format). */
  release?: { date?: string; country?: string; label?: string; catalog_number?: string; barcode?: string; format?: string; status?: string } | null;
  [key: string]: unknown;
};

/**
 * When a lookup came back because a source was busy (the sidecar's `rate_limited`), how many seconds to wait before
 * asking again by itself: 15, 30, 60, then 120, for at most eight tries. `null` when nothing was busy or the tries are used up.
 */
export function busyRetryDelay(errors: { code: string }[], attempt: number): number | null {
  if (!errors.some((e) => e.code === "rate_limited") || attempt >= 8) return null;
  return Math.min(120, 15 * 2 ** attempt);
}

/** How well an album's track lengths agree with the disc in the drive (counted by the sidecar). */
export type LengthFit = { compared: number; total: number; within: number; worst_ms: number };

/** A lookup answer: the album details plus every source that agreed on them. */
export type LookupCandidate = { album: Candidate; sources: string[]; length_fit?: LengthFit | null };

/** Every track that has a length agrees, and nearly all do: the same album for practical purposes (as the sidecar judges it). */
export function lengthFitStrong(fit: LengthFit | null | undefined): boolean {
  return !!fit && fit.compared >= 4 && fit.within === fit.compared && fit.compared * 10 >= fit.total * 9;
}

/** The line shown under an album choice about its track lengths, or null when its source gave no lengths. */
export function describeLengthFit(fit: LengthFit | null | undefined): { kind: "good" | "warn" | "info"; text: string } | null {
  if (!fit || fit.compared === 0) return null;
  const seconds = Math.round(fit.worst_ms / 1000);
  const listed = fit.compared === fit.total ? `all ${fit.total}` : `${fit.compared} of ${fit.total}`;
  if (lengthFitStrong(fit)) return { kind: "good", text: `Track lengths agree with your disc (${listed} within 3 seconds): very likely the right album.` };
  if (fit.within * 2 < fit.compared) return { kind: "warn", text: `Only ${fit.within} of ${fit.compared} track lengths agree with your disc: probably a different album or edition.` };
  return { kind: "info", text: `${fit.within} of ${fit.compared} track lengths agree with your disc (the biggest difference is ${seconds} seconds).` };
}

export type LookupResult = {
  candidates: LookupCandidate[];
  automatic_choice: number | null;
  errors: { source: string; code: string; message: string }[];
  sources_tried: string[];
  /** True for the answer to a search by name (never chosen automatically). */
  searched?: boolean;
  /** The disc's table of contents (sector numbers from the start of the first track, and the lead-out). */
  toc?: { track_starts: number[]; leadout: number };
};

/** The lines that tell one edition from another: "1998-03-02 · GB · Hellcat · ABC 1 · CD" and "Barcode 0123 · Official". */
export function releaseLines(candidate: Candidate): string[] {
  const r = candidate.release;
  const lines: string[] = [];
  const first = [candidate.year && !r?.date ? String(candidate.year) : "", r?.date, r?.country, r?.label, r?.catalog_number, r?.format].filter(Boolean).join(" · ");
  if (first) lines.push(first);
  const second = [r?.barcode ? `Barcode ${r.barcode}` : "", r?.status && r.status !== "Official" ? r.status : ""].filter(Boolean).join(" · ");
  if (second) lines.push(second);
  return lines;
}

const albumKey = (c: Candidate): string => `${c.album_artist}\n${c.album}`.toLowerCase().replace(/[^\p{L}\p{N}\n]+/gu, "");

/** True when every candidate is the same album (artist and title) as the first: different editions of it, not different albums. */
export function editionsOfOneAlbum(candidates: Candidate[]): boolean {
  return candidates.length > 1 && candidates.every((c) => albumKey(c) === albumKey(candidates[0]));
}

export type ArchiveView = { archive_enabled: boolean; archive_dir: string | null; library_dir: string | null };

export type Verification = { kind: "matched" | "no_match" | "unavailable"; confidence?: number };

export type StepEntry = { track: number; ok: boolean; error?: string; path?: string };

/** How the disc read, per track that was not simply fine (D102). */
export type DiscHealth = {
  state: "good" | "suspect" | "damaged";
  headline: string;
  tracks: { number: number; state: "recovered" | "unconfirmed" | "shifted" | "unmatched" | "suspect" | "damaged"; reasons: string[]; passes: number }[];
  advice: string[];
};

/** What AcoustID made of the audio of each ripped track, compared with the details chosen (D113). A report only. */
export type AudioCheck = {
  state: "agrees" | "mixed" | "different" | "named" | "unknown" | "failed";
  headline: string;
  tracks: { number: number; state: "agrees" | "other" | "named" | "unknown" | "failed"; title?: string | null; artist?: string | null; sounds_like?: number | null; problem?: string | null; named?: boolean; tag_ids?: boolean }[];
  album_hint?: { title: string; artist: string; tracks: number; of: number } | null;
};

export type RipResult = {
  tracks: { number: number; verification: Verification; pressing_shift?: { samples: number; confidence: number } }[];
  /** Present when AcoustID is switched on in Settings. */
  audio_check?: AudioCheck;
  /** Whether the disc read cleanly, and what was wrong where; shown above everything else when it did not. */
  disc_health?: DiscHealth;
  warnings: string[];
  archive?: { dir: string; tracks: StepEntry[] };
  mp3?: { dir: string; tracks: StepEntry[] };
  wav_removed?: number;
  files?: string[];
  /** Defect scans of the tracks AccurateRip could not confirm. */
  defect_scan?: { track: number; report: { verdict: "clean" | "minor" | "suspect" } }[];
};

export type RipProgress = {
  job_id: string;
  kind: "rip" | "rip_retry" | "archive" | "mp3" | "lookup" | "audio_check";
  track?: number;
  /** For rip_retry: which read of the track this is, of how many. */
  pass?: number;
  passes?: number;
  tracks_done?: number;
  tracks_total?: number;
  done?: number;
  total?: number;
  source?: string;
};

export type RipChoices = {
  device: string;
  candidate: Candidate | null;
  /** Typed by hand: year, genre and the track titles (one per line, in disc order) are optional. */
  manual: { album: string; artist: string; year?: string; genre?: string; titles?: string };
  tracks: number[]; // chosen track numbers; empty means every track
  archive: boolean;
  mp3: boolean;
  mp3Quality: "v0" | "cbr320";
  keepWav: boolean;
};

/** Why a rip must not start yet because of the FLAC archive setting, or null when it is fine. */
export function archiveBlocker(view: ArchiveView | null, wantArchive: boolean): string | null {
  if (!wantArchive) {
    return null;
  }
  if (!view?.archive_dir) {
    return "Keeping a FLAC archive is switched on, but no archive folder is chosen. Choose one in Settings, or switch the archive off for this rip.";
  }
  return null;
}

/** Why MP3 copies cannot be made yet, or null. MP3 copies go to the music library folder. */
export function libraryBlocker(view: ArchiveView | null, wantMp3: boolean): string | null {
  if (wantMp3 && !view?.library_dir) {
    return "MP3 copies are saved in your music library, but no music folder is chosen yet. Choose one on the Library page, or switch MP3 copies off for this rip.";
  }
  return null;
}

/** What the user has still to decide before the Rip button works, or null when ready. */
export function readyProblem(choices: RipChoices, archive: ArchiveView | null, hasTracks: boolean): string | null {
  if (!choices.device) {
    return "Choose a drive.";
  }
  if (!hasTracks) {
    return "Look up the disc, or enter the album and artist by hand.";
  }
  if (!choices.archive && !choices.mp3) {
    return "Switch on at least one output: the FLAC archive or MP3 copies.";
  }
  return archiveBlocker(archive, choices.archive) ?? libraryBlocker(archive, choices.mp3);
}

/** The track list to show and rip: from the chosen album, or numbered placeholders for a hand-entered one. */
export function trackListFor(choices: Pick<RipChoices, "candidate">, trackCount: number): CandidateTrack[] {
  if (choices.candidate) {
    return choices.candidate.tracks;
  }
  return Array.from({ length: trackCount }, (_, index) => ({ number: index + 1, title: `Track ${String(index + 1).padStart(2, "0")}` }));
}

/** Track titles typed one per line; blank lines are ignored and a leading "01 ", "1." or "1)" is dropped. */
export function manualTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\d{1,3}\s*[.)\-:]?\s+/, "").trim())
    .filter((line) => line !== "");
}

/** What is wrong with typed titles for a disc of `trackCount` tracks, or null. */
export function titlesProblem(text: string, trackCount: number | null): string | null {
  const titles = manualTitles(text);
  if (titles.length === 0 || trackCount === null || titles.length === trackCount) return null;
  return `You typed ${titles.length} title${titles.length === 1 ? "" : "s"}, but the disc has ${trackCount} tracks.`;
}

/** The `rip_disc` arguments. A chosen album is sent whole; otherwise the hand-entered details. */
export function buildRipRequest(choices: RipChoices, allTrackNumbers: number[]): Record<string, unknown> {
  const request: Record<string, unknown> = {
    device: choices.device,
    archive: choices.archive,
    mp3: choices.mp3,
    mp3_quality: choices.mp3Quality,
    keep_wav: choices.keepWav,
  };
  const everything = choices.tracks.length === 0 || choices.tracks.length === allTrackNumbers.length;
  if (!everything) {
    request.tracks = [...choices.tracks].sort((a, b) => a - b);
  }
  if (choices.candidate) {
    request.candidate = choices.candidate;
  } else {
    const metadata: Record<string, unknown> = {
      album: choices.manual.album.trim(),
      album_artist: choices.manual.artist.trim(),
      artist: choices.manual.artist.trim(),
    };
    const year = Number.parseInt((choices.manual.year ?? "").trim(), 10);
    if (year >= 1000 && year <= 2999) metadata.release_year = year;
    const genre = (choices.manual.genre ?? "").trim();
    if (genre) metadata.genre = genre;
    const titles = manualTitles(choices.manual.titles ?? "");
    if (titles.length > 0) {
      metadata.tracks = Object.fromEntries(titles.map((title, index) => [String(index + 1), { title }]));
    }
    request.metadata = metadata;
  }
  return request;
}

export function describeVerification(verification: Verification, shift?: { samples: number; confidence: number }): string {
  switch (verification.kind) {
    case "matched":
      return verification.confidence !== undefined ? `Matches AccurateRip (seen ${verification.confidence} times)` : "Matches AccurateRip";
    case "no_match":
      return shift ? `Matches another pressing (shifted ${Math.abs(shift.samples)} samples)` : "Differs from AccurateRip's copy";
    default:
      return "Not confirmed (no AccurateRip entry)";
  }
}

/** One cell of the results table: what AcoustID says this track is, in words, and whether it deserves a second look. */
export function describeAudio(check: AudioCheck | undefined, number: number): { text: string; warn: boolean } {
  const entry = check?.tracks.find((t) => t.number === number);
  if (!entry) return { text: "Not checked", warn: false };
  const named = entry.title ? `“${entry.title}”${entry.artist ? ` by ${entry.artist}` : ""}` : "";
  switch (entry.state) {
    case "agrees":
      return { text: entry.tag_ids ? "Recognised: the song you chose (ids saved in the file)" : "Recognised: the song you chose", warn: false };
    case "other":
      return { text: `Sounds like ${named}${entry.sounds_like ? ` (the title of track ${entry.sounds_like})` : ""}`, warn: true };
    case "named":
      return { text: entry.named ? `Named from the audio: ${named}` : `Recognised as ${named}`, warn: false };
    case "failed":
      return { text: "Could not be checked", warn: false };
    default:
      return { text: "Not in AcoustID's database", warn: false };
  }
}

export function stageLabel(kind: RipProgress["kind"]): string {
  switch (kind) {
    case "audio_check":
      return "Checking the audio with AcoustID";
    case "rip":
      return "Reading the disc";
    case "rip_retry":
      return "Reading a damaged track again, more carefully";
    case "archive":
      return "Saving the FLAC archive copy";
    case "mp3":
      return "Making the MP3 copy";
    default:
      return "Looking up the disc";
  }
}

/** Progress for the whole job. Reading is weighted 70 %, the later steps share the rest. */
export function overallPercent(kind: RipProgress["kind"], progress: RipProgress, laterSteps: number): number {
  const tracksTotal = Math.max(progress.tracks_total ?? 1, 1);
  const within = progress.total ? Math.min((progress.done ?? 0) / progress.total, 1) : 0;
  const trackFraction = ((progress.tracks_done ?? 0) + (kind === "rip" ? within : 0)) / tracksTotal;
  if (kind === "rip") {
    return Math.round(trackFraction * (laterSteps > 0 ? 70 : 100));
  }
  const order = kind === "archive" ? 0 : laterSteps > 1 ? 1 : 0;
  const share = 30 / Math.max(laterSteps, 1);
  return Math.min(100, Math.round(70 + order * share + trackFraction * share));
}

export type ResultSummary = { ok: boolean; heading: string; lines: string[]; warnings: string[]; health: DiscHealth | null };

/** One line under a track in the results table: what the disc read was like, in words. */
export function describeRead(health: DiscHealth | undefined, number: number): string {
  const entry = health?.tracks.find((t) => t.number === number);
  if (!entry) return "Read cleanly";
  switch (entry.state) {
    case "recovered":
      return `Trouble spots, fixed by reading it ${entry.passes} times`;
    case "damaged":
      return "Damaged: could not be read cleanly";
    case "suspect":
      return "Worth a listen";
    case "shifted":
      return "Read correctly (another pressing)";
    case "unmatched":
      return "Read cleanly, the same each time";
    default:
      return "Read cleanly, nothing to compare with";
  }
}

/** "Re-reading track 5 (attempt 2 of 3)" for the status line. */
export function describeRetry(progress: RipProgress): string {
  return `Re-reading track ${progress.track ?? "?"} (read ${progress.pass ?? 2} of ${progress.passes ?? 3})`;
}

/** A short, honest summary of a finished rip. */
export function summarizeResult(result: RipResult): ResultSummary {
  const lines: string[] = [];
  const total = result.tracks.length;
  const matched = result.tracks.filter((t) => t.verification.kind === "matched").length;
  const unconfirmed = result.tracks.filter((t) => t.verification.kind === "unavailable").length;
  const shifted = result.tracks.filter((t) => t.verification.kind === "no_match" && t.pressing_shift).length;
  const mismatched = result.tracks.filter((t) => t.verification.kind === "no_match").length - shifted;

  let ok = true;
  lines.push(`${total} track${total === 1 ? "" : "s"} read from the disc.`);
  lines.push(
    `AccurateRip: ${matched} matched` +
      (shifted ? `, ${shifted} matched another pressing` : "") +
      (unconfirmed ? `, ${unconfirmed} not confirmed` : "") +
      (mismatched ? `, ${mismatched} differ from AccurateRip's copy` : "") +
      ".",
  );
  for (const [label, step] of [["FLAC archive", result.archive], ["MP3 copies", result.mp3]] as const) {
    if (!step) {
      continue;
    }
    const good = step.tracks.filter((t) => t.ok).length;
    lines.push(`${label}: ${good} of ${total} saved in ${step.dir}.`);
    for (const failed of step.tracks.filter((t) => !t.ok)) {
      lines.push(`${label}, track ${failed.track}: ${failed.error ?? "failed"}.`);
    }
    if (good !== total) {
      ok = false;
    }
  }
  if (result.defect_scan && result.defect_scan.length > 0) {
    const bad = result.defect_scan.filter((s) => s.report.verdict !== "clean").map((s) => s.track);
    lines.push(
      `Defect scan of the ${result.defect_scan.length} track${result.defect_scan.length === 1 ? "" : "s"} AccurateRip could not confirm: ` +
        (bad.length === 0 ? "nothing suspicious found." : `look at track${bad.length === 1 ? "" : "s"} ${bad.join(", ")} (see the notes below).`),
    );
  }
  if (result.audio_check) {
    lines.push(`AcoustID: ${result.audio_check.headline}`);
    const hint = result.audio_check.album_hint;
    if (hint) lines.push(`AcoustID's best guess for the album: “${hint.title}”${hint.artist ? ` by ${hint.artist}` : ""} (${hint.tracks} of the ${hint.of} recognised tracks).`);
  }
  if ((result.wav_removed ?? 0) > 0) {
    lines.push("The temporary WAV files were removed.");
  } else if (result.files && result.files.length > 0) {
    lines.push("The temporary WAV files were kept because not everything could be saved, or you asked to keep them.");
  }
  const health = result.disc_health ?? null;
  const troubled = health?.state === "damaged" || health?.state === "suspect";
  const heading = !ok ? "Ripped, but not everything was saved" : troubled ? "Finished: the disc had problems" : mismatched > 0 ? "Finished with warnings" : "Finished";
  return { ok, heading, lines, warnings: result.warnings, health };
}
