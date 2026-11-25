// What the Album IDs panel says about a check (pure, so it is tested).

export type Counts = { ready: number; album_only: number; review: number; has_ids: number; too_few: number; applied: number; dismissed: number; error: number; total: number };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one-line summary of a check, in the owner's words: what is done, what waits. */
export function describeCounts(c: Counts): string {
  if (!c.total) return "The library has not been checked yet.";
  const parts = [`${plural(c.ready, "album")} ready (one edition fits exactly)`];
  if (c.album_only) parts.push(`${c.album_only} where only the album is certain`);
  if (c.review) parts.push(`${c.review} set aside for a look`);
  if (c.has_ids) parts.push(`${c.has_ids} already tagged`);
  if (c.too_few) parts.push(`${c.too_few} single-song folders left out`);
  if (c.applied) parts.push(`${c.applied} written`);
  if (c.error) parts.push(`${c.error} not answered (try again)`);
  return `${plural(c.total, "album")}: ${parts.join(", ")}.`;
}


