// Times the steps of building the pages, for finding what makes the program slow to start. Read it in the developer tools with `__mvSteps()`; the page's
// long freezes are in `__mvFreezes()`. The newest 400 are kept.

type Step = { label: string; at: number; ms: number };
const steps: Step[] = [];
const freezes: { at: number; ms: number }[] = [];
const scope = globalThis as { __mvSteps?: () => Step[]; __mvFreezes?: () => { at: number; ms: number }[] };
scope.__mvSteps = () => steps.slice();
scope.__mvFreezes = () => freezes.slice();

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) freezes.push({ at: Math.round(entry.startTime), ms: Math.round(entry.duration) });
  }).observe({ type: "longtask", buffered: true });
} catch {
  // long-task timing is not available: only the steps are recorded
}

/** Runs `step` and records how long it took (also when it throws). */
export function timed<T>(label: string, step: () => T): T {
  const at = performance.now();
  try {
    return step();
  } finally {
    steps.push({ label, at: Math.round(at), ms: Math.round((performance.now() - at) * 10) / 10 });
    if (steps.length > 400) steps.shift();
  }
}
