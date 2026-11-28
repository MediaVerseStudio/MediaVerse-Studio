// "Play on a TV or speaker" (D76, D77): the TV button in the player bar sends what is playing (the queue, the song
// and the place in it) somewhere else, then works as that device's remote.
// - TVs with the MediaVerse Studio app open on this computer's library: the TV plays the queue itself and shows its
//   own Now Playing (wall, lyrics, cover colours). Same protocol as the phone's remote (D58).
// - DLNA TVs and speakers (anything that can play music on the home network, such as a Samsung TV without the app
//   or a WiiM amplifier): this computer tells the device one song at a time and moves on when it ends. Found only
//   with Settings > Cast's switch on (owner, 2026-11-06).
// Playing on the computer takes the music back. docs/casting-plan.md has the rest of the plan.

import type { CastDevice, RemoteCommand, RemoteDevice } from "./desktop-bridge";
import { CastQueue } from "./cast-queue";
import { serverLibrary } from "./library-mode";
import { openMenu, type MenuItem } from "./context-menu";
import { el } from "./dom";
import { setIconButton } from "./icons";
import type { PlayableTrack } from "./play-queue";
import type { Player } from "./player";

const SEARCH_KEY = "mediaverse.cast.search";
const SEARCH_EVERY_MS = 2 * 60_000;
const POLL_MS = 2000;
const POLL_NEAR_END_MS = 500;

type Casting =
  | { kind: "app"; id: string; name: string }
  | {
      kind: "dlna";
      id: string;
      name: string;
      /** The songs, with shuffle and repeat applied (the same rules as the phone's). */
      queue: CastQueue<PlayableTrack>;
      playing: boolean;
      position: number;
      duration: number;
      started: number;
      /** Gapless: the device takes the next song ahead of time (Google Cast) and starts it by itself. */
      canQueue: boolean;
      /** The queue index of the song the device was told to play next, or null. */
      nextIndex: number | null;
      /** The device's own number for the song it plays (a different one later means it moved on by itself). */
      itemAtLoad: number;
      stoppedPolls: number;
      /** The device volume, 0 to 1, or -1 when unknown. */
      volume: number;
    };

export function searchAllowed(): boolean {
  try {
    return localStorage.getItem(SEARCH_KEY) === "1";
  } catch {
    return false;
  }
}

