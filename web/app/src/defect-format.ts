// Plain-language descriptions of defect scan results. No DOM, so it is unit tested.

export type Finding = { kind: "click" | "dropout" | "stuck" | "clipping" | "silent"; time_ms: number; length_ms: number; strength: number };

export type ScanReport = {
  verdict: "clean" | "minor" | "suspect";
  seconds: number;
  counts: { click: number; dropout: number; stuck: number; clipping: number; silent?: number };
  truncated: boolean;
  findings: Finding[];
};

export type TrackScan = { path: string; ok: boolean; error?: string; report?: ScanReport };

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const NAMES: Record<Finding["kind"], string> = { click: "Click or pop", dropout: "Dropout", stuck: "Stuck sound", clipping: "Clipping", silent: "No sound at all" };

export type GroupedFinding = Finding & { count?: number };

export function describeFinding(finding: GroupedFinding): string {
  const length = finding.length_ms >= 20 ? ` (${finding.length_ms >= 1000 ? `${(finding.length_ms / 1000).toFixed(1)} s` : `${finding.length_ms} ms`})` : "";
  const times = finding.count && finding.count > 1 ? `, ${finding.count} times close together` : "";
  return `${NAMES[finding.kind]}${length} at ${clock(finding.time_ms)}${times}`;
}

/**
 * Findings of one kind that follow each other within `gapMs` are one place to listen to, not a dozen: they are merged
 * into the first, which then says how many there were and runs to the end of the last.
 */
export function groupFindings(findings: Finding[], gapMs = 1500): GroupedFinding[] {
  const out: GroupedFinding[] = [];
  const open = new Map<Finding["kind"], GroupedFinding & { end: number }>();
  for (const f of [...findings].sort((a, b) => a.time_ms - b.time_ms)) {
    const group = open.get(f.kind);
    const end = f.time_ms + f.length_ms;
    if (group && f.time_ms - group.end <= gapMs) {
      group.count = (group.count ?? 1) + 1;
      group.end = Math.max(group.end, end);
      group.length_ms = group.end - group.time_ms;
      group.strength = Math.max(group.strength, f.strength);
    } else {
      const next = { ...f, count: 1, end };
      open.set(f.kind, next);
      out.push(next);
    }
  }
  return out.map(({ ...g }) => {
    delete (g as { end?: number }).end;
    return g;
  });
}

export function describeVerdict(report: ScanReport): string {
  switch (report.verdict) {
    case "clean":
      return "Nothing suspicious found.";
    case "minor":
      return "A few things that may or may not be audible.";
    default:
      return (report.counts.silent ?? 0) > 0 ? "No sound at all: silent from start to end." : "Likely audible problems: listen at the marked places.";
  }
}

/** Whether a scan found the whole song silent (an empty rip, or a track that is silent on purpose). */
export const isSilentScan = (report: Pick<ScanReport, "counts">): boolean => (report.counts.silent ?? 0) > 0;

export function describeCounts(counts: ScanReport["counts"]): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => n > 0 && parts.push(`${n} ${n === 1 ? one : many}`);
  if ((counts.silent ?? 0) > 0) return "no sound at all";
  add(counts.click, "click", "clicks");
  add(counts.dropout, "dropout", "dropouts");
  add(counts.stuck, "stuck stretch", "stuck stretches");
  add(counts.clipping, "clipped stretch", "clipped stretches");
  return parts.length === 0 ? "no findings" : parts.join(", ");
}

/** Findings worth showing as a list: clipping is only counted, because loud music clips a lot. */
export function listedFindings(report: ScanReport): Finding[] {
  return report.findings.filter((f) => f.kind !== "clipping");
}

/**
 * The part of a track to play for a defect: a sample of `lengthSeconds` with the defect at its midpoint
 * (it starts earlier for a defect near the start of the song, so the sample is never shorter than asked unless
 * the song is).
 */
export function snippetWindow(defectMs: number, lengthSeconds: number): { start: number; stop: number } {
  const length = Math.max(1, lengthSeconds);
  const centre = Math.max(0, defectMs) / 1000;
  const start = Math.max(0, centre - length / 2);
  return { start, stop: start + length };
}

export const LISTEN_RECOMMENDED = { min: 5, max: 12 } as const;

/** Songs per scan job. The sidecar accepts up to 1,000; smaller batches keep progress and cancelling quick. */
export const SCAN_BATCH = 500;

/** Splits `count` items into [start, end) ranges of at most `size`. */
export function batches(count: number, size: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < count; start += size) ranges.push([start, Math.min(count, start + size)]);
  return ranges;
}

/** Whether a scanned song belongs in the list: it has findings worth hearing, or it could not be scanned. */
export function worthListing(scan: TrackScan): boolean {
  return !scan.ok || !scan.report || scan.report.verdict !== "clean";
}
