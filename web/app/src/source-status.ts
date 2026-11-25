// The status line of the outside services (MusicBrainz, Cover Art Archive, ...): which are answering, which are busy,
// and when the next try is. It asks the sidecar's scheduler every few seconds while it is on screen, and shows nothing
// until a service has been asked about something.

import { invoke } from "./desktop-bridge";
import { el } from "./dom";
import { describeSources, type SourceRow } from "./source-status-format";

export function createSourceStatus(): HTMLElement {
  const box = el("div", "source-status");
  box.hidden = true;
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "off");

  async function refresh(): Promise<void> {
    // Only while shown: a page that is not on screen does not ask.
    if (!box.isConnected || box.offsetParent === null) return;
    try {
      const { sources } = await invoke<{ sources: SourceRow[] }>("source_status");
      const lines = describeSources(sources);
      box.hidden = lines.length === 0;
      box.replaceChildren(el("span", "source-status-title", "Online sources: "));
      lines.forEach((line, index) => {
        box.append(el("span", `source-status-item source-status-${line.level}`, line.text));
        if (index < lines.length - 1) box.append(document.createTextNode(" · "));
      });
    } catch {
      box.hidden = true;
    }
  }
  window.setInterval(() => void refresh(), 5000);
  window.setTimeout(() => void refresh(), 600);
  return box;
}