// Exclusive (WASAPI) output, the page's side (D186). When it is switched on in Settings > Sound, a song in the music folder that the
// program can play this way (FLAC, MP3, WAV) is played by the program itself straight to the sound card, and the page only steers it: the
// `NativeDeck` below stands in for the <audio> element (current time, pause, volume, "ended") while the sound comes from the program.
// A song that cannot be played this way is played the ordinary way, so nothing ever fails because of this setting.
// This file has no imports, so it is tested on its own (native-output.test.ts).

export type NativePrefs = { exclusive: boolean; /** The sound card's id, or "" for the one Windows uses. */ device: string };
export const DEFAULT_NATIVE_PREFS: NativePrefs = { exclusive: false, device: "" };

export function cleanNativePrefs(raw: unknown): NativePrefs {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    exclusive: source.exclusive === true,
    device: typeof source.device === "string" && source.device.length < 400 ? source.device : "",
  };
}

export type NativeInfo = {
  rate: number;
  /** The depth of the song itself. */
  bits: number;
  container_bits: number;
  valid_bits: number;
  channels: number;
  device: string | null;
  /** True while what reaches the card is the file's own sound (full volume, no bits dropped). */
  bit_perfect: boolean;
  duration_ms: number | null;
};

export type NativeStatus = Partial<NativeInfo> & {
  state: "idle" | "playing" | "paused" | "ended" | "error";
  token: number;
  position_ms: number;
  /** How long ago the program took this reading. */
  age_ms: number;
  error: string | null;
};

export type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const EXTENSIONS = new Set(["flac", "mp3", "wav"]);

