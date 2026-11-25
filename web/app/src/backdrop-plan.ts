// Pure choices for the page backdrop (no DOM), so they can be unit tested.

export type Cover = { folder: string; url: string; track: { source_uri: string; artist: string | null; title: string } };

/**
 * Which tile flips next and what it shows: a random tile, turned to a cover that is not on the wall at the
 * moment (so a flip always shows something new). With every cover already showing, any other cover will do.
 * Returns null when there is nothing to flip to.
 */
export function flipChoice(shown: string[], covers: Cover[], random: () => number): { tile: number; cover: Cover } | null {
  if (shown.length === 0 || covers.length < 2) return null;
  const tile = Math.floor(random() * shown.length) % shown.length;
  const onWall = new Set(shown);
  const fresh = covers.filter((c) => !onWall.has(c.folder));
  const pool = fresh.length > 0 ? fresh : covers.filter((c) => c.folder !== shown[tile]);
  if (pool.length === 0) return null;
  return { tile, cover: pool[Math.floor(random() * pool.length) % pool.length] };
}
