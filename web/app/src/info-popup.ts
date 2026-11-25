// A small "ⓘ" button that opens a floating window with a help text laid out in headings, paragraphs and lists (owner, 2026-11-18: the long
// explanations on the Lyrics page moved out of the page into windows that are easy to read). All text is set with textContent.

import { el } from "./dom";

export type InfoBlock = { heading?: string; paragraphs?: string[]; items?: string[] };

let dialog: HTMLDialogElement | null = null;

function shared(): HTMLDialogElement {
  if (dialog?.isConnected) return dialog;
  dialog = el("dialog", "info-dialog");
  dialog.setAttribute("aria-labelledby", "info-dialog-title");
  // A click on the dark area around the window closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog?.close();
  });
  document.body.append(dialog);
  return dialog;
}

/** Opens the window with `title` and `blocks`. */
export function showInfo(title: string, blocks: InfoBlock[]): void {
  const box = shared();
  const head = el("h2", undefined, title);
  head.id = "info-dialog-title";
  const body = el("div", "info-body");
  for (const block of blocks) {
    if (block.heading) body.append(el("h3", undefined, block.heading));
    for (const text of block.paragraphs ?? []) body.append(el("p", undefined, text));
    if (block.items?.length) {
      const list = el("ul");
      for (const item of block.items) list.append(el("li", undefined, item));
      body.append(list);
    }
  }
  const close = el("button", undefined, "Close");
  close.type = "button";
  close.addEventListener("click", () => box.close());
  const actions = el("div", "dialog-actions");
  actions.append(close);
  box.replaceChildren(head, body, actions);
  if (!box.open) box.showModal();
  close.focus();
}

/** The "ⓘ" button: press it to read about `title`. */
export function infoButton(title: string, blocks: InfoBlock[]): HTMLButtonElement {
  const button = el("button", "info-button", "ⓘ");
  button.type = "button";
  button.title = `About: ${title}`;
  button.setAttribute("aria-label", `About ${title}`);
  button.addEventListener("click", () => showInfo(title, blocks));
  return button;
}