export function initPlayOnTv(playerBar: HTMLElement, player: Player, openTvSettings: () => void, note: (text: string) => void, settingsBox: HTMLElement | null = null): void {
  const audio = player.signal; // the song playing now, whichever output plays it
  const share = window.mediaVerse?.share;
  if (!share?.remoteDevices || !share.remoteSend) return; // an older preload, or not in the app
  const toggles = playerBar.querySelector<HTMLElement>(".player-toggles");
  const button = el("button", "icon-button");
  button.type = "button";
  button.id = "player-tv";
  setIconButton(button, "tv", "Play on a TV or speaker");
  toggles?.prepend(button);

  let apps: RemoteDevice[] = [];
  let renderers: CastDevice[] = [];
  let searching: Promise<void> | null = null;
  let searchedAt = 0;
  let casting: Casting | null = null;
  let handingBack = false;
  let poll: number | undefined;

  const plain = (thrown: unknown): string => String((thrown as Error)?.message ?? thrown).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  const refreshApps = async (): Promise<void> => {
    // The TVs with the app play songs from this computer's files: not offered when the Jellyfin server alone is the library (D173); Google Cast and DLNA play them from the server.
    apps = serverLibrary() ? [] : ((await share.remoteDevices!().catch(() => [])) ?? []);
    if (casting?.kind === "app" && !apps.some((d) => d.id === casting!.id)) {
      note(`${casting.name} closed MediaVerse Studio.`);
      end();
    }
    show();
  };
  share.onRemoteChange?.(() => void refreshApps());

  /** Looks for DLNA TVs and speakers (only with the Settings switch on). */
  function search(): Promise<void> {
    if (!searchAllowed() || !share?.castDiscover) {
      renderers = [];
      return Promise.resolve();
    }
    searching ??= share
      .castDiscover()
      .then((found) => {
        renderers = found;
        searchedAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => (searching = null));
    return searching;
  }
  window.setInterval(() => {
    if (searchAllowed() && !document.hidden) void search();
  }, SEARCH_EVERY_MS);

  function show(): void {
    button.classList.toggle("is-on", casting !== null);
    const label = casting ? `Playing on ${casting.name}` : "Play on a TV or speaker";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function end(): void {
    window.clearTimeout(poll);
    poll = undefined;
    casting = null;
    show();
  }

  async function sendApp(id: string, command: RemoteCommand): Promise<boolean> {
    try {
      await share!.remoteSend!(id, command);
      return true;
    } catch (thrown) {
      note(`The TV could not be reached: ${plain(thrown)}`);
      return false;
    }
  }

  async function control(id: string, action: "play" | "pause" | "stop" | "seek" | "volume", value?: number): Promise<void> {
    try {
      await share!.castControl!(id, action, value);
    } catch (thrown) {
      note(plain(thrown));
    }
  }

  // ---- A TV with the app ----
  async function handOffApp(device: RemoteDevice): Promise<void> {
    const view = player.view();
    if (!view.tracks.length) return note("Choose something to play first, then send it to the TV.");
    const sent = await sendApp(device.id, { action: "play", paths: view.tracks.map((t) => t.source_uri), index: Math.max(0, view.current), position_ms: Math.round((audio.currentTime || 0) * 1000) });
    if (!sent) return;
    casting = { kind: "app", id: device.id, name: shortName(device.name) };
    player.pause();
    show();
    note(`Playing on ${casting.name}. Use the TV button for its controls, or play here to take the music back.`);
  }

  // ---- A Google Cast or DLNA TV or speaker: this computer sends the songs and follows the device ----
  type Dlna = Extract<Casting, { kind: "dlna" }>;

  async function playOn(target: Dlna, index: number, startSeconds = 0): Promise<void> {
    const track = target.queue.items[index];
    if (!track) {
      note(`The queue has finished on ${target.name}.`);
      end();
      return;
    }
    target.queue.moveTo(index);
    target.playing = true;
    target.position = startSeconds;
    target.duration = 0;
    target.started = Date.now();
    target.nextIndex = null;
    target.itemAtLoad = 0;
    target.stoppedPolls = 0;
    try {
      const reply = await share!.castLoad!(target.id, track.source_uri, startSeconds);
      target.canQueue = reply.queued === true;
      note(`Playing on ${target.name}: ${track.title}${track.artist ? ` — ${track.artist}` : ""}`);
      await preloadAhead(target);
    } catch (thrown) {
      note(`${target.name}: ${plain(thrown)}`);
      if (casting === target && Date.now() - target.started < 5000 && index === target.queue.index) end();
    }
  }

  /** Tells the device which song follows this one, when it can take it ahead of time: it then starts it by itself, with no gap. */
  async function preloadAhead(target: Dlna): Promise<void> {
    if (!target.canQueue || target.queue.repeat === "one" || casting !== target) return; // one song repeated: loaded again when it ends
    const after = target.queue.afterEnd();
    if (after === null) return;
    try {
      const reply = await share!.castPreload!(target.id, target.queue.items[after].source_uri);
      if (reply.ok && casting === target) target.nextIndex = after;
    } catch {
      // the next song is loaded when the end is seen, as with any device
    }
  }

  /** The device started the song it was told about: the queue moves on without a load. */
  function deviceMovedOn(target: Dlna, itemId: number, position: number): void {
    if (target.nextIndex === null) return;
    target.queue.moveTo(target.nextIndex);
    const track = target.queue.current;
    target.nextIndex = null;
    target.itemAtLoad = itemId;
    target.started = Date.now();
    target.position = position;
    target.duration = 0;
    target.stoppedPolls = 0;
    note(`Playing on ${target.name}: ${track.title}${track.artist ? ` — ${track.artist}` : ""}`);
    void preloadAhead(target);
  }

  /** The song that follows changed (shuffle or repeat): the device was told the old one, so the current song is loaded again at its place. */
  function reloadHere(target: Dlna): void {
    if (target.nextIndex === null) return;
    void playOn(target, target.queue.index, target.position);
  }

  async function handOffDlna(device: CastDevice): Promise<void> {
    const view = player.view();
    if (!view.tracks.length) return note("Choose something to play first, then send it to the TV or speaker.");
    const target: Dlna = {
      kind: "dlna",
      id: device.id,
      name: device.name,
      queue: new CastQueue(view.tracks, Math.max(0, view.current)),
      playing: true,
      position: 0,
      duration: 0,
      started: Date.now(),
      canQueue: false,
      nextIndex: null,
      itemAtLoad: 0,
      stoppedPolls: 0,
      volume: -1,
    };
    casting = target;
    player.pause();
    show();
    await playOn(target, target.queue.index, audio.currentTime || 0);
    schedule(target);
  }

  /** Asks the device again: every two seconds, but every half second in the last ten seconds of a song, so the next song
   * starts as soon as the end is seen (the phone does the same; D122). */
  function schedule(target: Dlna): void {
    window.clearTimeout(poll);
    const nearEnd = target.duration > 0 && target.position >= target.duration - 10;
    poll = window.setTimeout(async () => {
      await check(target);
      if (casting === target) schedule(target);
    }, nearEnd ? POLL_NEAR_END_MS : POLL_MS);
  }

  /** Follows the device: where it is in the song, whether it moved on by itself, and on to the next song when one ends. */
  async function check(target: Dlna): Promise<void> {
    if (casting !== target) return;
    let status;
    try {
      status = await share!.castStatus!(target.id);
    } catch {
      return; // a missed answer; try again next time
    }
    if (casting !== target) return;
    if (typeof status.volume === "number" && status.volume >= 0) target.volume = status.volume;
    if (status.state === "PLAYING" || status.state === "PAUSED_PLAYBACK" || status.state === "TRANSITIONING") {
      target.stoppedPolls = 0;
      const item = status.itemId ?? 0;
      // The device's own number for the song loaded last, noted once it has had time to start it.
      if (target.itemAtLoad === 0 && item !== 0 && Date.now() - target.started > 800 && status.state !== "TRANSITIONING") target.itemAtLoad = item;
      // The song told to the device ahead of time began by itself: follow it without loading anything.
      if (target.nextIndex !== null && target.itemAtLoad !== 0 && item !== 0 && item !== target.itemAtLoad && status.state === "PLAYING") {
        deviceMovedOn(target, item, status.position);
        return;
      }
      if (status.state === "TRANSITIONING") return;
      target.playing = status.state === "PLAYING";
      if (status.duration) target.duration = status.duration;
      target.position = status.position;
      return;
    }
    // Stopped: the song ended (it was near its end, or a short song), so play the next; a song just sent may
    // still be starting. With a song queued on the device it may pass through "stopped" for a moment between two songs:
    // look again before loading.
    if (status.state === "STOPPED" || status.state === "NO_MEDIA_PRESENT") {
      target.stoppedPolls += 1;
      if (Date.now() - target.started > 6000 && (target.nextIndex === null || target.stoppedPolls >= 3)) {
        const nearEnd = target.duration > 0 ? target.position >= target.duration - 6 : true;
        if (target.playing && nearEnd) await playOn(target, target.queue.afterEnd() ?? target.queue.items.length);
        else target.playing = false;
      }
    }
  }

  /** Louder or quieter by a tenth (the device's own volume). */
  function nudgeVolume(target: Dlna, change: number): void {
    const level = Math.min(1, Math.max(0, (target.volume >= 0 ? target.volume : 0.3) + change));
    target.volume = level;
    void control(target.id, "volume", level);
  }

  function skip(target: Dlna, seconds: number): void {
    const place = Math.max(0, target.duration > 0 ? Math.min(target.duration - 1, target.position + seconds) : target.position + seconds);
    target.position = place;
    void control(target.id, "seek", place);
  }
  /** Plays here from where the TV or speaker is, and stops it there. */
  function bringBack(): void {
    if (!casting) return;
    const was = casting;
    handingBack = true;
    end();
    if (was.kind === "app") {
      const state = apps.find((d) => d.id === was.id)?.state;
      void sendApp(was.id, { action: "pause" });
      const view = player.view();
      const place = state?.path ? view.tracks.findIndex((t) => t.source_uri === state.path) : -1;
      if (place >= 0) player.play(view.tracks, place, (state!.position_ms + (state!.playing ? Date.now() - state!.at : 0)) / 1000);
      else void audio.play().catch(() => {});
    } else {
      void control(was.id, "stop");
      player.play(was.queue.items, was.queue.index, was.position);
    }
    handingBack = false;
  }

  // While casting, the player bar volume slider should control the cast device, not the local audio element.
  let volumeSyncTimer: number | undefined;
  audio.addEventListener("volumechange", () => {
    if (casting?.kind !== "dlna") return;
    const target = casting;
    const { volume: level, muted } = player.controls.volume();
    const effective = muted ? 0 : level;
    target.volume = effective;
    window.clearTimeout(volumeSyncTimer);
    volumeSyncTimer = window.setTimeout(() => void control(target.id, "volume", effective), 150);
  });

  // Playing here while something else plays: the music comes back here and the other device stops.
  audio.addEventListener("play", () => {
    if (casting && !handingBack) {
      const was = casting;
      end();
      if (was.kind === "app") void sendApp(was.id, { action: "pause" });
      else void control(was.id, "stop");
    }
  });

  button.addEventListener("click", async () => {
    await refreshApps();
    if (searchAllowed() && Date.now() - searchedAt > 30_000) await search();
    const box = button.getBoundingClientRect();
    const items: MenuItem[] = [];
    if (casting?.kind === "app") {
      const id = casting.id;
      const playing = apps.find((d) => d.id === id)?.state?.playing;
      items.push(
        { label: playing === false ? `Play on ${casting.name}` : `Pause on ${casting.name}`, action: () => void sendApp(id, { action: "toggle" }) },
        { label: "Next song", action: () => void sendApp(id, { action: "next" }) },
        { label: "Previous song", action: () => void sendApp(id, { action: "previous" }) },
        "separator",
        { label: "Bring the music back here", action: bringBack },
        { label: "Stop on the TV", action: () => {
          void sendApp(id, { action: "pause" });
          end();
        } },
      );
    } else if (casting?.kind === "dlna") {
      const target = casting;
      items.push(
        { label: target.playing ? `Pause on ${target.name}` : `Play on ${target.name}`, action: () => {
          void control(target.id, target.playing ? "pause" : "play");
          target.playing = !target.playing;
        } },
        { label: "Next song", action: () => void playOn(target, target.queue.afterNext() ?? target.queue.index), disabled: target.queue.afterNext() === null },
        { label: "Previous song", action: () => void playOn(target, target.position > 4 ? target.queue.index : Math.max(0, target.queue.index - 1)) },
        { label: "Back 15 seconds", action: () => skip(target, -15) },
        { label: "Forward 15 seconds", action: () => skip(target, 15) },
        "separator",
        { label: `Shuffle: ${target.queue.shuffle ? "on" : "off"}`, action: () => {
          target.queue.toggleShuffle();
          note(`Shuffle ${target.queue.shuffle ? "on" : "off"} on ${target.name}.`);
          reloadHere(target);
        } },
        { label: `Repeat: ${target.queue.repeat}`, action: () => {
          target.queue.cycleRepeat();
          note(`Repeat ${target.queue.repeat} on ${target.name}.`);
          reloadHere(target);
        } },
        { label: target.volume >= 0 ? `Louder (now ${Math.round(target.volume * 100)}%)` : "Louder", action: () => nudgeVolume(target, 0.1) },
        { label: "Quieter", action: () => nudgeVolume(target, -0.1) },
        "separator",
        { label: "Bring the music back here", action: bringBack },
        { label: `Stop on ${target.name}`, action: () => {
          void control(target.id, "stop");
          end();
        } },
      );
    } else {
      const status = await share.status().catch(() => null);
      if (!status?.enabled) {
        items.push({ label: "Share the library with TVs first…", action: openTvSettings });
      } else {
        for (const device of apps) items.push({ label: `Play on ${shortName(device.name)} (MediaVerse app)`, action: () => void handOffApp(device) });
        for (const device of renderers) items.push({ label: `Play on ${device.name}${device.kind ? ` (${device.kind})` : ""}`, action: () => void handOffDlna(device) });
        if (!apps.length && !renderers.length) {
          items.push({ label: searchAllowed() ? "No TV or speaker found" : "No TV has MediaVerse Studio open", action: () => {}, disabled: true });
        }
        items.push("separator");
        if (searchAllowed()) items.push({ label: "Search again", action: () => void search().then(() => button.click()) });
        else items.push({ label: "Find TVs and speakers without the app…", action: openCastSettings });
      }
    }
    openMenu(box.left, box.top - 8, items, "Play on a TV or speaker");
    const menu = document.querySelector<HTMLElement>(".ctx-menu");
    if (menu) menu.style.top = `${Math.max(4, box.top - menu.getBoundingClientRect().height - 6)}px`;
  });

  function openCastSettings(): void {
    document.querySelector<HTMLButtonElement>("[data-page=settings]")?.click();
    document.querySelector<HTMLButtonElement>("[data-settings-section=cast]")?.click();
  }

  // Settings > Cast: the switch that allows searching the home network (off until turned on).
  if (settingsBox) {
    const row = el("label", "check cast-switch");
    const box = el("input");
    box.type = "checkbox";
    box.checked = searchAllowed();
    const words = el("span");
    words.append(
      el("strong", undefined, "Look for TVs and speakers on my home network (Google Cast and DLNA)"),
      el("span", "field-hint", " Chromecasts, Google TVs, smart TVs with Google Cast or DLNA, and network speakers and amplifiers (such as Nest, WiiM, Sonos, Denon HEOS, Yamaha MusicCast) can then be chosen from the TV button. They fetch the music from this computer, so “Share my library with TVs” (under TV) must be on too. Off until you turn it on."),
    );
    box.addEventListener("change", () => {
      try {
        localStorage.setItem(SEARCH_KEY, box.checked ? "1" : "0");
      } catch {
        // kept for this session only
      }
      if (box.checked) void search();
      else renderers = [];
    });
    row.append(box, words);
    settingsBox.querySelector(".cast-switch-slot")?.replaceWith(row);
  }

  void refreshApps();
  void search();
}

/** "Bedroom TV (192.168.68.77)" → "Bedroom TV". */
function shortName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "") || name;
}
