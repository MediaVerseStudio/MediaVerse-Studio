// The Library (D52), laid out like Windows Media Player and styled like Zune (owner, 2026-11-04): an artist wall of
// rotated album stacks grouped by letter, with "The" ignored when sorting; and an artist page with each album's
// square cover beside its songs, in columns the person chooses, orders and sizes, sortable by clicking a heading.

import { el } from "./dom";
import { serverLibrary } from "./library-mode";
import { icon, setIconButton } from "./icons";
import { openMenu, type MenuItem } from "./context-menu";
import {
  COLUMNS,
  albumsOf,
  alsoAppearsOn,
  artistKey,
  artistOf,
  artistWall,
  cellText,
  formatLength,
  formatTotal,
  guestArtists,
  letterOf,
  plural,
  sortKey,
  sortSongs,
  totalLength,
  type AlbumGroup,
  type AlbumOrder,
  type ColumnId,
  type LibrarySong,
} from "./library-format";
import { searchLibrary } from "./playlist-format";
import type { PlaylistStore } from "./playlists";
import { initPlaylistsView } from "./playlists-view";

export type LibraryTrack = LibrarySong & { id: string };

type Settings = {
  columns: ColumnId[];
  widths: Partial<Record<ColumnId, number>>;
  albumOrder: AlbumOrder;
  ignoreArticles: boolean;
  showArt: boolean;
};

const SETTINGS_KEY = "mediaverse.library-view.v1";
const DEFAULTS: Settings = {
  columns: ["number", "title", "length", "artist", "genre", "bitrate", "added"],
  widths: {},
  albumOrder: "year-asc",
  ignoreArticles: true,
  showArt: true,
};
const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    if (!saved) return { ...DEFAULTS };
    const known = new Set(COLUMNS.map((c) => c.id));
    const columns = (saved.columns ?? DEFAULTS.columns).filter((c) => known.has(c));
    return { ...DEFAULTS, ...saved, columns: columns.includes("title") ? columns : ["title", ...columns] };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A convenience only.
  }
}

export type LibraryDeps = {
  songs: () => LibraryTrack[];
  openArtist: (name: string) => void;
  back: () => void;
  play: (queue: LibraryTrack[], index: number) => void;
  coverUrl: (path: string) => Promise<string | null>;
  /** An artist's photo, looked for in the given songs (D97); null when none has one. */
  artistPhotoUrl?: (paths: string[]) => Promise<string | null>;
  editTags: (selected: LibraryTrack[]) => void;
  pictures: (selected: LibraryTrack[]) => void;
  /** The lyrics editor, with playback and timing, for one song. */
  lyrics: (song: LibraryTrack) => void;
  albumPictures: (album: string, songs: LibraryTrack[]) => void;
  scan: (selected: LibraryTrack[]) => void;
  isFavorite: (path: string) => boolean;
  setFavorite: (paths: string[], on: boolean) => void;
  isFlagged: (path: string) => boolean;
  flag: (track: LibraryTrack) => void;
  isPinned: (album: LibraryTrack[]) => boolean;
  enqueue: (songs: LibraryTrack[], where: "next" | "end") => void;
  showInFolder: (path: string) => Promise<boolean>;
  togglePin: (album: string, songs: LibraryTrack[]) => void;
  /** Playlists (D74): the store behind Library > Playlists and every "Add to playlist" menu. */
  playlists: PlaylistStore;
};

