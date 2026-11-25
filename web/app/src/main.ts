import { listen, invoke, open, showInFolder, useServerLibrary } from "./desktop-bridge";
import { libraryMode, serverLibrary, setLibraryMode } from "./library-mode";
import { openMenu } from "./context-menu";
import { timed } from "./startup-trace";
import { serverLibraryHandlers, signedOutHandlers } from "./jellyfin-library";
import { chosenServer, desktopJellyfin, deviceId, savedDesktopSession } from "./jellyfin-desktop";
import { initDriveSetup } from "./drive-setup";
import { artistPhotoUrl, coverUrl, forgetCovers } from "./cover-art";
import { folderOf } from "./cover-util";
import { snippetWindow } from "./defect-format";
import { initDefectDialog } from "./defect-dialog";
import { createFavoriteStore } from "./favorites";
import { createPlaylistStore } from "./playlists";
import { initPlayOnTv } from "./play-on-tv";
import { createFlagStore, initFlagDialog, initReviewPage } from "./flags";
import { initGettingStarted } from "./getting-started";
import { initHomePage } from "./home-page";
import { type GroupMode, GROUP_MODES, type SuspectedAlbum, type TrackGroup, VARIOUS_ARTISTS, batchRequests, commonValue, groupTracks, isVariousArtists, suspectedAlbums, suggestion as batchSuggestion } from "./tag-batch";
import { initArtistsPanel } from "./artists-panel";
import { renderLyricAiSettings } from "./lyric-ai-settings";
import { initAlbumIdsPanel } from "./album-ids-panel";
import { initAuditPanel } from "./library-audit-panel";
import { initAudioCheckPanel } from "./audio-check-panel";
import { createSourceStatus } from "./source-status";
import { initAlbumAlignPanel } from "./album-align-panel";
import { initReviewHub } from "./review-hub";
import { initReviewPanels } from "./review-panels";
import { initFixTags } from "./fix-tags";
import { initLibraryView } from "./library-view";
import { initTagTools } from "./tag-tools";
import { setIconButton } from "./icons";
import { createPinStore } from "./pins";
import { initMediaDialog } from "./media-dialog";
import { initNowPlaying } from "./now-playing";
import { initBackdrop } from "./backdrop";
import { initAmbient } from "./ambient";
import { initVisualizer } from "./visualizer";
import { renderDisplaySettings } from "./display-settings";
import { renderSoundSettings } from "./sound-settings";
import { renderOrganizeSettings } from "./organize-settings";
import { initAutoDj } from "./auto-dj";
import { initDialect } from "./dialect-ui";
import { renderLanguageSettings } from "./language-settings";
import { initMediaBridge } from "./media-bridge";
import { renderAboutSettings } from "./about-settings";
import { renderJellyfinSettings } from "./jellyfin-settings";
import { renderProblemSync } from "./problem-sync-ui";
import { flipInterval, loadDisplayPrefs } from "./display-prefs";
import { createAccent } from "./accent";
import { applyMask, loadMask } from "../tv/background-mask.ts";
import { initSettingsSections } from "./settings-sections";
import { initShareSettings } from "./share-settings";
import { showWelcomeIfNeeded } from "./welcome";
import type { PlayableTrack } from "./play-queue";
import { initPlayer } from "./player";
import { initRipPage } from "./rip-page";
import { initSettingsPage } from "./settings-page";
import "./style.css";

// The Jellyfin server alone as the library (D173): the commands that read the music folder are answered from the server instead. Set before anything asks.
document.body.dataset.library = libraryMode();
if (serverLibrary()) {
  const session = savedDesktopSession();
  if (session) {
    // The program plays and casts with the sign-in it was told; told again when this computer signs in again (Settings > Jellyfin).
    let told = "";
    const tell = (): void => {
      const now = savedDesktopSession();
      if (!now || told === now.token) return;
      told = now.token;
      void window.mediaVerse?.jellyfinStreamSession?.({ base: now.base, token: now.token, userId: now.userId, deviceId: deviceId() })?.catch(() => undefined);
    };
    tell();
    window.setInterval(tell, 5_000);
    useServerLibrary(
      serverLibraryHandlers(desktopJellyfin(), session, (read, total) => {
        const line = document.querySelector<HTMLElement>("#status");
        if (line && read < total) line.textContent = `Reading the Jellyfin library… ${read.toLocaleString()} of ${total.toLocaleString()} songs.`;
      }).handlers,
    );
  } else {
    useServerLibrary(signedOutHandlers());
  }
}

type Track = {
  album: string | null;
  album_artist: string | null;
  artist: string | null;
  genre: string | null;
  id: string;
  release_year: number | null;
  title: string;
  source_uri: string;
  suggestions: string[];
  track_number: number | null;
  /** File facts for the library's columns (D52). */
  length_ms?: number | null;
  bitrate_kbps?: number | null;
  disc_number?: number | null;
  size_bytes?: number | null;
  added_secs?: number | null;
};

type LibrarySnapshot = {
  tracks: Track[];
};

type CollectionImport = {
  filename_title_fallbacks: number;
  metadata_failures: number;
  root: string;
  track_count: number;
  tracks: Track[];
};

type CollectionStatus = {
  root: string | null;
};

type AlbumChoice = {
  album: string;
  album_artist: string;
  release_year: number | null;
};

type TagEditorChoices = {
  albums: AlbumChoice[];
  artists: string[];
  genres: string[];
};

type ApiError = {
  code: string;
  message: string;
};

