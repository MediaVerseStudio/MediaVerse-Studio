// Pure queue logic for the player: order, shuffle, repeat and what is saved between sessions.
// No DOM, so it is unit tested.

export type PlayableTrack = { title: string; artist: string | null; source_uri: string; album?: string | null };
export type RepeatMode = "off" | "all" | "one";

/** The address the page uses to ask the app for a library file (served by electron/media-access.js). */
export function mediaUrl(sourcePath: string): string {
  // A song of the Jellyfin server (D173): the program fetches it from the server (electron/jellyfin-stream.js).
  const server = /^jellyfin:[A-Za-z0-9_-]{1,64}\/([0-9a-f]{32})$/i.exec(sourcePath);
  if (server) return `mediaverse-media://jellyfin/${server[1]!.toLowerCase()}`;
  return `mediaverse-media://library/?path=${encodeURIComponent(sourcePath)}`;
}

export type SavedPlayer = {
  items: PlayableTrack[];
  index: number; // index into `items` of the current track
  seconds: number;
  shuffle: boolean;
  repeat: RepeatMode;
};

/** Checks data read back from storage; anything odd is dropped rather than trusted. */
export function readSavedPlayer(raw: unknown): SavedPlayer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > 5000) return null;
  const items: PlayableTrack[] = [];
  for (const entry of data.items) {
    const item = entry as Record<string, unknown>;
    if (typeof item?.title !== "string" || typeof item?.source_uri !== "string") return null;
    items.push({
      title: item.title,
      artist: typeof item.artist === "string" ? item.artist : null,
      source_uri: item.source_uri,
      album: typeof item.album === "string" ? item.album : null,
    });
  }
  const index = typeof data.index === "number" && Number.isInteger(data.index) && data.index >= 0 && data.index < items.length ? data.index : 0;
  const seconds = typeof data.seconds === "number" && Number.isFinite(data.seconds) && data.seconds >= 0 ? data.seconds : 0;
  const repeat: RepeatMode = data.repeat === "all" || data.repeat === "one" ? data.repeat : "off";
  return { items, index, seconds, shuffle: data.shuffle === true, repeat };
}

export class PlayQueue {
  private items: PlayableTrack[] = [];
  private order: number[] = [];
  private position = -1; // index into `order`
  private shuffled = false;
  private repeatMode: RepeatMode = "off";

  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  /** Replace the queue and start at `index`. Shuffle and repeat settings are kept. */
  start(items: PlayableTrack[], index = 0): PlayableTrack | null {
    this.items = [...items];
    if (items.length === 0) {
      this.order = [];
      this.position = -1;
      return null;
    }
    const first = Math.min(Math.max(index, 0), items.length - 1);
    this.arrange(first);
    return this.current();
  }

