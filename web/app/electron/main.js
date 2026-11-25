const { attach: attachEditMenu } = require("./edit-menu");
const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, shell } = require("electron");
const { setupMediaControls } = require("./media-setup");
const { isAllowedExternal } = require("./external-links");
const { seedPage } = require("./musicbrainz-seed");
const { initialBounds, manageWindowState, MIN_SIZE } = require("./window-state");
const { createDlna } = require("./dlna");
const { createGoogleCast } = require("./googlecast");

/** DLNA casting (D77) and Google Cast (D80): the same commands; Google Cast devices have ids starting "cast:". */
const dlna = createDlna({ log: (message) => console.warn(message) });
const googleCast = createGoogleCast({ log: (message) => console.warn(message) });
const casterFor = (id) => (String(id).startsWith("cast:") ? googleCast : dlna);
/** Settings > Jellyfin (D90). Installing is left to Jellyfin's own installer, from its official download page. */
const { createJellyfinHelper } = require("./jellyfin");
const { homeHttp } = require("./home-http");
const { createJellyfinStream, songIdOf } = require("./jellyfin-stream");
const jellyfin = createJellyfinHelper({ log: (message) => console.warn(message) });
/** Songs of a Jellyfin server played and cast when the server alone is the library (D173). */
const jellyfinStream = createJellyfinStream();
const JELLYFIN_DOWNLOAD_PAGE = "https://jellyfin.org/downloads/windows";
const { pathToFileURL } = require("node:url");
const { resolveAllowedAudio, mimeTypeFor } = require("./media-access");
const { createLibraryShare, parseRange } = require("./library-share");
const firewall = require("./firewall");
const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");

// A fixed name gives a stable per-user data folder (%APPDATA%\MediaVerse Studio) whether the app is
// run from source or installed. Must happen before anything asks for a data path.
app.setName("MediaVerse Studio");
// Optional: run with a different data folder (used by tools/start-mediaverse.ps1 -Fresh).
if (process.env.MEDIAVERSE_USER_DATA) {
  app.setPath("userData", process.env.MEDIAVERSE_USER_DATA);
}
const { SidecarClient, resolveSidecarPath } = require("./sidecar");
const { toEnvelope } = require("./ipc-envelope");

