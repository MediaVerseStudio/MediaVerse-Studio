// Settings > Language: the spelling of the program's own words. American English is the default. All text is set with textContent.

import { DIALECTS, type Dialect } from "./dialect";
import { currentDialect, setDialect } from "./dialect-ui";
import { el } from "./dom";

export function renderLanguageSettings(root: HTMLElement): void {
  root.className = "settings-block";
  root.replaceChildren(el("h3", undefined, "Language"));
  root.append(el("p", "field-hint", "The spelling used for the program's own words: menus, buttons and settings. Song, album and artist names are never changed."));
  const group = el("fieldset", "settings-radios");
  group.append(el("legend", "field-label", "English"));
  for (const d of DIALECTS) {
    const row = el("label", "check");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "language";
    radio.value = d.id;
    radio.checked = currentDialect() === d.id;
    radio.addEventListener("change", () => setDialect(d.id as Dialect));
    const text = el("span");
    const note = el("span", "field-hint", ` ${d.note}`);
    note.setAttribute("data-content", ""); // the examples show each spelling, so they are not themselves converted
    text.append(el("strong", undefined, d.label), note);
    row.append(radio, text);
    group.append(row);
  }
  root.append(group);
  root.append(
    el(
      "p",
      "field-hint",
      "Other languages are planned. They need every piece of the program's text gathered into one translatable list first, which is a larger piece of work; the spelling choices above already work across settings, page names and the player's tooltips, and will spread to the other pages as that list grows. Tell us which language you would like at contact@mediaverse.studio.",
    ),
  );
}