  /** Rebuild `order` with `first` as the current track: in sequence, or shuffled with it first. */
  private arrange(first: number): void {
    const indices = this.items.map((_, i) => i);
    if (this.shuffled) {
      const rest = indices.filter((i) => i !== first);
      for (let i = rest.length - 1; i > 0; i -= 1) {
        const j = Math.floor(this.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = [first, ...rest];
      this.position = 0;
    } else {
      this.order = indices;
      this.position = first;
    }
  }

  current(): PlayableTrack | null {
    return this.items[this.order[this.position]] ?? null;
  }

  /** The next track. `automatic` is true when the last one just ended (repeat-one applies then). */
  next(automatic = false): PlayableTrack | null {
    if (this.items.length === 0) return null;
    if (automatic && this.repeatMode === "one") return this.current();
    if (this.position + 1 < this.order.length) {
      this.position += 1;
    } else if (this.repeatMode === "all") {
      this.arrange(this.shuffled ? this.order[this.position] : 0);
      if (this.shuffled && this.order.length > 1) {
        // A fresh shuffled round should not begin with the track that just played.
        this.position = 1;
      }
    } else {
      return null;
    }
    return this.current();
  }

  /** The next `count` songs in the order they will be played (so the player can load them ahead); none while one song repeats. */
  upcoming(count: number): PlayableTrack[] {
    if (this.items.length === 0 || count <= 0 || this.repeatMode === "one") return [];
    const out: PlayableTrack[] = [];
    for (let step = 1; step <= count; step += 1) {
      let place = this.position + step;
      if (place >= this.order.length) {
        if (this.repeatMode !== "all") break;
        place %= this.order.length;
      }
      const track = this.items[this.order[place]];
      if (track) out.push(track);
    }
    return out;
  }

  previous(): PlayableTrack | null {
    if (this.position > 0) {
      this.position -= 1;
      return this.current();
    }
    return this.repeatMode === "all" && this.order.length > 0 ? ((this.position = this.order.length - 1), this.current()) : null;
  }

  setShuffle(on: boolean): void {
    if (on === this.shuffled) return;
    this.shuffled = on;
    if (this.items.length > 0) this.arrange(this.order[this.position]);
  }

  setRepeat(mode: RepeatMode): void {
    this.repeatMode = mode;
  }

  get shuffle(): boolean {
    return this.shuffled;
  }

  get repeat(): RepeatMode {
    return this.repeatMode;
  }

  get length(): number {
    return this.items.length;
  }

  /** The 0-based place of the current track in the order it will be played. */
  get index(): number {
    return this.position;
  }

  /** The tracks in the order they will be played, and where the current one is. */
  view(): { tracks: PlayableTrack[]; current: number } {
    return { tracks: this.order.map((i) => this.items[i]), current: this.position };
  }

  /** Go straight to the track at `place` in the play order. */
  jump(place: number): PlayableTrack | null {
    if (!Number.isInteger(place) || place < 0 || place >= this.order.length) return null;
    this.position = place;
    return this.current();
  }

  /**
   * Puts `tracks` straight after the current one ("Play next"), or at the end ("Add to queue"). With nothing
   * queued they simply become the queue; returns true then, so the caller starts playing.
   */
  add(tracks: PlayableTrack[], where: "next" | "end"): boolean {
    if (tracks.length === 0) return false;
    if (this.items.length === 0) {
      this.start(tracks, 0);
      return true;
    }
    const first = this.items.length;
    this.items.push(...tracks);
    const added = tracks.map((_, i) => first + i);
    if (where === "next") this.order.splice(this.position + 1, 0, ...added);
    else this.order.push(...added);
    return false;
  }

  /**
   * Takes the song at `place` in the play order out of the queue (owner, 2026-11-06: as on the TV and the phone).
   * The song playing stays: it is what is on. Returns whether anything was removed.
   */
  remove(place: number): boolean {
    if (!Number.isInteger(place) || place < 0 || place >= this.order.length || place === this.position) return false;
    const slot = this.order[place];
    this.order.splice(place, 1);
    this.items.splice(slot, 1);
    this.order = this.order.map((i) => (i > slot ? i - 1 : i));
    if (place < this.position) this.position -= 1;
    return true;
  }

  get hasNext(): boolean {
    return this.position + 1 < this.order.length || this.repeatMode === "all";
  }

  get hasPrevious(): boolean {
    return this.position > 0 || (this.repeatMode === "all" && this.order.length > 0);
  }

  snapshot(seconds: number): SavedPlayer | null {
    if (this.items.length === 0) return null;
    // In play order when not shuffled, so songs put in with "Play next" keep their place after a restart.
    if (!this.shuffled) return { items: this.order.map((i) => this.items[i]), index: this.position, seconds, shuffle: false, repeat: this.repeatMode };
    return { items: this.items, index: this.order[this.position], seconds, shuffle: this.shuffled, repeat: this.repeatMode };
  }

  restore(saved: SavedPlayer): PlayableTrack | null {
    this.shuffled = saved.shuffle;
    this.repeatMode = saved.repeat;
    return this.start(saved.items, saved.index);
  }
}