const allowedCommands = new Set([
  "calibrate_drive",
  "cancel_job",
  "collection_status",
  "get_archive_settings",
  "get_metadata_settings",
  "import_collection",
  "library_snapshot",
  "list_drive_profiles",
  "drive_history",
  "disc_probe",
  "submit_gnudb",
  "search_albums",
  "clear_drive_history",
  "list_drives",
  "lookup_disc",
  "rescan_collection",
  "rip_disc",
  "set_archive_dir",
  "set_archive_enabled",
  "track_cover",
  "track_artist_photo",
  "rename_artist",
  "scan_mb_ids",
  "scan_album_align",
  "find_wiki_photos",
  "check_artist_names",
  "cover_preview",
  "canonical_artist_names",
  "write_wiki_photos",
  "list_wiki_photos",
  "align_album",
  "undo_album_align",
  "list_mb_ids",
  "apply_mb_ids",
  "undo_mb_ids",
  "dismiss_mb_ids",
  "undo_artist_rename",
  "album_pictures",
  "track_lyrics",
  "scan_defects",
  "list_defect_results",
  "set_defect_reviewed",
  "scan_library_defects",
  "scan_library_loudness",
  "organize_preview",
  "organize_apply",
  "organize_undo",
  "organize_last",
  "library_loudness_status",
  "loudness_gains",
  "get_loudness_settings",
  "levelling_tags_albums",
  "levelling_tags_preview",
  "levelling_tags_strip",
  "levelling_tags_undo",
  "levelling_tags_write",
  "native_audio_control",
  "native_audio_devices",
  "native_audio_next",
  "native_audio_open",
  "native_audio_status",
  "set_loudness_settings",
  "library_scan_status",
  "list_defect_problems",
  "scan_tag_repair",
  "tag_repair_status",
  "source_status",
  "search_folder_album",
  "check_folder_audio",
  "scan_audio_check",
  "list_audio_check",
  "dismiss_audio_check",
  "apply_audio_names",
  "compare_album_release",
  "adopt_release_values",
  "flag_rerip",
  "unflag_rerip",
  "list_rerip",
  "leave_albums_alone",
  "stop_leaving_alone",
  "list_tag_repair",
  "apply_tag_repair",
  "undo_tag_repair",
  "id3_survey",
  "standardize_id3",
  "tag_untagged",
  "get_tag_settings",
  "set_tag_settings",
  "convert_survey",
  "convert_to_mp3",
  "find_album_art",
  "fetch_album_art",
  "library_gaps",
  "get_listen_settings",
  "set_listen_settings",
  "list_flags",
  "record_play",
  "list_history",
  "create_folder",
  "list_pins",
  "get_lyrics_settings",
  "set_lyrics_settings",
  "lookup_lyrics",
  "lyric_ai_status",
  "lyric_ai_configure",
  "lyric_ai_analyse",
  "lyric_ai_judge",
  "lyric_ai_time",
  "lyric_ai_time_lines",
  "lyric_ai_confirm_words",
  "lyric_ai_draft",
  "lyric_ai_results",
  "lyric_ai_apply",
  "lyric_ai_wrong_check",
  "lyric_ai_wrong_results",
  "lyric_ai_wrong_dismiss",
  "lyric_photos_status",
  "lyric_photos_download",
  "lyric_photos_preview",
  "lyric_photos_read",
  "lyric_photos_session_save",
  "lyric_photos_session_load",
  "lyric_photos_session_forget",
  "save_lyrics_review",
  "list_lyrics_review",
  "get_lyrics_review",
  "reject_lyrics_candidate",
  "remove_lyrics_review",
  "list_lyrics_instrumental",
  "mark_lyrics_instrumental",
  "unmark_lyrics_instrumental",
  "confirm_lyrics_instrumental",
  "find_tidy_titles",
  "apply_title_tidy",
  "set_pin",
  "clear_history",
  "set_history_enabled",
  "recent_files",
  "set_flag",
  "list_favorites",
  "set_favorite",
  "list_playlists",
  "save_playlist",
  "delete_playlist",
  "update_track_media",
  "undo_picture_batch",
  "set_metadata_settings",
  "tag_editor_choices_command",
  "write_track_tags",
]);

const allowedEvents = new Set([
  "collection-sync-failed",
  "job-finished",
  "job-progress",
  "library-updated",
  "marks-changed",
]);

let sidecar = null;
// Library sharing with the TV app (D38): off until switched on in Settings > TV.
let libraryShare = null;

