// The one Web Audio graph the player's sound goes through (owner's list 2026-11-23, issues #5, #6): each of the two audio elements has its own fade gain and
// its own levelling gain (the song's volume-levelling gain from the loudness scan), then both go through one ten-band equalizer and the analyser the glow
// follows, to the speakers. It is built when the first song plays (the browser allows sound only after the person has done something); if Web Audio is not
// available the music plays as before, without levelling, equalizer or crossfade ramps.

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_LIMIT_DB = 12;

export type EqSetting = { on: boolean; gains: number[] };

export function cleanEq(value: unknown): EqSetting {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const gains = Array.isArray(v.gains) ? v.gains : [];
  return {
    on: v.on === true,
    gains: EQ_BANDS.map((_, i) => {
      const g = Number(gains[i]);
      return Number.isFinite(g) ? Math.min(EQ_LIMIT_DB, Math.max(-EQ_LIMIT_DB, Math.round(g))) : 0;
    }),
  };
}

/** Decibels to the multiplier Web Audio's gain nodes take. */
export const dbToGain = (db: number): number => 10 ** (db / 20);

type Deck = { element: HTMLAudioElement; fade: GainNode; level: GainNode };

export type AudioGraph = {
  /** Lets the graph carry this element's sound. Call for both elements before the first song plays. */
  attach: (element: HTMLAudioElement) => void;
  /** Builds the graph if it is not built, and starts the audio clock (call when a song is about to play). */
  wake: () => void;
  analyser: () => AnalyserNode | null;
  available: () => boolean;
  /** Sets an element's fade gain at once (0 to 1), cancelling any ramp. */
  setFade: (element: HTMLAudioElement, gain: number) => void;
  /** Ramps an element's fade gain to `to` over `seconds`. */
  fadeTo: (element: HTMLAudioElement, to: number, seconds: number) => void;
  /** An element's levelling gain in dB (0 for none). With `rampSeconds` the change glides there instead of jumping (a gain that arrives while the song plays). */
  setLevelDb: (element: HTMLAudioElement, db: number, rampSeconds?: number) => void;
  setEq: (setting: EqSetting) => void;
};

export function createAudioGraph(): AudioGraph {
  const pending: HTMLAudioElement[] = [];
  const decks = new Map<HTMLAudioElement, Deck>();
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let filters: BiquadFilterNode[] = [];
  let failed = false;
  let eq: EqSetting = { on: false, gains: EQ_BANDS.map(() => 0) };
  const levels = new Map<HTMLAudioElement, number>();

  function applyEq(): void {
    filters.forEach((filter, i) => {
      filter.gain.value = eq.on ? (eq.gains[i] ?? 0) : 0;
    });
  }

  function build(): void {
    if (context || failed) return;
    try {
      const ctx = new AudioContext();
      const bus = ctx.createGain();
      filters = EQ_BANDS.map((frequency, i) => {
        const filter = ctx.createBiquadFilter();
        filter.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
        filter.frequency.value = frequency;
        filter.Q.value = 1.1;
        return filter;
      });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.45; // low enough that single beats come through
      // The default range (-100 to -30 dB) pins loud, compressed music at full scale; this leaves headroom.
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;
      let last: AudioNode = bus;
      for (const filter of filters) {
        last.connect(filter);
        last = filter;
      }
      last.connect(analyser);
      analyser.connect(ctx.destination);
      for (const element of pending) {
        const fade = ctx.createGain();
        const level = ctx.createGain();
        ctx.createMediaElementSource(element).connect(fade);
        fade.connect(level);
        level.connect(bus);
        decks.set(element, { element, fade, level });
        level.gain.value = dbToGain(levels.get(element) ?? 0);
      }
      context = ctx;
      applyEq();
    } catch {
      failed = true;
      context = null;
      analyser = null;
      decks.clear();
    }
  }

  return {
    attach(element) {
      if (!pending.includes(element)) pending.push(element);
    },
    wake() {
      build();
      if (context && context.state === "suspended") void context.resume().catch(() => undefined);
    },
    analyser: () => analyser,
    available: () => context !== null,
    setFade(element, gain) {
      const deck = decks.get(element);
      if (!deck || !context) return;
      deck.fade.gain.cancelScheduledValues(context.currentTime);
      deck.fade.gain.value = gain;
    },
    fadeTo(element, to, seconds) {
      const deck = decks.get(element);
      if (!deck || !context) return;
      const now = context.currentTime;
      deck.fade.gain.cancelScheduledValues(now);
      deck.fade.gain.setValueAtTime(deck.fade.gain.value, now);
      deck.fade.gain.linearRampToValueAtTime(to, now + Math.max(0.01, seconds));
    },
    setLevelDb(element, db, rampSeconds = 0) {
      levels.set(element, db);
      const deck = decks.get(element);
      if (!deck || !context) return;
      const param = deck.level.gain;
      param.cancelScheduledValues(context.currentTime);
      if (rampSeconds > 0) {
        param.setValueAtTime(param.value, context.currentTime);
        param.linearRampToValueAtTime(dbToGain(db), context.currentTime + rampSeconds);
      } else {
        param.value = dbToGain(db);
      }
    },
    setEq(setting) {
      eq = setting;
      applyEq();
    },
  };
}
