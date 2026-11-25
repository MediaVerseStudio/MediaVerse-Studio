// The queue a cast device plays from this computer, with shuffle and repeat applied to it (the phone's CastQueue.kt, same
// rules: owner, 2026-11-11). Pure, so it is unit tested.
// Shuffle mixes the songs still to come (what was already played stays where it is); turning it off puts the original
// order back around the song that is playing. Repeat: off, all (the queue starts again at its end), one (the same song
// again when it ends).

export type Repeat = "off" | "all" | "one";

export class CastQueue<T> {
  items: T[];
  index: number;
  shuffle = false;
  repeat: Repeat = "off";
  private original: T[];

  private readonly random: () => number;

  constructor(items: readonly T[], start: number, random: () => number = Math.random) {
    this.random = random;
    this.items = [...items];
    this.original = this.items;
    this.index = Math.min(Math.max(0, start), Math.max(0, this.items.length - 1));
  }

  get current(): T {
    return this.items[this.index];
  }

  moveTo(i: number): void {
    this.index = Math.min(Math.max(0, i), this.items.length - 1);
  }

  /** Turns shuffle on or off; returns the new state. */
  toggleShuffle(): boolean {
    if (!this.shuffle) {
      this.original = this.items;
      const rest = this.items.slice(this.index + 1);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.items = [...this.items.slice(0, this.index + 1), ...rest];
      this.shuffle = true;
    } else {
      const now = this.current;
      this.items = this.original;
      const at = this.items.indexOf(now);
      this.index = at >= 0 ? at : Math.min(this.index, this.items.length - 1);
      this.shuffle = false;
    }
    return this.shuffle;
  }

  /** off, then all, then one, then off again. */
  cycleRepeat(): Repeat {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    return this.repeat;
  }

  /** The index to play when the current song has finished by itself; null when the queue is done. */
  afterEnd(): number | null {
    if (this.repeat === "one") return this.index;
    if (this.index + 1 < this.items.length) return this.index + 1;
    return this.repeat === "all" ? 0 : null;
  }

  /** The index for the Next button: the next song, or the first again when repeating all; null at the end. */
  afterNext(): number | null {
    if (this.index + 1 < this.items.length) return this.index + 1;
    return this.repeat !== "off" ? 0 : null;
  }
}
