// The player bar: plays a queue of library tracks through an <audio> element, with shuffle, repeat,
// and a remembered queue, position and volume. All text is set with textContent. Audio comes from the
// app's own `mediaverse-media` scheme, which only serves audio files inside the music library folder.
// Saved state lives in this window's own storage only (never sent anywhere) and is optional: if
// storage is unavailable the player simply starts empty.

import { createAudioCache } from "./audio-cache";
import { clockText } from "./clock-format";
import { setIconButton } from "./icons";
import { coverUrl } from "./cover-art";
import { playedThreshold } from "./home-format";
import { PlayQueue, type PlayableTrack, type RepeatMode, mediaUrl, readSavedPlayer } from "./play-queue";
import { invoke } from "./desktop-bridge";
import { nativeEligible } from "./native-output";
import { fetchLevels, graph, levelKnown, nativeDeck, nativePrefs, onNativePrefs, soundPrefs } from "./sound";
import { fadeFor, shouldHandOver, startLatency } from "./sound-handover";

const QUEUE_KEY = "mediaverse.player.v1";
const VOLUME_KEY = "mediaverse.volume.v1";
/** Where the playing song had got to, saved every few seconds on its own (the queue itself only when it changes). */
const POSITION_KEY = "mediaverse.player-position.v1";
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };
const REPEAT_LABEL: Record<RepeatMode, string> = { off: "Repeat: off", all: "Repeat: all songs", one: "Repeat: this song" };

function readStorage(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable or full; remembering is a convenience only.
  }
}

/** What the screen-care, glow and "Play on the TV" code need to know of the sound: paused or not, how far on, and play/pause/ended events, whichever output is playing. */
export type PlaybackSignal = EventTarget & { readonly paused: boolean; readonly currentTime: number; play(): Promise<void> };

export type Player = {
  /** The song playing now, told the way an audio element tells it (it follows the sound from one output to the next). */
  signal: PlaybackSignal;
  /** Plays a queue from `index`, optionally starting `startSeconds` in and stopping at `stopAtSeconds` (a short sample). */
  play: (tracks: PlayableTrack[], index: number, startSeconds?: number, stopAtSeconds?: number) => void;
  stopIfPlaying: (paths: string[]) => void;
  /** The queue in play order and the place of the current track in it. */
  view: () => { tracks: PlayableTrack[]; current: number };
  jump: (place: number) => void;
  /** Called whenever the current track or the queue settings change. */
  onChange: (listener: () => void) => void;
  /** Called as playback moves (about four times a second) with the position in milliseconds. */
  onTime: (listener: (ms: number) => void) => void;
  /** Called once per track when it has been listened to long enough to count as played. */
  onPlayed: (listener: (track: PlayableTrack) => void) => void;
  /** Jump to a place in the current track, in seconds. */
  seek: (seconds: number) => void;
  /** The track now loaded and how far into it the listener is. */
  now: () => { track: PlayableTrack; seconds: number } | null;
  pause: () => void;
  /** Carries on playing the loaded track (after a pause). */
  resume: () => void;
  /** Whether the loaded track is paused, its length in seconds (0 until known) and the speed it plays at (1 is normal; the pitch is kept). */
  state: () => { paused: boolean; duration: number; rate: number };
  setRate: (rate: number) => void;
  /** "Play next" (straight after the current song) or "Add to queue" (at the end); starts playing if nothing is queued. */
  enqueue: (tracks: PlayableTrack[], where: "next" | "end") => void;
  /** Takes the song at `place` in the play order out of the queue (not the one playing). */
  remove: (place: number) => void;
  /** What the media keys, the taskbar buttons and the mini player need (issue #8). */
  controls: {
    toggle: () => void;
    next: () => void;
    previous: () => void;
    setVolume: (volume: number) => void;
    volume: () => { volume: number; muted: boolean };
    canPrevious: () => boolean;
    canNext: () => boolean;
  };
};

