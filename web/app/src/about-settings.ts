// Settings > About (D88): which version this is, the licence, and the button that opens the licences folder
// (licence texts and notices for everything bundled, and how to get the source). All text is set with textContent.

import { aboutInfo, openLicences } from "./desktop-bridge";
import { el } from "./dom";

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

  // Plain text: the app opens only an allow-list of https sites (external-links.js), not mail links.
  const contact = el("p", "field-hint", `Questions, problems or ideas: ${CONTACT}`);

  root.replaceChildren(heading, el("p", "about-version", version), licence, parts, actions, contact);
}
