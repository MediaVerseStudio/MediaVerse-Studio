// The words of a progress bar, kept apart from the page so they can be tested: how far, how long it has taken and a rough guess of how long is left.

export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "Reading the songs: 1,200 of 13,849 (9 %), 0:42 so far, about 6:30 left". With no total yet it only says how long it has been going. */
export function describeProgress(label: string, done: number, total: number, elapsedMs: number): string {
  if (!(total > 0)) return `${label}… ${clockText(elapsedMs)} so far`;
  const share = Math.min(1, done / total);
  const parts = [`${label}: ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} (${Math.floor(share * 100)} %)`, `${clockText(elapsedMs)} so far`];
  // A guess from the speed so far, shown only once there is something to go on.
  if (done >= 20 && elapsedMs >= 4000 && share < 1) parts.push(`about ${clockText((elapsedMs / share) * (1 - share))} left`);
  return parts.join(", ");
}