export function initPlayer(root: HTMLElement): Player {
  // Two audio elements take turns (owner's list 2026-11-23, gapless and crossfade): `audio` is the one the person hears as the current song; the other is kept
  // ready with the next song and takes over a moment before the current one ends (see sound-handover.ts).
  const primary = root.querySelector<HTMLAudioElement>("#player-audio")!;
  const secondary = document.createElement("audio");
  secondary.hidden = true;
  primary.after(secondary);
  let audio = primary;
  let spare = secondary;
  // With exclusive output switched on (Settings > Sound) the program itself plays the song straight to the sound card and `deck` stands in for the audio
  // element (see native-output.ts); songs it cannot play that way go through the elements as usual.
  const deck = nativeDeck;
  let usingNative = false;
  const out = (): HTMLAudioElement | typeof deck => (usingNative ? deck : audio);
  for (const element of [primary, secondary]) {
    // CORS mode, so the analyser may read the sound (the media scheme sends the matching header).
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    graph.attach(element);
  }
  const title =root.querySelector<HTMLElement>("#player-title")!;
  const detail = root.querySelector<HTMLElement>("#player-detail")!;
  const previousButton = root.querySelector<HTMLButtonElement>("#player-previous")!;
  const nextButton = root.querySelector<HTMLButtonElement>("#player-next")!;
  const shuffleButton = root.querySelector<HTMLButtonElement>("#player-shuffle")!;
  const repeatButton = root.querySelector<HTMLButtonElement>("#player-repeat")!;
  const cover = root.querySelector<HTMLImageElement>("#player-cover")!;
  setIconButton(previousButton, "previous", "Previous song");
  const playButton = root.querySelector<HTMLButtonElement>("#player-play")!;
  const elapsed = root.querySelector<HTMLElement>("#player-elapsed")!;
  const lengthLabel = root.querySelector<HTMLElement>("#player-duration")!;
  const seekBar = root.querySelector<HTMLInputElement>("#player-seek")!;
  const muteButton = root.querySelector<HTMLButtonElement>("#player-mute")!;
  const volumeBar = root.querySelector<HTMLInputElement>("#player-volume")!;
  setIconButton(nextButton, "next", "Next song");
  const queue = new PlayQueue();
  // Songs are read whole into memory before they play, and the next ones ahead of time (owner, 2026-11-23: no waiting when moving about in a song or going to the next).
  const cache = createAudioCache({
    fetchBlob: async (uri) => {
      const reply = await fetch(mediaUrl(uri));
      if (!reply.ok) throw new Error(`The song could not be read (${reply.status}).`);
      return reply.blob();
    },
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  });
  /** How many of the songs after this one are loaded ahead. */
  const AHEAD = 2;
  const listeners: (() => void)[] = [];
  const playedListeners: ((track: PlayableTrack) => void)[] = [];
  const timeListeners: ((ms: number) => void)[] = [];
  let reported: PlayableTrack | null = null;
  let restoreSeconds = 0;
  let stopAt: number | null = null; // end of a short sample, in seconds into the track

  // Performance: the queue can be thousands of songs, and saving all of it every 5 seconds while music plays
  // made the page stutter (and can fill the browser's storage). The queue is saved when it changes; the
  // position on its own every few seconds.
  let savedQueue = "";
  function save(): void {
    const snapshot = queue.snapshot(out().currentTime || 0);
    if (!snapshot) return;
    const shape = `${snapshot.items.length}:${snapshot.items[0]?.source_uri ?? ""}:${snapshot.items.at(-1)?.source_uri ?? ""}:${snapshot.index}:${snapshot.shuffle}:${snapshot.repeat}`;
    if (shape !== savedQueue) {
      savedQueue = shape;
      writeStorage(QUEUE_KEY, snapshot);
    }
    writeStorage(POSITION_KEY, { index: snapshot.index, seconds: snapshot.seconds });
  }

  function updateButtons(): void {
    previousButton.disabled = !queue.hasPrevious;
    nextButton.disabled = !queue.hasNext;
    setIconButton(shuffleButton, "shuffle", queue.shuffle ? "Shuffle: on" : "Shuffle: off");
    shuffleButton.setAttribute("aria-pressed", String(queue.shuffle));
    shuffleButton.classList.toggle("is-on", queue.shuffle);
    setIconButton(repeatButton, queue.repeat === "one" ? "repeat-one" : "repeat", REPEAT_LABEL[queue.repeat]);
    repeatButton.classList.toggle("is-on", queue.repeat !== "off");
  }

  function show(track: PlayableTrack | null, autoplay = true): void {
    root.hidden = false;
    if (!track) return;
    handedOver = false;
    if (!inHandOver) stopSpare(); // a song chosen by the person ends any overlap in progress
    reported = null;
    stopAt = null;
    title.textContent = track.title;
    detail.textContent = `${track.artist ?? "Unknown artist"} · ${queue.index + 1} of ${queue.length}`;
    attach(track, autoplay);
    cover.hidden = true;
    void coverUrl(track.source_uri, true).then((url) => {
      if (url && queue.current() === track) {
        cover.src = url;
        cover.hidden = false;
      }
    });
    updateButtons();
    save();
    for (const listener of listeners) listener();
  }

  /** The songs after the one playing are loaded ahead (and the one before it kept, for "previous"). */
  function warmAhead(): void {
    const current = queue.current();
    if (!current) return;
    const ahead = queue.upcoming(AHEAD);
    void fetchLevels([current.source_uri, ...ahead.map((t) => t.source_uri)]); // their volume-levelling gains, so each song starts at its right volume
    cache.warm(ahead.map((t) => t.source_uri), [current.source_uri, ...ahead.map((t) => t.source_uri), ...(queue.view().tracks[queue.index - 1] ? [queue.view().tracks[queue.index - 1]!.source_uri] : [])]);
  }

  /** Which song the audio element is being given: a newer one makes an older, slower read give up. */
  let attachment = 0;
  /** True while two songs overlap in a crossfade. */
  let fading = false;
  let fadeTimer = 0;
  let handedOver = false;
  let inHandOver = false;
  const latencies: number[] = [];

  /**
   * The volume-levelling gain the loudness scan worked out for the song (with its whole album). It is normally known before the song starts (asked for the
   * songs about to play, see `warmAhead`), so the song starts at its right volume. If it is not known, the song waits a moment for it rather than changing
   * volume under the listener's ears; a gain that still arrives late glides in over a few seconds.
   */
  async function applyLevel(track: PlayableTrack, element: HTMLAudioElement, wait: boolean): Promise<void> {
    const uri = track.source_uri;
    const known = levelKnown(uri);
    if (known !== undefined) {
      graph.setLevelDb(element, known);
      return;
    }
    graph.setLevelDb(element, 0);
    const asked = fetchLevels([uri]);
    if (wait) await Promise.race([asked, new Promise((resolve) => window.setTimeout(resolve, 700))]);
    const now = levelKnown(uri);
    if (now !== undefined && queue.current() === track) graph.setLevelDb(element, now);
    else void asked.then(() => {
      const late = levelKnown(uri);
      if (late !== undefined && queue.current() === track) graph.setLevelDb(element, late, 3);
    });
  }
  /** Lets the spare element hold the next song ahead of time, so it can start the moment it is needed. */
  function prepareSpare(): void {
    const next = queue.repeat === "one" ? undefined : queue.upcoming(1)[0];
    if (!next || fading) return;
    const url = cache.ready(next.source_uri);
    if (url && spare.getAttribute("src") !== url) {
      spare.src = url;
      spare.load();
    }
    graph.setLevelDb(spare, levelKnown(next.source_uri) ?? 0); // the next song is at its own volume before it starts
  }

  function stopSpare(): void {
    window.clearTimeout(fadeTimer);
    fading = false;
    spare.pause();
    graph.setFade(spare, 1);
  }

  /** Starts the next song on the spare element and lets the old one finish (or fade). */
  function handOver(next: PlayableTrack): void {
    handedOver = true;
    const seconds = fadeFor(soundPrefs(), Number.isFinite(audio.duration) ? audio.duration : 0);
    const outgoing = audio;
    audio = spare;
    spare = outgoing;
    const promised = queue.next(true);
    if (!promised) {
      audio = outgoing;
      spare = audio === primary ? secondary : primary;
      return;
    }
    if (seconds > 0 && graph.available()) {
      fading = true;
      graph.setFade(audio, 0);
      graph.fadeTo(audio, 1, seconds);
      graph.fadeTo(spare, 0, seconds);
    }
    audio.volume = outgoing.volume;
    audio.muted = outgoing.muted;
    audio.playbackRate = outgoing.playbackRate;
    const asked = performance.now();
    audio.addEventListener("playing", () => latencies.push((performance.now() - asked) / 1000), { once: true });
    inHandOver = true;
    show(promised);
    inHandOver = false;
    window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => {
      fading = false;
      spare.pause();
      graph.setFade(spare, 1);
    }, Math.max(seconds, 0.2) * 1000 + 600);
    void next;
  }

  /** Looks about 100 times a second for the moment to start the next song (a coarser look could step over the last few hundredths of a second). */
  window.setInterval(() => {
    if (usingNative || audio.paused || !audio.getAttribute("src")) return; // exclusive output joins songs inside the program, on the very sample
    const next = queue.repeat === "one" ? undefined : queue.upcoming(1)[0];
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const ready = !!next && !!cache.ready(next.source_uri);
    if (ready && !handedOver) prepareSpare();
    if (
      next &&
      shouldHandOver({ prefs: soundPrefs(), remaining: duration - audio.currentTime, duration, paused: audio.paused, nextReady: ready && !!spare.getAttribute("src"), sample: stopAt !== null, latency: startLatency(latencies), alreadyHandedOver: handedOver })
    ) {
      handOver(next);
    }
  }, 10);

  /**
   * Gives the audio element the song, from memory: the whole file is read first (at once when it was loaded ahead), so moving about in it never waits.
   * If the read is slow (a huge file over a slow network) or fails, the song is streamed from the file instead after a few seconds.
   */
  function attach(track: PlayableTrack, autoplay: boolean): void {
    const mine = ++attachment;
    if (nativeWanted(track)) {
      void attachNative(track, autoplay, mine);
      return;
    }
    if (usingNative) {
      deck.stop(); // the sound card is let go
      usingNative = false;
    }
    attachElement(track, autoplay, mine);
  }

  /** Whether this song is to be played by the program straight to the sound card (Settings > Sound > Sound output). */
  function nativeWanted(track: PlayableTrack): boolean {
    return nativePrefs().exclusive && nativeEligible(track.source_uri) && audio.playbackRate === 1;
  }

  /** The song after this one, if it can follow on the very sample (repeat-one loops the same song). */
  function queueNativeNext(): void {
    if (!usingNative || !deck.loaded) return;
    const next = queue.repeat === "one" ? queue.current() : queue.upcoming(1)[0];
    void deck.queueNext(next && nativeWanted(next) ? next.source_uri : null);
    // a following song that cannot be played this way is read into memory ahead of time like any other
    if (next && !nativeWanted(next)) warmAhead();
  }

  /** True after the program started the next song by itself, until the page has moved its queue on. */
  let advancedByProgram = false;

  async function attachNative(track: PlayableTrack, autoplay: boolean, mine: number): Promise<void> {
    stopSpare();
    audio.pause(); // the elements stay quiet while the program plays
    const startAt = restoreSeconds;
    restoreSeconds = 0;
    root.classList.remove("is-loading");
    if (usingNative && advancedByProgram && deck.owns(track.source_uri)) {
      advancedByProgram = false; // it is already playing: it started on the last song's final sample
      paintTransport();
      queueNativeNext();
      return;
    }
    advancedByProgram = false;
    usingNative = true;
    paintTransport();
    const info = await deck.open(track.source_uri, startAt, autoplay);
    if (mine !== attachment) return; // another song was chosen meanwhile
    if (!info) {
      // this song is played the usual way (a card that refuses it, another program using the card, a file the program cannot open)
      usingNative = false;
      restoreSeconds = startAt;
      attachElement(track, autoplay, mine);
      return;
    }
    paintTransport();
    queueNativeNext();
  }

  function attachElement(track: PlayableTrack, autoplay: boolean, mine: number): void {
    const uri = track.source_uri;
    let started = false;
    const start = (url: string): void => {
      if (mine !== attachment || started) return;
      started = true;
      root.classList.remove("is-loading");
      if (audio.getAttribute("src") !== url) audio.src = url; // the spare element may already hold it (loaded ahead for a gapless start)
      graph.wake();
      if (!fading) graph.setFade(audio, 1);
      const element = audio;
      void applyLevel(track, element, autoplay && !inHandOver).then(() => {
        if (mine !== attachment || element !== audio) return;
        if (autoplay) {
          void element.play().catch(() => {
            detail.textContent = "This track could not be played.";
          });
        }
        paintTransport();
      });
    };
    const ready = cache.ready(uri);
    if (ready) {
      start(ready);
      warmAhead();
      return;
    }
    // Stop the old song while the new one is read.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    root.classList.add("is-loading");
    paintTransport();
    const fallback = window.setTimeout(() => start(mediaUrl(uri)), 4000);
    cache.load(uri).then(
      (url) => {
        window.clearTimeout(fallback);
        start(url);
        if (mine === attachment) warmAhead();
      },
      () => {
        window.clearTimeout(fallback);
        start(mediaUrl(uri));
      },
    );
  }

  /** The queue changed around the song playing (added to, or a song taken out): the count, buttons, save, views. */
  function queueChanged(): void {
    const current = queue.current();
    if (current) detail.textContent = `${current.artist ?? "Unknown artist"} · ${queue.index + 1} of ${queue.length}`;
    updateButtons();
    save();
    for (const listener of listeners) listener();
    warmAhead(); // a song put next in line is loaded ahead too
  }

  previousButton.addEventListener("click", () => {
    // Like most players: past the first few seconds, "previous" restarts the track.
    if (out().currentTime > 3) {
      out().currentTime = 0;
      return;
    }
    const track = queue.previous();
    if (track) show(track);
  });
  nextButton.addEventListener("click", () => {
    const track = queue.next();
    if (track) show(track);
  });
  shuffleButton.addEventListener("click", () => {
    queue.setShuffle(!queue.shuffle);
    updateButtons();
    save();
    queueNativeNext(); // the song that follows has changed
  });
  repeatButton.addEventListener("click", () => {
    queue.setRepeat(NEXT_REPEAT[queue.repeat]);
    updateButtons();
    save();
    queueNativeNext();
  });
  // The elements and the exclusive-output deck are all listened to, but only the one that is the current song drives the queue, the time and the saved state.
  for (const element of [primary, secondary, deck] as const) {
    element.addEventListener("ended", () => {
      if (element !== out()) return; // the song that was handed over from has finished its last moment
      const track = queue.next(true);
      if (track) show(track);
    });
    element.addEventListener("error", () => {
      if (element !== out()) return;
      detail.textContent = "This track could not be played (is the file still in your library?).";
    });
    element.addEventListener("loadedmetadata", () => {
      if (element !== out() || element === deck) return; // the deck is given its place when the song is opened
      if (restoreSeconds > 0 && restoreSeconds < audio.duration) audio.currentTime = restoreSeconds;
      restoreSeconds = 0;
    });
    element.addEventListener("timeupdate", () => {
      if (element !== out()) return;
      const now = out();
      if (stopAt !== null && now.currentTime >= stopAt) {
        stopAt = null;
        now.pause();
      }
      for (const listener of timeListeners) listener(Math.round(now.currentTime * 1000));
      const current = queue.current();
      if (current && reported !== current && now.currentTime >= playedThreshold(now.duration) && !now.paused) {
        reported = current;
        for (const listener of playedListeners) listener(current);
      }
    });
    element.addEventListener("pause", () => {
      if (element === out()) save();
    });
    element.addEventListener("volumechange", () => {
      if (element === primary) writeStorage(VOLUME_KEY, primary.volume);
    });
  }
  // The program started the next song itself, on the last one's final sample: the queue moves on without opening it again.
  deck.addEventListener("advanced", () => {
    if (!usingNative) return;
    const track = queue.next(true);
    if (!track) return;
    advancedByProgram = true;
    show(track);
  });
  // The program could not carry on (the card was taken, unplugged...): the song continues the usual way from where it had got to.
  deck.addEventListener("fallback", (event) => {
    if (!usingNative) return;
    usingNative = false;
    const track = queue.current();
    if (!track) return;
    restoreSeconds = (event as CustomEvent<{ seconds: number }>).detail.seconds;
    attachElement(track, true, ++attachment);
  });
  window.setInterval(() => {
    if (!out().paused) save();
  }, 5000);
  window.addEventListener("beforeunload", save);

  // ---- The controls (ours, in the accent colour, like the TV's): play/pause, the time, a progress bar, the volume ----
  let scrubbing = false;
  let frame = 0;
  let drawnPlaying: boolean | null = null;
  const fill = (input: HTMLInputElement, fraction: number): void => {
    input.style.setProperty("--fill", `${Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100}%`);
  };

  function paintTransport(): void {
    const now = out();
    const length = Number.isFinite(now.duration) ? now.duration : 0;
    const here = scrubbing ? Number(seekBar.value) : now.currentTime || 0;
    if (!scrubbing) {
      seekBar.max = String(length || 1);
      seekBar.value = String(here);
    }
    fill(seekBar, length ? here / length : 0);
    seekBar.disabled = length === 0;
    elapsed.textContent = root.classList.contains("is-loading") ? "Loading…" : clockText(here);
    lengthLabel.textContent = clockText(length || null);
    const playing = !now.paused && (usingNative || audio.src !== "");
    if (playing !== drawnPlaying) {
      drawnPlaying = playing; // the icon is drawn again only when it changes, not every frame
      setIconButton(playButton, playing ? "pause" : "play", playing ? "Pause" : "Play", true);
    }
  }

  /** While the song plays the bar moves smoothly (every frame), not four times a second. */
  function follow(): void {
    window.cancelAnimationFrame(frame);
    paintTransport();
    if (!out().paused) frame = window.requestAnimationFrame(follow);
  }

  /** The volume the person chose, held the same on both elements and the exclusive output. */
  function setVolume(level: number, muted: boolean): void {
    for (const element of [primary, secondary]) {
      element.muted = muted;
      element.volume = level;
    }
    deck.setLevel(level, muted);
  }

  function paintVolume(): void {
    const level = primary.muted ? 0 : primary.volume;
    volumeBar.value = String(level);
    fill(volumeBar, level);
    setIconButton(muteButton, level === 0 ? "mute" : "volume", level === 0 ? "Sound on" : "Mute");
  }

  playButton.addEventListener("click", () => {
    if (!usingNative && !audio.getAttribute("src")) return; // nothing loaded (or still being read)
    if (usingNative && !deck.loaded) return;
    if (out().paused) {
      void out()
        .play()
        .catch(() => {
          detail.textContent = "This track could not be played.";
        });
    } else {
      stopSpare();
      out().pause();
    }
  });
  seekBar.addEventListener("input", () => {
    scrubbing = true;
    paintTransport();
  });
  seekBar.addEventListener("change", () => {
    scrubbing = false;
    if (Number.isFinite(out().duration)) out().currentTime = Number(seekBar.value);
    paintTransport();
  });
  volumeBar.addEventListener("input", () => setVolume(Number(volumeBar.value), false));
  muteButton.addEventListener("click", () => {
    const muted = !primary.muted;
    setVolume(!muted && primary.volume === 0 ? 0.5 : primary.volume, muted);
  });
  for (const element of [primary, secondary, deck] as const) {
    element.addEventListener("play", follow);
    for (const name of ["pause", "ended", "durationchange", "loadedmetadata", "emptied", "seeked"] as const) element.addEventListener(name, follow);
    element.addEventListener("volumechange", paintVolume);
  }

  const volume = readStorage(VOLUME_KEY);
  if (typeof volume === "number" && volume >= 0 && volume <= 1) setVolume(volume, false);
  paintVolume();
  paintTransport();

  // Bring back the last queue, paused where it was.
  const saved = readSavedPlayer(readStorage(QUEUE_KEY));
  if (saved) {
    const position = readStorage(POSITION_KEY) as { index?: unknown; seconds?: unknown } | null;
    restoreSeconds = position && position.index === saved.index && typeof position.seconds === "number" ? position.seconds : saved.seconds;
    show(queue.restore(saved), false);
  } else {
    updateButtons();
  }

  // What the screen care, the glow and "Play on the TV" watch: whichever output is playing now, told like one audio element.
  const signal = new EventTarget() as PlaybackSignal;
  Object.defineProperties(signal, {
    paused: { get: () => out().paused },
    currentTime: { get: () => out().currentTime },
    play: { value: () => out().play() },
  });
  for (const element of [primary, secondary, deck] as const) {
    for (const name of ["play", "playing", "pause", "ended"] as const) {
      element.addEventListener(name, () => {
        if (element === out()) signal.dispatchEvent(new Event(name));
      });
    }
  }
  // Volume changes (slider or mute) are forwarded so cast sessions can follow them.
  primary.addEventListener("volumechange", () => signal.dispatchEvent(new Event("volumechange")));

  // Exclusive output switched on or off (or another sound card chosen) in Settings: the song playing carries on from where it is, through the new output.
  let lastNative = JSON.stringify(nativePrefs());
  onNativePrefs(() => {
    const now = JSON.stringify(nativePrefs());
    if (now === lastNative) return;
    lastNative = now;
    const track = queue.current();
    if (!track || !(usingNative || nativeWanted(track))) return;
    const wasPlaying = !out().paused;
    restoreSeconds = out().currentTime;
    const counted = reported;
    stopSpare();
    if (usingNative) {
      deck.stop();
      usingNative = false;
    }
    show(track, wasPlaying);
    reported = counted; // it is the same listen, not a new one
  });

  return {
    signal,
    play(tracks, index, startSeconds = 0, stopAtSeconds) {
      restoreSeconds = startSeconds;
      show(queue.start(tracks, index));
      stopAt = stopAtSeconds ?? null;
    },
    view: () => queue.view(),
    jump(place) {
      restoreSeconds = 0;
      show(queue.jump(place));
    },
    onChange(listener) {
      listeners.push(listener);
    },
    onTime(listener) {
      timeListeners.push(listener);
    },
    onPlayed(listener) {
      playedListeners.push(listener);
    },
    seek(seconds) {
      if (Number.isFinite(seconds) && seconds >= 0) out().currentTime = seconds;
    },
    pause() {
      stopSpare();
      out().pause();
    },
    controls: {
      toggle: () => playButton.click(),
      next: () => nextButton.click(),
      previous: () => previousButton.click(),
      setVolume(volume) {
        setVolume(Math.min(1, Math.max(0, volume)), false);
      },
      volume: () => ({ volume: primary.volume, muted: primary.muted }),
      canPrevious: () => queue.hasPrevious || out().currentTime > 3,
      canNext: () => queue.hasNext,
    },
    resume() {
      void out()
        .play()
        .catch(() => {
          detail.textContent = "This track could not be played.";
        });
    },
    state: () => ({ paused: out().paused, duration: Number.isFinite(out().duration) ? out().duration : 0, rate: usingNative ? 1 : audio.playbackRate }),
    setRate(rate) {
      if (usingNative) return; // exclusive output plays at normal speed
      if (Number.isFinite(rate) && rate >= 0.25 && rate <= 2) {
        audio.preservesPitch = true;
        audio.playbackRate = rate;
      }
    },
    enqueue(tracks, where) {
      if (queue.add(tracks, where)) {
        restoreSeconds = 0;
        show(queue.current());
        return;
      }
      queueChanged();
    },
    remove(place) {
      if (queue.remove(place)) queueChanged();
    },
    now() {
      const track = queue.current();
      return track ? { track, seconds: out().currentTime || 0 } : null;
    },
    /** Lets go of a file that is about to be edited (Windows will not replace a file that is playing). */
    stopIfPlaying(paths) {
      cache.forget(paths); // the file is about to change: a copy held in memory would be stale
      const current = queue.current();
      if (usingNative && deck.loaded && (paths.includes(deck.currentUri() ?? "") || (current && paths.includes(current.source_uri)))) {
        deck.stop();
        usingNative = false;
      }
      if (current && paths.includes(current.source_uri)) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    },
  };
}
