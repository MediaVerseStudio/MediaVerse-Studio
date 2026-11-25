// Pure helpers for tracks flagged for review. No DOM or bridge access, so they are unit tested.

export type FlagReason = "audio" | "tags" | "cover_or_lyrics" | "wrong_track" | "other";

export const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: "audio", label: "Audio problem (pop, click, skip, distortion)" },
  { value: "tags", label: "Missing or wrong tags" },
  { value: "cover_or_lyrics", label: "Cover picture or lyrics" },
  { value: "wrong_track", label: "Wrong track or wrong album" },
  { value: "other", label: "Something else" },
];

export type Flag = {
  path: string;
  reasons: FlagReason[];
  note: string;
  position_ms: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  flagged_at: number;
};

export function reasonLabels(reasons: FlagReason[]): string {
  const names = reasons.map((r) => FLAG_REASONS.find((f) => f.value === r)?.label.replace(/ \(.*\)$/, "") ?? r);
  return names.length === 0 ? "Something else" : names.join(", ");
}

/** "1:12" for a position in milliseconds. */
export function positionText(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function describeFlag(flag: Flag): string {
  const parts = [reasonLabels(flag.reasons)];
  if (flag.position_ms !== null) parts.push(`noticed at ${positionText(flag.position_ms)}`);
  return parts.join(" · ");
}

/** Newest first. */
export function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort((a, b) => b.flagged_at - a.flagged_at);
}

/** The request for `set_flag`: flag (or update) a track at the moment the user noticed something. */
export function flagRequest(
  track: { source_uri: string; title: string; artist: string | null; album?: string | null },
  reasons: FlagReason[],
  note: string,
  seconds: number,
): Record<string, unknown> {
  return {
    path: track.source_uri,
    flagged: true,
    reasons,
    note: note.trim(),
    position_ms: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
  };
}

export class FlagIndex {
  private paths = new Set<string>();
  private flags: Flag[] = [];

  replace(flags: Flag[]): void {
    this.flags = flags;
    this.paths = new Set(flags.map((f) => f.path));
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  get(path: string): Flag | undefined {
    return this.flags.find((f) => f.path === path);
  }

  all(): Flag[] {
    return this.flags;
  }
}
