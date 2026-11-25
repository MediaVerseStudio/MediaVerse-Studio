// Pure logic for showing lyrics while a song plays. No DOM, so it is unit tested.

export type LyricLine = { ms: number; text: string };

export type TrackLyrics = {
  plain: string | null;
  synced: boolean;
  lines: LyricLine[];
  source: "tag" | "lrc_file" | "server" | null;
};

/** Index of the line being sung at `ms` (the last line that has started), or -1 before the first line. */
export function currentLine(lines: LyricLine[], ms: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].ms <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Lines in time order (the sidecar already sorts them; this guards against any other source). */
export function sortedLines(lines: LyricLine[]): LyricLine[] {
  return [...lines].sort((a, b) => a.ms - b.ms);
}

/** Plain lyrics split into display lines, keeping blank lines between verses. */
export function plainLines(plain: string): string[] {
  return plain.replace(/\r\n?/g, "\n").split("\n");
}

export function sourceLabel(source: TrackLyrics["source"]): string {
  return source === "tag" ? "From the song's tags" : source === "lrc_file" ? "From a .lrc file next to the song" : source === "server" ? "From the Jellyfin server" : "";
}

/** The note shown when there are no lyrics and the Jellyfin server alone is the library (lyrics cannot be added from here). */
export const NO_LYRICS_SERVER = "The Jellyfin server has no lyrics for this song. With your music in a folder (or the server's shared folder), this program can add them.";

/** The note shown when there are no lyrics. */
export const NO_LYRICS = "No lyrics are saved for this song yet. Add them with Lyrics… (right-click the song in the library).";
