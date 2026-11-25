// Media keys, the taskbar thumbnail buttons and the mini player's state (owner's list 2026-11-23, issue #8). The main window publishes what is playing; this
// module cleans it (it comes from a page, so it is checked), turns it into the taskbar buttons, and carries commands back from the keys, the buttons and the
// mini player. Pure where it can be, so it is tested; the Electron objects are passed in.

const ACTIONS = new Set(["toggle", "play", "pause", "next", "previous", "stop", "volume", "mute", "seek"]);
const KEY_ACTIONS = { MediaPlayPause: "toggle", MediaNextTrack: "next", MediaPreviousTrack: "previous", MediaStop: "stop" };

function text(value, max = 300) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function number(value, low, high, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

/** What a page may tell the program about the player; anything else is dropped. */
function cleanState(value) {
  const v = value && typeof value === "object" ? value : {};
  const cover = typeof v.cover === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v.cover) && v.cover.length < 120_000 ? v.cover : null;
  return {
    title: text(v.title),
    artist: text(v.artist),
    album: text(v.album),
    playing: v.playing === true,
    hasTrack: v.hasTrack === true,
    canPrevious: v.canPrevious === true,
    canNext: v.canNext === true,
    position: number(v.position, 0, 100_000),
    duration: number(v.duration, 0, 100_000),
    volume: number(v.volume, 0, 1, 1),
    muted: v.muted === true,
    accent: typeof v.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(v.accent) ? v.accent : null,
    cover,
  };
}

/** A command from a key, a button or the mini player, checked. */
function cleanCommand(value) {
  const v = value && typeof value === "object" ? value : {};
  if (!ACTIONS.has(v.action)) return null;
  const out = { action: v.action };
  if (v.action === "volume" || v.action === "seek") out.value = number(v.value, 0, v.action === "volume" ? 1 : 100_000);
  return out;
}

/** The three taskbar thumbnail buttons for what is playing: previous, play or pause, next. */
function thumbarSpec(state) {
  return [
    { icon: "previous", tooltip: "Previous song", enabled: state.hasTrack && state.canPrevious, action: "previous" },
    { icon: state.playing ? "pause" : "play", tooltip: state.playing ? "Pause" : "Play", enabled: state.hasTrack, action: "toggle" },
    { icon: "next", tooltip: "Next song", enabled: state.hasTrack && state.canNext, action: "next" },
  ];
}

/** The text for the taskbar button's tooltip and the window title of the mini player. */
function nowPlayingText(state) {
  if (!state.hasTrack) return "MediaVerse Studio";
  return [state.title, state.artist].filter(Boolean).join(" · ") || "MediaVerse Studio";
}

/** Registers the media keys; returns a function that lets them go. A key another program already holds is skipped (not an error). */
function registerMediaKeys(globalShortcut, send) {
  const held = [];
  for (const [key, action] of Object.entries(KEY_ACTIONS)) {
    try {
      if (globalShortcut.register(key, () => send({ action }))) held.push(key);
    } catch {
      // not available on this system
    }
  }
  return () => {
    for (const key of held) {
      try {
        globalShortcut.unregister(key);
      } catch {
        // already gone
      }
    }
  };
}

module.exports = { ACTIONS, KEY_ACTIONS, cleanState, cleanCommand, thumbarSpec, nowPlayingText, registerMediaKeys };
