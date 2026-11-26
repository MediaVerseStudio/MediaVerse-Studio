// Settings > About (D88): which version this is, the licence, and the button that opens the licences folder
// (licence texts and notices for everything bundled, and how to get the source). All text is set with textContent.

import { aboutInfo, openExternal, openLicences } from "./desktop-bridge";
import { el } from "./dom";
import { ISSUE_BOARD, SUPPORT_INTRO, SUPPORT_LINKS } from "./support-services";

const CONTACT = "contact@mediaverse.studio";

export async function renderAboutSettings(root: HTMLElement): Promise<void> {
  root.className = "settings-block about-settings";
  const info = await aboutInfo().catch(() => null);

  const heading = el("div", "about-heading");
  const emblem = el("img", "about-emblem");
  emblem.src = "./mediaverse-emblem.png";
  emblem.alt = "";
  const wordmark = el("img", "about-wordmark");
  wordmark.src = "./mediaverse-wordmark.png";
  wordmark.alt = "MediaVerse Studio";
  heading.append(emblem, wordmark);

  const version = info
    ? `Version ${info.version}${info.commit ? ` (build ${info.commit})` : ""} · Electron ${info.electron}`
    : "Version unknown";

  const licence = el("p", undefined, "MediaVerse Studio is free software: you can redistribute it and change it under the terms of the GNU General Public License, version 3 or (at your option) any later version. It comes with no warranty.");
  const parts = el("p", "field-hint", "It includes other people's work under their own licences: libcdio and libcdio-paranoia (GPL), LAME and libiconv (LGPL), Electron and Chromium, and Rust libraries under MIT, Apache and similar licences. The licences folder has every licence text, the notices, and how to get the complete source code.");

  const actions = el("div", "about-actions");
  const show = el("button", "secondary", "Open the licences folder");
  show.type = "button";
  show.disabled = !info?.licences;
  const result = el("span", "field-hint");
  result.setAttribute("role", "status");
  show.addEventListener("click", async () => {
    result.textContent = (await openLicences()) ? "" : "The licences folder could not be opened.";
  });
  actions.append(show, result);
  if (!info?.licences) {
    actions.append(el("p", "field-hint", "This copy was run from source and has no licences folder yet (tools\\make-licence-pack.ps1 makes one). The licence texts are also in the source code: LICENSE and THIRD_PARTY_NOTICES.md."));
  }

  // Questions, problems and ideas go on the issue board (the app opens only an allow-list of https sites: electron/external-links.js).
  const board = el("p", "field-hint", "Questions, problems or ideas: ");
  const boardLink = el("button", "secondary", "Open the issue board ↗");
  boardLink.type = "button";
  boardLink.addEventListener("click", () => void openExternal(ISSUE_BOARD));
  board.append(boardLink);

  // Support the services behind the program (instead of a donation link for this free program).
  const support = el("div", "about-support");
  support.append(el("h4", undefined, "Support the services behind it"), el("p", "field-hint", SUPPORT_INTRO));
  for (const service of SUPPORT_LINKS) {
    const row = el("div", "setup-extra");
    const open = el("button", "secondary", `${service.label} ↗`);
    open.type = "button";
    open.addEventListener("click", () => void openExternal(service.url));
    row.append(el("strong", undefined, service.name), el("p", "field-hint", service.what), open);
    support.append(row);
  }

  root.replaceChildren(heading, el("p", "about-version", version), licence, parts, actions, board, support);}