// The page plays music through this scheme (see media-access.js). It must be declared before ready.
protocol.registerSchemesAsPrivileged([
  // corsEnabled lets the page's audio analyser (the music-reactive glow) read the sound; without it Web Audio
  // hears silence. It changes nothing about which files are served.
  { scheme: "mediaverse-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// The music library folder, remembered so that playing a song does not wait for the sidecar (which can be
// busy for seconds resyncing a very large library, ADR 0008). It only changes through import_collection,
// which passes through this file, so the copy is updated there. undefined = not asked yet.
let libraryRoot;

async function currentLibraryRoot() {
  if (libraryRoot === undefined) {
    const collection = await sidecar.invoke("collection_status", {});
    libraryRoot = collection?.root ?? null;
  }
  return libraryRoot;
}

async function serveAudio(request) {
  try {
    // A song of a Jellyfin server (the server alone is the library): fetched from it, not from a file.
    if (new URL(request.url).hostname === "jellyfin") return await jellyfinStream.serve(request);
    const requested = new URL(request.url).searchParams.get("path");
    const file = resolveAllowedAudio(requested, await currentLibraryRoot());
    // Byte ranges are answered here rather than left to a file:// fetch, which does not honour them reliably:
    // without a 206 answer the player cannot seek, so dragging the position slider did nothing.
    const { size } = await fs.promises.stat(file);
    const range = parseRange(request.headers.get("range") ?? undefined, size);
    // The app's own page is the only thing that can reach this scheme (no other windows are allowed).
    const headers = { "Content-Type": mimeTypeFor(file), "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    if (size === 0) return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, "Content-Length": String(end - start + 1), ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) },
    });
  } catch (error) {
    return new Response(String(error.message ?? error), { status: 403 });
  }
}

function createWindow() {
  // Opens where it was last time, kept wholly on a screen that is still there (D73).
  const bounds = initialBounds(screen, app.getPath("userData"));
  const window = new BrowserWindow({
    ...(bounds.x === undefined ? {} : { x: bounds.x, y: bounds.y }),
    width: bounds.width,
    height: bounds.height,
    minWidth: Math.min(MIN_SIZE.width, bounds.width),
    minHeight: Math.min(MIN_SIZE.height, bounds.height),
    show: false,
    // Title bar and taskbar icon (D86). brand/ holds the sources; tools/make-brand-assets.ps1 remakes it.
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#050404",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      // Music keeps playing, and songs keep handing over to each other on time, when the window is minimised or covered.
      backgroundThrottling: false,
    },
  });

  if (bounds.maximized) window.maximize();
  window.show();
  manageWindowState(window, screen, app.getPath("userData"));

  // Right-click in a text box: spelling suggestions, Add to dictionary, and the editing items (the lyrics editor).
  attachEditMenu(window, { Menu });
  // The app never opens extra windows of its own; links go to the browser only through open-external.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // No File/Edit/View/Window menu (D86), so the few keys it gave that are still useful are handled here: page
  // zoom for everyone; reload and developer tools only when run from source (not in an installed copy).
  // Copy, paste, undo and select-all in text boxes need no menu on Windows.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const contents = window.webContents;
    const key = input.key.toLowerCase();
    if (key === "=" || key === "+") contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 4));
    else if (key === "-") contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3));
    else if (key === "0") contents.setZoomLevel(0);
    else if (!app.isPackaged && input.shift && key === "i") contents.toggleDevTools();
    else if (!app.isPackaged && key === "r" && !input.shift) contents.reload();
    else return;
    event.preventDefault();
  });
  // Security: the window never leaves the app's own page. A page it navigated to would get the preload bridge
  // (window.mediaVerse) and with it the sidecar's commands.
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  const developmentUrl = process.env.MEDIAVERSE_DEV_SERVER_URL;
  if (developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

const appPage = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;

/** True for the app's own page (the built file, or the development server when one is used). */
function isAppPage(url) {
  if (typeof url !== "string") return false;
  const developmentUrl = process.env.MEDIAVERSE_DEV_SERVER_URL;
  if (developmentUrl) return url.startsWith(developmentUrl);
  return url.split(/[?#]/)[0] === appPage;
}

/** Bridge calls are answered only for the app's own page in its own window (defence in depth). */
function fromApp(event) {
  return isAppPage(event.senderFrame?.url);
}

/** The licences folder (D88), or null when this copy has none. */
function licencesFolder() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "..", "licenses")]
    : [path.join(__dirname, "..", "..", "..", "dist-app", "licenses")];
  return candidates.find((folder) => fs.existsSync(path.join(folder, "README.txt"))) ?? null;
}

/** A short, printable title from the page, or a neutral default. */
function folderDialogTitle(title) {
  if (typeof title !== "string") return "Choose a folder";
  const clean = title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return clean || "Choose a folder";
}

const CHANGES_LIBRARY = new Set(["import_collection", "write_track_tags", "update_track_media", "undo_picture_batch", "rename_artist", "undo_artist_rename", "apply_mb_ids", "undo_mb_ids", "align_album", "undo_album_align", "write_wiki_photos", "apply_tag_repair", "undo_tag_repair", "standardize_id3", "tag_untagged", "convert_to_mp3"]);