const chooseFolderButton = document.querySelector<HTMLButtonElement>("#choose-folder");
const rescanButton = document.querySelector<HTMLButtonElement>("#rescan-collection");
const collectionRootElement = document.querySelector<HTMLElement>("#collection-root");
const statusElement = document.querySelector<HTMLElement>("#status");
const libraryPage = document.querySelector<HTMLElement>("#library-page")!;
const artistPage = document.querySelector<HTMLElement>("#artist-page")!;
const drivesPage = document.querySelector<HTMLElement>("#drives-page")!;
const playerBar = document.querySelector<HTMLElement>("#player")!;
const player = initPlayer(playerBar);
// Pages leave room at the bottom for the player bar's real height (0 while it is hidden), so it never covers
// the last rows or a page's own buttons.
new ResizeObserver(() => document.documentElement.style.setProperty("--player-height", `${playerBar.offsetHeight}px`)).observe(playerBar);
// Sticky things (the song list's column headings, the selection bar) stop just below the sticky app header.
const appHeader = document.querySelector<HTMLElement>(".app-header");
if (appHeader) new ResizeObserver(() => document.documentElement.style.setProperty("--header-height", `${appHeader.offsetHeight}px`)).observe(appHeader);
// The highlight colour (D72): the chosen one (Settings > Display), or the cover's while Now Playing is open.
const accent = createAccent();
// Playlists (D74): Library > Playlists, and "Add to playlist" on every right-click menu of songs.
const playlistStore = createPlaylistStore();
void playlistStore.load();
accent.setDefault(loadDisplayPrefs().accent);
applyMask(document.documentElement, loadMask("mediaverse.mask", true)); // the colour mask over the cover wall (owner, 2026-11-11)
const nowPlaying = initNowPlaying(
  document.querySelector<HTMLElement>("#now-playing")!,
  player,
  () => tracks.map((track) => ({ title: track.title, artist: track.artist, source_uri: track.source_uri, album: track.album })),
  (track) => reviewPanels.openLyricsEditor(track),
  (colour) => accent.setCover(colour),
  playlistStore,
);
document.querySelector<HTMLButtonElement>("#player-expand")!.addEventListener("click", () => nowPlaying.open());
// The album-art wall behind every page (D32). It rests while Now Playing shows its own wall.
const nowPlayingRoot = document.querySelector<HTMLElement>("#now-playing")!;
// Screen care and motion (D32): idle dimming, Now Playing when idle, fade to black, the motion level.
const ambient = initAmbient(player.signal, nowPlayingRoot, () => nowPlaying.open());
initVisualizer(player.signal, ambient.motion);
// Media keys, the taskbar buttons and the mini player (issue #8): the page tells the program what plays and does what it is asked.
initMediaBridge(player, () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
initAutoDj(player, () => tracks);
// "Play on the TV" (D76): the TV button in the player bar.
initPlayOnTv(
  playerBar,
  player,
  () => {
    document.querySelector<HTMLButtonElement>("[data-page=settings]")?.click();
    document.querySelector<HTMLButtonElement>("[data-settings-section=tv]")?.click();
  },
  (text) => {
    const line = document.querySelector<HTMLElement>("#status");
    if (line) line.textContent = text;
  },
  document.querySelector<HTMLElement>("#settings-cast"),
);
renderDisplaySettings(document.querySelector<HTMLElement>("#settings-display")!, ambient, (hex) => accent.setDefault(hex));
renderSoundSettings(document.querySelector<HTMLElement>("#settings-sound")!);
renderOrganizeSettings(document.querySelector<HTMLElement>("#settings-organize")!);
renderLanguageSettings(document.querySelector<HTMLElement>("#settings-language")!);
initDialect();
renderLyricAiSettings(document.querySelector<HTMLElement>("#settings-lyric-ai")!);
initSettingsSections(document.querySelector<HTMLElement>("#settings-page")!);
initShareSettings(document.querySelector<HTMLElement>("#settings-share")!);
void renderAboutSettings(document.querySelector<HTMLElement>("#settings-about")!);
// Settings > Jellyfin (D90) searches the network only when its tab is opened, not at every start.
const jellyfinSettings = renderJellyfinSettings(document.querySelector<HTMLElement>("#settings-jellyfin")!);
{
  let searched = false;
  const searchOnce = (): void => {
    if (searched) return;
    searched = true;
    jellyfinSettings.refresh();
  };
  document.querySelector("[data-settings-section=jellyfin]")?.addEventListener("click", searchOnce);
  setTimeout(() => {
    const panel = document.querySelector<HTMLElement>("[data-settings-panel=jellyfin]");
    const page = document.querySelector<HTMLElement>("#settings-page");
    if (panel && !panel.hidden && page && !page.hidden) searchOnce();
  }, 0);
}
// Settings > Library > "Using a Jellyfin server…" goes to the Jellyfin tab.
document.querySelector<HTMLButtonElement>("#open-jellyfin-settings")?.addEventListener("click", () => document.querySelector<HTMLButtonElement>("[data-settings-section=jellyfin]")?.click());
// ...and chooses where the library comes from (D173). Changing it starts the page again, so every list reads the new library.
{
  const useServer = document.querySelector<HTMLButtonElement>("#use-server-library");
  const useFolder = document.querySelector<HTMLButtonElement>("#use-folder-library");
  const modeStatus = document.querySelector<HTMLElement>("#library-mode-status");
  const server = serverLibrary();
  const signedIn = savedDesktopSession();
  if (useServer) useServer.hidden = server;
  if (useFolder) useFolder.hidden = !server;
  if (modeStatus) {
    const named = chosenServer()?.name ?? signedIn?.name ?? "the Jellyfin server";
    modeStatus.textContent = server
      ? `The library now comes from ${named} alone. Songs are played and cast from the server; ripping and editing are switched off.`
      : signedIn
        ? `This computer is signed in to ${signedIn.name}. The library now comes from the music folder above.`
        : "To use the server alone as the library, sign in to it first (Settings > Jellyfin).";
  }
  useServer?.addEventListener("click", () => {
    if (!savedDesktopSession()) {
      if (modeStatus) modeStatus.textContent = "Sign in to the Jellyfin server first (Settings > Jellyfin), then come back here.";
      document.querySelector<HTMLButtonElement>("[data-settings-section=jellyfin]")?.click();
      return;
    }
    setLibraryMode("jellyfin");
    location.reload();
  });
  useFolder?.addEventListener("click", () => {
    setLibraryMode("folder");
    location.reload();
  });
}
const backdrop = initBackdrop(document.querySelector<HTMLElement>("#backdrop")!, () => tracks, () => flipInterval(ambient.motion()));
new MutationObserver(() => {
  backdrop.setPaused(!nowPlayingRoot.hidden);
  if (nowPlayingRoot.hidden) accent.setCover(null); // the chosen colour again outside Now Playing
}).observe(nowPlayingRoot, { attributes: true, attributeFilter: ["hidden"] });
const mediaDialog = initMediaDialog(document.querySelector<HTMLDialogElement>("#media-dialog")!, {
  beforeEdit: (paths) => player.stopIfPlaying(paths),
  afterEdit: (saved) => {
    nowPlaying.reloadLyrics();
    reviewPanels.mediaSaved(saved);
    void refreshLibrary("Pictures or lyrics were saved.");
  },
});
// The sample played by a "Listen" button: the defect sits at its midpoint (Settings: length, 8 seconds by default).
let listenSeconds = 8;
async function refreshListenSeconds(): Promise<void> {
  try {
    listenSeconds = (await invoke<{ seconds: number }>("get_listen_settings")).seconds;
  } catch {
    // keep the last known length
  }
}
void refreshListenSeconds();
function listenToDefect(queue: PlayableTrack[], index: number, defectMs: number): void {
  const window = snippetWindow(defectMs, listenSeconds);
  player.play(queue, index, window.start, window.stop);
}
const defectDialog = initDefectDialog(document.querySelector<HTMLDialogElement>("#scan-dialog")!, (queue, index, defectMs) => listenToDefect(queue, index, defectMs), () => {
  if (reviewHub.current() === "defects") reviewPanels.showDefects();
});
const flagStore = createFlagStore();
const flagDialog = initFlagDialog(document.querySelector<HTMLDialogElement>("#flag-dialog")!, flagStore);
const reviewPageElement = document.querySelector<HTMLElement>("#review-page")!;
const reviewPage = initReviewPage(reviewPageElement, flagStore, {
  play: (track, seconds) => player.play([track], 0, seconds),
  scan: (track) => defectDialog.open({ label: `“${track.title}”`, tracks: [track] }),
  scanMany: (list) => defectDialog.open({ label: `${list.length} flagged songs`, tracks: list }),
  lyrics: (track) => reviewPanels.openLyricsEditor(track),
  artwork: (track) => mediaDialog.open({ label: `“${track.title}”`, paths: [track.source_uri], song: { title: track.title, artist: track.artist, album: track.album ?? null } }),
});
const reviewPanels = initReviewPanels(
  {
    artwork: document.querySelector<HTMLElement>("#review-panel-artwork")!,
    lyrics: document.querySelector<HTMLElement>("#review-panel-lyrics")!,
    defects: document.querySelector<HTMLElement>("#review-panel-defects")!,
  },
  {
    libraryTracks: () => tracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album, source_uri: t.source_uri, album_artist: t.album_artist, release_year: t.release_year, track_number: t.track_number ?? null })),
    openAlbumPictures: (gap) =>
      mediaDialog.open({
        label: `the album “${gap.album}”`,
        paths: gap.albumMp3Paths ?? gap.mp3Paths,
        albumSearch: { artist: gap.albumArtist ?? gap.artist, album: gap.album, year: gap.year ?? null, tracks: gap.total },
      }),
    play: (queue, index) => player.play(queue, index),
    listenToDefect: (queue, index, defectMs) => listenToDefect(queue, index, defectMs),
    scanTracks: (list) => defectDialog.open({ label: `${list.length} songs`, tracks: list }),
    beforePictureEdit: (paths) => player.stopIfPlaying(paths),
    picturesChanged: () => {
      forgetCovers();
      void refreshLibrary("Pictures were saved.");
    },
    lyricsPlayer: {
      dialog: document.querySelector<HTMLDialogElement>("#lyrics-dialog")!,
      play: (track, seconds) => player.play([track], 0, seconds),
      pause: () => player.pause(),
      resume: () => player.resume(),
      seek: (seconds) => player.seek(seconds),
      setRate: (rate) => player.setRate(rate),
      state: () => player.state(),
      now: () => player.now(),
      onTime: (listener) => player.onTime(listener),
    },
    lyricsSaved: () => nowPlaying.reloadLyrics(),
    playlists: playlistStore,
    titlesChanged: (message) => void refreshLibrary(message),
  },
);
const fixTags = initFixTags(document.querySelector<HTMLElement>("#review-panel-fixtags")!, { songs: () => tracks });
const albumAlignPanel = initAlbumAlignPanel(document.querySelector<HTMLElement>("#review-panel-match")!, { changed: (message) => void refreshLibrary(message), stopIfPlaying: (paths) => player.stopIfPlaying(paths) });
const auditPanel = initAuditPanel(document.querySelector<HTMLElement>("#review-panel-audit")!, { songs: () => tracks });
const audioCheckPanel = initAudioCheckPanel(document.querySelector<HTMLElement>("#review-panel-ear")!, { changed: (message) => void refreshLibrary(message) });
const albumIdsPanel = initAlbumIdsPanel(document.querySelector<HTMLElement>("#review-panel-ids")!, { changed: (message) => void refreshLibrary(message) });
const artistsPanel = initArtistsPanel(document.querySelector<HTMLElement>("#review-panel-artists")!, {
  songs: () => tracks.map((t) => ({ album: t.album ?? null, album_artist: t.album_artist ?? null, artist: t.artist ?? null, genre: t.genre ?? null, release_year: t.release_year ?? null, title: t.title, source_uri: t.source_uri, track_number: t.track_number ?? null })),
  // Tags were rewritten on disk: the library is rescanned now and the page waits for it (the folder watcher would get there a little
  // later, and the list of names would show the old tags until the next click).
  changed: async (message) => {
    forgetCovers();
    try {
      const snapshot = await invoke<LibrarySnapshot>("rescan_collection");
      tracks = snapshot.tracks;
      renderPages();
      status.textContent = message;
    } catch {
      await refreshLibrary(message);
    }
  },
  stopIfPlaying: (paths) => player.stopIfPlaying(paths),
});
reviewPageElement.querySelector(".subnav")?.after(createSourceStatus());
const reviewHub = initReviewHub(reviewPageElement, {
  flagged: () => reviewPage.render(),
  fixtags: () => fixTags.show(),
  artists: () => artistsPanel.show(),
  ids: () => albumIdsPanel.show(),
  match: () => albumAlignPanel.show(),
  audit: () => auditPanel.show(),
  ear: () => audioCheckPanel.show(),
  artwork: () => reviewPanels.showArtwork(),
  lyrics: () => reviewPanels.showLyrics(),
  defects: () => reviewPanels.showDefects(),
});
const playerFlag = document.querySelector<HTMLButtonElement>("#player-flag")!;
function showFlagButton(): void {
  const now = player.now();
  const on = !!now && flagStore.index.has(now.track.source_uri);
  setIconButton(playerFlag, "flag", on ? "Flagged for review (change or remove the flag)" : "Flag this song for review", on);
  playerFlag.classList.toggle("is-on", on);
}
playerFlag.addEventListener("click", () => {
  const now = player.now();
  if (now) {
    player.pause();
    flagDialog.open(now.track, now.seconds);
  }
});
flagStore.onChange(() => {
  const badge = document.querySelector<HTMLElement>("#review-badge")!;
  const count = flagStore.index.all().length;
  badge.textContent = count > 0 ? `(${count})` : "";
  document.querySelector<HTMLElement>("#review-flag-count")!.textContent = count > 0 ? `(${count})` : "";
  showFlagButton();
  renderPages();
});
void flagStore.reload().catch(() => {});
// Settings > Jellyfin > Shared problem tracks (D96): flags from phones and TVs, and Done, through the server's playlists.
const problemSync = renderProblemSync(jellyfinSettings.syncRoot, {
  store: flagStore,
  library: () => tracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album, album_artist: t.album_artist, source_uri: t.source_uri, length_ms: t.length_ms })),
  playlists: () => playlistStore.all(),
  savePlaylist: async (playlist) => (await playlistStore.save(playlist)).id,
});
// A playlist changed here reaches the server (and so the TV) a few seconds later.
playlistStore.onChange(() => problemSync.scheduleSync());
// Favorites (D44): the heart in the player bar, the Favorites shelf on Home, a heart beside listed songs.
const favoriteStore = createFavoriteStore();
const favoriteButton = document.querySelector<HTMLButtonElement>("#player-favorite")!;
function showFavoriteButton(): void {
  const now = player.now();
  const on = !!now && favoriteStore.has(now.track.source_uri);
  setIconButton(favoriteButton, "heart", on ? "Favorite (click to remove)" : "Add to favorites", on);
  favoriteButton.setAttribute("aria-pressed", String(on));
  favoriteButton.classList.toggle("is-on", on);
}
favoriteButton.addEventListener("click", () => {
  const now = player.now();
  if (now) void favoriteStore.toggle(now.track.source_uri).catch(() => {});
});
player.onChange(showFavoriteButton);
player.onChange(showFlagButton);
showFavoriteButton();
showFlagButton();
favoriteStore.onChange(() => {
  showFavoriteButton();
  renderPages();
});
void favoriteStore.reload().catch(() => {});
// A paired TV flagged a song or changed a favorite.
window.mediaVerse?.listen("marks-changed", () => {
  void flagStore.reload().catch(() => {});
  void favoriteStore.reload().catch(() => {});
});
const gettingStarted = initGettingStarted(document.querySelector<HTMLElement>("#home-setup")!, () => {
  void settingsView.refresh();
  void invoke<LibrarySnapshot>("library_snapshot").then((snapshot) => {
    tracks = snapshot.tracks;
    renderPages();
  });
  void showCollectionRoot();
});
// First run: the dark welcome screen, once, while setup is not finished (D32).
if (!serverLibrary()) void showWelcomeIfNeeded(
  () => {
    void settingsView.refresh();
    void invoke<LibrarySnapshot>("library_snapshot").then((snapshot) => {
      tracks = snapshot.tracks;
      renderPages();
    });
    void showCollectionRoot();
  },
  () => void gettingStarted.render(),
);
const pinStore = createPinStore();
const homePageElement = document.querySelector<HTMLElement>("#home-page")!;
const homePage = initHomePage(homePageElement, {
  pins: pinStore,
  playlists: playlistStore,
  libraryTracks: () => tracks,
  libraryReady: () => libraryRead,
  flaggedCount: () => flagStore.index.all().length,
  favorites: () => favoriteStore.all(),
  play: (queue, index) => player.play(queue, index),
  enqueue: (queue, where) => player.enqueue(queue, where),
  openArtist: (artist) => {
    selectedArtist = artist;
    activePage = "artist";
    renderPages();
  },
  go: (page) => {
    document.querySelector<HTMLButtonElement>(`[data-page=${page}]`)?.click();
  },
});
// A play that has lasted long enough is added to the listening history (if it is switched on in Settings).
player.onPlayed((track) => {
  void invoke("record_play", { path: track.source_uri, title: track.title, artist: track.artist, album: track.album ?? null })
    .then(() => (activePage === "home" ? homePage.render() : undefined))
    .catch(() => {});
});
pinStore.onChange(() => renderPages());
void pinStore.reload().catch(() => {});
const driveSetup = initDriveSetup(drivesPage);
const ripPageElement = document.querySelector<HTMLElement>("#rip-page")!;
const ripPage = initRipPage(ripPageElement);
const settingsPage = document.querySelector<HTMLElement>("#settings-page")!;
settingsPage.addEventListener("listen-seconds-changed", () => void refreshListenSeconds());
const settingsView = initSettingsPage(settingsPage);
// The settings form is never submitted (Enter in a field would reload the page); this replaces an inline
// onsubmit attribute, which the Content Security Policy does not allow.
document.querySelector("#settings-form")?.addEventListener("submit", (event) => event.preventDefault());
// Settings > Tags & files: convert to MP3, one ID3 version. Changed files are read again by the folder watcher;
// the covers may have moved with them, so the remembered ones are forgotten.
const tagTools = initTagTools(document.querySelector<HTMLElement>("#settings-tags")!, () => forgetCovers());
const issueCountElement = document.querySelector<HTMLElement>("#issue-count")!;
const issueList = document.querySelector<HTMLUListElement>("#issue-list")!;
// The tag-issue list is drawn only on screen (see renderIssuesPage); draw it when it comes into view.
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && issuesNeedDrawing) renderIssuesPage();
}).observe(issueList.closest<HTMLElement>(".review-panel") ?? issueList.parentElement ?? issueList);
const navigationButtons = document.querySelectorAll<HTMLButtonElement>(".nav-button");
const tagEditor = document.querySelector<HTMLDialogElement>("#tag-editor")!;
const tagEditorForm = document.querySelector<HTMLFormElement>("#tag-editor-form")!;
const tagEditorPath = document.querySelector<HTMLElement>("#tag-editor-path")!;
const titleEditor = document.querySelector<HTMLInputElement>("#edit-title")!;
const artistEditor = document.querySelector<HTMLInputElement>("#edit-artist")!;
const albumEditor = document.querySelector<HTMLInputElement>("#edit-album")!;
const albumArtistEditor = document.querySelector<HTMLInputElement>("#edit-album-artist")!;
const genreEditor = document.querySelector<HTMLInputElement>("#edit-genre")!;
const releaseYearEditor = document.querySelector<HTMLInputElement>("#edit-release-year")!;
const trackNumberEditor = document.querySelector<HTMLInputElement>("#edit-track-number")!;
const cancelTagEditButton = document.querySelector<HTMLButtonElement>("#cancel-tag-edit")!;
const artistOptionsToggle = document.querySelector<HTMLButtonElement>("#artist-options-toggle")!;
const albumArtistOptionsToggle = document.querySelector<HTMLButtonElement>("#album-artist-options-toggle")!;
const albumOptionsToggle = document.querySelector<HTMLButtonElement>("#album-options-toggle")!;
const genreOptionsToggle = document.querySelector<HTMLButtonElement>("#genre-options-toggle")!;
const releaseYearOptionsToggle = document.querySelector<HTMLButtonElement>("#release-year-options-toggle")!;
const artistOptionsMenu = document.querySelector<HTMLElement>("#artist-options-menu")!;
const albumArtistOptionsMenu = document.querySelector<HTMLElement>("#album-artist-options-menu")!;
const albumOptionsMenu = document.querySelector<HTMLElement>("#album-options-menu")!;
const genreOptionsMenu = document.querySelector<HTMLElement>("#genre-options-menu")!;
const releaseYearOptionsMenu = document.querySelector<HTMLElement>("#release-year-options-menu")!;
const compilationBox = document.querySelector<HTMLInputElement>("#edit-compilation")!;
const batchNote = document.querySelector<HTMLElement>("#edit-batch-note")!;
const issueTools = document.querySelector<HTMLElement>("#issue-tools")!;
let batchTracks: Track[] | null = null; // set while one edit is applied to several selected tracks
let initiallyCompilation = false;
let issueGroupMode: GroupMode = "problem";
const selectedIssues = new Set<string>();
let trackBeingEdited: Track | null = null;
let tagEditorChoices: TagEditorChoices | null = null;
let tracks: Track[] = [];
/** Set once the library has been read for the first time (until then Home does not say the library is empty). */
let libraryRead = false;
let selectedArtist: string | null = null;
let activePage: "artist" | "home" | "library" | "review" | "rip" | "settings" = "home";

