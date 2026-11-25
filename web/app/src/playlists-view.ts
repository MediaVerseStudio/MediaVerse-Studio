// Library > Playlists (D74), after Windows Media Player's (owner, 2026-11-06): the playlists down the left, the
// chosen one's songs on the right in play order. Songs are selected as in the library (click, Ctrl, Shift),
// played with a double-click or Enter, rearranged by dragging, Alt+↑/↓ or the right-click menu, and taken out
// with Delete. All text is set with textContent.

import { el } from "./dom";
import { icon, setIconButton } from "./icons";
import { openMenu, type MenuItem } from "./context-menu";
import { artistOf, formatLength, formatTotal, plural, totalLength } from "./library-format";
import { moved, newName, withoutPlaces, type Playlist } from "./playlist-format";
import { parsePlaylist, resolveEntries, toM3u8, toXspf } from "./playlist-files";
import { askName, type PlaylistStore } from "./playlists";
import type { LibraryTrack } from "./library-view";
import { buildSmartPane } from "./smart-playlists-view";
import { createSmartStore } from "./smart-store";

export type PlaylistsViewDeps = {
  songs: () => LibraryTrack[];
  store: PlaylistStore;
  play: (queue: LibraryTrack[], index: number) => void;
  enqueue: (songs: LibraryTrack[], where: "next" | "end") => void;
  openArtist: (name: string) => void;
};

type Row = { place: number; path: string; song: LibraryTrack | null };

