// The Getting Started box on the Home page: everything a new person has to choose or enter before the
// program is fully working (library folder, FLAC archive decision, contact email), each with a short reason,
// plus the optional services with links. It goes away when the required steps are done; the same settings
// stay available in Settings. All text is set with textContent.

import { invoke, open, openExternal } from "./desktop-bridge";
import { el } from "./dom";
import { describeError, toApiError } from "./drive-format";
import { OPTIONAL_SERVICES, type SetupInput, looksLikeEmail, remainingText, setupComplete, setupSteps } from "./setup-state";

type ArchiveView = { archive_enabled: boolean; archive_decided: boolean; archive_dir: string | null; library_dir: string | null };
type MetadataView = { identity: { contact: string } };

export function initGettingStarted(root: HTMLElement, onChange: () => void): { render: () => Promise<void> } {
  let message = "";
  let problem = "";
  let naming: "library" | "archive" | null = null; // which folder is being named for creation
  let parentFolder = "";
  let archiveWanted: boolean | null = null; // the person's choice in this box before it is saved
  let busy = ""; // what is being saved right now; the buttons wait while it runs
  const editing = new Set<"library" | "archive" | "contact">(); // finished steps the person reopened with Change

  async function load(): Promise<SetupInput> {
    const [archive, metadata] = await Promise.all([invoke<ArchiveView>("get_archive_settings"), invoke<MetadataView>("get_metadata_settings")]);
    return { ...archive, contact: metadata.identity?.contact ?? "" };
  }

  async function attempt(action: () => Promise<unknown>, success: string, step?: "library" | "archive" | "contact"): Promise<void> {
    problem = "";
    message = "";
    busy = step === "library" ? "Reading your music library… (a large library can take a while)" : "Saving…";
    await render();
    try {
      await action();
      message = success;
      naming = null;
      if (step) editing.delete(step);
      onChange();
    } catch (thrown) {
      problem = describeError(toApiError(thrown));
    } finally {
      busy = "";
    }
    await render();
  }

  async function chooseExisting(kind: "library" | "archive"): Promise<void> {
    const chosen = await open({ directory: true, title: kind === "library" ? "Choose your music library folder" : "Choose the archive folder" });
    if (typeof chosen !== "string") return;
    await attempt(() => (kind === "library" ? invoke("import_collection", { root: chosen }) : saveArchive(chosen)), kind === "library" ? "Library folder saved." : "Archive folder saved.", kind);
  }

  async function saveArchive(path: string): Promise<void> {
    await invoke("set_archive_dir", { path });
    await invoke("set_archive_enabled", { enabled: true });
  }

  async function startCreate(kind: "library" | "archive"): Promise<void> {
    const chosen = await open({ directory: true, title: kind === "library" ? "Choose where the new music library folder should go" : "Choose where the new archive folder should go" });
    if (typeof chosen !== "string") return;
    parentFolder = chosen;
    naming = kind;
    await render();
  }

  async function finishCreate(name: string): Promise<void> {
    const kind = naming;
    if (!kind) return;
    await attempt(async () => {
      const made = await invoke<{ path: string }>("create_folder", { parent: parentFolder, name });
      if (kind === "library") await invoke("import_collection", { root: made.path });
      else await saveArchive(made.path);
    }, kind === "library" ? "Library folder created and saved." : "Archive folder created and saved.", kind);
  }

  function folderButtons(kind: "library" | "archive"): HTMLElement {
    const row = el("div", "setup-buttons");
    const choose = el("button", undefined, "Choose an existing folder…");
    choose.type = "button";
    choose.addEventListener("click", () => void chooseExisting(kind));
    const create = el("button", "secondary", "Create a new folder…");
    create.type = "button";
    create.addEventListener("click", () => void startCreate(kind));
    row.append(choose, create);
    if (naming === kind) {
      const form = el("form", "setup-name");
      form.append(el("p", "field-hint", `The new folder will be made inside ${parentFolder}.`));
      const input = el("input");
      input.value = kind === "library" ? "MediaVerse Music" : "MediaVerse Archive";
      input.setAttribute("aria-label", "Name of the new folder");
      const make = el("button", undefined, "Create it");
      make.type = "submit";
      const cancel = el("button", "secondary", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        naming = null;
        void render();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void finishCreate(input.value);
      });
      form.append(input, make, cancel);
      row.append(form);
    }
    return row;
  }

  function stepBox(number: number, title: string, done: boolean, why: string): HTMLElement {
    const box = el("section", `setup-step${done ? " is-done" : ""}`);
    box.append(el("h4", undefined, `${done ? "✓" : `${number}.`} ${title}`), el("p", "field-hint", why));
    return box;
  }

  async function render(): Promise<void> {
    let input: SetupInput;
    try {
      input = await load();
    } catch {
      root.hidden = true;
      return;
    }
    const steps = setupSteps(input);
    if (setupComplete(steps)) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    root.hidden = false;
    root.replaceChildren();
    root.append(el("h3", undefined, "Getting started"), el("p", undefined, remainingText(steps)));
    if (busy) root.append(el("p", "setup-busy", busy));
    if (message) root.append(el("p", "result-ok", message));
    if (problem) root.append(el("p", "result-warning", problem));

    // A finished step shrinks to one line with a Change button, so only what is left stays open.
    const finished = (id: "library" | "archive" | "contact", label: string, value: string): boolean => {
      const index = id === "library" ? 0 : id === "archive" ? 1 : 2;
      if (!steps[index].done || editing.has(id)) return false;
      const row = el("div", "setup-done");
      const change = el("button", "secondary", "Change");
      change.type = "button";
      change.addEventListener("click", () => {
        editing.add(id);
        void render();
      });
      row.append(el("span", undefined, `✓ ${label}: `), el("strong", undefined, value), change);
      root.append(row);
      return true;
    };

    // 1. library
    if (!finished("library", "Music library", input.library_dir ?? "")) {
      const library = stepBox(1, "Your music library folder", steps[0].done, "The folder that holds your MP3 files. MediaVerse Studio lists it, plays from it, and puts the MP3 copies of CDs you rip there. Pick one you already have, or make a new one.");
      if (steps[0].done) library.append(el("p", undefined, input.library_dir ?? ""));
      library.append(folderButtons("library"));
      root.append(library);
    }

    // 2. archive
    const archiveSummary = input.archive_enabled ? `yes, in ${input.archive_dir ?? ""}` : "no, MP3 copies only";
    if (!finished("archive", "Lossless FLAC copies", archiveSummary)) {
      const archive = stepBox(2, "Lossless FLAC copies of ripped CDs", steps[1].done, "A perfect-quality master of each CD you rip, kept in its own folder (not mixed into your library). It is optional: without it you keep only the MP3 copies.");
      const keep = archiveWanted ?? (input.archive_decided ? input.archive_enabled : null);
      const radios = el("div", "setup-choice");
      for (const [wanted, label] of [[true, "Yes, keep FLAC copies"], [false, "No, MP3 copies only"]] as const) {
        const row = el("label", "check");
        const radio = el("input");
        radio.type = "radio";
        radio.name = "setup-archive";
        radio.checked = keep === wanted;
        radio.addEventListener("change", () => {
          archiveWanted = wanted;
          if (!wanted) void attempt(() => invoke("set_archive_enabled", { enabled: false }), "Noted: no FLAC copies will be kept.", "archive");
          else void render();
        });
        row.append(radio, el("span", undefined, label));
        radios.append(row);
      }
      archive.append(radios);
      if (keep === true) {
        if (input.archive_dir) archive.append(el("p", undefined, `Archive folder: ${input.archive_dir}`));
        archive.append(folderButtons("archive"));
      }
      root.append(archive);
    }

    // 3. contact email
    if (!finished("contact", "Email address", input.contact)) {
      const contact = stepBox(3, "Your email address", steps[2].done, "MusicBrainz, gnudb and LRCLIB ask every program to say who is using it, so their operators can contact someone if something goes wrong. Your address is sent to them with each lookup and to nobody else. Consider an address made just for this.");
      const form = el("form", "setup-name");
      form.noValidate = true; // the box explains a bad address itself, in its own words
      const email = el("input");
      email.type = "email";
      email.value = input.contact;
      email.setAttribute("aria-label", "Your email address");
      email.placeholder = "name@example.com";
      const save = el("button", undefined, "Save");
      save.type = "submit";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!looksLikeEmail(email.value)) {
          problem = "That does not look like an email address.";
          void render();
          return;
        }
        void attempt(() => invoke("set_metadata_settings", { settings: { identity: { contact: email.value.trim() } } }), "Email address saved.", "contact");
      });
      form.append(email, save);
      contact.append(form);
      root.append(contact);
    }

    // While something is being saved, nothing else in the box can be pressed.
    if (busy) for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) control.disabled = true;

    // Optional services
    const extras = el("details", "setup-extras");
    extras.append(el("summary", undefined, "Optional extras (you can skip these)"));
    for (const service of OPTIONAL_SERVICES) {
      const item = el("div", "setup-extra");
      item.append(el("strong", undefined, service.name), el("p", "field-hint", service.purpose));
      if (service.link) {
        const link = el("button", "secondary", `${service.link.label} ↗`);
        link.type = "button";
        link.addEventListener("click", () => void openExternal(service.link!.url));
        item.append(link);
      }
      extras.append(item);
    }
    root.append(extras);
  }

  return { render };
}