function registerBridge() {
  ipcMain.handle("mediaverse:choose-folder", async (event, title) => {
    if (!fromApp(event)) return null;
    // The page says what the folder is for; the window must say the same (a fixed title once made people
    // pick their library when the page wanted the archive or a parent folder).
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: folderDialogTitle(title),
    });

    return result.canceled ? null : result.filePaths[0];
  });

  // Lyrics by photo: the pictures of a booklet, chosen in the system's own window (several at once). Only the paths leave this
  // handler; the sidecar checks that each is a JPEG or PNG file before reading it.
  ipcMain.handle("mediaverse:choose-pictures", async (event, title) => {
    if (!fromApp(event)) return [];
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: typeof title === "string" && title.trim() ? title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "Choose pictures",
      filters: [{ name: "Pictures (JPEG, PNG)", extensions: ["jpg", "jpeg", "png"] }],
    });
    return result.canceled ? [] : result.filePaths.slice(0, 40);
  });

  // "Open file location": only for a song inside the music library (the same check the player's media scheme uses).
  ipcMain.handle("mediaverse:show-in-folder", async (event, filePath) => {
    if (!fromApp(event)) return false;
    try {
      shell.showItemInFolder(resolveAllowedAudio(String(filePath ?? ""), await currentLibraryRoot()));
      return true;
    } catch {
      return false;
    }
  });
  // Settings > About (D88). The licences folder sits beside the program in an installed copy
  // (tools/make-licence-pack.ps1 makes it); from source it is the last one made in dist-app.
  ipcMain.handle("mediaverse:about", (event) => {
    if (!fromApp(event)) return null;
    let commit = null;
    try { commit = fs.readFileSync(path.join(__dirname, "..", "commit.txt"), "utf8").trim() || null; } catch { /* from source */ }
    // The app's own package.json (app.getVersion() reports Electron's when started by a test script).
    let version = app.getVersion();
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version || version; } catch { /* keep */ }
    return { version, electron: process.versions.electron, commit, licences: licencesFolder() !== null };
  });
  ipcMain.handle("mediaverse:open-licences", async (event) => {
    const folder = fromApp(event) ? licencesFolder() : null;
    if (!folder) return false;
    return (await shell.openPath(folder)) === "";
  });

  ipcMain.handle("mediaverse:open-external", async (event, address) => {
    if (!fromApp(event) || !isAllowedExternal(address)) return false;
    await shell.openExternal(address);
    return true;
  });

  // "Add this album to MusicBrainz" (D107): a local page, built here from checked fields, posts the details to MusicBrainz's
  // Add Release form in the person's own browser. The renderer never supplies HTML.
  ipcMain.handle("mediaverse:musicbrainz-add-release", async (event, release) => {
    if (!fromApp(event)) return { ok: false, message: "Only the MediaVerse Studio page may use this." };
    let page;
    try {
      page = seedPage(release);
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
    const file = path.join(app.getPath("temp"), "mediaverse-musicbrainz-add-release.html");
    fs.writeFileSync(file, page, "utf8");
    const failure = await shell.openPath(file);
    return failure === "" ? { ok: true } : { ok: false, message: failure };
  });

  // Replies are envelopes so structured errors survive the trip (see ipc-envelope.js).
  ipcMain.handle("mediaverse:invoke", (event, command, args) =>
    toEnvelope(async () => {
      if (!fromApp(event)) throw { code: "not_allowed", message: "Only the MediaVerse Studio page may use this." };
      if (!allowedCommands.has(command)) {
        throw { code: "unknown_command", message: `Unsupported MediaVerse command: ${command}` };
      }
      if (command === "import_collection") libraryRoot = undefined; // asked again on the next song
      const result = await sidecar.invoke(command, args);
      if (command === "import_collection" && typeof result?.root === "string") libraryRoot = result.root;
      // Anything that changes files or the library: the TV is sent fresh lists.
      if (CHANGES_LIBRARY.has(command)) libraryShare?.invalidate();
      return result;
    }),
  );
  const guarded = (handler) => (event, ...args) => {
    if (!fromApp(event)) throw new Error("Only the MediaVerse Studio page may use this.");
    return handler(...args);
  };
  ipcMain.handle("mediaverse:share-status", guarded(() => libraryShare.status()));
  ipcMain.handle("mediaverse:share-set-enabled", guarded((enabled) => libraryShare.setEnabled(enabled === true)));
  ipcMain.handle("mediaverse:share-forget-device", guarded((id) => libraryShare.forgetDevice(String(id))));
  ipcMain.handle("mediaverse:share-cancel-pairing", guarded(() => libraryShare.cancelPairing()));
  ipcMain.handle("mediaverse:share-arm-pairing", guarded(() => libraryShare.armPairing()));
  ipcMain.handle("mediaverse:remote-devices", guarded(() => libraryShare.remoteDevices()));
  // Playlists as files (D78): the person chooses where; the type follows the chosen extension.
  ipcMain.handle(
    "mediaverse:playlist-save",
    guarded(async (name, contents) => {
      const xspf = typeof contents?.xspf === "string" ? contents.xspf : "";
      const m3u8 = typeof contents?.m3u8 === "string" ? contents.m3u8 : "";
      if (xspf.length + m3u8.length > 40 * 1024 * 1024) throw new Error("That playlist is too large to save.");
      const safe = String(name ?? "Playlist").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Playlist";
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const chosen = await dialog.showSaveDialog(parent, {
        title: "Save the playlist",
        defaultPath: path.join(app.getPath("music"), `${safe}.xspf`),
        filters: [
          { name: "XSPF playlist, to share (finds songs in any library)", extensions: ["xspf"] },
          { name: "M3U8 playlist (file locations on this computer)", extensions: ["m3u8"] },
        ],
      });
      if (chosen.canceled || !chosen.filePath) return null;
      const m3u = /\.m3u8?$/i.test(chosen.filePath);
      await fs.promises.writeFile(chosen.filePath, m3u ? m3u8 : xspf, "utf8");
      return chosen.filePath;
    }),
  );
  ipcMain.handle(
    "mediaverse:playlist-open",
    guarded(async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const chosen = await dialog.showOpenDialog(parent, {
        title: "Import a playlist",
        properties: ["openFile"],
        filters: [{ name: "Playlists (XSPF, JSPF, M3U)", extensions: ["xspf", "jspf", "json", "m3u", "m3u8"] }],
      });
      const file = chosen.filePaths?.[0];
      if (chosen.canceled || !file) return null;
      const { size } = await fs.promises.stat(file);
      if (size > 10 * 1024 * 1024) throw new Error("That file is too large to be a playlist.");
      return { name: path.basename(file), text: await fs.promises.readFile(file, "utf8") };
    }),
  );
  // DLNA TVs and speakers (D77): the page searches only with Settings > Cast's switch on.
  ipcMain.handle(
    "mediaverse:cast-discover",
    guarded(async () => {
      const [upnp, cast] = await Promise.all([dlna.discover(3).catch(() => []), googleCast.discover(3).catch(() => [])]);
      // A device that speaks both (the Samsung TVs, the WiiM amplifier) is offered once, by Google Cast, which
      // shows the cover and follows the queue better.
      const castHosts = new Set(cast.map((d) => d.host));
      return [...cast.map((d) => ({ ...d, kind: "Google Cast" })), ...upnp.filter((d) => !castHosts.has(d.host)).map((d) => ({ ...d, kind: "DLNA" }))];
    }),
  );
  /** A song as a cast device needs it: a link with a token, its type, what to show, and (Google Cast) its lyrics. */
  async function castSong(id, filePath) {
    const caster = casterFor(id);
    const host = caster.host(String(id));
    if (!host) throw new Error("That TV or speaker is no longer found. Search again.");
    // A song of the Jellyfin server: the device fetches it from the server itself.
    if (String(filePath).startsWith("jellyfin:")) {
      const songId = songIdOf(filePath);
      if (!songId) throw new Error("That is not a song of the server.");
      const info = await jellyfinStream.castInfo(songId);
      const lyrics = String(id).startsWith("cast:") ? info.lyrics : null;
      return { url: info.url, mime: info.mime, title: info.title, artist: info.artist, album: info.album, cover: info.cover, seconds: info.seconds, lyrics: lyrics && { synced: lyrics.synced, lines: lyrics.lines.slice(0, 400).map((l) => ({ ms: l.ms, text: l.text.slice(0, 200) })), plain: lyrics.plain.slice(0, 20_000) } };
    }
    const link = await libraryShare.castLink(String(filePath), host);
    if (!link) throw new Error("That song is not in the library.");
    const { track } = link;
    // Google Cast devices with the MediaVerse receiver show the lyrics (sent with the song, kept small).
    let lyrics = null;
    if (String(id).startsWith("cast:")) {
      const found = await sidecar.invoke("track_lyrics", { path: String(filePath) }).catch(() => null);
      if (found && (found.plain || found.lines?.length)) {
        lyrics = { synced: !!found.synced, lines: (found.lines ?? []).slice(0, 400).map((l) => ({ ms: l.ms, text: String(l.text ?? "").slice(0, 200) })), plain: String(found.plain ?? "").slice(0, 20_000) };
      }
    }
    return { url: link.audio, mime: link.mime, title: track.title, artist: track.artist, album: track.album, cover: link.cover, seconds: (track.length_ms ?? 0) / 1000, lyrics };
  }
  ipcMain.handle(
    "mediaverse:cast-load",
    guarded(async (id, filePath, startSeconds) => {
      await casterFor(id).load(String(id), await castSong(id, filePath), Number(startSeconds) || 0);
      // `queued`: the device can be told which song follows (cast-preload), and then plays it with no gap.
      return { ok: true, queued: casterFor(id).canPreload(String(id)) };
    }),
  );
  // The song that follows the one playing: put behind it on the device, which then starts it by itself (gapless).
  ipcMain.handle(
    "mediaverse:cast-preload",
    guarded(async (id, filePath) => {
      const caster = casterFor(id);
      if (!caster.canPreload(String(id))) return { ok: false };
      await caster.preloadNext(String(id), await castSong(id, filePath));
      return { ok: true };
    }),
  );
  ipcMain.handle(
    "mediaverse:cast-control",
    guarded((id, action, seconds) => {
      const device = String(id);
      const caster = casterFor(device);
      if (action === "play") return caster.play(device);
      if (action === "pause") return caster.pause(device);
      if (action === "stop") return caster.stop(device);
      if (action === "seek") return caster.seek(device, Number(seconds) || 0);
      if (action === "volume") return caster.setVolume(device, Math.min(1, Math.max(0, Number(seconds) || 0))); // `seconds` carries the level, 0 to 1
      throw new Error("Unknown command.");
    }),
  );
  ipcMain.handle("mediaverse:cast-status", guarded((id) => casterFor(id).status(String(id))));
  ipcMain.handle("mediaverse:remote-send", guarded((id, command) => libraryShare.sendRemote(String(id), command)));
  // Windows Firewall: whether TVs on the current network are turned away, and adding the narrow rule (firewall.js).
  ipcMain.handle("mediaverse:share-firewall-check", guarded(async () => firewall.check(process.execPath, (await libraryShare.status()).port)));
  ipcMain.handle("mediaverse:share-firewall-allow", guarded(async () => firewall.allow(process.execPath, (await libraryShare.status()).port)));
  // Settings > Jellyfin (D90).
  ipcMain.handle("mediaverse:jellyfin-find", guarded(() => jellyfin.find()));
  // Requests to servers on the home network, for the shared problem list (D96); the page may not make them itself.
  ipcMain.handle("mediaverse:home-http", guarded((request) => homeHttp(request)));
  // The sign-in the page uses for the Jellyfin library, kept here so songs can be played and cast (D173); null forgets it.
  ipcMain.handle("mediaverse:jellyfin-stream-session", guarded((session) => {
    jellyfinStream.setSession(session && typeof session === "object" ? session : null);
    return true;
  }));
  ipcMain.handle("mediaverse:jellyfin-firewall-check", guarded(() => firewall.checkJellyfin()));
  ipcMain.handle("mediaverse:jellyfin-firewall-allow", guarded(() => firewall.allowJellyfin()));
  ipcMain.handle("mediaverse:jellyfin-open", guarded(async (id) => {
    const address = jellyfin.webAddress(id);
    if (!address) return false;
    await shell.openExternal(address);
    return true;
  }));
  ipcMain.handle("mediaverse:jellyfin-download-page", guarded(async () => {
    await shell.openExternal(JELLYFIN_DOWNLOAD_PAGE);
    return true;
  }));
  ipcMain.handle("mediaverse:copy-text", guarded((text) => {
    clipboard.writeText(String(text).slice(0, 2000));
    return true;
  }));
  ipcMain.handle("mediaverse:subscribe", (_event, eventName) => {
    if (!allowedEvents.has(eventName)) {
      throw new Error(`Unsupported MediaVerse event: ${eventName}`);
    }
  });
}