export function initLibraryView(libraryRoot: HTMLElement, artistRoot: HTMLElement, deps: LibraryDeps): { renderWall: () => void; renderArtist: (name: string) => boolean } {
  let settings = readSettings();
  let filter = "";
  let sort: { column: ColumnId; descending: boolean } = { column: "number", descending: false };
  let currentArtist: string | null = null;
  const selected = new Set<string>();
  let anchor: string | null = null;

  // Covers are asked for only when they come near the screen.
  const loaders = new WeakMap<Element, () => void>();
  const watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        watcher.unobserve(entry.target);
        loaders.get(entry.target)?.();
        loaders.delete(entry.target);
      }
    },
    { rootMargin: "600px 0px" },
  );
  function lazyCover(box: HTMLElement, path: string, alt = ""): void {
    loaders.set(box, () =>
      void deps.coverUrl(path).then((url) => {
        if (!url) return;
        const image = el("img");
        image.alt = alt;
        image.src = url;
        image.decoding = "async";
        box.replaceChildren(image);
        box.classList.add("has-cover");
      }),
    );
    watcher.observe(box);
  }

  // ---- The artist wall ----
  // Three views, named in the title as Zune does: artists (the wall), albums (every album, compilations too) and
  // playlists (D74, D85). The heading stays at the top of the window while the page scrolls.
  type Tab = "artists" | "albums" | "playlists";
  let tab: Tab = "artists";
  /** An album to scroll to when its artist's page opens (from the albums view). */
  let pendingAlbum: string | null = null;
  // The pinned heading's height, so the song table's sticky column headings sit just below it.
  const barHeight = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.target as HTMLElement;
      if (box.isConnected && box.offsetParent) document.documentElement.style.setProperty("--lib-bar-height", `${box.offsetHeight}px`);
    }
  });
  const wallHead = el("div", "lib-head lib-sticky");
  const title = el("h2", "lib-title lib-pivots");
  title.id = "library-title";
  const pivots = new Map<Tab, HTMLButtonElement>();
  for (const name of ["artists", "albums", "playlists"] as const) {
    const pivot = el("button", "lib-pivot", name);
    pivot.type = "button";
    pivot.addEventListener("click", () => {
      tab = name;
      renderWall();
    });
    pivots.set(name, pivot);
    title.append(pivot);
  }
  const count = el("p", "lib-count");
  count.id = "artist-count";
  const find = el("input", "lib-find");
  find.type = "search";
  find.placeholder = "Search artists, albums and songs";
  find.setAttribute("aria-label", "Search artists, albums and songs");
  find.addEventListener("input", () => {
    filter = find.value;
    // Search results (artists, albums, songs) are shown in the artists view.
    if (filter.trim() && tab === "albums") tab = "artists";
    renderWall();
  });
  // Play all and Shuffle (owner, 2026-11-06): the whole library, or what the search found.
  const playEverything = el("button", "secondary lib-options", "Play all");
  playEverything.type = "button";
  playEverything.prepend(icon("play", { size: 14, filled: true }));
  playEverything.addEventListener("click", () => {
    const songs = wallQueue();
    if (songs.length) deps.play(songs, 0);
  });
  const shuffleEverything = el("button", "secondary lib-options", "Shuffle");
  shuffleEverything.type = "button";
  shuffleEverything.prepend(icon("shuffle", { size: 15 }));
  shuffleEverything.addEventListener("click", () => {
    const songs = shuffled(wallQueue());
    if (songs.length) deps.play(songs, 0);
  });
  // Sort and columns lives on the artist page (Columns), where the song table is (owner, 2026-11-06).
  wallHead.append(title, count, find, playEverything, shuffleEverything);
  barHeight.observe(wallHead);
  /** Sets the pinned heading's height now (the observer only reports once the window has drawn). */
  function setBarHeight(box: HTMLElement): void {
    if (box.isConnected && box.offsetHeight) document.documentElement.style.setProperty("--lib-bar-height", `${box.offsetHeight}px`);
  }
  const playlistsRoot = el("div", "pl-page");
  const playlistsView = initPlaylistsView(playlistsRoot, {
    songs: deps.songs,
    store: deps.playlists,
    play: deps.play,
    enqueue: deps.enqueue,
    openArtist: deps.openArtist,
  });
  /** What Play all plays: every artist in wall order (or the search's artists, albums and songs). */
  function wallQueue(): LibraryTrack[] {
    const songs = deps.songs();
    const groups = artistWall(songs, settings.ignoreArticles, filter);
    const fromArtists = groups.flatMap((g) => g.artists.flatMap((a) => inPlayOrder(a.songs as LibraryTrack[])));
    if (!filter.trim()) return fromArtists;
    const found = searchLibrary(songs, filter, settings.ignoreArticles);
    const seen = new Set<string>();
    return [...fromArtists, ...found.albums.flatMap((a) => a.songs), ...found.songs].filter((s) => !seen.has(s.source_uri) && seen.add(s.source_uri));
  }
  const wall = el("div", "lib-wall");
  wall.id = "artist-grid";
  wall.setAttribute("aria-live", "polite");
  const letterBar = el("nav", "lib-letters");
  letterBar.setAttribute("aria-label", "Jump to a letter");
  const letterButtons = new Map<string, HTMLButtonElement>();
  for (const letter of LETTERS) {
    const button = el("button", undefined, letter);
    button.type = "button";
    button.title = letter === "#" ? "Numbers and symbols" : `Artists under ${letter}`;
    button.addEventListener("click", () => {
      const heading = wall.querySelector<HTMLElement>(`[data-letter="${letter === "#" ? "num" : letter}"]`);
      heading?.scrollIntoView({ block: "start" });
    });
    letterButtons.set(letter, button);
    letterBar.append(button);
  }
  const body = el("div", "lib-body");
  body.append(wall, letterBar);
  libraryRoot.replaceChildren(wallHead, body);
  let wallKey = "";
  let wallSongs: LibraryTrack[] | null = null;

  /**
   * The covers of an artist's albums, piled. With `photo` (the artist wall, not album results), the artist's own photo
   * (the "Artist" picture in their songs) is laid on top of the pile when they have one (D97).
   */
  function stack(albums: AlbumGroup[], name: string, photo = false): HTMLElement {
    const box = el("span", "lib-stack");
    if (photo && deps.artistPhotoUrl) {
      const paths = albums.slice(0, 4).map((album) => album.songs[0].source_uri);
      const photoUrl = deps.artistPhotoUrl;
      loaders.set(box, () =>
        void photoUrl(paths).then((url) => {
          if (!url) return;
          const card = el("span", "lib-stack-card lib-stack-photo has-cover");
          const image = el("img");
          image.alt = `${name}`;
          image.src = url;
          image.decoding = "async";
          card.append(image);
          box.classList.add("has-photo");
          box.append(card);
        }),
      );
      watcher.observe(box);
    }
    // Up to three covers: the newest on top, two older ones turned out behind it.
    const shown = albums.slice(-3);
    shown.forEach((album, index) => {
      const card = el("span", `lib-stack-card lib-stack-${shown.length - index}`);
      card.append(el("span", "lib-stack-initial", (album.name === "Unknown album" ? name : album.name).slice(0, 1).toUpperCase()));
      lazyCover(card, album.songs[0].source_uri);
      box.append(card);
    });
    return box;
  }

  function renderWall(): void {
    for (const [name, pivot] of pivots) {
      pivot.classList.toggle("is-active", name === tab);
      pivot.setAttribute("aria-pressed", String(name === tab));
    }
    const onPlaylists = tab === "playlists";
    setBarHeight(wallHead);
    find.hidden = onPlaylists;
    playEverything.hidden = onPlaylists;
    shuffleEverything.hidden = onPlaylists;
    if (onPlaylists) {
      count.textContent = "";
      if (body.parentElement) body.replaceWith(playlistsRoot);
      playlistsView.render();
      return;
    }
    if (playlistsRoot.parentElement) playlistsRoot.replaceWith(body);
    const songs = deps.songs();
    if (tab === "albums") {
      renderAlbums(songs);
      return;
    }
    // Redrawn when the library itself is replaced (a new snapshot, such as the lengths arriving after start), or
    // the filter or sorting changes; not on every page change.
    const key = `artists:${filter}:${settings.ignoreArticles}`;
    if (songs === wallSongs && key === wallKey && wall.childElementCount) return;
    wallSongs = songs;
    wallKey = key;
    const groups = artistWall(songs, settings.ignoreArticles, filter);
    const searching = filter.trim() !== "";
    // Bands that are only on compilations are not on the wall but a search finds them (owner, 2026-11-10).
    const guests = searching ? guestArtists(songs, settings.ignoreArticles, filter) : [];
    const artists = groups.reduce((sum, g) => sum + g.artists.length, 0) + guests.length;
    const found = searching ? searchLibrary(songs, filter, settings.ignoreArticles) : { albums: [], songs: [] };
    count.textContent = !songs.length
      ? ""
      : searching
        ? [plural(artists, "artist"), plural(found.albums.length, "album"), plural(found.songs.length, "song")].join(" · ")
        : `${plural(artists, "artist")} · ${songs.length.toLocaleString()} songs`;
    wall.replaceChildren();
    letterBar.hidden = searching;
    if (!songs.length) {
      wall.append(el("p", "lib-empty", "Choose a music folder in Settings to start your library."));
    } else if (searching && !groups.length && !guests.length && !found.albums.length && !found.songs.length) {
      wall.append(el("p", "lib-empty", `Nothing matches “${filter.trim()}”.`));
    }
    if (searching) {
      // Search (owner, 2026-11-06): artists first, then albums, a line, then songs.
      if (groups.length || guests.length) wall.append(el("h3", "lib-letter-heading lib-result-heading", "artists"));
      const grid = el("div", "lib-artist-grid");
      for (const group of groups) for (const artist of group.artists) grid.append(artistTile(artist));
      for (const artist of guests) grid.append(artistTile(artist));
      if (groups.length || guests.length) wall.append(grid);
      if (found.albums.length) {
        wall.append(el("h3", "lib-letter-heading lib-result-heading", "albums"));
        const albums = el("div", "lib-artist-grid");
        for (const album of found.albums.slice(0, 120)) albums.append(albumTile(album.name, album.artist, album.songs));
        wall.append(albums);
      }
      if (found.songs.length) {
        if (groups.length || guests.length || found.albums.length) wall.append(el("hr", "lib-result-rule"));
        wall.append(el("h3", "lib-letter-heading lib-result-heading", "songs"));
        wall.append(songResults(found.songs.slice(0, 300)));
        if (found.songs.length > 300) wall.append(el("p", "field-hint", `Showing the first 300 of ${found.songs.length.toLocaleString()} songs: type more to narrow it down.`));
      }
      return;
    }
    const present = new Set(groups.map((g) => g.letter));
    for (const [letter, button] of letterButtons) button.disabled = !present.has(letter);
    for (const group of groups) {
      const heading = el("h3", "lib-letter-heading", group.letter);
      heading.dataset.letter = group.letter === "#" ? "num" : group.letter;
      const grid = el("div", "lib-artist-grid");
      for (const artist of group.artists) grid.append(artistTile(artist));
      wall.append(heading, grid);
    }
  }

  /**
   * Every album, compilations included (owner, 2026-11-06: there was no way to reach "Various Artists" albums), by
   * title under letter headings, each a cover tile; a click opens its artist's page at that album.
   */
  function renderAlbums(songs: LibraryTrack[]): void {
    const key = `albums:${settings.ignoreArticles}`;
    if (songs === wallSongs && key === wallKey && wall.childElementCount) return;
    wallSongs = songs;
    wallKey = key;
    const byKey = new Map<string, { name: string; artist: string; songs: LibraryTrack[] }>();
    for (const song of songs) {
      const name = song.album?.trim() || "Unknown album";
      const artist = artistOf(song);
      const id = `${artistKey(artist)}\u0000${name.toLocaleLowerCase()}`;
      const found = byKey.get(id);
      if (found) found.songs.push(song);
      else byKey.set(id, { name, artist, songs: [song] });
    }
    const albums = [...byKey.values()].sort((a, b) => sortKey(a.name, settings.ignoreArticles).localeCompare(sortKey(b.name, settings.ignoreArticles), undefined, { numeric: true }) || a.artist.localeCompare(b.artist));
    count.textContent = plural(albums.length, "album");
    wall.replaceChildren();
    letterBar.hidden = false;
    const present = new Set<string>();
    let grid: HTMLElement | null = null;
    let current = "";
    for (const album of albums) {
      const letter = letterOf(album.name, settings.ignoreArticles);
      if (letter !== current) {
        current = letter;
        present.add(letter);
        const heading = el("h3", "lib-letter-heading", letter);
        heading.dataset.letter = letter === "#" ? "num" : letter;
        grid = el("div", "lib-artist-grid");
        wall.append(heading, grid);
      }
      const ordered = [...album.songs].sort((a, b) => (a.disc_number ?? 1) - (b.disc_number ?? 1) || (a.track_number ?? 0) - (b.track_number ?? 0));
      const tile = albumTile(album.name, album.artist, ordered);
      // Open the artist's page at this album, rather than at the top.
      tile.addEventListener("click", () => (pendingAlbum = album.name), { capture: true });
      grid!.append(tile);
    }
    for (const [letter, button] of letterButtons) button.disabled = !present.has(letter);
  }

  /** Right-click, or the menu key (Shift+F10), on `target` opens `show` there. */
  function onMenu(target: HTMLElement, show: (x: number, y: number) => void): void {
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      show(event.clientX, event.clientY);
    });
    target.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const box = target.getBoundingClientRect();
        show(box.left + 40, box.bottom);
      }
    });
  }

  function artistTile(artist: ReturnType<typeof artistWall>[number]["artists"][number]): HTMLElement {
    const tile = el("button", "lib-artist");
    tile.type = "button";
    const text = el("span", "lib-artist-text");
    text.append(
      el("span", "lib-artist-name", artist.name),
      el("span", "lib-artist-line", artist.albums.length > 1 ? `${plural(artist.albums.length, "album")}, ${plural(artist.songs.length, "song")}` : plural(artist.songs.length, "song")),
    );
    const total = formatTotal(artist.lengthMs);
    if (total) text.append(el("span", "lib-artist-line", total));
    if (artist.genre) text.append(el("span", "lib-artist-genre", artist.genre));
    tile.append(stack(artist.albums, artist.name, true), text);
    tile.addEventListener("click", () => deps.openArtist(artist.name));
    // Right-click (or the menu key): play the artist, or add them to what is playing (owner, 2026-11-06).
    onMenu(tile, (x, y) => artistMenu(x, y, artist.name, inPlayOrder(artist.songs as LibraryTrack[])));
    return tile;
  }

  /** An album found by the search: its cover, name and artist; click opens the artist, right-click plays it. */
  function albumTile(name: string, artist: string, songs: LibraryTrack[]): HTMLElement {
    const tile = el("button", "lib-artist lib-album-result");
    tile.type = "button";
    const cover = el("span", "lib-stack");
    const card = el("span", "lib-stack-card lib-stack-1");
    card.append(el("span", "lib-stack-initial", name.slice(0, 1).toUpperCase()));
    lazyCover(card, songs[0].source_uri);
    cover.append(card);
    const text = el("span", "lib-artist-text");
    const year = songs.find((s) => s.release_year)?.release_year;
    text.append(el("span", "lib-artist-name", name), el("span", "lib-artist-line", artist), el("span", "lib-artist-genre", [year ? String(year) : "", plural(songs.length, "song")].filter(Boolean).join(" · ")));
    tile.append(cover, text);
    tile.addEventListener("click", () => deps.openArtist(artist));
    onMenu(tile, (x, y) =>
      openMenu(x, y, [
        { label: "Play album", action: () => deps.play(songs, 0) },
        { label: "Play next", action: () => deps.enqueue(songs, "next") },
        { label: "Add to queue", action: () => deps.enqueue(songs, "end") },
        deps.playlists.menuItem(() => songs.map((s) => s.source_uri)),
        "separator",
        { label: `Open ${artist}`, action: () => deps.openArtist(artist) },
      ], name),
    );
    return tile;
  }

  /** Songs found by the search: one row each; click plays from there, right-click for the rest. */
  function songResults(songs: LibraryTrack[]): HTMLElement {
    const table = el("table", "lib-table lib-song-results");
    const head = el("tr");
    for (const [text, cls] of [["Title", ""], ["Length", "is-number"], ["Artist", ""], ["Album", ""]]) head.append(el("th", cls || undefined, text));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    songs.forEach((song, index) => {
      const row = el("tr", "lib-row");
      row.tabIndex = 0;
      row.title = "Double-click to play; right-click for more";
      row.append(el("td", undefined, song.title), el("td", "is-number", formatLength(song.length_ms)), el("td", undefined, song.artist ?? artistOf(song)), el("td", undefined, song.album ?? ""));
      row.addEventListener("dblclick", () => deps.play(songs, index));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") deps.play(songs, index);
      });
      onMenu(row, (x, y) => songMenu(x, y, [song], songs));
      tbody.append(row);
    });
    table.append(thead, tbody);
    return table;
  }

  // ---- An artist ----
  function selection(): LibraryTrack[] {
    return deps.songs().filter((s) => selected.has(s.source_uri));
  }

  function renderArtist(name: string): boolean {
    const key = artistKey(name);
    const own = deps.songs().filter((s) => artistKey(artistOf(s)) === key);
    // Songs on other artists' albums (compilations) that credit this artist (owner, 2026-11-10).
    const also = alsoAppearsOn(deps.songs(), key);
    if (!own.length && !also.length) return false;
    const songs = [...own, ...also];
    if (currentArtist !== name) {
      selected.clear();
      anchor = null;
      currentArtist = name;
    }
    const sorted = (list: LibraryTrack[]) => albumsOf(list, settings.albumOrder, settings.ignoreArticles).map((album) => ({ ...album, songs: sortSongs(album.songs, sort.column, sort.descending) as LibraryTrack[] }));
    const albums = sorted(own);
    // The compilations in their entirety (owner, 2026-11-11), so a whole album or just this artist's song can be chosen.
    const albumKeyOf = (s: LibraryTrack): string => `${artistKey(artistOf(s))}\u0000${(s.album ?? "").trim().toLocaleLowerCase()}`;
    const alsoKeys = new Set(also.map(albumKeyOf));
    const alsoAlbums = sorted(alsoKeys.size ? deps.songs().filter((s) => alsoKeys.has(albumKeyOf(s))) : []);

    const back = el("button", "lib-back");
    back.type = "button";
    setIconButton(back, "back", "Back to artists");
    back.id = "back-to-library";
    back.addEventListener("click", () => deps.back());
    const crumbs = el("nav", "lib-crumbs");
    crumbs.setAttribute("aria-label", "You are here");
    // library › artists (or albums, when opened from there) › the artist; both links go back to the library.
    const toLibrary = el("button", "lib-crumb", "library");
    toLibrary.type = "button";
    toLibrary.addEventListener("click", () => deps.back());
    const toWall = el("button", "lib-crumb", tab === "albums" ? "albums" : "artists");
    toWall.type = "button";
    toWall.addEventListener("click", () => deps.back());
    crumbs.append(toLibrary, el("span", undefined, "›"), toWall, el("span", undefined, `› ${name}`));
    // The way back stays at the top of the window while the songs scroll (owner, 2026-11-06).
    const top = el("div", "lib-artist-top lib-sticky");
    top.append(back, crumbs);

    const heading = el("div", "lib-artist-heading");
    const nameEl = el("h2", "lib-artist-title", name.toLocaleLowerCase());
    nameEl.id = "artist-page-title";
    const genres = [...new Set(songs.map((s) => s.genre).filter(Boolean))].slice(0, 2).join(", ");
    const summary = [albums.length ? plural(albums.length, "album") : "", alsoAlbums.length ? (albums.length ? "plus " : "on ") + plural(alsoAlbums.length, albums.length ? "other album" : "album") : "", plural(songs.length, "song"), formatTotal(totalLength(songs)), genres].filter(Boolean).join(" · ");
    const words = el("div", "lib-artist-words");
    words.append(nameEl, el("span", "lib-artist-summary", summary));
    const playAll = el("button", undefined, "Play all");
    playAll.type = "button";
    const everything = [...albums.flatMap((a) => a.songs), ...sorted(also).flatMap((a) => a.songs)]; // this artist's songs only
    playAll.addEventListener("click", () => deps.play(everything, 0));
    const shuffle = el("button", "secondary", "Shuffle");
    shuffle.type = "button";
    shuffle.addEventListener("click", () => deps.play(shuffled(everything), 0));
    // Play next / Add to queue stay on right-click on the PC (owner, 2026-11-06: keep the page clean); the
    // artist's name and Play all offer them, as do the songs, albums and wall tiles.
    for (const target of [nameEl, playAll] as HTMLElement[]) {
      target.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          { label: "Play all", action: () => deps.play(everything, 0) },
          { label: "Shuffle", action: () => deps.play(shuffled(everything), 0) },
          { label: "Play next", action: () => deps.enqueue(everything, "next") },
          { label: "Add to queue", action: () => deps.enqueue(everything, "end") },
          deps.playlists.menuItem(() => everything.map((s) => s.source_uri)),
        ], name);
      });
    }
    const columnsButton = el("button", "secondary", "Columns");
    columnsButton.type = "button";
    columnsButton.prepend(icon("columns", { size: 16 }));
    columnsButton.addEventListener("click", () => openOptions());
    heading.append(words, playAll, shuffle, columnsButton);

    const count = el("span", "lib-selected-count");
    count.setAttribute("aria-live", "polite");
    words.append(count);
    const holder = el("div", "lib-table-box");
    holder.id = "artist-albums";
    if (albums.length) holder.append(songTable(albums));
    if (alsoAlbums.length) {
      // A line and a note before the compilations the artist is on (owner, 2026-11-10).
      if (albums.length) holder.append(el("hr", "lib-result-rule"));
      holder.append(el("h3", "lib-letter-heading lib-result-heading lib-also-heading", ` also appears in:`), songTable(alsoAlbums));
    }
    artistRoot.replaceChildren(top, heading, holder);
    barHeight.observe(top);
    setBarHeight(top);
    setTimeout(() => setBarHeight(top), 0); // once the page is showing
    paintSelection();
    // Opened from the albums view: go to that album.
    if (pendingAlbum !== null) {
      const wanted = pendingAlbum;
      pendingAlbum = null;
      setTimeout(() => {
        const row = [...artistRoot.querySelectorAll<HTMLElement>("tr.lib-album-title")].find((r) => r.dataset.album === wanted);
        row?.scrollIntoView({ block: "start" });
      }, 0);
    }
    return true;
  }

  function refresh(): void {
    if (currentArtist) renderArtist(currentArtist);
  }

  /** Shows the selection on the rows already drawn (no redraw, so covers do not flicker). */
  function paintSelection(): void {
    for (const row of artistRoot.querySelectorAll<HTMLElement>("tr.lib-row")) {
      const on = selected.has(row.dataset.path ?? "");
      row.classList.toggle("is-selected", on);
      row.setAttribute("aria-selected", String(on));
    }
    const count = artistRoot.querySelector<HTMLElement>(".lib-selected-count");
    if (count) count.textContent = selected.size > 1 ? `${plural(selected.size, "song")} selected` : "";
  }

  function select(song: LibraryTrack, event: MouseEvent | KeyboardEvent, order: LibraryTrack[]): void {
    const path = song.source_uri;
    if (event.shiftKey && anchor) {
      const from = order.findIndex((s) => s.source_uri === anchor);
      const to = order.findIndex((s) => s.source_uri === path);
      if (from >= 0 && to >= 0) {
        if (!event.ctrlKey) selected.clear();
        for (const s of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(s.source_uri);
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      anchor = path;
    } else {
      selected.clear();
      selected.add(path);
      anchor = path;
    }
    paintSelection();
    artistRoot.querySelector<HTMLElement>(`tr[data-path="${CSS.escape(path)}"]`)?.focus();
  }

  /** The right-click menu for the selected songs (Windows Media Player's, less what this program cannot do yet). */
  function songMenu(x: number, y: number, chosen: LibraryTrack[], album: LibraryTrack[]): void {
    if (!chosen.length) return;
    const one = chosen.length === 1 ? chosen[0] : null;
    const allFavorite = chosen.every((s) => deps.isFavorite(s.source_uri));
    const scannable = chosen.filter((s) => /\.(mp3|flac|wav)$/i.test(s.source_uri));
    const items: MenuItem[] = [
      { label: "Play", action: () => (one ? deps.play(album, Math.max(album.indexOf(one), 0)) : deps.play(chosen, 0)) },
      { label: "Play next", action: () => deps.enqueue(chosen, "next") },
      { label: "Add to queue", action: () => deps.enqueue(chosen, "end") },
      deps.playlists.menuItem(() => chosen.map((s) => s.source_uri)),
      "separator",
      // Editing, scanning and the file's place need a file: not with the Jellyfin server alone as the library (D173).
      ...(serverLibrary()
        ? []
        : ([
            { label: chosen.length > 1 ? `Edit tags of ${chosen.length} songs…` : "Edit tags…", action: () => deps.editTags(chosen) },
            { label: "Artwork…", action: () => deps.pictures(chosen), disabled: !(one && /\.mp3$/i.test(one.source_uri)) },
            { label: "Lyrics…", action: () => one && deps.lyrics(one), disabled: !(one && /\.mp3$/i.test(one.source_uri)) },
            { label: "Scan for defects…", action: () => deps.scan(scannable), disabled: scannable.length === 0 },
            "separator",
          ] as MenuItem[])),
      { label: allFavorite ? "Remove from favorites" : "Add to favorites", action: () => deps.setFavorite(chosen.map((s) => s.source_uri), !allFavorite) },
      { label: one && deps.isFlagged(one.source_uri) ? "Change flag…" : "Flag for review…", action: () => one && deps.flag(one), disabled: !one },
      ...(serverLibrary()
        ? []
        : ([
            "separator",
            { label: "Properties", action: () => one && properties(one), disabled: !one },
            { label: "Open file location", action: () => one && void deps.showInFolder(one.source_uri), disabled: !one },
          ] as MenuItem[])),
    ];
    openMenu(x, y, items, chosen.length > 1 ? `${chosen.length} songs` : chosen[0].title);
  }

  /** An artist's songs as Play all plays them: albums in the chosen order, songs by track number. */
  function inPlayOrder(songs: LibraryTrack[]): LibraryTrack[] {
    return albumsOf(songs, settings.albumOrder, settings.ignoreArticles).flatMap((album) => sortSongs(album.songs, "number", false) as LibraryTrack[]);
  }

  function shuffled(songs: LibraryTrack[]): LibraryTrack[] {
    const mixed = [...songs];
    for (let i = mixed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    return mixed;
  }

  /** The right-click menu of an artist on the wall. */
  function artistMenu(x: number, y: number, name: string, songs: LibraryTrack[]): void {
    openMenu(
      x,
      y,
      [
        { label: "Play all", action: () => deps.play(songs, 0) },
        { label: "Shuffle", action: () => deps.play(shuffled(songs), 0) },
        { label: "Play next", action: () => deps.enqueue(songs, "next") },
        { label: "Add to queue", action: () => deps.enqueue(songs, "end") },
        deps.playlists.menuItem(() => songs.map((s) => s.source_uri)),
        "separator",
        { label: "Open", action: () => deps.openArtist(name) },
      ],
      name,
    );
  }

  function albumMenu(x: number, y: number, name: string, songs: LibraryTrack[]): void {
    const pinned = deps.isPinned(songs);
    openMenu(
      x,
      y,
      [
        { label: "Play album", action: () => deps.play(songs, 0) },
        { label: "Play next", action: () => deps.enqueue(songs, "next") },
        { label: "Add to queue", action: () => deps.enqueue(songs, "end") },
        deps.playlists.menuItem(() => songs.map((s) => s.source_uri)),
        "separator",
        {
          label: "Select the album's songs",
          action: () => {
            selected.clear();
            for (const s of songs) selected.add(s.source_uri);
            anchor = songs[0]?.source_uri ?? null;
            paintSelection();
          },
        },
        ...(serverLibrary()
          ? []
          : ([
              { label: `Edit tags of ${plural(songs.length, "song")}…`, action: () => deps.editTags(songs) },
              { label: "Album pictures…", action: () => deps.albumPictures(name, songs) },
            ] as MenuItem[])),
        { label: pinned ? "Unpin from Home" : "Pin to Home", action: () => deps.togglePin(name, songs) },
        ...(serverLibrary() ? [] : ([("separator" as const), { label: "Open folder", action: () => songs[0] && void deps.showInFolder(songs[0].source_uri) }] as MenuItem[])),
      ],
      name,
    );
  }

  /** Everything known about one song, read only, with a way into the tag editor. */
  function properties(song: LibraryTrack): void {
    const dialog = el("dialog", "lib-dialog lib-properties");
    dialog.append(el("h2", undefined, "properties"));
    const list = el("dl", "lib-props");
    const facts: [string, string][] = [
      ["Title", song.title],
      ["Contributing artist", song.artist ?? ""],
      ["Album", song.album ?? ""],
      ["Album artist", song.album_artist ?? ""],
      ["Genre", song.genre ?? ""],
      ["Year", song.release_year ? String(song.release_year) : ""],
      ["Track", cellText(song, "number")],
      ["Disc", cellText(song, "disc")],
      ["Length", cellText(song, "length")],
      ["Bitrate", cellText(song, "bitrate")],
      ["Size", cellText(song, "size")],
      ["Date added", cellText(song, "added")],
      ["File type", cellText(song, "type")],
      ["Location", song.source_uri],
    ];
    for (const [term, value] of facts) list.append(el("dt", undefined, term), el("dd", undefined, value || "—"));
    const edit = el("button", "secondary", "Edit tags…");
    edit.type = "button";
    edit.addEventListener("click", () => {
      dialog.close();
      deps.editTags([song]);
    });
    const folder = el("button", "secondary", "Open file location");
    folder.type = "button";
    folder.addEventListener("click", () => void deps.showInFolder(song.source_uri));
    const close = el("button", undefined, "Close");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    const actions = el("div", "dialog-actions");
    actions.append(edit, folder, el("span", "lib-grow"), close);
    dialog.append(list, actions);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }
  function songTable(albums: (AlbumGroup & { songs: LibraryTrack[] })[]): HTMLTableElement {
    const columns = settings.columns.map((id) => COLUMNS.find((c) => c.id === id)!).filter(Boolean);
    const table = el("table", "lib-table");
    const colgroup = el("colgroup");
    if (settings.showArt) {
      const art = el("col");
      art.style.width = "220px";
      colgroup.append(art);
    }
    for (const column of columns) {
      const col = el("col");
      if (column.id !== "title") col.style.width = `${settings.widths[column.id] ?? column.width}px`;
      colgroup.append(col);
    }
    const head = el("tr");
    if (settings.showArt) head.append(el("th", "lib-th-album", "Album"));
    for (const column of columns) {
      const th = el("th", column.numeric ? "is-number" : undefined);
      const button = el("button", "lib-sort", column.label);
      button.type = "button";
      const active = sort.column === column.id;
      if (active) {
        button.classList.add("is-active");
        button.append(el("span", "lib-sort-mark", sort.descending ? " ▼" : " ▲"));
        th.setAttribute("aria-sort", sort.descending ? "descending" : "ascending");
      }
      button.title = `Sort each album's songs by ${column.label.toLocaleLowerCase()}`;
      button.addEventListener("click", () => {
        sort = { column: column.id, descending: active ? !sort.descending : false };
        refresh();
      });
      th.append(button);
      head.append(th);
    }
    const thead = el("thead");
    thead.append(head);
    table.append(colgroup, thead);
    const order = albums.flatMap((a) => a.songs);
    const span = columns.length + (settings.showArt ? 1 : 0);

    for (const album of albums) {
      const tbody = el("tbody", "lib-album");
      const titleRow = el("tr", "lib-album-title");
      titleRow.dataset.album = album.name;
      const titleCell = el("th", undefined, album.name);
      titleCell.colSpan = span;
      titleCell.scope = "rowgroup";
      titleRow.append(titleCell);
      tbody.append(titleRow);
      // The album's songs sit in a table of their own beside the cover, with the same column widths as the
      // headings: each row keeps its own height (a one-song album no longer stretches its row around the cover),
      // and hovering or selecting a song never lights up the album details.
      const body = el("tr", "lib-album-body");
      if (settings.showArt) body.append(albumCell(album));
      const holder = el("td", "lib-tracks-cell");
      holder.colSpan = columns.length;
      const inner = el("table", "lib-tracks");
      const innerCols = el("colgroup");
      for (const column of columns) {
        const col = el("col");
        if (column.id !== "title") col.style.width = `${settings.widths[column.id] ?? column.width}px`;
        innerCols.append(col);
      }
      const rows = el("tbody");
      for (const song of album.songs) {
        const tr = el("tr", "lib-row");
        tr.dataset.path = song.source_uri;
        tr.tabIndex = 0;
        tr.setAttribute("aria-selected", String(selected.has(song.source_uri)));
        if (selected.has(song.source_uri)) tr.classList.add("is-selected");
        for (const column of columns) {
          const td = el("td", column.numeric ? "is-number" : undefined);
          td.textContent = cellText(song, column.id);
          if (column.id === "title") {
            td.title = song.title;
            if (deps.isFavorite(song.source_uri)) td.append(icon("heart", { size: 13, filled: true }));
            if (deps.isFlagged(song.source_uri)) td.append(icon("flag", { size: 13 }));
          }
          tr.append(td);
        }
        tr.addEventListener("click", (event) => select(song, event, order));
        tr.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          // Right-clicking a song outside the selection selects just that song first, as Windows does.
          if (!selected.has(song.source_uri)) select(song, event, order);
          songMenu(event.clientX, event.clientY, selection(), album.songs);
        });
        tr.addEventListener("dblclick", () => deps.play(album.songs, album.songs.indexOf(song)));
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter") deps.play(album.songs, album.songs.indexOf(song));
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            if (!selected.has(song.source_uri)) select(song, new MouseEvent("click"), order);
            const box = tr.getBoundingClientRect();
            songMenu(box.left + 120, box.bottom, selection(), album.songs);
          }
          if (event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            for (const s of order) selected.add(s.source_uri);
            paintSelection();
          }
          if (event.key === " ") {
            event.preventDefault();
            select(song, event, order);
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = order[order.indexOf(song) + (event.key === "ArrowDown" ? 1 : -1)];
            if (next) select(next, event, order);
          }
        });
        rows.append(tr);
      }
      inner.append(innerCols, rows);
      holder.append(inner);
      body.append(holder);
      tbody.append(body);
      table.append(tbody);
    }
    return table;
  }

  function albumCell(album: AlbumGroup & { songs: LibraryTrack[] }): HTMLTableCellElement {
    const td = el("td", "lib-album-cell");
    td.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      albumMenu(event.clientX, event.clientY, album.name, album.songs);
    });
    const art = el("button", "lib-art");
    art.type = "button";
    art.title = `Play ${album.name}`;
    art.append(el("span", "lib-stack-initial", album.name.slice(0, 1).toUpperCase()));
    lazyCover(art, album.songs[0].source_uri, `Cover of ${album.name}`);
    art.addEventListener("click", () => deps.play(album.songs, 0));
    const facts = el("div", "lib-album-facts");
    const artists = [...new Set(album.songs.map((s) => s.artist).filter(Boolean))];
    facts.append(
      el("span", undefined, artists.length > 2 ? "Various artists" : artists.join(", ")),
      el("span", undefined, album.genre ?? ""),
      el("span", undefined, album.year ? String(album.year) : ""),
      el("span", "lib-album-count", [plural(album.songs.length, "song"), formatTotal(album.lengthMs)].filter(Boolean).join(" · ")),
    );
    const actions = el("div", "lib-album-actions");
    const pictures = el("button", "icon-button");
    pictures.type = "button";
    setIconButton(pictures, "picture", "Album pictures");
    pictures.addEventListener("click", () => deps.albumPictures(album.name, album.songs));
    const pinned = deps.isPinned(album.songs);
    const pin = el("button", pinned ? "icon-button is-on" : "icon-button");
    pin.type = "button";
    setIconButton(pin, "pin", pinned ? "Unpin from Home" : "Pin to Home", pinned);
    pin.addEventListener("click", () => deps.togglePin(album.name, album.songs));
    actions.append(pictures, pin);
    td.append(art, facts, actions);
    return td;
  }

  // ---- Columns and sorting ----
  function openOptions(): void {
    const dialog = el("dialog", "lib-dialog");
    const draft: Settings = { ...settings, columns: [...settings.columns], widths: { ...settings.widths } };
    let picked: ColumnId = draft.columns[0] ?? "title";
    const list = el("div", "lib-col-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Columns");
    const width = el("input");
    width.type = "number";
    width.min = "30";
    width.max = "600";
    const order = (): ColumnId[] => [...draft.columns, ...COLUMNS.map((c) => c.id).filter((id) => !draft.columns.includes(id))];
    function drawList(): void {
      list.replaceChildren();
      for (const id of order()) {
        const column = COLUMNS.find((c) => c.id === id)!;
        const row = el("label", id === picked ? "lib-col is-picked" : "lib-col");
        const box = el("input");
        box.type = "checkbox";
        box.checked = draft.columns.includes(id);
        box.disabled = id === "title";
        box.addEventListener("change", () => {
          draft.columns = box.checked ? [...draft.columns, id] : draft.columns.filter((c) => c !== id);
          picked = id;
          drawList();
        });
        row.addEventListener("click", () => {
          picked = id;
          width.value = String(draft.widths[id] ?? column.width);
          width.disabled = id === "title";
          for (const r of list.children) r.classList.toggle("is-picked", r === row);
        });
        row.append(box, el("span", undefined, column.label === "#" ? "Track number" : column.label), el("span", "lib-col-width", id === "title" ? "fills the rest" : `${draft.widths[id] ?? column.width} px`));
        list.append(row);
      }
    }
    const move = (step: number) => () => {
      const at = draft.columns.indexOf(picked);
      if (at < 0) return;
      const to = Math.min(Math.max(at + step, 0), draft.columns.length - 1);
      draft.columns.splice(to, 0, ...draft.columns.splice(at, 1));
      drawList();
    };
    const up = el("button", "secondary", "Move up");
    up.type = "button";
    up.addEventListener("click", move(-1));
    const down = el("button", "secondary", "Move down");
    down.type = "button";
    down.addEventListener("click", move(1));
    width.value = String(draft.widths[picked] ?? COLUMNS.find((c) => c.id === picked)?.width ?? 100);
    width.addEventListener("change", () => {
      const value = Math.min(Math.max(Number(width.value) || 0, 30), 600);
      if (picked !== "title") draft.widths[picked] = value;
      drawList();
    });
    const widthLabel = el("label", "lib-field", "Width (px)");
    widthLabel.append(width);
    const side = el("div", "lib-col-side");
    side.append(up, down, widthLabel);
    const columnsBox = el("div", "lib-col-box");
    columnsBox.append(list, side);

    const albumOrder = el("select");
    for (const [value, label] of [["year-asc", "Release year, oldest first"], ["year-desc", "Release year, newest first"], ["name", "Album name"]] as const) {
      const option = el("option", undefined, label);
      option.value = value;
      option.selected = draft.albumOrder === value;
      albumOrder.append(option);
    }
    albumOrder.addEventListener("change", () => (draft.albumOrder = albumOrder.value as AlbumOrder));
    const orderLabel = el("label", "lib-field", "Order an artist’s albums by");
    orderLabel.append(albumOrder);
    const check = (label: string, value: boolean, set: (on: boolean) => void): HTMLLabelElement => {
      const row = el("label", "lib-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = value;
      box.addEventListener("change", () => set(box.checked));
      row.append(box, document.createTextNode(` ${label}`));
      return row;
    };
    const ok = el("button", undefined, "OK");
    ok.type = "button";
    ok.addEventListener("click", () => {
      settings = draft;
      writeSettings(settings);
      wallKey = "";
      dialog.close();
      renderWall();
      refresh();
    });
    const cancel = el("button", "secondary", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    const reset = el("button", "lib-link", "Restore defaults");
    reset.type = "button";
    reset.addEventListener("click", () => {
      Object.assign(draft, { ...DEFAULTS, columns: [...DEFAULTS.columns], widths: {} });
      picked = "title";
      drawList();
    });
    const actions = el("div", "dialog-actions");
    actions.append(reset, el("span", "lib-grow"), cancel, ok);
    const heading = el("h2", undefined, "columns and sorting");
    dialog.append(
      heading,
      el("p", "field-hint", "Tick the columns to show in an artist’s song list and put them in order. Click a column heading in the list to sort by it."),
      columnsBox,
      orderLabel,
      check("Ignore “The”, “A” and “An” when sorting names", draft.ignoreArticles, (on) => (draft.ignoreArticles = on)),
      check("Show each album’s cover beside its songs", draft.showArt, (on) => (draft.showArt = on)),
      actions,
    );
    drawList();
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  return { renderWall, renderArtist };
}
