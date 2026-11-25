// What the Getting Started box asks for, and when it is done. No DOM or bridge access, so it is unit tested.

export type SetupInput = {
  library_dir: string | null;
  archive_enabled: boolean;
  archive_decided: boolean;
  archive_dir: string | null;
  contact: string;
};

export type SetupStepId = "library" | "archive" | "contact";
export type SetupStep = { id: SetupStepId; title: string; done: boolean };

/** A plain check that something looks like an email address (the services do the real checking). */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text.trim());
}

export function setupSteps(input: SetupInput): SetupStep[] {
  const archiveDone = input.archive_decided && (!input.archive_enabled || (input.archive_dir !== null && input.archive_dir !== ""));
  return [
    { id: "library", title: "Where your music library lives", done: input.library_dir !== null && input.library_dir !== "" },
    { id: "archive", title: "Whether to keep lossless FLAC copies of ripped CDs", done: archiveDone },
    { id: "contact", title: "Your email address, for looking up song details", done: looksLikeEmail(input.contact) },
  ];
}

export function setupComplete(steps: SetupStep[]): boolean {
  return steps.every((step) => step.done);
}

export function remainingText(steps: SetupStep[]): string {
  const left = steps.filter((s) => !s.done).length;
  return left === 0 ? "Everything is set up." : `${left} thing${left === 1 ? "" : "s"} left to set up before MediaVerse Studio is fully working.`;
}

/** Optional services, with what each is for and where to get what it needs. */
export const OPTIONAL_SERVICES: { name: string; purpose: string; link: { label: string; url: string } | null }[] = [
  {
    name: "AcoustID application key (optional)",
    purpose: "For recognising songs by how they sound. This is not used yet; you can skip it. When it is, you register this program at acoustid.org and paste the key in Settings.",
    link: { label: "AcoustID web service information", url: "https://acoustid.org/webservice" },
  },
  {
    name: "gnudb registration (optional)",
    purpose: "gnudb is a free disc-name database used as a second opinion after MusicBrainz. It asks new programs to register by email. Your address above is what it sees.",
    link: { label: "How to register with gnudb", url: "https://gnudb.org/howto.php" },
  },
  {
    name: "MusicBrainz and LRCLIB",
    purpose: "No key or account is needed. They only ask that a program says who it is, which is what your email address is used for.",
    link: null,
  },
];
