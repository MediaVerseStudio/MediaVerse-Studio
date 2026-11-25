// Plain-language lines for a drive's track record (D104). No DOM, so it is unit tested.

export type DriveHistory = {
  name: string;
  discs: number;
  failures: number;
  tracks: number;
  matched: number;
  shifted: number;
  differing: number;
  unconfirmed: number;
  skipped_blocks: number;
  cache_doubts: number;
  verified_percent: number | null;
  recent: { discs: number; verified_percent: number | null; trouble: number };
  notes: string[];
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What was counted for one drive, one fact per line. */
export function historyLines(history: DriveHistory): string[] {
  const lines: string[] = [];
  if (history.discs > 0) {
    lines.push(`${plural(history.discs, "disc", "discs")} ripped (${plural(history.tracks, "track", "tracks")}).`);
    if (history.verified_percent !== null) {
      const parts = [`${history.matched} matched`];
      if (history.shifted) parts.push(`${history.shifted} matched another pressing`);
      if (history.differing) parts.push(`${history.differing} differed`);
      if (history.unconfirmed) parts.push(`${history.unconfirmed} had no AccurateRip entry`);
      lines.push(`AccurateRip confirmed ${history.verified_percent}% of the tracks it could check (${parts.join(", ")}).`);
    }
    lines.push(
      history.skipped_blocks + history.cache_doubts === 0
        ? "No unreadable blocks and no doubts about the drive's cache."
        : `${plural(history.skipped_blocks, "block", "blocks")} could not be read; the drive's cache was doubted ${history.cache_doubts} times.`,
    );
  }
  if (history.failures > 0) lines.push(`${plural(history.failures, "rip", "rips")} failed because the drive failed or lost the disc.`);
  return lines;
}
