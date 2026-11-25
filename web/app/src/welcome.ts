// The first-run welcome (D32, after Zune's): a dark full-window screen shown once, while setup is not
// finished. "start playing" asks only for the music folder; "set it up now" shows the same three steps as
// the Getting Started box (the same component, so there is one set of rules); "later" goes to Home, where
// the Getting Started box keeps what is left. All text is set with textContent.

import { invoke, open } from "./desktop-bridge";
import { el } from "./dom";
import { describeError, toApiError } from "./drive-format";
import { initGettingStarted } from "./getting-started";
import { setupComplete, setupSteps } from "./setup-state";

const KEY = "mediaverse.welcome-seen";

type ArchiveView = { archive_enabled: boolean; archive_decided: boolean; archive_dir: string | null; library_dir: string | null };

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // shown again next time; harmless
  }
}

export async function showWelcomeIfNeeded(onChange: () => void, onClose: () => void): Promise<void> {
  if (seen()) return;
  let complete = false;
  try {
    const [archive, metadata] = await Promise.all([invoke<ArchiveView>("get_archive_settings"), invoke<{ identity: { contact: string } }>("get_metadata_settings")]);
    complete = setupComplete(setupSteps({ ...archive, contact: metadata.identity?.contact ?? "" }));
  } catch {
    return; // the sidecar is not answering; Home's box will say what is needed
  }
  if (complete) {
    markSeen();
    return;
  }

  const screen = el("div", "welcome");
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "true");
  screen.setAttribute("aria-labelledby", "welcome-title");
  const inner = el("div", "welcome-inner");
  const title = el("h1", "welcome-title", "Welcome to MediaVerse Studio");
  title.id = "welcome-title";
  inner.append(el("div", "welcome-bar"), title);
  screen.append(inner);
  document.body.append(screen);

  const close = (): void => {
    markSeen();
    screen.remove();
    onClose();
  };

  const message = el("p", "result-warning");
  message.hidden = true;

  // Choice 1: just the music folder.
  const quick = el("section", "welcome-choice");
  const start = el("button", undefined, "Choose my music folder");
  start.type = "button";
  start.addEventListener("click", async () => {
    const folder = await open({ directory: true, title: "Choose your music library folder" });
    if (typeof folder !== "string") return;
    start.disabled = true;
    start.textContent = "Reading your music library…";
    try {
      await invoke("import_collection", { root: folder });
      onChange();
      close();
    } catch (thrown) {
      start.disabled = false;
      start.textContent = "Choose my music folder";
      message.textContent = describeError(toApiError(thrown));
      message.hidden = false;
    }
  });
  quick.append(
    el("h2", undefined, "start playing"),
    el("p", "welcome-lead", "Point MediaVerse Studio at your music and go. The rest can wait."),
    bullets(["Lists and plays the music in that folder; nothing in it is moved or changed.", "Ripped CDs will be saved there as MP3 copies.", "Finish the other settings later from Home or Settings."]),
    start,
  );

  // Choice 2: everything now, in the same steps as the Getting Started box.
  const full = el("section", "welcome-choice");
  const setUp = el("button", "secondary", "Set it up now");
  setUp.type = "button";
  full.append(
    el("h2", undefined, "set it up now"),
    el("p", "welcome-lead", "Three short choices:"),
    bullets(["Your music library folder.", "Whether to keep perfect-quality FLAC copies of the CDs you rip, and where.", "An email address for the services that name your CDs and find lyrics."]),
    setUp,
  );
  const steps = el("section", "welcome-steps setup-box");
  steps.hidden = true;
  setUp.addEventListener("click", () => {
    quick.hidden = true;
    full.hidden = true;
    steps.hidden = false;
    void wizard.render();
  });
  const wizard = initGettingStarted(steps, onChange);
  // The box hides itself when all three steps are done: that is the end of the welcome.
  new MutationObserver(() => {
    if (steps.hidden && quick.hidden) close();
  }).observe(steps, { attributes: true, attributeFilter: ["hidden"] });

  const later = el("button", "welcome-later", "Later — take me to Home");
  later.type = "button";
  later.addEventListener("click", close);
  inner.append(message, quick, full, steps, later);
  start.focus();
}

function bullets(lines: string[]): HTMLElement {
  const list = el("ul", "welcome-list");
  for (const line of lines) list.append(el("li", undefined, line));
  return list;
}
