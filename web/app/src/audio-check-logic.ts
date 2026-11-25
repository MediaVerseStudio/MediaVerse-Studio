// Pure rules of what AcoustID said about the songs of an album already in the library (Review > Audio check, and "Identify by
// listening" in Fix tags). Tested apart from the pages. Nothing here writes anything.

export type HeardState = "agrees" | "other" | "named" | "unknown" | "failed";

export type HeardTrack = {
  number: number;
  state: HeardState;
  title?: string | null;
  artist?: string | null;
  sounds_like?: number | null;
  name_it?: boolean;
  problem?: string | null;
};

export type HeardFile = { number: number; path: string; name: string; title: string | null; track: number | null };

export type Heard = {
  folder?: string;
  album?: string;
  artist?: string;
  state: "agrees" | "mixed" | "different" | "named" | "unknown" | "failed";
  headline: string;
  tracks: HeardTrack[];
  files: HeardFile[];
  total: number;
  asked: number;
  album_hint?: { title: string; artist: string; tracks: number; of: number } | null;
  checked_at?: number;
  dismissed?: boolean;
};

/** What AcoustID says about one song, in words. */
export function describeHeard(track: HeardTrack, files: readonly HeardFile[]): string {
  const named = track.title ? `“${track.title}”${track.artist ? ` by ${track.artist}` : ""}` : "";
  switch (track.state) {
    case "agrees":
      return "The song its title says";
    case "other": {
      const like = track.sounds_like ? files.find((f) => f.number === track.sounds_like) : undefined;
      return `Sounds like ${named}${like ? ` (the title of ${like.title ? `“${like.title}”` : like.name})` : ""}`;
    }
    case "named":
      return `Recognised as ${named}`;
    case "failed":
      return track.problem ? `Could not be checked: ${track.problem}` : "Could not be checked";
    default:
      return "Not in AcoustID's database";
  }
}

/** How much of the album was listened to. */
export function coverage(result: Pick<Heard, "asked" | "total">): string {
  return result.asked >= result.total ? `Listened to all ${result.total} songs.` : `Listened to ${result.asked} of ${result.total} songs (a sample across the album).`;
}

/** The songs whose title AcoustID would change: a different song, or one with no real title. */
export function changes(result: Heard): { file: HeardFile; track: HeardTrack }[] {
  const out: { file: HeardFile; track: HeardTrack }[] = [];
  for (const track of result.tracks) {
    if ((track.state !== "other" && track.state !== "named") || !track.title) continue;
    const file = result.files.find((f) => f.number === track.number);
    if (file && file.title !== track.title) out.push({ file, track });
  }
  return out;
}

/** The titles to write for the songs the person ticked (by track number). */
export function titlesToWrite(result: Heard, ticked: ReadonlySet<number>): { path: string; title: string }[] {
  return changes(result)
    .filter(({ track }) => ticked.has(track.number))
    .map(({ file, track }) => ({ path: file.path, title: track.title as string }));
}

/**
 * Fix tags' "Identify by listening": what to type into the table for the songs AcoustID named (title always; the artist only
 * where the song has none). Nothing is written until Apply.
 */
export function editsFromHeard(result: Heard, currentArtist: (path: string) => string | null): Record<string, Record<string, string>> {
  const edits: Record<string, Record<string, string>> = {};
  for (const { file, track } of changes(result)) {
    const fields: Record<string, string> = { title: track.title as string };
    if (track.artist && !(currentArtist(file.path) ?? "").trim()) fields.artist = track.artist;
    edits[file.path] = fields;
  }
  return edits;
}

/** The page's headline numbers for the filter chips. */
export type Summary = { problems: number; named: number; unknown: number; failed: number; agrees: number; dismissed: number; checked: number };
