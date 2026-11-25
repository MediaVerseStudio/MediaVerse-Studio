const { contextBridge, ipcRenderer } = require("electron");

// About a dozen panels each listen for "job-finished" (one listener each, for the life of the page: not a leak), which
// is more than Node's default of 10 and printed a warning at every start.
ipcRenderer.setMaxListeners(60);

const allowedEvents = new Set([
  "collection-sync-failed",
  "job-finished",
  "job-progress",
  "library-updated",
  "marks-changed",
]);

contextBridge.exposeInMainWorld("mediaVerse", {
  choosePictures: (title) => ipcRenderer.invoke("mediaverse:choose-pictures", typeof title === "string" ? title : undefined),
  chooseFolder: (title) => ipcRenderer.invoke("mediaverse:choose-folder", typeof title === "string" ? title : undefined),
  openExternal: (address) => ipcRenderer.invoke("mediaverse:open-external", address),
  musicbrainzAddRelease: (release) => ipcRenderer.invoke("mediaverse:musicbrainz-add-release", release),
  showInFolder: (filePath) => ipcRenderer.invoke("mediaverse:show-in-folder", String(filePath)),
  about: () => ipcRenderer.invoke("mediaverse:about"),
  openLicences: () => ipcRenderer.invoke("mediaverse:open-licences"),
  copyText: (text) => ipcRenderer.invoke("mediaverse:copy-text", String(text)),
  homeHttp: (request) => ipcRenderer.invoke("mediaverse:home-http", request && typeof request === "object" ? request : {}),
  /** The Jellyfin sign-in songs are played and cast with when the server alone is the library (D173); null forgets it. */
  jellyfinStreamSession: (session) => ipcRenderer.invoke("mediaverse:jellyfin-stream-session", session && typeof session === "object" ? session : null),
  jellyfin: {
    find: () => ipcRenderer.invoke("mediaverse:jellyfin-find"),
    open: (id) => ipcRenderer.invoke("mediaverse:jellyfin-open", String(id)),
    downloadPage: () => ipcRenderer.invoke("mediaverse:jellyfin-download-page"),
    firewallCheck: () => ipcRenderer.invoke("mediaverse:jellyfin-firewall-check"),
    firewallAllow: () => ipcRenderer.invoke("mediaverse:jellyfin-firewall-allow"),
  },
  share: {
    status: () => ipcRenderer.invoke("mediaverse:share-status"),
    setEnabled: (enabled) => ipcRenderer.invoke("mediaverse:share-set-enabled", enabled === true),
    forgetDevice: (id) => ipcRenderer.invoke("mediaverse:share-forget-device", String(id)),
    cancelPairing: () => ipcRenderer.invoke("mediaverse:share-cancel-pairing"),
    armPairing: () => ipcRenderer.invoke("mediaverse:share-arm-pairing"),
    firewallCheck: () => ipcRenderer.invoke("mediaverse:share-firewall-check"),
    firewallAllow: () => ipcRenderer.invoke("mediaverse:share-firewall-allow"),
    onChange: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("mediaverse:share-changed", listener);
      return () => ipcRenderer.removeListener("mediaverse:share-changed", listener);
    },
    // Playlists as files (D78).
    playlistSave: (name, contents) => ipcRenderer.invoke("mediaverse:playlist-save", String(name), contents),
    playlistOpen: () => ipcRenderer.invoke("mediaverse:playlist-open"),
    // DLNA TVs and speakers (D77).
    castDiscover: () => ipcRenderer.invoke("mediaverse:cast-discover"),
    castLoad: (id, filePath, startSeconds) => ipcRenderer.invoke("mediaverse:cast-load", String(id), String(filePath), Number(startSeconds) || 0),
    castPreload: (id, filePath) => ipcRenderer.invoke("mediaverse:cast-preload", String(id), String(filePath)),
    castControl: (id, action, seconds) => ipcRenderer.invoke("mediaverse:cast-control", String(id), String(action), Number(seconds) || 0),
    castStatus: (id) => ipcRenderer.invoke("mediaverse:cast-status", String(id)),
    // "Play on the TV" (D76): paired TVs with the app open, and commands for them.
    remoteDevices: () => ipcRenderer.invoke("mediaverse:remote-devices"),
    remoteSend: (id, command) => ipcRenderer.invoke("mediaverse:remote-send", String(id), command),
    onRemoteChange: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("mediaverse:remote-changed", listener);
      return () => ipcRenderer.removeListener("mediaverse:remote-changed", listener);
    },
  },
  /** What is playing, for the media keys, the taskbar buttons and the mini player (issue #8). */
  player: {
    publish: (state) => ipcRenderer.send("mediaverse:player-state", state && typeof state === "object" ? state : {}),
    onCommand: (handler) => {
      const listener = (_event, command) => handler(command);
      ipcRenderer.on("mediaverse:player-command", listener);
      return () => ipcRenderer.removeListener("mediaverse:player-command", listener);
    },
    toggleMini: () => ipcRenderer.invoke("mediaverse:mini-toggle"),
    onMiniChange: (handler) => {
      const listener = (_event, open) => handler(open === true);
      ipcRenderer.on("mediaverse:mini-changed", listener);
      return () => ipcRenderer.removeListener("mediaverse:mini-changed", listener);
    },
  },
  invoke: (command, arguments_) =>
    ipcRenderer.invoke("mediaverse:invoke", command, arguments_),
  listen: (eventName, handler) => {
    if (!allowedEvents.has(eventName)) {
      throw new Error(`Unsupported MediaVerse event: ${eventName}`);
    }

    const listener = (_event, payload) => handler({ payload });
    ipcRenderer.on(`mediaverse:event:${eventName}`, listener);
    return () => ipcRenderer.removeListener(`mediaverse:event:${eventName}`, listener);
  },
});