function startLibraryShare() {
  libraryShare = createLibraryShare({
    settingsFile: path.join(app.getPath("userData"), "library-share.json"),
    source: {
      snapshot: () => sidecar.invoke("library_snapshot", {}),
      root: () => currentLibraryRoot(),
      cover: (file) => sidecar.invoke("track_cover", { path: file }),
      lyrics: (file) => sidecar.invoke("track_lyrics", { path: file }),
      favorites: async () => (await sidecar.invoke("list_favorites", {}))?.favorites ?? [],
      flags: async () => (await sidecar.invoke("list_flags", {}))?.flags ?? [],
      playlists: async () => (await sidecar.invoke("list_playlists", {}))?.playlists ?? [],
      setFavorite: (file, args) => sidecar.invoke("set_favorite", { path: file, ...args }),
      setFlag: (file, args) => sidecar.invoke("set_flag", { path: file, ...args }),
      // Electron's own image code, so covers for the TV can be sent small (no extra component).
      shrink: async (bytes, size) => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error("not a picture Electron can read");
        const { width, height } = image.getSize();
        if (Math.max(width, height) <= size) return image.toJPEG(85);
        const resized = width >= height ? image.resize({ width: size, quality: "good" }) : image.resize({ height: size, quality: "good" });
        return resized.toJPEG(85);
      },
    },
    log: (message) => console.warn(message),
    // A TV asking to pair must reach the owner wherever they are in the app: the page shows the code.
    onChange: () => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mediaverse:share-changed");
    },
    // A TV flagged a song or changed a favorite: the page shows the same lists.
    onMarks: () => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mediaverse:event:marks-changed", {});
    },
    // "Play on the TV" (D76): a TV opened or left the app, or said what it is playing.
    onRemote: () => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mediaverse:remote-changed");
    },
  });
  void libraryShare.start();
}