export function initPlaylistsView(root: HTMLElement, deps: PlaylistsViewDeps): { render: () => void } {
  let chosenId: string | null = null;
  // Smart playlists (rules, worked out when opened), listed under the ordinary ones (issue #10).
  const smartStore = createSmartStore();
  let chosenSmart: string | null = null;
  const selected = new Set<number>();
  let anchor: number | null = null;
  let note = "";
  let dragging: number[] | null = null;

  const byPath = (): Map<string, LibraryTrack> => new Map(deps.songs().map((s) => [s.source_uri, s]));
  const chosen = (): Playlist | undefined => (chosenId ? deps.store.get(chosenId) : undefined);
  const rowsOf = (playlist: Playlist): Row[] => {
    const known = byPath();
    return playlist.paths.map((path, place) => ({ place, path, song: known.get(path) ?? null }));
  };
  const playable = (rows: Row[]): LibraryTrack[] => rows.flatMap((r) => (r.song ? [r.song] : []));
  const shuffled = <T>(list: T[]): T[] => {
    const mixed = [...list];
    for (let i = mixed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    return mixed;
  };
  const say = (text: string): void => {
    note = text;
    const line = root.querySelector<HTMLElement>(".pl-note");
    if (line) line.textContent = text;
  };

  async function savePaths(playlist: Playlist, paths: string[], keep: number[] = []): Promise<void> {
    try {
      await deps.store.save({ id: playlist.id, name: playlist.name, paths });
      selected.clear();
      for (const place of keep) selected.add(place);
      anchor = keep[0] ?? null;
      render();
      root.querySelector<HTMLElement>(`.pl-row[data-place="${keep[0]}"]`)?.focus();
    } catch (thrown) {
      say((thrown as Error).message);
    }
  }

  function removeSelected(playlist: Playlist): void {
    if (!selected.size) return;
    const count = selected.size;
    void savePaths(playlist, withoutPlaces(playlist.paths, [...selected])).then(() => say(`Took ${plural(count, "song")} out of “${playlist.name}”.`));
  }

  function move(playlist: Playlist, to: number | "up" | "down"): void {
    if (!selected.size) return;
    const result = moved(playlist.paths, [...selected], to);
    void savePaths(playlist, result.paths, result.places);
  }

  async function rename(playlist: Playlist): Promise<void> {
    const others = deps.store.all().filter((p) => p.id !== playlist.id);
    const name = await askName("rename playlist", playlist.name, (n) => (others.some((p) => p.name.toLocaleLowerCase() === n.toLocaleLowerCase()) ? "There is already a playlist with that name." : null));
    if (name === null || name === playlist.name) return;
    try {
      await deps.store.save({ id: playlist.id, name, paths: playlist.paths });
    } catch (thrown) {
      say((thrown as Error).message);
    }
  }

  async function remove(playlist: Playlist): Promise<void> {
    if (!window.confirm(`Delete the playlist “${playlist.name}”? Its songs stay in your library.`)) return;
    await deps.store.remove(playlist.id).catch((thrown) => say(String((thrown as Error)?.message ?? thrown)));
    if (chosenId === playlist.id) chosenId = null;
  }

  async function create(): Promise<void> {
    try {
      const made = await deps.store.createWith([]);
      if (made) {
        chosenId = made.id;
        render();
      }
    } catch (thrown) {
      say((thrown as Error).message);
    }
  }

  /** Saves a playlist as a file: XSPF to share (found by artist and title anywhere), or M3U8 (D78). */
  async function exportPlaylist(playlist: Playlist): Promise<void> {
    const songs = playable(rowsOf(playlist));
    try {
      const saved = await window.mediaVerse?.share?.playlistSave?.(playlist.name, { xspf: toXspf(playlist.name, songs), m3u8: toM3u8(playlist.name, songs) });
      if (saved) say(`Saved “${playlist.name}” as ${saved}.`);
    } catch (thrown) {
      say(String((thrown as Error)?.message ?? thrown).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }

  /** Makes a playlist from an XSPF, JSPF or M3U file, with the songs this library has (D78). */
  async function importPlaylist(): Promise<void> {
    try {
      const file = await window.mediaVerse?.share?.playlistOpen?.();
      if (!file) return;
      const { name, entries } = parsePlaylist(file.text, file.name);
      if (!entries.length) {
        say(`${file.name} has no songs in it that could be read.`);
        return;
      }
      const { songs, missing } = resolveEntries(entries, deps.songs());
      const free = newName(deps.store.all().map((p) => p.name), name);
      const made = await deps.store.save({ name: free, paths: songs.map((s) => s.source_uri) });
      chosenId = made.id;
      selected.clear();
      render();
      say(`Imported “${free}”: ${songs.length} of ${entries.length} songs found in your library${missing.length ? `; ${missing.length} not found were skipped (first: ${[missing[0].artist, missing[0].title].filter(Boolean).join(" – ") || missing[0].location})` : ""}.`);
    } catch (thrown) {
      say(`That playlist could not be read: ${String((thrown as Error)?.message ?? thrown)}`);
    }
  }

  /** The right-click menu of a playlist in the list on the left. */
  function playlistMenu(x: number, y: number, playlist: Playlist): void {
    const songs = playable(rowsOf(playlist));
    openMenu(x, y, [
      { label: "Play", action: () => deps.play(songs, 0), disabled: !songs.length },
      { label: "Shuffle", action: () => deps.play(shuffled(songs), 0), disabled: !songs.length },
      { label: "Play next", action: () => deps.enqueue(songs, "next"), disabled: !songs.length },
      { label: "Add to queue", action: () => deps.enqueue(songs, "end"), disabled: !songs.length },
      "separator",
      { label: "Rename…", action: () => void rename(playlist) },
      { label: "Export…", action: () => void exportPlaylist(playlist) },
      { label: "Delete", action: () => void remove(playlist) },
    ], playlist.name);
  }

  /** The right-click menu of the selected songs in a playlist. */
  function songMenu(x: number, y: number, playlist: Playlist, rows: Row[]): void {
    const picked = rows.filter((r) => selected.has(r.place));
    const songs = playable(picked);
    if (!picked.length) return;
    const one = picked.length === 1 ? picked[0] : null;
    const all = playable(rows);
    const items: MenuItem[] = [
      { label: "Play", action: () => (one?.song ? deps.play(all, Math.max(0, all.indexOf(one.song))) : deps.play(songs, 0)), disabled: !songs.length },
      { label: "Play next", action: () => deps.enqueue(songs, "next"), disabled: !songs.length },
      { label: "Add to queue", action: () => deps.enqueue(songs, "end"), disabled: !songs.length },
      deps.store.menuItem(() => songs.map((s) => s.source_uri), say),
      "separator",
      { label: "Remove from playlist", action: () => removeSelected(playlist) },
      { label: "Move up", action: () => move(playlist, "up"), disabled: Math.min(...selected) === 0 },
      { label: "Move down", action: () => move(playlist, "down"), disabled: Math.max(...selected) === playlist.paths.length - 1 },
      "separator",
      { label: one?.song ? `Open ${artistOf(one.song)}` : "Open artist", action: () => one?.song && deps.openArtist(artistOf(one.song)), disabled: !one?.song },
    ];
    openMenu(x, y, items, one ? (one.song?.title ?? "Song") : `${picked.length} songs`);
  }

  function select(place: number, event: MouseEvent | KeyboardEvent): void {
    if (event.shiftKey && anchor !== null) {
      if (!event.ctrlKey) selected.clear();
      for (let i = Math.min(anchor, place); i <= Math.max(anchor, place); i += 1) selected.add(i);
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(place)) selected.delete(place);
      else selected.add(place);
      anchor = place;
    } else {
      selected.clear();
      selected.add(place);
      anchor = place;
    }
    paint();
  }

  function paint(): void {
    for (const row of root.querySelectorAll<HTMLElement>(".pl-row")) {
      const on = selected.has(Number(row.dataset.place));
      row.classList.toggle("is-selected", on);
      row.setAttribute("aria-selected", String(on));
    }
  }

  function render(): void {
    const lists = [...deps.store.all()].sort((a, b) => a.name.localeCompare(b.name));
    if (chosenId && !deps.store.get(chosenId)) chosenId = null;
    if (!chosenId && lists.length) chosenId = lists[0].id;
    const playlist = chosen();
    if (!playlist) selected.clear();

    // ---- The playlists ----
    const side = el("nav", "pl-side");
    side.setAttribute("aria-label", "Playlists");
    const make = el("button", "secondary pl-new", "New playlist");
    make.type = "button";
    make.prepend(icon("add", { size: 15 }));
    make.addEventListener("click", () => void create());
    const importButton = el("button", "secondary pl-new", "Import…");
    importButton.type = "button";
    importButton.title = "Make a playlist from an XSPF, JSPF or M3U file; songs not in your library are skipped";
    importButton.addEventListener("click", () => void importPlaylist());
    const sideButtons = el("div", "pl-side-buttons");
    sideButtons.append(make, importButton);
    const list = el("ul", "pl-lists");
    for (const p of lists) {
      const item = el("li");
      const button = el("button", p.id === chosenId ? "pl-list is-active" : "pl-list");
      button.type = "button";
      button.setAttribute("aria-current", String(p.id === chosenId));
      button.append(el("span", "pl-list-name", p.name), el("span", "pl-list-count", String(p.paths.length)));
      button.addEventListener("click", () => {
        if (chosenId !== p.id) selected.clear();
        chosenId = p.id;
        chosenSmart = null;
        render();
      });
      button.addEventListener("dblclick", () => {
        const songs = playable(rowsOf(p));
        if (songs.length) deps.play(songs, 0);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        playlistMenu(event.clientX, event.clientY, p);
      });
      item.append(button);
      list.append(item);
    }
    const smartHead = el("div", "pl-side-buttons");
    const makeSmart = el("button", "secondary pl-new", "New smart playlist");
    makeSmart.type = "button";
    makeSmart.prepend(icon("add", { size: 15 }));
    makeSmart.title = "A playlist made of rules (a genre, songs not played for a year, hearts...), always up to date";
    makeSmart.addEventListener("click", () => {
      const blank = smartStore.blank();
      smartStore.save(blank);
      chosenSmart = blank.id;
      render();
    });
    smartHead.append(makeSmart);
    const smartList = el("ul", "pl-lists");
    for (const s of smartStore.all()) {
      const item = el("li");
      const button = el("button", s.id === chosenSmart ? "pl-list is-active" : "pl-list");
      button.type = "button";
      button.append(el("span", "pl-list-name", s.name), el("span", "pl-list-count", "smart"));
      button.addEventListener("click", () => {
        chosenSmart = s.id;
        render();
      });
      item.append(button);
      smartList.append(item);
    }
    side.append(sideButtons, list, smartHead, smartList);

    // ---- The chosen playlist ----
    const main = el("div", "pl-main");
    if (!playlist) {
      main.append(el("p", "lib-empty", lists.length ? "Choose a playlist." : "No playlists yet. Make one with New playlist, or right-click songs, albums or artists anywhere in the library and choose Add to playlist."));
    } else {
      const rows = rowsOf(playlist);
      const songs = playable(rows);
      const head = el("div", "pl-head");
      const words = el("div", "lib-artist-words");
      const missing = rows.length - songs.length;
      words.append(
        el("h3", "pl-title", playlist.name.toLocaleLowerCase()),
        el("span", "lib-artist-summary", [plural(rows.length, "song"), formatTotal(totalLength(songs)), missing ? `${missing} no longer in the library` : ""].filter(Boolean).join(" · ")),
      );
      const play = el("button", undefined, "Play");
      play.type = "button";
      play.prepend(icon("play", { size: 14, filled: true }));
      play.disabled = !songs.length;
      play.addEventListener("click", () => deps.play(songs, 0));
      const mix = el("button", "secondary", "Shuffle");
      mix.type = "button";
      mix.prepend(icon("shuffle", { size: 15 }));
      mix.disabled = !songs.length;
      mix.addEventListener("click", () => deps.play(shuffled(songs), 0));
      const renameButton = el("button", "icon-button");
      renameButton.type = "button";
      setIconButton(renameButton, "edit", "Rename this playlist");
      renameButton.addEventListener("click", () => void rename(playlist));
      const deleteButton = el("button", "icon-button");
      deleteButton.type = "button";
      setIconButton(deleteButton, "remove", "Delete this playlist");
      deleteButton.addEventListener("click", () => void remove(playlist));
      const exportButton = el("button", "secondary", "Export…");
      exportButton.type = "button";
      exportButton.title = "Save as an XSPF file to share (it finds the songs in any library), or M3U8";
      exportButton.addEventListener("click", () => void exportPlaylist(playlist));
      head.append(words, play, mix, exportButton, renameButton, deleteButton);
      const line = el("p", "field-hint pl-note", note);
      line.setAttribute("role", "status");

      const table = el("table", "lib-table pl-table");
      table.setAttribute("role", "grid");
      table.setAttribute("aria-label", playlist.name);
      table.setAttribute("aria-multiselectable", "true");
      const headRow = el("tr");
      for (const [text, cls] of [["#", "is-number pl-col-n"], ["Title", "pl-col-title"], ["Length", "is-number pl-col-len"], ["Artist", "pl-col-artist"], ["Album", "pl-col-album"]] as const) {
        headRow.append(el("th", cls, text));
      }
      const thead = el("thead");
      thead.append(headRow);
      const tbody = el("tbody");
      for (const row of rows) {
        const tr = el("tr", selected.has(row.place) ? "lib-row pl-row is-selected" : "lib-row pl-row");
        tr.dataset.place = String(row.place);
        tr.tabIndex = 0;
        tr.draggable = true;
        tr.setAttribute("aria-selected", String(selected.has(row.place)));
        const name = row.song?.title ?? row.path.split(/[\\/]/).pop() ?? row.path;
        tr.append(
          el("td", "is-number", String(row.place + 1)),
          el("td", undefined, name),
          el("td", "is-number", formatLength(row.song?.length_ms)),
          el("td", undefined, row.song ? (row.song.artist ?? artistOf(row.song)) : "Not in the library"),
          el("td", undefined, row.song?.album ?? ""),
        );
        if (!row.song) tr.classList.add("is-missing");
        tr.addEventListener("click", (event) => select(row.place, event));
        tr.addEventListener("dblclick", () => row.song && deps.play(songs, songs.indexOf(row.song)));
        tr.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          if (!selected.has(row.place)) select(row.place, event);
          songMenu(event.clientX, event.clientY, playlist, rows);
        });
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && row.song) deps.play(songs, songs.indexOf(row.song));
          else if (event.key === "Delete") removeSelected(playlist);
          else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            if (!selected.has(row.place)) select(row.place, event);
            move(playlist, event.key === "ArrowUp" ? "up" : "down");
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const next = row.place + (event.key === "ArrowUp" ? -1 : 1);
            if (next < 0 || next >= rows.length) return;
            select(next, event);
            root.querySelector<HTMLElement>(`.pl-row[data-place="${next}"]`)?.focus();
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            if (!selected.has(row.place)) select(row.place, event);
            const box = tr.getBoundingClientRect();
            songMenu(box.left + 60, box.bottom, playlist, rows);
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            for (const r of rows) selected.add(r.place);
            paint();
          }
        });
        // Drag to rearrange: the selected songs (or this one) move to where they are dropped.
        tr.addEventListener("dragstart", (event) => {
          if (!selected.has(row.place)) select(row.place, event);
          dragging = [...selected];
          event.dataTransfer?.setData("text/plain", playlist.name);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        tr.addEventListener("dragover", (event) => {
          if (!dragging) return;
          event.preventDefault();
          const box = tr.getBoundingClientRect();
          const below = event.clientY > box.top + box.height / 2;
          tr.classList.toggle("drop-below", below);
          tr.classList.toggle("drop-above", !below);
        });
        tr.addEventListener("dragleave", () => tr.classList.remove("drop-above", "drop-below"));
        tr.addEventListener("drop", (event) => {
          event.preventDefault();
          const below = tr.classList.contains("drop-below");
          tr.classList.remove("drop-above", "drop-below");
          if (!dragging) return;
          const result = moved(playlist.paths, dragging, row.place + (below ? 1 : 0));
          dragging = null;
          void savePaths(playlist, result.paths, result.places);
        });
        tr.addEventListener("dragend", () => (dragging = null));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      main.append(head, line);
      if (rows.length) main.append(table);
      else main.append(el("p", "lib-empty", "This playlist is empty. Right-click songs, albums or artists in the library and choose Add to playlist."));
    }
    const smart = chosenSmart ? smartStore.get(chosenSmart) : undefined;
    if (chosenSmart && !smart) chosenSmart = null;
    if (smart) {
      main.replaceChildren(
        buildSmartPane(smart, {
          songs: deps.songs,
          store: smartStore,
          play: deps.play,
          enqueue: deps.enqueue,
          saveAsPlaylist: (songs) => void deps.store.createWith(songs.map((s) => s.source_uri)),
          refresh: () => {
            chosenSmart = null;
            render();
          },
        }),
      );
    }
    root.replaceChildren(side, main);
  }

  deps.store.onChange(() => {
    if (root.isConnected) render();
  });
  return { render };
}