if (!chooseFolderButton || !rescanButton || !collectionRootElement || !statusElement || !libraryPage || !artistPage || !issueCountElement || !issueList || !tagEditor || !tagEditorForm || !tagEditorPath || !titleEditor || !artistEditor || !albumEditor || !albumArtistEditor || !genreEditor || !releaseYearEditor || !trackNumberEditor || !cancelTagEditButton || !artistOptionsToggle || !albumArtistOptionsToggle || !albumOptionsToggle || !genreOptionsToggle || !releaseYearOptionsToggle || !artistOptionsMenu || !albumArtistOptionsMenu || !albumOptionsMenu || !genreOptionsMenu || !releaseYearOptionsMenu) {
  throw new Error("The MediaVerse Studio page is missing required controls.");
}

const collectionRoot = collectionRootElement;
const status = statusElement;

function suggestionValue(track: Track, label: string): string | null {
  const suggestion = track.suggestions.find((value) => value.startsWith(`${label}: `));
  return suggestion?.slice(label.length + 2) ?? null;
}

function displayArtist(track: Track): string {
  return track.album_artist ?? track.artist ?? "Unknown artist";
}

function sortTracks(left: Track, right: Track): number {
  if (left.track_number !== null && right.track_number !== null) {
    return left.track_number - right.track_number;
  }
  if (left.track_number !== null) return -1;
  if (right.track_number !== null) return 1;
  return left.title.localeCompare(right.title);
}

