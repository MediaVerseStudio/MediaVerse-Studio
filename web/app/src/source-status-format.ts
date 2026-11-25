// How the outside services are doing, in plain words, for the status line on the Rip and Review pages (D108 stage 4).
// The sidecar's scheduler knows each service's state; this only words it. No DOM, so it is unit tested.

export type SourceRow = {
  source: string;
  state: "ok" | "slowed" | "down";
  refusals: number;
  retry_in_seconds: number;
  waiting: number;
  last_ok_seconds_ago: number | null;
  last_request_seconds_ago: number | null;
};

const NAMES: Record<string, string> = {
  musicbrainz: "MusicBrainz",
  coverart: "Cover Art Archive",
  wikimedia: "Wikimedia",
  discogs: "Discogs",
  itunes: "iTunes",
  deezer: "Deezer",
  ctdb: "CUETools Database",
  lrclib: "LRCLIB",
  gnudb: "gnudb",
  audiodb: "TheAudioDB",
  fanart: "Fanart.tv",
};

export function sourceName(source: string): string {
  return NAMES[source] ?? source;
}

function seconds(n: number): string {
  return n >= 120 ? `${Math.round(n / 60)} minutes` : `${n} second${n === 1 ? "" : "s"}`;
}

/** One service as a short phrase and how worrying it is. */
export function describeSource(row: SourceRow): { text: string; level: "ok" | "warn" | "bad" } {
  const name = sourceName(row.source);
  const queue = row.waiting > 0 ? ` (${row.waiting} waiting)` : "";
  if (row.state === "down") return { text: `${name} is not answering${row.retry_in_seconds > 0 ? `; next try in ${seconds(row.retry_in_seconds)}` : ""}${queue}`, level: "bad" };
  if (row.state === "slowed") return { text: `${name} is busy${row.retry_in_seconds > 0 ? `; waiting ${seconds(row.retry_in_seconds)}` : ""}${queue}`, level: "warn" };
  return { text: `${name} ok${queue}`, level: "ok" };
}

/** Worst services first; services never used are not in the list at all. */
export function describeSources(rows: SourceRow[]): { text: string; level: "ok" | "warn" | "bad" }[] {
  const order = { bad: 0, warn: 1, ok: 2 } as const;
  return rows.map(describeSource).sort((a, b) => order[a.level] - order[b.level]);
}