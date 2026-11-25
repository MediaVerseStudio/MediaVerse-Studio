// Pure presentation logic for the Drive setup screen: turns the sidecar's drive profiles and
// calibration reports (docs/architecture/0004-drive-calibration.md) into plain-language text.
// No DOM access, so it can be unit tested with `npm run test:unit`.

export type Provenance = "measured" | "suggested" | "manual";

export type Field<T> = { value: T; provenance: Provenance };

export type CacheSize =
  | { kind: "none" }
  | { kind: "between"; cached_through: number; uncached_at: number }
  | { kind: "at_least"; sectors: number };

export type DriveProfile = {
  identity: { vendor: string; model: string; revision: string; connection: string };
  read_offset: Field<number> | null;
  offset_evidence: {
    disc: string;
    tracks_matched: number[];
    checksum_versions: number[];
    date: string;
  } | null;
  cache: Field<CacheSize> | null;
  max_transfer_sectors: Field<number> | null;
  repeat_reads_agree: boolean | null;
};

export type DriveEntry = {
  device: string;
  vendor?: string;
  model?: string;
  revision?: string;
  error?: string;
  profile?: DriveProfile | null;
};

export type OffsetOutcome =
  | { kind: "measured"; offset: number; tracks: number[]; versions: number[] }
  | { kind: "needs_disc"; reason: string }
  | { kind: "inconclusive"; reason: string };

export type CalibrationReport = {
  profile: DriveProfile;
  offset: OffsetOutcome;
  warnings: string[];
  disc: string;
};

export type ApiError = { code: string; message: string };

const SECTOR_BYTES = 2352;

/** `\\.\E:` -> `E:`; other device names are returned unchanged. */
export function formatDevice(device: string): string {
  return device.replace(/^\\\\[.?]\\/, "");
}

export function driveName(drive: DriveEntry): string {
  const name = [drive.vendor, drive.model].filter((part) => part && part.trim()).join(" ");
  return name || formatDevice(drive.device);
}

export function formatKilobytes(sectors: number): string {
  const kilobytes = (sectors * SECTOR_BYTES) / 1024;
  return kilobytes >= 1024 ? `${(kilobytes / 1024).toFixed(1)} MB` : `${Math.round(kilobytes)} KB`;
}

export function formatOffset(offset: number): string {
  const sign = offset > 0 ? "+" : offset < 0 ? "−" : "";
  const count = Math.abs(offset);
  return `${sign}${count} sample${count === 1 ? "" : "s"}`;
}

export function provenanceLabel(provenance: Provenance): string {
  switch (provenance) {
    case "measured":
      return "verified on this drive";
    case "suggested":
      return "suggested, not yet checked on this drive";
    case "manual":
      return "entered by hand, not verified";
  }
}

/** Offset line for the drive card. An unverified offset is never described as verified. */
export function describeOffset(profile: DriveProfile | null | undefined): string {
  const field = profile?.read_offset;
  if (!field) {
    return "Not checked yet";
  }
  const evidence = profile?.offset_evidence;
  let text = `${formatOffset(field.value)} (${provenanceLabel(field.provenance)})`;
  if (field.provenance === "measured" && evidence) {
    const tracks = evidence.tracks_matched.join(", ");
    text += `; matched AccurateRip on track${evidence.tracks_matched.length === 1 ? "" : "s"} ${tracks}, ${evidence.date}`;
  }
  return text;
}

export function describeCache(profile: DriveProfile | null | undefined): string {
  const field = profile?.cache;
  if (!field) {
    return "Not tested yet";
  }
  const size = field.value;
  switch (size.kind) {
    case "none":
      return "No audio cache detected";
    case "between":
      return `About ${size.cached_through}–${size.uncached_at} sectors (${formatKilobytes(size.cached_through)}–${formatKilobytes(size.uncached_at)})`;
    case "at_least":
      return `Larger than ${size.sectors} sectors (${formatKilobytes(size.sectors)}); secure re-reads may not bypass it`;
  }
}

export function describeTransfer(profile: DriveProfile | null | undefined): string {
  const field = profile?.max_transfer_sectors;
  return field ? `${field.value} sectors per read (${formatKilobytes(field.value)})` : "Not tested yet";
}

export function describeRepeatReads(profile: DriveProfile | null | undefined): string {
  if (profile?.repeat_reads_agree == null) {
    return "Not tested yet";
  }
  return profile.repeat_reads_agree ? "Yes" : "No – clean the disc or try another before trusting results";
}

export type Step = "read_test" | "cache_test" | "offset_check";

const STEPS: { step: Step; label: string; start: number; weight: number }[] = [
  { step: "read_test", label: "Testing reads", start: 0, weight: 25 },
  { step: "cache_test", label: "Measuring the drive’s cache", start: 25, weight: 25 },
  { step: "offset_check", label: "Checking the read offset against AccurateRip", start: 50, weight: 50 },
];

/** Overall progress (0-100) and a label for a `job-progress` event. */
export function progressFor(step: string, done: number, total: number): { percent: number; label: string; stepNumber: number } {
  const index = STEPS.findIndex((entry) => entry.step === step);
  if (index < 0) {
    return { percent: 0, label: "Working…", stepNumber: 0 };
  }
  const entry = STEPS[index];
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return {
    percent: Math.round(entry.start + entry.weight * fraction),
    label: entry.label,
    stepNumber: index + 1,
  };
}

export const STEP_COUNT = STEPS.length;

/** What to tell the user about the offset result of a finished calibration. */
export function describeOffsetOutcome(outcome: OffsetOutcome): { verified: boolean; text: string } {
  switch (outcome.kind) {
    case "measured":
      return {
        verified: true,
        text: `Read offset ${formatOffset(outcome.offset)} verified: ${outcome.tracks.length} tracks matched the AccurateRip database at the same offset.`,
      };
    case "needs_disc":
      return {
        verified: false,
        text: `The read offset could not be verified: ${outcome.reason}. Insert a different audio CD that is in the AccurateRip database and run the check again.`,
      };
    case "inconclusive":
      return {
        verified: false,
        text: `The read offset could not be verified: ${outcome.reason}. Clean the disc, or try another disc.`,
      };
  }
}

/** Friendly text for an error from the sidecar or the CD helper. */
export function describeError(error: ApiError): string {
  switch (error.code) {
    case "helper_unavailable":
      return "The CD helper program was not found, so drives can’t be tested. Build it with tools\\build-cd-helper.ps1.";
    case "helper_failed":
      return `The CD helper stopped unexpectedly. ${error.message}`;
    case "no_disc":
      return "There is no readable audio CD in the drive. Insert one and try again.";
    case "drive_not_found":
      return "That drive is no longer available. Refresh the list and try again.";
    case "cancelled":
      return "Calibration was cancelled. Nothing was changed.";
    case "unknown_command":
      return "Drive setup is not available in this version of the app.";
    default:
      return error.message || "Something went wrong while testing the drive.";
  }
}

/** Normalises whatever the bridge throws (an `{code, message}` object, an Error, or a string). */
export function toApiError(thrown: unknown): ApiError {
  if (thrown && typeof thrown === "object") {
    const candidate = thrown as Partial<ApiError> & { message?: unknown };
    if (typeof candidate.code === "string") {
      return { code: candidate.code, message: String(candidate.message ?? "") };
    }
    if (typeof candidate.message === "string") {
      // An older sidecar without a command reports it as a plain error.
      return { code: /unsupported|not found|unknown/i.test(candidate.message) ? "unknown_command" : "error", message: candidate.message };
    }
  }
  return { code: "error", message: String(thrown) };
}

