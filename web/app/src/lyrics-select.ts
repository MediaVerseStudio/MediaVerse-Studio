// Selecting songs in the review list (owner, 2026-11-18): tick one, shift-click another further down, and every song in between is ticked (or unticked) too,
// like a file list. Pure, so it is unit tested.

/** The keys from `from` to `to` (either way round, both included) in the order the rows are shown. */
export function rangeKeys(order: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= order.length || to >= order.length) return [];
  const [a, b] = from <= to ? [from, to] : [to, from];
  return order.slice(a, b + 1);
}

/**
 * Applies one click. Without shift only the clicked row changes; with shift (and an earlier click to start from) every row between the two is set to the
 * clicked box's new state. Returns the new selection (a new set) and the row to start the next range from.
 */
export function clickRow(selected: Set<string>, order: string[], anchor: number | null, index: number, checked: boolean, shift: boolean): { selected: Set<string>; anchor: number } {
  const next = new Set(selected);
  const keys = shift && anchor !== null ? rangeKeys(order, anchor, index) : order[index] !== undefined ? [order[index]] : [];
  for (const key of keys) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  return { selected: next, anchor: index };
}
