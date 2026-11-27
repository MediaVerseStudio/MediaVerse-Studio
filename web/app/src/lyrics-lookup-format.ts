// Plain-language helpers for the online lyrics lookup results. No DOM, so they are unit tested.

export type LyricsCandidate = {
  id: number | null;
  track: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  instrumental: boolean;
  plain: string | null;
  synced: string | null;
  /** The artist's version of another length (live, an edit, another album): its words, not its timing. */
  other_version?: boolean;
  /** The same song by another artist (the original of a cover, or a cover): its words, not its timing. */
  other_artist?: boolean;
};

export type LyricsLookup = { via: "exact" | "search" | "other_artists"; results: LyricsCandidate[]; /** The song's own length in seconds, when it could be read. */ song_duration?: number | null };

export function lengthText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** How a candidate's length compares with the song's: "0:03 longer", "same length", or "" when either is unknown. */
export function lengthGap(candidate: number | null, song: number | null | undefined): string {
  if (candidate === null || song === null || song === undefined || !Number.isFinite(candidate) || !Number.isFinite(song)) return "";
  const gap = Math.round(candidate) - Math.round(song);
  if (Math.abs(gap) <= 2) return "same length";
  return `${lengthText(Math.abs(gap))} ${gap > 0 ? "longer" : "shorter"}`;
}

/** The line shown above the results: the song being matched, with its length. */
export function yourSong(title: string, artist: string | null, album: string | null, seconds: number | null | undefined): string {
  const where = [album, seconds ? lengthText(seconds) : ""].filter(Boolean).join(", ");
  return `Your song: ${artist ? `${artist} — ` : ""}${title}${where ? ` (${where})` : ""}`;
}

export function describeCandidate(c: LyricsCandidate, songSeconds?: number | null): string {
  const kind = c.instrumental ? "instrumental" : c.synced ? "time-stamped lyrics" : "plain lyrics";
  const gap = lengthGap(c.duration, songSeconds);
  const where = [c.album, lengthText(c.duration), gap && gap !== "same length" ? `${gap} than your song` : gap].filter(Boolean).join(", ");
  const note = c.other_artist ? " · the same song by another artist" : c.other_version ? " · another version (the words fit; the timing would not)" : "";
  return `${c.artist ?? "Unknown artist"} — ${c.track ?? "Unknown song"}${where ? ` (${where})` : ""}: ${kind}${note}`;
}

/** The text to put in the lyrics box: time-stamped lyrics when there are any, else plain. Null for instrumentals. */
export function textToUse(c: LyricsCandidate): string | null {
  if (c.synced && c.synced.trim() !== "") return c.synced;
  if (c.plain && c.plain.trim() !== "") return c.plain;
  return null;
}

/** A web search for a song's words, to read in the browser: artist, album, song and "lyrics" (owner, 2026-11-26). */
export function lyricsWebSearchUrl(title: string, artist: string | null, album: string | null): string {
  const words = [artist, album, title, "lyrics"].filter((w): w is string => !!w && w.trim() !== "");
  return `https://www.google.com/search?q=${encodeURIComponent(words.join(" "))}`;
}

export function lookupSummary(found: LyricsLookup): string {
  if (found.results.length === 0) return "LRCLIB has no lyrics for this song.";
  if (found.via === "exact") return "LRCLIB has this song. Check the lyrics, then use them.";
  if (found.via === "other_artists") return `LRCLIB has nothing under this artist, but has the same song by ${found.results.length === 1 ? "another artist" : "other artists"} (the original or a cover): the words should be the same. Check them, then use them.`;
  return `LRCLIB has no exact match; ${found.results.length} similar song${found.results.length === 1 ? "" : "s"} found. Pick the right one.`;
}