function toPlayable(track: Pick<Track, "title" | "artist" | "source_uri" | "album">): PlayableTrack {
  return { title: track.title, artist: track.artist, source_uri: track.source_uri, album: track.album };
}

function createTrackItem(track: Track, showSource: boolean, queue: Track[] = [track], selectable = false): HTMLLIElement {
  const item = document.createElement("li");
  if (selectable) {
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.className = "issue-pick";
    pick.checked = selectedIssues.has(track.id);
    pick.setAttribute("aria-label", `Select ${track.title}`);
    pick.addEventListener("change", () => {
      if (pick.checked) selectedIssues.add(track.id);
      else selectedIssues.delete(track.id);
      updateSelectionButton();
    });
    item.append(pick);
  }
  const title = document.createElement("strong");
  const metadata = document.createElement("span");
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play-button";
  playButton.textContent = "▶ Play";
  playButton.setAttribute("aria-label", `Play ${track.title}`);
  playButton.addEventListener("click", () => player.play(queue.map(toPlayable), Math.max(queue.indexOf(track), 0)));
  item.append(playButton);
  if (flagStore.index.has(track.source_uri)) {
    const flagged = document.createElement("span");
    flagged.className = "flagged-mark";
    flagged.textContent = "⚑ Flagged for review";
    item.append(flagged);
  }
  if (favoriteStore.has(track.source_uri)) {
    const heart = document.createElement("span");
    heart.className = "favorite-mark";
    heart.textContent = "♥";
    heart.title = "Favorite";
    item.append(heart);
  }
  if (/\.mp3$/i.test(track.source_uri)) {
    const mediaButton = document.createElement("button");
    mediaButton.type = "button";
    mediaButton.className = "secondary";
    mediaButton.textContent = "Artwork…";
    mediaButton.addEventListener("click", () =>
      mediaDialog.open({ label: `“${track.title}”`, paths: [track.source_uri], song: { title: track.title, artist: track.artist, album: track.album, length_ms: track.length_ms } }),
    );
    item.append(mediaButton);
    const lyricsButton = document.createElement("button");
    lyricsButton.type = "button";
    lyricsButton.className = "secondary";
    lyricsButton.textContent = "Lyrics…";
    lyricsButton.addEventListener("click", () => reviewPanels.openLyricsEditor(toPlayable(track)));
    item.append(lyricsButton);
  }
  if (/\.(mp3|flac|wav)$/i.test(track.source_uri)) {
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.className = "secondary";
    scanButton.textContent = "Scan for defects…";
    scanButton.addEventListener("click", () => defectDialog.open({ label: `“${track.title}”`, tracks: [toPlayable(track)] }));
    item.append(scanButton);
  }

  title.textContent = track.track_number
    ? `${String(track.track_number).padStart(2, "0")}. ${track.title}`
    : track.title;
  metadata.textContent = [track.artist, track.release_year?.toString(), track.genre].filter(Boolean).join(" — ");
  item.append(title);
  if (metadata.textContent) {
    item.append(metadata);
  }
  if (showSource) {
    const source = document.createElement("span");
    source.textContent = track.source_uri;
    item.append(source);
  }
  for (const suggestion of track.suggestions) {
    const suggestionItem = document.createElement("span");
    suggestionItem.className = "suggestion";
    suggestionItem.textContent = suggestion;
    item.append(suggestionItem);
  }
  if (track.suggestions.length > 0) {
    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    reviewButton.textContent = "Review and save tags";
    reviewButton.addEventListener("click", () => openTagEditor(track));
    item.append(reviewButton);
  }
  // The buttons share one row instead of each taking a line of its own.
  const buttons = [...item.querySelectorAll(":scope > button")];
  if (buttons.length > 0) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(...buttons);
    item.append(actions);
  }
  return item;
}

