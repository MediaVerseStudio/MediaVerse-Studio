// Titles with a track number in front ("14 Donut Dan"): which library songs to send to the sidecar's check, and what its
// answer looks like. The rule itself is in the sidecar (crates/tag-repair names::tidy_title_for_track). No DOM or bridge access.

export type TidyTrack = { source_uri: string; title: string; artist: string | null; album_artist?: string | null; track_number?: number | null };
export type TidyItem = { path: string; from: string; to: string };

/** Only a title that starts with a digit can carry a track number, so only those are sent (a few hundred, not the library). */
export function tracksToCheck(tracks: TidyTrack[]): { path: string; title: string; artist: string; album_artist: string; track: number | null }[] {
  return tracks
    .filter((t) => /^\s*\d/.test(t.title ?? ""))
    .map((t) => ({ path: t.source_uri, title: t.title, artist: t.artist ?? "", album_artist: t.album_artist ?? "", track: t.track_number ?? null }));
}

/** The items still to offer: not the ones just fixed, and only songs the library still has. */
export function stillOffered(items: TidyItem[], fixed: ReadonlySet<string>): TidyItem[] {
  return items.filter((i) => !fixed.has(i.path));
}
