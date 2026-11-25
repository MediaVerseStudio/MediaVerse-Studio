// Songs LRCLIB says are instrumental. No DOM or bridge access, so it is unit tested.

export type LyricsAnswer = {
  via: "exact" | "search" | "other_artists";
  results: { instrumental?: boolean; other_version?: boolean; other_artist?: boolean; length_unknown?: boolean }[];
};

/**
 * Whether a lookup's best answer says the song itself has no words: LRCLIB's exact match, or the artist's own recording of
 * the same length, flagged instrumental. Another version, another artist's recording, or a match whose length could not be
 * compared says nothing about this recording, so the song stays in the missing list.
 */
export function sureInstrumental(found: LyricsAnswer): boolean {
  const best = found.results[0];
  if (!best || best.instrumental !== true || found.via === "other_artists") return false;
  return !best.other_version && !best.other_artist && !(found.via === "search" && best.length_unknown);
}

/** Songs whose lookup should be repeated although they were asked about recently: asked before `since` (a change in what the
 * lookup can do: it reads instrumentals and track numbers now), and not already holding likely lyrics to review. */
export function askAgain(askedAt: number | undefined, since: number, hasReview: boolean): boolean {
  return askedAt !== undefined && askedAt < since && !hasReview;
}