// The Library (D52): the artist wall and an artist's songs, in library-view.ts.
const libraryView = initLibraryView(libraryPage, artistPage, {
  songs: () => tracks,
  openArtist: (name) => {
    selectedArtist = name;
    activePage = "artist";
    renderPages();
    window.scrollTo({ top: 0 });
  },
  back: () => {
    activePage = "library";
    selectedArtist = null;
    renderPages();
  },
  play: (queue, index) => player.play(queue.map(toPlayable), index),
  coverUrl,
  artistPhotoUrl,
  editTags: (selected) => (selected.length === 1 ? openTagEditor(selected[0] as Track) : openBatchEditor(selected as Track[])),
  lyrics: (song) => reviewPanels.openLyricsEditor(toPlayable(song)),
  pictures: (selected) =>
    mediaDialog.open({ label: `“${selected[0].title}”`, paths: [selected[0].source_uri], song: { title: selected[0].title, artist: selected[0].artist, album: selected[0].album, length_ms: selected[0].length_ms } }),
  albumPictures: (album, songs) =>
    mediaDialog.open({
      label: `the album “${album}”`,
      paths: songs.map((song) => song.source_uri).filter((path) => /\.mp3$/i.test(path)),
      albumSearch: {
        artist: songs.find((t) => t.album_artist)?.album_artist ?? songs[0]?.artist ?? null,
        album: songs[0]?.album ?? album,
        year: songs.find((t) => t.release_year)?.release_year ?? null,
        tracks: songs.length,
      },
    }),
  scan: (selected) => defectDialog.open({ label: selected.length === 1 ? `“${selected[0].title}”` : `${selected.length} songs`, tracks: selected.map(toPlayable) }),
  isFavorite: (path) => favoriteStore.has(path),
  setFavorite: (paths, on) => {
    for (const path of paths) if (favoriteStore.has(path) !== on) void favoriteStore.toggle(path).catch(() => {});
  },
  isFlagged: (path) => flagStore.index.has(path),
  flag: (track) => flagDialog.open(toPlayable(track), 0),
  isPinned: (songs) => pinStore.has(folderOf(songs[0].source_uri)),
  enqueue: (songs, where) => player.enqueue(songs.map(toPlayable), where),
  showInFolder: (path) => showInFolder(path),
  togglePin: (album, songs) => void pinStore.toggle(folderOf(songs[0].source_uri), album, displayArtist(songs[0] as Track)).catch(() => {}),
  playlists: playlistStore,
});

/**
 * Right-click on the song that is playing (the player bar, and the cover, title and artist on Now Playing): edit its tags, its artwork or its lyrics
 * (owner, 2026-11-24). The same editors as the library's menu; with only the Jellyfin server as the library there is no file to edit, so there is no menu.
 */
function playingSongMenu(event: MouseEvent): void {
  if (serverLibrary()) return;
  const view = player.view();
  const now = view.tracks[view.current];
  if (!now) return;
  event.preventDefault();
  const song = tracks.find((t) => t.source_uri === now.source_uri);
  const mp3 = /\.mp3$/i.test(now.source_uri);
  openMenu(
    event.clientX,
    event.clientY,
    [
      { label: "Edit tags…", action: () => song && openTagEditor(song), disabled: !song },
      {
        label: "Edit artwork…",
        action: () => mediaDialog.open({ label: `“${now.title}”`, paths: [now.source_uri], song: { title: now.title, artist: now.artist, album: now.album ?? null, length_ms: song?.length_ms } }),
        disabled: !mp3,
      },
      { label: "Edit lyrics…", action: () => reviewPanels.openLyricsEditor(now), disabled: !mp3 },
    ],
    now.title,
  );
}
for (const selector of ["#player-expand", "#np-cover", "#np-title", "#np-artist", "#np-album"]) {
  document.querySelector<HTMLElement>(selector)?.addEventListener("contextmenu", playingSongMenu);
}

