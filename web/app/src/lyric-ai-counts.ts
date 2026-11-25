// How one finished song of a Lyric AI run is counted (pure, so it is unit tested). Owner, 2026-11-18: with "write" off, certain results used to be counted
// as "nothing to do" and were not shown anywhere; now every timed result is "ready to check" under General review.

export type Live = { path?: string; task?: string; verdict?: string; need?: string; applied?: boolean; has_timing?: boolean };

/** Written into the song, instrumental, an error, a result waiting to be checked, or nothing found / nothing to do. */
export function classify(r: Live): "applied" | "instrumental" | "failed" | "ready" | "nothing" {
  if (r.applied) return "applied";
  if (r.task === "instrumental") return "instrumental";
  if (r.task === "error") return "failed";
  // Timed lyrics waiting under General review (certain ones too, when "write" is off).
  if (r.has_timing) return "ready";
  return "nothing";
}
