// Review > Missing & copies: albums whose track numbers skip some, and songs found more than once. Worked out at once
// from the library already loaded (see library-audit.ts); nothing is scanned, fetched or written. Files are never
// deleted or moved from here: each entry opens its folder, and the person decides.

import { invoke, showInFolder } from "./desktop-bridge";
import { el } from "./dom";
import { describeMissing, findCopies, findMissingTracks, type CopyGroup, type MissingAlbum } from "./library-audit";
import type { LibrarySong } from "./library-format";

export type AuditPanelDeps = { songs: () => LibrarySong[] };

type View = "missing" | "copies" | "elsewhere" | "rerip";
type Flagged = { path: string; album: string; artist: string; reason: string; flagged_at: number; exists: boolean };
const PAGE = 10;

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

function clock(ms: number | null): string {
  if (ms === null) return "length unknown";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function size(bytes: number | null): string {
  return bytes === null ? "" : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function tail(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ");
}

export function initAuditPanel(root: HTMLElement, deps: AuditPanelDeps): { show: () => void } {
  root.classList.add("audit-panel");
  let view: View = "missing";
  let offset = 0;
  let withCompilations = false;
  let missing: MissingAlbum[] = [];
  let copies: CopyGroup[] = [];
  let flagged: Flagged[] = [];

  function draw(): void {
    const shownMissing = missing.filter((a) => withCompilations || !a.compilation);
    const real = copies.filter((g) => g.kind === "copies");
    const other = copies.filter((g) => g.kind === "elsewhere");
    const counts: Record<View, number> = { missing: shownMissing.length, copies: real.length, elsewhere: other.length, rerip: flagged.length };

    const intro = el("p", undefined, "What your own tags say is missing or doubled. Nothing here changes a file: each entry opens its folder and you decide.");
    const chips = el("div", "dialog-actions");
    const labels: [View, string][] = [["missing", "Missing tracks"], ["copies", "Copies"], ["elsewhere", "Also on other albums"], ["rerip", "To re-rip"]];
    for (const [value, label] of labels) {
      const chip = button(`${label} (${counts[value]})`, value === view ? "" : "secondary");
      chip.addEventListener("click", () => {
        view = value;
        offset = 0;
        draw();
      });
      chips.append(chip);
    }
    const blurb: Record<View, string> = {
      missing: "Albums whose track numbers have holes, the likeliest real losses first (one gap in a long album). The numbers come from the songs' tags, so an album that is missing its last song cannot be seen here.",
      copies: "The same song twice in a folder, or the same album in two folders. “Identical files” have exactly the same size and length. Keep the better one (higher bitrate, longer, properly tagged) and remove the other yourself.",
      elsewhere: "The same song on different albums (a best-of, a compilation, a single). Often right to keep; listed so you know.",
      rerip: "Discs you flagged for a re-rip, from Review > Album IDs > Compare (a song a few seconds off from the release can mean a skipped or damaged section). Nothing happens to the files; remove a flag when it is done.",
    };

    const list = el("div", "audit-list");
    const rows: HTMLElement[] =
      view === "missing" ? shownMissing.slice(offset, offset + PAGE).map(missingCard) : view === "rerip" ? flagged.slice(offset, offset + PAGE).map(flagCard) : (view === "copies" ? real : other).slice(offset, offset + PAGE).map(copyCard);
    const total = counts[view];
    if (!rows.length) list.append(el("p", "field-hint", total === 0 && !deps.songs().length ? "Your library is not loaded yet." : "Nothing to show here."));
    for (const row of rows) list.append(row);

    const pager = el("div", "dialog-actions");
    if (total > PAGE) {
      const previous = button("Previous");
      previous.disabled = offset === 0;
      previous.addEventListener("click", () => {
        offset = Math.max(0, offset - PAGE);
        draw();
      });
      const next = button("Next");
      next.disabled = offset + PAGE >= total;
      next.addEventListener("click", () => {
        offset += PAGE;
        draw();
      });
      pager.append(previous, el("span", "field-hint", `${offset + 1}–${Math.min(total, offset + PAGE)} of ${total}`), next);
    }

    const extras = el("div");
    if (view === "missing") {
      const label = el("label", "ft-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = withCompilations;
      box.addEventListener("change", () => {
        withCompilations = box.checked;
        offset = 0;
        draw();
      });
      label.append(box, document.createTextNode(" Include compilations and mixes (their holes are usually on purpose)"));
      extras.append(label);
    }
    root.replaceChildren(intro, chips, el("p", "field-hint", blurb[view]), extras, list, pager);
  }

  function flagCard(entry: Flagged): HTMLElement {
    const card = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const text = el("div", "ft-card-text");
    text.append(el("div", "ft-card-title", `${entry.artist || "Unknown artist"} — ${entry.album || tail(entry.path)}`), el("div", "ft-card-folder", entry.reason || "Flagged by you"), el("div", "ft-card-folder", `${entry.path}${entry.exists ? "" : " (the folder is no longer there)"}`));
    const actions = el("div", "ft-actions");
    const open = button("Show in folder");
    open.disabled = !entry.exists;
    open.addEventListener("click", () => void showInFolder(entry.path));
    const done = button("Remove the flag");
    done.addEventListener("click", () => {
      void invoke("unflag_rerip", { path: entry.path })
        .catch(() => undefined)
        .then(loadFlags);
    });
    actions.append(open, done);
    head.append(text, actions);
    card.append(head);
    return card;
  }

  async function loadFlags(): Promise<void> {
    try {
      flagged = (await invoke<{ albums: Flagged[] }>("list_rerip")).albums;
    } catch {
      flagged = [];
    }
    draw();
  }

  function missingCard(album: MissingAlbum): HTMLElement {
    const card = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const text = el("div", "ft-card-text");
    text.append(
      el("div", "ft-card-title", `${album.artist} — ${album.album}${album.disc > 1 ? ` (disc ${album.disc})` : ""}`),
      el("div", "ft-card-folder", `${describeMissing(album)} · you have ${album.have} of the ${album.last} numbered songs${album.compilation ? " · compilation or mix" : ""}`),
      el("div", "ft-card-folder", album.folder),
    );
    const actions = el("div", "ft-actions");
    const open = button("Show in folder");
    open.addEventListener("click", () => void showInFolder(album.sample));
    actions.append(open);
    head.append(text, actions);
    card.append(head);
    return card;
  }

  function copyCard(group: CopyGroup): HTMLElement {
    const card = el("section", "ft-card");
    const head = el("div", "ft-card-head");
    const text = el("div", "ft-card-text");
    const note = group.kind === "elsewhere" ? "Same song on different albums" : group.identical ? "Identical files" : "Same song twice (different files)";
    text.append(el("div", "ft-card-title", `${group.artist} — ${group.title}`), el("div", "ft-card-folder", note));
    head.append(text);
    card.append(head);
    const table = el("table", "ft-table");
    const body = el("tbody");
    for (const file of group.files) {
      const row = el("tr");
      row.append(
        el("td", undefined, file.album),
        el("td", "ft-name", tail(file.folder)),
        el("td", undefined, `${clock(file.lengthMs)}${file.kbps ? ` · ${file.kbps} kbps` : ""}${size(file.bytes) ? ` · ${size(file.bytes)}` : ""}`),
      );
      const cell = el("td");
      const open = button("Show in folder");
      open.addEventListener("click", () => void showInFolder(file.path));
      cell.append(open);
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    card.append(table);
    return card;
  }

  return {
    show: () => {
      const songs = deps.songs();
      missing = findMissingTracks(songs);
      copies = findCopies(songs);
      offset = 0;
      draw();
      void loadFlags();
    },
  };
}