function updateSelectionButton(): void {
  const button = issueTools.querySelector<HTMLButtonElement>(".issue-edit-selected");
  if (!button) return;
  button.textContent = `Edit ${selectedIssues.size} selected…`;
  button.disabled = selectedIssues.size === 0;
}

/** Tracks shown at a time inside an opened group, and groups shown at a time. */
const ISSUE_PAGE = 50;
const GROUPS_PAGE = 100;
/** Opened groups ("mode:label") and how many of their tracks are shown. */
const openIssueGroups = new Map<string, number>();
let issueGroupsShown = GROUPS_PAGE;
/** Set when the list changed while it was off screen; it is drawn when it comes into view. */
let issuesNeedDrawing = true;

function renderIssuesPage(): void {
  const issues = tracks.filter((track) => track.suggestions.length > 0).sort(sortTracks);
  const libraryIds = new Set(tracks.map((t) => t.id));
  for (const id of [...selectedIssues]) if (!libraryIds.has(id)) selectedIssues.delete(id);
  issueCountElement.textContent = `${issues.length} track${issues.length === 1 ? "" : "s"} need review`;
  const issueBadge = document.querySelector<HTMLElement>("#issue-badge");
  if (issueBadge) issueBadge.textContent = issues.length > 0 ? `(${issues.length})` : "";

  // Tools: how to group, and an edit button for the ticked tracks.
  issueTools.replaceChildren();
  const groupLabel = document.createElement("label");
  groupLabel.textContent = "Group by ";
  const groupSelect = document.createElement("select");
  for (const mode of GROUP_MODES) {
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = mode.label;
    groupSelect.append(option);
  }
  groupSelect.value = issueGroupMode;
  groupSelect.addEventListener("change", () => {
    issueGroupMode = groupSelect.value as GroupMode;
    issueGroupsShown = GROUPS_PAGE;
    renderIssuesPage();
  });
  groupLabel.append(groupSelect);
  const editSelected = document.createElement("button");
  editSelected.type = "button";
  editSelected.className = "issue-edit-selected";
  editSelected.addEventListener("click", () => openBatchEditor(tracks.filter((t) => selectedIssues.has(t.id))));
  issueTools.append(groupLabel, editSelected);
  updateSelectionButton();

  // Drawing tens of thousands of rows is what made large libraries slow (D32, Phase B): the list is drawn
  // only while it is on screen, groups start closed, and long lists are shown a page at a time.
  if (issueList.offsetParent === null) {
    issuesNeedDrawing = true;
    return;
  }
  issuesNeedDrawing = false;
  issueList.replaceChildren();
  // Suspected albums look at the whole library: an album split by inconsistent tags often has nothing missing.
  const suspectMode = issueGroupMode === "suspected_album";
  const groups: (TrackGroup & { proposal?: SuspectedAlbum["proposal"] })[] = suspectMode ? suspectedAlbums(tracks) : groupTracks(issues, issueGroupMode);
  if (suspectMode) issueCountElement.textContent = `${groups.length} suspected album${groups.length === 1 ? "" : "s"} with tags that disagree`;
  if (groups.length === 0) {
    const item = document.createElement("li");
    item.textContent = suspectMode ? "No albums with disagreeing tags were found." : "No tag issues are currently flagged.";
    issueList.append(item);
    return;
  }
  for (const group of groups.slice(0, issueGroupsShown)) {
    const header = document.createElement("li");
    header.className = "issue-group";
    const all = document.createElement("input");
    all.type = "checkbox";
    all.setAttribute("aria-label", `Select all ${group.tracks.length} tracks in ${group.label}`);
    all.checked = group.tracks.every((t) => selectedIssues.has(t.id));
    all.addEventListener("change", () => {
      for (const t of group.tracks) {
        if (all.checked) selectedIssues.add(t.id);
        else selectedIssues.delete(t.id);
      }
      renderIssuesPage();
    });
    const title = document.createElement("strong");
    title.textContent = `${group.label} (${group.tracks.length})`;
    const editGroup = document.createElement("button");
    editGroup.type = "button";
    editGroup.className = "secondary";
    editGroup.textContent = "Edit this group…";
    editGroup.addEventListener("click", () => openBatchEditor(group.tracks, group.proposal));
    const key = `${issueGroupMode}:${group.label}`;
    const shown = openIssueGroups.get(key) ?? 0;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary";
    toggle.textContent = shown > 0 ? "Hide tracks" : "Show tracks";
    toggle.setAttribute("aria-expanded", String(shown > 0));
    toggle.addEventListener("click", () => {
      if (shown > 0) openIssueGroups.delete(key);
      else openIssueGroups.set(key, ISSUE_PAGE);
      renderIssuesPage();
    });
    header.append(all, title, editGroup, toggle);
    issueList.append(header);
    if (shown > 0) {
      issueList.append(...group.tracks.slice(0, shown).map((track) => createTrackItem(track, true, [track], true)));
      if (group.tracks.length > shown) {
        issueList.append(moreButton(`Show ${Math.min(ISSUE_PAGE, group.tracks.length - shown)} more of ${group.tracks.length - shown} left`, () => openIssueGroups.set(key, shown + ISSUE_PAGE)));
      }
    }
  }
  if (groups.length > issueGroupsShown) {
    issueList.append(moreButton(`Show more groups (${groups.length - issueGroupsShown} left)`, () => (issueGroupsShown += GROUPS_PAGE)));
  }
}

/** A "show more" row for the tag-issue list; `grow` widens what is shown, then the list is drawn again. */
function moreButton(label: string, grow: () => void): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "issue-more";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = label;
  button.addEventListener("click", () => {
    grow();
    renderIssuesPage();
  });
  item.append(button);
  return item;
}
function renderPages(): void {
  timed("backdrop.refresh", () => backdrop.refresh());
  timed("renderIssuesPage", () => renderIssuesPage());
  if (activePage === "artist" && !(selectedArtist && libraryView.renderArtist(selectedArtist))) {
    selectedArtist = null;
    activePage = "library";
  }
  if (activePage === "library") timed("library wall", () => libraryView.renderWall());
  // Pages can style themselves (the library darkens the collage behind it).
  document.body.dataset.page = activePage;
  homePageElement.hidden = activePage !== "home";
  if (activePage === "home") {
    timed("gettingStarted.render", () => void gettingStarted.render());
    timed("homePage.render (sync part)", () => void homePage.render());
  }
  libraryPage.hidden = activePage !== "library";
  artistPage.hidden = activePage !== "artist";
  ripPageElement.hidden = activePage !== "rip";
  reviewPageElement.hidden = activePage !== "review";
  settingsPage.hidden = activePage !== "settings";
  for (const button of navigationButtons) {
    button.classList.toggle("is-active", button.dataset.page === activePage);
  }
}

type ChoiceControl = {
  input: HTMLInputElement;
  menu: HTMLElement;
  toggle: HTMLButtonElement;
};