// Stability: if the sidecar stops unexpectedly (a crash), it is started again, so the program does not stay
// broken until it is restarted by hand. Every caller reaches it through `sidecar` at call time, so the new one
// is used at once. At most 5 restarts in 10 minutes, so a sidecar that cannot start does not loop.
let quitting = false;
const restarts = [];

function startSidecar() {
  sidecar = new SidecarClient({
    executable: resolveSidecarPath(process.resourcesPath),
    dataDir: app.getPath("userData"),
    onEvent: (eventName, payload) => {
      if (!allowedEvents.has(eventName)) return;
      if (eventName === "library-updated") libraryShare?.invalidate();
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(`mediaverse:event:${eventName}`, payload);
      }
    },
    onExit: (code) => {
      if (quitting) return;
      const now = Date.now();
      while (restarts.length && now - restarts[0] > 10 * 60_000) restarts.shift();
      if (restarts.length >= 5) {
        console.error(`The MediaVerse sidecar stopped (code ${code}) and was not started again: it stopped 5 times in 10 minutes.`);
        return;
      }
      restarts.push(now);
      console.error(`The MediaVerse sidecar stopped (code ${code}); starting it again.`);
      setTimeout(() => {
        if (!quitting) startSidecar();
      }, 1000);
    },
  });
}

app.whenReady().then(() => {
  // The default Electron menu (File, Edit, View, Window, Help) offered nothing the app uses (D86).
  Menu.setApplicationMenu(null);
  // Spell checking in text boxes (the lyrics editor), in the language of the system and in English.
  try {
    const wanted = [app.getLocale(), "en-US"].filter((l, i, all) => l && all.indexOf(l) === i);
    const usable = session.defaultSession.availableSpellCheckerLanguages;
    session.defaultSession.setSpellCheckerLanguages(wanted.filter((l) => usable.includes(l)));
    session.defaultSession.setSpellCheckerEnabled(true);
  } catch {
    // No spell checker on this system: text boxes simply have no squiggles.
  }
  // Security: the page needs no camera, microphone, location, notifications or the like; refuse them all (full
  // screen, used by Now Playing, is the one exception).
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  protocol.handle("mediaverse-media", serveAudio);
  startSidecar();
  startLibraryShare();
  registerBridge();
  createWindow();
  // Media keys, the taskbar buttons and the mini player (issue #8).
  setupMediaControls({ app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen, getMainWindow: () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")) ?? null });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  quitting = true;
  if (libraryShare) void libraryShare.stop();
  if (sidecar) void sidecar.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

