// Tells the program what is playing (for the media keys, the taskbar buttons, the system's media overlay and the mini player), and does what they ask
// (issue #8). Outside the Windows program there is no bridge and nothing happens.

import { setIconButton } from "./icons";
import type { Player } from "./player";

type Bridge = {
  publish: (state: object) => void;
  onCommand: (handler: (command: { action: string; value?: number }) => void) => () => void;
  toggleMini: () => Promise<boolean>;
  onMiniChange: (handler: (open: boolean) => void) => () => void;
};

/** A small JPEG of the cover for the mini player, or null (an image from another origin cannot be read back). */
function coverData(image: HTMLImageElement): string | null {
  if (image.hidden || !image.complete || !image.naturalWidth) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 124;
    canvas.getContext("2d")?.drawImage(image, 0, 0, 124, 124);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

export function initMediaBridge(player: Player, accent: () => string): void {
  const bridge = (window as unknown as { mediaVerse?: { player?: Bridge } }).mediaVerse?.player;
  if (!bridge) return;
  const cover = document.querySelector<HTMLImageElement>("#player-cover")!;
  const miniButton = document.querySelector<HTMLButtonElement>("#player-mini")!;
  let sent = "";
  let coverFor = "";
  let coverText: string | null = null;

  function publish(force = false): void {
    const view = player.view();
    const track = view.tracks[view.current];
    const info = player.state();
    const here = player.now();
    const key = track?.source_uri ?? "";
    if (key !== coverFor || (coverText === null && !cover.hidden)) {
      coverFor = key;
      coverText = coverData(cover);
    }
    const volume = player.controls.volume();
    const state = {
      title: track?.title ?? "",
      artist: track?.artist ?? "",
      album: track?.album ?? "",
      hasTrack: !!track,
      playing: !!track && !info.paused,
      canPrevious: player.controls.canPrevious(),
      canNext: player.controls.canNext(),
      position: here?.seconds ?? 0,
      duration: info.duration,
      volume: volume.volume,
      muted: volume.muted,
      accent: accent(),
      cover: coverText,
    };
    // The position moves every second; everything else only when it changes.
    const shape = JSON.stringify({ ...state, position: Math.floor(state.position), cover: !!state.cover });
    if (!force && shape === sent) return;
    sent = shape;
    bridge!.publish(state);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = track ? new MediaMetadata({ title: state.title, artist: state.artist, album: state.album }) : null;
        navigator.mediaSession.playbackState = state.playing ? "playing" : track ? "paused" : "none";
      } catch {
        // the system overlay is only a convenience
      }
    }
  }

  player.onChange(() => publish());
  player.onTime(() => publish());
  cover.addEventListener("load", () => {
    coverText = null;
    publish(true);
  });
  window.setInterval(() => publish(), 1000);

  bridge.onCommand((command) => {
    switch (command.action) {
      case "toggle":
        player.controls.toggle();
        break;
      case "play":
        if (player.state().paused) player.controls.toggle();
        break;
      case "pause":
      case "stop":
        player.pause();
        break;
      case "next":
        player.controls.next();
        break;
      case "previous":
        player.controls.previous();
        break;
      case "volume":
        if (typeof command.value === "number") player.controls.setVolume(command.value);
        break;
      case "seek":
        if (typeof command.value === "number") player.seek(command.value);
        break;
    }
    publish(true);
  });

  // The button that opens the mini player (only in the Windows program).
  miniButton.hidden = false;
  setIconButton(miniButton, "mini", "Mini player");
  miniButton.addEventListener("click", () => {
    void bridge.toggleMini().then((open) => miniButton.setAttribute("aria-pressed", String(open)));
  });
  bridge.onMiniChange((open) => {
    miniButton.setAttribute("aria-pressed", String(open));
    if (open) publish(true);
  });
  publish(true);
}