const artistChoice: ChoiceControl = { input: artistEditor, menu: artistOptionsMenu, toggle: artistOptionsToggle };
const albumArtistChoice: ChoiceControl = { input: albumArtistEditor, menu: albumArtistOptionsMenu, toggle: albumArtistOptionsToggle };
const albumChoice: ChoiceControl = { input: albumEditor, menu: albumOptionsMenu, toggle: albumOptionsToggle };
const genreChoice: ChoiceControl = { input: genreEditor, menu: genreOptionsMenu, toggle: genreOptionsToggle };
const releaseYearChoice: ChoiceControl = { input: releaseYearEditor, menu: releaseYearOptionsMenu, toggle: releaseYearOptionsToggle };
const choiceControls = [artistChoice, albumArtistChoice, albumChoice, genreChoice, releaseYearChoice];

function closeChoiceMenus(): void {
  for (const control of choiceControls) {
    control.menu.hidden = true;
    control.toggle.setAttribute("aria-expanded", "false");
  }
}

function replaceChoiceOptions(control: ChoiceControl, values: readonly string[]): void {
  const options = [...new Set(values)];
  control.toggle.disabled = options.length === 0;
  control.menu.replaceChildren(
    ...options.map((value) => {
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = value;
      option.addEventListener("click", () => {
        control.input.value = value;
        control.input.dispatchEvent(new Event("input"));
        closeChoiceMenus();
      });
      return option;
    }),
  );
}

function refreshScopedAlbumOptions(): void {
  if (!tagEditorChoices) return;

  const albumArtist = (albumArtistEditor.value.trim() || artistEditor.value.trim()).toLocaleLowerCase();
  const album = albumEditor.value.trim().toLocaleLowerCase();
  const scopedAlbums = tagEditorChoices.albums.filter(
    (choice) => choice.album_artist.toLocaleLowerCase() === albumArtist,
  );

  replaceChoiceOptions(albumChoice, scopedAlbums.map((choice) => choice.album));
  replaceChoiceOptions(
    releaseYearChoice,
    scopedAlbums
      .filter((choice) => !album || choice.album.toLocaleLowerCase() === album)
      .flatMap((choice) => (choice.release_year === null ? [] : [choice.release_year.toString()])),
  );
}

function applyTagEditorChoices(): void {
  if (!tagEditorChoices) return;

  replaceChoiceOptions(artistChoice, tagEditorChoices.artists);
  replaceChoiceOptions(albumArtistChoice, tagEditorChoices.artists);
  replaceChoiceOptions(genreChoice, tagEditorChoices.genres);
  refreshScopedAlbumOptions();
}

async function loadTagEditorChoices(): Promise<void> {
  try {
    tagEditorChoices = await invoke<TagEditorChoices>("tag_editor_choices_command");
    applyTagEditorChoices();
  } catch (error) {
    const apiError = error as ApiError;
    status.textContent = apiError.message ?? "Known tag values could not be loaded.";
  }
}

function setCompilationState(checked: boolean): void {
  compilationBox.checked = checked;
  albumArtistEditor.readOnly = checked;
  if (checked) albumArtistEditor.value = VARIOUS_ARTISTS;
}

compilationBox.addEventListener("change", () => {
  setCompilationState(compilationBox.checked);
  refreshScopedAlbumOptions();
});

/** Opens the editor for several selected tracks at once: shared values are filled in, differing ones left blank. */
/** Opens the tag editor for several tracks. `prefill` (from a suspected album) fills each album-wide field with
 * the value most of its tracks have, so one save makes the album consistent. */
function openBatchEditor(selected: Track[], prefill?: SuspectedAlbum["proposal"]): void {
  if (selected.length === 0) return;
  batchTracks = selected;
  trackBeingEdited = selected[0];
  const shared = (label: string, current: (track: Track) => string | null): string =>
    commonValue(selected, (t) => batchSuggestion(t, label) ?? current(t)) ?? "";
  tagEditorPath.textContent = `${selected.length} selected tracks`;
  titleEditor.value = "";
  artistEditor.value = shared("Suggested artist", (t) => t.artist);
  albumEditor.value = shared("Suggested album", (t) => t.album);
  albumArtistEditor.value = shared("Suggested album artist", (t) => t.album_artist);
  genreEditor.value = shared("Suggested genre", (t) => t.genre);
  releaseYearEditor.value = shared("Suggested release year", (t) => t.release_year?.toString() ?? null);
  trackNumberEditor.value = "";
  if (prefill) {
    albumEditor.value = prefill.album;
    albumArtistEditor.value = prefill.album_artist;
    releaseYearEditor.value = prefill.release_year;
    genreEditor.value = prefill.genre;
  }
  initiallyCompilation = selected.every((t) => isVariousArtists(batchSuggestion(t, "Suggested album artist") ?? t.album_artist));
  setCompilationState(initiallyCompilation);
  batchNote.hidden = false;
  batchNote.textContent = "Fields you leave blank keep each track's own value. Titles and track numbers are not changed by a batch edit.";
  for (const label of tagEditorForm.querySelectorAll<HTMLLabelElement>("label")) {
    if (["edit-title", "edit-track-number"].includes(label.htmlFor) || label.querySelector("#edit-title, #edit-track-number")) label.hidden = true;
  }
  titleEditor.required = false;
  applyTagEditorChoices();
  tagEditor.showModal();
  void loadTagEditorChoices();
}

function leaveBatchMode(): void {
  batchTracks = null;
  batchNote.hidden = true;
  titleEditor.required = true;
  for (const label of tagEditorForm.querySelectorAll<HTMLLabelElement>("label")) label.hidden = false;
}

function openTagEditor(track: Track): void {
  leaveBatchMode();
  trackBeingEdited = track;
  tagEditorPath.textContent = track.source_uri;
  titleEditor.value = suggestionValue(track, "Suggested title") ?? track.title;
  artistEditor.value = suggestionValue(track, "Suggested artist") ?? track.artist ?? "";
  albumEditor.value = suggestionValue(track, "Suggested album") ?? track.album ?? "";
  albumArtistEditor.value = suggestionValue(track, "Suggested album artist") ?? track.album_artist ?? "";
  genreEditor.value = track.genre ?? "";
  releaseYearEditor.value = track.release_year?.toString() ?? "";
  trackNumberEditor.value = suggestionValue(track, "Suggested track number") ?? track.track_number?.toString() ?? "";
  initiallyCompilation = isVariousArtists(albumArtistEditor.value);
  setCompilationState(initiallyCompilation);
  applyTagEditorChoices();
  tagEditor.showModal();
  void loadTagEditorChoices();
}

cancelTagEditButton.addEventListener("click", () => {
  tagEditor.close();
  leaveBatchMode();
});
artistEditor.addEventListener("input", refreshScopedAlbumOptions);
albumArtistEditor.addEventListener("input", refreshScopedAlbumOptions);
albumEditor.addEventListener("input", refreshScopedAlbumOptions);
for (const control of choiceControls) {
  control.toggle.addEventListener("click", () => {
    const shouldOpen = control.menu.hidden;
    closeChoiceMenus();
    control.menu.hidden = !shouldOpen;
    control.toggle.setAttribute("aria-expanded", shouldOpen.toString());
  });
}
for (const button of navigationButtons) {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    if (page === "home" || page === "library" || page === "rip" || page === "review" || page === "settings") {
      activePage = page;
      renderPages();
      if (page === "rip") {
        void driveSetup.refresh();
        void ripPage.refresh();
      }
      if (page === "review") {
        reviewHub.show(reviewHub.current());
      }
      if (page === "home") {
        void homePage.render();
      }
      if (page === "settings") {
        void settingsView.refresh();
        void tagTools.refresh();
      }
    }
  });
}

