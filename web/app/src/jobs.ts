// Runs a sidecar command that works as a background job (it answers with a job id and later sends a
// "job-finished" event) and resolves with its result, so a page can simply await it.

import { invoke, listen } from "./desktop-bridge";

type Finished<T> = { job_id: string; ok: true; result: T } | { job_id: string; ok: false; error: { code: string; message: string } };

export type JobProgress = { job_id?: string; kind?: string; done?: number; total?: number; tracks_done?: number; tracks_total?: number; current?: string };

/** `onProgress` hears the job's own `job-progress` events (for a progress bar), including any sent before the reply that names the job arrived. */
export async function runJob<T>(command: string, args: Record<string, unknown>, onProgress?: (progress: JobProgress) => void): Promise<T> {
  // Listen first: the job may finish before the reply that names it arrives.
  const finishedEarly = new Map<string, Finished<T>>();
  const progressEarly = new Map<string, JobProgress>();
  let jobId: string | null = null;
  const stopProgress = onProgress
    ? await listen<JobProgress>("job-progress", (event) => {
        if (jobId === null) {
          if (event.payload.job_id) progressEarly.set(event.payload.job_id, event.payload);
        } else if (event.payload.job_id === jobId) onProgress(event.payload);
      })
    : () => {};
  let waiting: { id: string; resolve: (value: Finished<T>) => void } | null = null;
  const stop = await listen<Finished<T>>("job-finished", (event) => {
    if (waiting && event.payload.job_id === waiting.id) waiting.resolve(event.payload);
    else finishedEarly.set(event.payload.job_id, event.payload);
  });
  try {
    const started = await invoke<{ job_id: string }>(command, args);
    jobId = started.job_id;
    const early = progressEarly.get(jobId);
    if (early && onProgress) onProgress(early);
    const outcome = finishedEarly.get(started.job_id) ?? (await new Promise<Finished<T>>((resolve) => (waiting = { id: started.job_id, resolve })));
    if (outcome.ok) return outcome.result;
    throw outcome.error;
  } finally {
    stop();
    stopProgress();
  }
}
