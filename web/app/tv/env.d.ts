/** The TV app's version, from tv/public/config.xml (set by vite.tv.config.ts). */
declare const __TV_VERSION__: string;

/** Vite's inline web workers (`?worker&inline`), as used by tv/spectrum-thread.ts. */
declare module "*?worker&inline" {
  const WorkerConstructor: { new (): Worker };
  export default WorkerConstructor;
}