/** The compilation flag to send: set when ticked, removed when it was ticked and now is not, otherwise untouched. */
function compilationToSend(): boolean | undefined {
  return compilationBox.checked ? true : initiallyCompilation ? false : undefined;
}

async function saveBatch(selected: Track[]): Promise<void> {
  const requests = batchRequests(selected, {
    artist: artistEditor.value,
    album: albumEditor.value,
    album_artist: albumArtistEditor.value,
    genre: genreEditor.value,
    release_year: releaseYearEditor.value,
    compilation: compilationToSend(),
  });
  let lastSnapshot: LibrarySnapshot | null = null;
  let failed = 0;
  for (const [index, request] of requests.entries()) {
    status.textContent = `Writing tag changes… ${index + 1} of ${requests.length}`;
    try {
      lastSnapshot = await invoke<LibrarySnapshot>("write_track_tags", { request });
    } catch {
      failed += 1;
    }
  }
  if (lastSnapshot) {
    tracks = lastSnapshot.tracks;
    selectedIssues.clear();
    renderPages();
  }
  status.textContent = failed === 0 ? `Tag changes saved on ${requests.length} tracks.` : `Saved on ${requests.length - failed} of ${requests.length} tracks; ${failed} could not be written.`;
  tagEditor.close();
  leaveBatchMode();
  trackBeingEdited = null;
}

tagEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!trackBeingEdited) return;
  if (batchTracks) {
    await saveBatch(batchTracks);
    return;
  }
  const parsedTrackNumber = trackNumberEditor.value === "" ? null : Number(trackNumberEditor.value);
  const parsedReleaseYear = releaseYearEditor.value === "" ? null : Number(releaseYearEditor.value);
  if (parsedTrackNumber !== null && (!Number.isInteger(parsedTrackNumber) || parsedTrackNumber < 1)) {
    status.textContent = "Track number must be a positive whole number.";
    return;
  }
  if (parsedReleaseYear !== null && (!Number.isInteger(parsedReleaseYear) || parsedReleaseYear < 1)) {
    status.textContent = "Release year must be a positive whole number.";
    return;
  }

  try {
    status.textContent = "Writing tag changes…";
    const snapshot = await invoke<LibrarySnapshot>("write_track_tags", {
      request: {
        album: albumEditor.value.trim() || null,
        album_artist: albumArtistEditor.value.trim() || null,
        artist: artistEditor.value.trim() || null,
        genre: genreEditor.value.trim() || null,
        release_year: parsedReleaseYear,
        source_uri: trackBeingEdited.source_uri,
        title: titleEditor.value.trim() || null,
        track_number: parsedTrackNumber,
        ...(compilationToSend() === undefined ? {} : { compilation: compilationToSend() }),
      },
    });
    tracks = snapshot.tracks;
    renderPages();
    status.textContent = "Tag changes saved and library rescanned.";
    tagEditor.close();
    trackBeingEdited = null;
  } catch (error) {
    const apiError = error as ApiError;
    status.textContent = apiError.message ?? "The tag changes could not be saved.";
  }
});

async function showCollectionRoot(): Promise<void> {
  try {
    const collection = await invoke<CollectionStatus>("collection_status");
    collectionRoot.textContent = collection.root ?? "No folder selected.";
  } catch {
    // The folder name is only a label; the library itself is unaffected.
  }
}

async function refreshLibrary(message?: string): Promise<void> {
  if (message) problemSync.rescanSoon(); // something was saved: the Jellyfin server is asked to look at the files again
  const snapshot = await invoke<LibrarySnapshot>("library_snapshot");
  tracks = snapshot.tracks;
  libraryRead = true;
  renderPages();
  status.textContent =
    message ??
    `${snapshot.tracks.length} track${snapshot.tracks.length === 1 ? "" : "s"} in your library.`;
}

chooseFolderButton.addEventListener("click", async () => {
  const folder = await open({
    directory: true,
    multiple: false,
    title: "Choose your music collection",
  });

  if (typeof folder !== "string") {
    return;
  }

  chooseFolderButton.disabled = true;
  status.textContent = "Importing your music collection…";

  try {
    const imported = await invoke<CollectionImport>("import_collection", { root: folder });
    collectionRoot.textContent = imported.root;
    const metadataWarning =
      imported.metadata_failures > 0
        ? ` ${imported.metadata_failures} file${imported.metadata_failures === 1 ? "" : "s"} could not be read; those entries use their file names.`
        : "";
    const missingTitleWarning =
      imported.filename_title_fallbacks > 0
        ? ` ${imported.filename_title_fallbacks} file${imported.filename_title_fallbacks === 1 ? "" : "s"} did not contain a title tag; those entries use their file names.`
        : "";
    tracks = imported.tracks;
    renderPages();
    status.textContent = `${imported.track_count} track${imported.track_count === 1 ? "" : "s"} imported. This folder is now monitored for changes.${metadataWarning}${missingTitleWarning}`;
  } catch (error) {
    const apiError = error as ApiError;
    status.textContent = apiError.message ?? "The music collection could not be imported.";
  } finally {
    chooseFolderButton.disabled = false;
  }
});

rescanButton.addEventListener("click", async () => {
  status.textContent = "Rescanning your music collection…";
  try {
    const snapshot = await invoke<LibrarySnapshot>("rescan_collection");
    tracks = snapshot.tracks;
    renderPages();
    void showCollectionRoot();
    const reviewCount = snapshot.tracks.filter((track) => track.suggestions.length > 0).length;
    status.textContent =
      reviewCount > 0
        ? `Your music collection was rescanned. ${reviewCount} track${reviewCount === 1 ? "" : "s"} need review.`
        : "Your music collection was rescanned.";
  } catch (error) {
    const apiError = error as ApiError;
    status.textContent = apiError.message ?? "The music collection could not be rescanned.";
  }
});

listen<LibrarySnapshot>("library-updated", (event) => {
  if (serverLibrary()) return; // the music folder's changes are not this library's
  tracks = event.payload.tracks;
  renderPages();
  artistsPanel.refresh(); // the Artist names list reads the library
  void showCollectionRoot();
  status.textContent = "Your music collection was updated.";
}).catch((error: ApiError) => {
  status.textContent = error.message ?? "The music collection monitor could not start.";
});

listen<ApiError>("collection-sync-failed", (event) => {
  status.textContent = event.payload.message;
}).catch(() => {
  status.textContent = "The music collection monitor could not start.";
});

Promise.all([invoke<CollectionStatus>("collection_status"), refreshLibrary()])
  .then(([collection]) => {
    collectionRoot.textContent = collection.root ?? "No folder selected.";
  })
  .catch((error: ApiError) => {
    libraryRead = true; // nothing more to wait for: Home may say what it has
    renderPages();
    status.textContent = error.message ?? "The library could not be loaded.";
  });


