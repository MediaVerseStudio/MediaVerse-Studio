// The picture changes that can still be undone, newest last: each run is a list of small journals (one per album or
// artist), so undoing never needs one very long request and can itself be done a few minutes at a time. Storage is
// passed in, so it is unit tested.

export type PictureRun = { id: string; label: string; batches: string[] };
export type TextStore = { get: (key: string) => string | null; set: (key: string, value: string | null) => void };

export const HISTORY_KEY = "mediaverse.picture-runs";
/** Where earlier builds kept the one change they could undo: [key, what to call it, whether it holds a list]. */
const OLD_KEYS: [string, string, boolean][] = [
  ["mediaverse.last-picture-fix", "Oversized pictures fixed", false],
  ["mediaverse.auto-covers-batch", "Automatic covers", false],
  ["mediaverse.artwork-fill-batches", "Pictures added to songs", true],
];

const isRun = (value: unknown): value is PictureRun => {
  const run = value as PictureRun;
  return !!run && typeof run.id === "string" && typeof run.label === "string" && Array.isArray(run.batches) && run.batches.every((b) => typeof b === "string");
};

export function pictureHistory(store: TextStore) {
  const read = (): PictureRun[] => {
    try {
      const found = JSON.parse(store.get(HISTORY_KEY) ?? "[]") as unknown;
      return Array.isArray(found) ? found.filter(isRun) : [];
    } catch {
      return [];
    }
  };
  const write = (runs: PictureRun[]): void => store.set(HISTORY_KEY, runs.length ? JSON.stringify(runs) : null);

  /** Notes a journal of run `id` before anything is written under it. */
  const add = (id: string, label: string, batch: string): void => {
    const runs = read();
    let run = runs.find((r) => r.id === id);
    if (!run) {
      run = { id, label, batches: [] };
      runs.push(run);
    }
    if (!run.batches.includes(batch)) run.batches.push(batch);
    write(runs);
  };

  for (const [key, label, list] of OLD_KEYS) {
    const value = store.get(key);
    if (!value) continue;
    let batches: unknown = [value];
    if (list) {
      try {
        batches = JSON.parse(value);
      } catch {
        batches = [];
      }
    }
    for (const batch of Array.isArray(batches) ? batches : []) if (typeof batch === "string") add(key, label, batch);
    store.set(key, null);
  }

  return {
    add,
    last: (): PictureRun | null => read().at(-1) ?? null,
    /** Forgets one journal (it was undone, or there was nothing in it); an emptied run goes too. */
    remove(id: string, batch: string): void {
      write(read().flatMap((run) => (run.id !== id ? [run] : run.batches.length > 1 || run.batches[0] !== batch ? [{ ...run, batches: run.batches.filter((b) => b !== batch) }] : [])));
    },
  };
}
