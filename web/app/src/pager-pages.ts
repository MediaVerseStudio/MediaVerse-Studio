// The numbers of a page navigation for long lists (the drawing is in pager.ts): Previous, 1 2 3 … 16, Next, and "Showing 801–900 of 1,600". The numbers follow the usual
// pattern: every page up to eight, otherwise the first and last page, the current page with two on each side, and "…" for the rest.



/** The items of the navigation: page numbers (1-based) and "…" for a stretch that is left out. */
export type PageItem = number | "gap";

/** Pages up to this many are all listed. */
const ALL_UP_TO = 8;
/** Pages shown each side of the current one. */
const SIDE = 2;
/** Near either end this many pages are listed from that end, so the row does not jump about. */
const NEAR_END = 6;

export function pageItems(current: number, pages: number): PageItem[] {
  if (pages <= ALL_UP_TO) return Array.from({ length: pages }, (_, i) => i + 1);
  const at = Math.min(Math.max(current, 1), pages);
  const keep = new Set<number>([1, pages]);
  if (at <= NEAR_END - SIDE) for (let p = 1; p <= NEAR_END; p++) keep.add(p);
  else if (at >= pages - (NEAR_END - SIDE) + 1) for (let p = pages - NEAR_END + 1; p <= pages; p++) keep.add(p);
  else for (let p = at - SIDE; p <= at + SIDE; p++) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const items: PageItem[] = [];
  for (const [i, page] of sorted.entries()) {
    const before = sorted[i - 1];
    if (before !== undefined && page - before > 1) {
      // A gap of one page is that page: "…" would take the place of a single number.
      if (page - before === 2) items.push(before + 1);
      else items.push("gap");
    }
    items.push(page);
  }
  return items;
}

/** "Showing 801–900 of 1,600 songs" for a 0-based page. */
export function rangeText(page: number, size: number, total: number, noun: string): string {
  if (total === 0) return `No ${noun}s`;
  const first = page * size + 1;
  const last = Math.min(total, (page + 1) * size);
  return `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${noun}${total === 1 ? "" : "s"}`;
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}
