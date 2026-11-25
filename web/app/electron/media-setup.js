// Wires the media keys, the taskbar thumbnail buttons and the mini player window into the app (issue #8). The pure parts are in media-controls.js.

const path = require("node:path");
const { cleanCommand, cleanState, nowPlayingText, registerMediaKeys, thumbarSpec } = require("./media-controls");
const { manageMiniPlace, miniPosition, readMiniPlace } = require("./window-state");

function setupMediaControls({ app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen, getMainWindow }) {
  let state = cleanState({});
  let mini = null;
  let drawnThumbs = "";
  let pinned = true; // the mini player stays on top of other windows until the pin is switched off
  let quitting = false;
  const icons = {};
  const icon = (name) => (icons[name] ??= nativeImage.createFromPath(path.join(__dirname, "icons", `thumb-${name}.png`)));

  const toMain = (command) => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send("mediaverse:player-command", command);
  };

  function drawThumbs() {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || process.platform !== "win32") return;
    const spec = thumbarSpec(state);
    const key = JSON.stringify(spec.map((b) => [b.icon, b.enabled]));
    if (key === drawnThumbs) return;
    drawnThumbs = key;
    try {
      main.setThumbarButtons(spec.map((b) => ({ tooltip: b.tooltip, icon: icon(b.icon), flags: b.enabled ? [] : ["disabled"], click: () => toMain({ action: b.action }) })));
    } catch {
      // the taskbar is not available (remote desktop, say): the buttons are only a convenience
    }
  }

  function openMini() {
    if (mini && !mini.isDestroyed()) {
      mini.show();
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    // Where it was left last time, if all of it is still on a screen; otherwise the bottom right corner of the main screen.
    const placeFile = path.join(app.getPath("userData"), "mini-player-place.json");
    const place = miniPosition(
      readMiniPlace(placeFile),
      screen.getAllDisplays().map((d) => d.workArea),
      380,
      124,
    );
    mini = new BrowserWindow({
      width: 380,
      height: 124,
      x: place ? place.x : area.x + area.width - 380 - 16,
      y: place ? place.y : area.y + area.height - 124 - 16,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: "MediaVerse Studio mini player",
      backgroundColor: "#0b0807",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "mini-preload.js"), backgroundThrottling: false },
    });
    manageMiniPlace(mini, placeFile);
    mini.setMenu(null);
    mini.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mini.webContents.on("will-navigate", (event) => event.preventDefault());
    void mini.loadFile(path.join(__dirname, "mini.html"));
    // If the main window goes (closed, or the program is told to quit) the mini player goes with it: a window left open keeps the whole program running with
    // nothing to click, which left four stray processes behind (owner, 2026-11-24).
    const owner = getMainWindow();
    if (owner && !owner.isDestroyed()) {
      owner.once("closed", () => {
        if (mini && !mini.isDestroyed()) mini.destroy();
      });
    }
    mini.once("ready-to-show", () => {
      mini.show();
      mini.webContents.send("mediaverse:mini-state", { ...state, pinned });
      // The main window shrinks into the mini player (hidden, not closed: the music and the page carry on).
      const main = getMainWindow();
      if (main && !main.isDestroyed()) main.hide();
    });
    mini.on("closed", () => {
      mini = null;
      const main = getMainWindow();
      if (!main || main.isDestroyed()) return;
      main.webContents.send("mediaverse:mini-changed", false);
      // Leaving the mini player always brings the main window back, so it can never be left hidden with nothing to click.
      if (!quitting) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      }
    });
  }

  const isMain = (event) => getMainWindow()?.webContents === event.sender;
  const isMini = (event) => !!mini && !mini.isDestroyed() && mini.webContents === event.sender;

  ipcMain.on("mediaverse:player-state", (event, value) => {
    if (!isMain(event)) return;
    state = cleanState(value);
    drawThumbs();
    if (mini && !mini.isDestroyed()) mini.webContents.send("mediaverse:mini-state", { ...state, pinned });
  });
  ipcMain.on("mediaverse:mini-pin", (event, value) => {
    if (!isMini(event)) return;
    pinned = typeof value === "boolean" ? value : !pinned;
    mini.setAlwaysOnTop(pinned);
    mini.webContents.send("mediaverse:mini-state", { ...state, pinned });
  });
  ipcMain.on("mediaverse:mini-command", (event, value) => {
    if (!isMini(event)) return;
    const command = cleanCommand(value);
    if (command) toMain(command);
  });
  ipcMain.on("mediaverse:mini-close", (event) => {
    if (isMini(event)) mini.close();
  });
  // "Back to the full window": closing the mini player brings the main window back (see the 'closed' handler).
  ipcMain.on("mediaverse:mini-show-main", (event) => {
    if (isMini(event)) mini.close();
  });
  ipcMain.handle("mediaverse:mini-toggle", (event) => {
    if (!isMain(event)) return false;
    if (mini && !mini.isDestroyed()) {
      mini.close();
      return false;
    }
    openMini();
    return true;
  });

  const release = registerMediaKeys(globalShortcut, toMain);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    release();
    if (mini && !mini.isDestroyed()) mini.destroy();
  });
  drawThumbs();
  return { openMini, state: () => state, title: () => nowPlayingText(state) };
}

module.exports = { setupMediaControls };