/** Whether a song is one the program can play to the card: a local FLAC, MP3 or WAV file (the program checks the folder itself). */
export function nativeEligible(uri: string): boolean {
  if (!uri || /^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return false;
  const dot = uri.lastIndexOf(".");
  return dot > 0 && EXTENSIONS.has(uri.slice(dot + 1).toLowerCase());
}

/** "96 kHz, 24-bit". */
export function describeFormat(info: Pick<NativeInfo, "rate" | "bits" | "container_bits" | "valid_bits">): string {
  const khz = info.rate / 1000;
  const rate = `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
  return `${rate}, ${info.bits}-bit`;
}

/** The line shown under the switch: what the last song was played as. */
export function describeInfo(info: NativeInfo | null, problem: string | null): string {
  if (!info) return problem ?? "No song has been played this way yet.";
  const parts = [`Playing exclusively at ${describeFormat(info)}${info.device ? ` through ${info.device}` : ""}.`];
  if (info.bit_perfect) parts.push("Bit-perfect: the card receives exactly what is in the file.");
  else if (info.valid_bits < info.bits) parts.push(`The card only takes ${info.valid_bits} bits, so the sound is rounded to that.`);
  else parts.push("The volume is below full, so the sound is scaled (turn it to the top and use the speakers' own volume for bit-perfect).");
  return parts.join(" ");
}

type Playing = { token: number; uri: string };

/** Looks like an <audio> element to the player, for the parts the player uses; the sound itself is made by the program. */
export class NativeDeck extends EventTarget {
  volume = 1;
  muted = false;
  playbackRate = 1;
  /** Why the last song fell back to the ordinary player (for the settings page), or null. */
  lastProblem: string | null = null;
  lastInfo: NativeInfo | null = null;

  private seq = 0;
  private current: Playing | null = null;
  private upcoming: Playing | null = null;
  private pausedNow = true;
  private durationSeconds = Number.NaN;
  private anchor = { ms: 0, at: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Readings from the program taken just before a command took effect are not trusted. */
  private ignoreUntil = 0;
  private ended = false;
  private failures = 0;
  private polling = false;

  private readonly call: Call;
  private readonly clock: () => number;
  private readonly device: () => string;
  private readonly interval: number;

  constructor(call: Call, clock: () => number = () => performance.now(), device: () => string = () => "", interval = 120) {
    super();
    this.call = call;
    this.clock = clock;
    this.device = device;
    this.interval = interval;
  }

  /** True while a song is loaded in the program. */
  get loaded(): boolean {
    return this.current !== null;
  }

  get paused(): boolean {
    return this.pausedNow;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  get currentTime(): number {
    const elapsed = this.pausedNow ? 0 : this.clock() - this.anchor.at;
    let seconds = (this.anchor.ms + elapsed) / 1000;
    if (Number.isFinite(this.durationSeconds)) seconds = Math.min(seconds, this.durationSeconds);
    return Math.max(0, seconds);
  }

  set currentTime(seconds: number) {
    if (!this.current || !Number.isFinite(seconds)) return;
    this.setAnchor(Math.max(0, seconds) * 1000);
    this.ended = false;
    void this.send({ action: "seek", ms: Math.round(Math.max(0, seconds) * 1000) });
    this.dispatchEvent(new Event("seeked"));
  }

  /** The file the program is playing now, or null. */
  currentUri(): string | null {
    return this.current?.uri ?? null;
  }

  /** Whether the song the deck is playing now is this one (it already started on its own when the last one ended). */
  owns(uri: string): boolean {
    return this.current?.uri === uri;
  }

  /** Starts a song. Returns what the sound card was opened as, or null when this song has to be played the ordinary way. */
  async open(uri: string, startSeconds: number, play: boolean): Promise<NativeInfo | null> {
    const token = ++this.seq;
    this.upcoming = null;
    this.ignoreUntil = this.clock() + 400;
    try {
      const reply = await this.call<NativeInfo & { deferred?: boolean }>("native_audio_open", {
        path: uri,
        token,
        start_ms: Math.round(Math.max(0, startSeconds) * 1000),
        play,
        device: this.device() || null,
      });
      if (token !== this.seq) return reply; // a newer song was asked for meanwhile; the program plays that one
      this.current = { token, uri };
      this.ended = false;
      this.failures = 0;
      this.lastProblem = null;
      if (!(reply as { deferred?: boolean }).deferred) this.lastInfo = reply;
      this.durationSeconds = reply.duration_ms ? reply.duration_ms / 1000 : Number.NaN;
      this.pausedNow = !play;
      this.setAnchor(Math.max(0, startSeconds) * 1000);
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("durationchange"));
      this.dispatchEvent(new Event(play ? "play" : "pause"));
      if (play) this.dispatchEvent(new Event("playing"));
      this.sendVolume();
      this.start();
      return reply;
    } catch (error) {
      this.lastProblem = problemText(error);
      return null;
    }
  }

  /** Tells the program which song follows, so it starts on the very next sample; null cancels. */
  async queueNext(uri: string | null): Promise<void> {
    if (!this.current) return;
    if ((uri ?? null) === (this.upcoming?.uri ?? null)) return;
    if (!uri) {
      this.upcoming = null;
      await this.call("native_audio_next", { token: 0 }).catch(() => undefined);
      return;
    }
    const token = ++this.seq;
    this.upcoming = { token, uri };
    try {
      await this.call("native_audio_next", { path: uri, token });
    } catch {
      if (this.upcoming?.token === token) this.upcoming = null; // the next song is then started the ordinary way when this one ends
    }
  }

  async play(): Promise<void> {
    if (!this.current) throw new Error("Nothing is loaded.");
    this.pausedNow = false;
    this.ended = false;
    this.setAnchor(this.anchor.ms);
    this.ignoreUntil = this.clock() + 400;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    await this.send({ action: "play" });
  }

  pause(): void {
    if (!this.current || this.pausedNow) return;
    const here = this.currentTime * 1000;
    this.pausedNow = true;
    this.setAnchor(here);
    void this.send({ action: "pause" });
    this.dispatchEvent(new Event("pause"));
  }

  /** Lets the card go. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) void this.send({ action: "stop" });
    this.current = null;
    this.upcoming = null;
    this.seq += 1;
    if (!this.pausedNow) {
      this.pausedNow = true;
      this.dispatchEvent(new Event("pause"));
    }
  }

  /** Sets the volume the program applies (the page's volume bar, mute); at full volume the sound is untouched. */
  setLevel(volume: number, muted: boolean): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.muted = muted;
    this.sendVolume();
    this.dispatchEvent(new Event("volumechange"));
  }

  private sendVolume(): void {
    if (this.current) void this.send({ action: "volume", volume: this.volume, muted: this.muted });
  }

  private setAnchor(ms: number): void {
    this.anchor = { ms, at: this.clock() };
  }

  private async send(args: Record<string, unknown>): Promise<void> {
    await this.call("native_audio_control", args);
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.interval);
  }

  /** Reads the program's status once: moves the clock, notices the next song starting, the end, or trouble. Public for tests. */
  async poll(): Promise<void> {
    if (!this.current || this.polling) return;
    this.polling = true;
    let status: NativeStatus;
    try {
      status = await this.call<NativeStatus>("native_audio_status");
    } catch (error) {
      this.polling = false;
      this.failures += 1;
      if (this.failures >= 3) this.giveUp(problemText(error));
      return;
    } finally {
      this.polling = false;
    }
    this.failures = 0;
    if (!this.current) return;
    if (status.state === "error") {
      this.giveUp(status.error ?? "The sound card stopped playing.");
      return;
    }
    if (this.upcoming && status.token === this.upcoming.token && status.state !== "idle") {
      // the next song took over on its own, exactly where the last one ended
      this.current = this.upcoming;
      this.upcoming = null;
      this.ended = false;
      this.durationSeconds = status.duration_ms ? status.duration_ms / 1000 : Number.NaN;
      this.setAnchor((status.position_ms ?? 0) + (status.age_ms ?? 0));
      this.ignoreUntil = 0;
      this.dispatchEvent(new Event("advanced"));
      return;
    }
    if (status.token !== this.current.token) return;
    this.updateInfo(status);
    if (status.duration_ms) this.durationSeconds = status.duration_ms / 1000;
    if (status.state === "ended") {
      if (!this.ended && !this.pausedNow) {
        this.ended = true;
        this.pausedNow = true;
        this.setAnchor(Number.isFinite(this.durationSeconds) ? this.durationSeconds * 1000 : this.anchor.ms);
        this.dispatchEvent(new Event("ended"));
      }
      return;
    }
    if (this.clock() >= this.ignoreUntil) this.setAnchor((status.position_ms ?? 0) + (this.pausedNow ? 0 : (status.age_ms ?? 0)));
    this.dispatchEvent(new Event("timeupdate"));
  }

  private updateInfo(status: NativeStatus): void {
    if (status.rate === undefined || status.bits === undefined || status.container_bits === undefined || status.valid_bits === undefined) return;
    const next: NativeInfo = {
      rate: status.rate,
      bits: status.bits,
      container_bits: status.container_bits,
      valid_bits: status.valid_bits,
      channels: status.channels ?? 2,
      device: status.device ?? null,
      bit_perfect: status.bit_perfect === true,
      duration_ms: status.duration_ms ?? null,
    };
    if (!this.lastInfo || this.lastInfo.bit_perfect !== next.bit_perfect || this.lastInfo.rate !== next.rate || this.lastInfo.bits !== next.bits) {
      this.lastInfo = next;
      this.dispatchEvent(new Event("info"));
    }
  }

  private giveUp(reason: string): void {
    const seconds = this.currentTime;
    this.lastProblem = reason;
    this.stop();
    this.dispatchEvent(new CustomEvent("fallback", { detail: { seconds, reason } }));
  }
}

/** A readable reason from whatever the bridge threw. */
export function problemText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") return (error as { message: string }).message;
  return typeof error === "string" ? error : "The sound card could not be used.";
}
