// Settings > Display and motion: how much the picture moves, and the screen-care timers (D32). Kept on this
// computer (display-prefs.ts). All text is set with textContent.

import type { Ambient } from "./ambient";
import { DRIFT_SWATCH, applyMask, loadMask, saveMask } from "../tv/background-mask.ts";
import { ACCENT_CHOICES, type DisplayPrefs, LYRICS_SIZE_STEPS, type Motion, NOW_PLAYING_CHOICES, SLEEP_CHOICES, saveDisplayPrefs } from "./display-prefs";
import { el } from "./dom";

const MOTION_CHOICES: { value: Motion; label: string; hint: string }[] = [
  { value: "full", label: "Full motion", hint: "The tint drifts, covers flip now and then, and a glow along the bottom moves with the music." },
  { value: "gentle", label: "Gentle", hint: "The same, slower and softer." },
  { value: "still", label: "Still", hint: "No flips and no glow; the tint stays put. Burn-in protection still applies. Windows' reduce-motion setting always means Still." },
];

const minutes = (n: number, never: string): string => (n === 0 ? never : `After ${n} minute${n === 1 ? "" : "s"}`);

export function renderDisplaySettings(root: HTMLElement, ambient: Ambient, showAccent: (hex: string) => void): void {
  const save = (change: Partial<DisplayPrefs>): void => {
    const next = { ...ambient.prefs(), ...change };
    saveDisplayPrefs(next);
    ambient.setPrefs(next);
    showAccent(next.accent);
  };
  const prefs = ambient.prefs();
  root.className = "settings-block";
  root.replaceChildren(el("h3", undefined, "Display and motion"), el("p", "field-hint", "These choices belong to this computer's screen."));

  const motion = el("fieldset", "settings-radios");
  motion.append(el("legend", "field-label", "How much the picture moves"));
  for (const choice of MOTION_CHOICES) {
    const row = el("label", "check");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "display-motion";
    radio.checked = prefs.motion === choice.value;
    radio.addEventListener("change", () => save({ motion: choice.value }));
    const text = el("span");
    text.append(el("strong", undefined, choice.label), el("span", "field-hint", ` ${choice.hint}`));
    row.append(radio, text);
    motion.append(row);
  }
  root.append(motion);

  // Windows turns its animation effects off in a virtual machine and over remote desktop, and then the program would never move: this lets it ignore that.
  const ignoreRow = el("label", "check");
  const ignoreBox = el("input");
  ignoreBox.type = "checkbox";
  ignoreBox.checked = prefs.ignoreSystemMotion;
  ignoreBox.addEventListener("change", () => save({ ignoreSystemMotion: ignoreBox.checked }));
  const ignoreText = el("span");
  ignoreText.append(
    el("strong", undefined, "Ignore Windows' reduce-motion setting"),
    el("span", "field-hint", " Windows' \"Animation effects\" switch (Settings > Accessibility > Visual effects) stops the lucky jukebox's spin and the cover flips. A virtual machine or a remote desktop session usually has it off without anyone choosing that. Tick this to let the program move as chosen above. Leave it off if you turned animations off because motion bothers you."),
  );
  ignoreRow.append(ignoreBox, ignoreText);
  root.append(ignoreRow);

  // How large the lyrics are in Now Playing (owner, 2026-11-17): the standard size in the middle, three steps either way.
  const lyricsBox = el("div", "field lyrics-size");
  const lyricsLabel = el("label", undefined, "Lyrics size in Now Playing");
  lyricsLabel.htmlFor = "display-lyrics-size";
  const slider = el("input");
  slider.type = "range";
  slider.id = "display-lyrics-size";
  slider.min = String(-LYRICS_SIZE_STEPS);
  slider.max = String(LYRICS_SIZE_STEPS);
  slider.step = "1";
  slider.value = String(prefs.lyricsSize);
  const sizeName = el("span", "field-hint");
  const showSize = (): void => {
    const step = Number(slider.value);
    sizeName.textContent = step === 0 ? "Standard" : `${step < 0 ? "Smaller" : "Larger"} by ${Math.abs(step)} step${Math.abs(step) === 1 ? "" : "s"}`;
    slider.setAttribute("aria-valuetext", sizeName.textContent);
  };
  slider.addEventListener("input", showSize);
  slider.addEventListener("change", () => save({ lyricsSize: Number(slider.value) }));
  showSize();
  const sizeRow = el("div", "lyrics-size-row");
  sizeRow.append(el("span", "field-hint", "Smaller"), slider, el("span", "field-hint", "Larger"), sizeName);
  lyricsBox.append(lyricsLabel, sizeRow, el("p", "field-hint", "The lyrics in the full-screen Now Playing. Open it to see the change."));
  root.append(lyricsBox);

  // The highlight colour (D72): 16 bright 70s/80s/90s shades as swatches (radio buttons, so arrow keys move
  // between them). Now Playing uses the cover's colour instead.
  const colours = el("fieldset", "accent-choices");
  colours.append(el("legend", "field-label", "Highlight colour"));
  const swatches = el("div", "accent-swatches");
  const chosenName = el("p", "field-hint accent-name");
  const nameOf = (hex: string): string => ACCENT_CHOICES.find((c) => c.hex === hex)?.name ?? "";
  chosenName.textContent = nameOf(prefs.accent);
  for (const choice of ACCENT_CHOICES) {
    const swatch = el("label", "accent-swatch");
    swatch.title = choice.name;
    swatch.style.setProperty("--swatch", choice.hex);
    const radio = el("input");
    radio.type = "radio";
    radio.name = "display-accent";
    radio.value = choice.hex;
    radio.checked = prefs.accent === choice.hex;
    radio.setAttribute("aria-label", choice.name);
    radio.addEventListener("change", () => {
      chosenName.textContent = choice.name;
      save({ accent: choice.hex });
    });
    swatch.append(radio);
    swatches.append(swatch);
  }
  colours.append(swatches, chosenName, el("p", "field-hint", "Buttons, the progress bar and highlights use this colour. Now Playing takes its colours from the album cover instead."));
  root.append(colours);

  // The colour mask over the wall of covers (owner, 2026-11-11): on is the Zune look, off shows the covers in their own
  // colours; the colour below it is drifting or one of the same swatches.
  let mask = loadMask("mediaverse.mask", true);
  const maskBox = el("fieldset", "accent-choices");
  maskBox.append(el("legend", "field-label", "Background colour mask"));
  const maskRow = el("label", "check");
  const maskToggle = el("input");
  maskToggle.type = "checkbox";
  maskToggle.checked = mask.on;
  maskRow.append(maskToggle, el("span", undefined, "Wash the album covers behind the pages with one colour"));
  const maskSwatches = el("div", "accent-swatches");
  const maskName = el("p", "field-hint accent-name");
  const maskNameOf = (hex: string | null): string => (hex ? nameOf(hex) : "Drifting: the colour changes slowly");
  const showMask = (): void => {
    applyMask(document.documentElement, mask);
    saveMask("mediaverse.mask", mask);
    maskName.textContent = mask.on ? maskNameOf(mask.hex) : "Off: the covers show in their own colours.";
    for (const input of maskSwatches.querySelectorAll("input")) input.disabled = !mask.on;
  };
  maskToggle.addEventListener("change", () => {
    mask = { ...mask, on: maskToggle.checked };
    showMask();
  });
  for (const choice of [{ hex: null as string | null, name: "Drifting" }, ...ACCENT_CHOICES]) {
    const swatch = el("label", "accent-swatch");
    swatch.title = choice.name;
    swatch.style.setProperty("--swatch", choice.hex ?? DRIFT_SWATCH);
    const radio = el("input");
    radio.type = "radio";
    radio.name = "display-mask-hue";
    radio.checked = mask.hex === choice.hex;
    radio.setAttribute("aria-label", choice.name);
    radio.addEventListener("change", () => {
      mask = { ...mask, hex: choice.hex };
      showMask();
    });
    swatch.append(radio);
    maskSwatches.append(swatch);
  }
  maskBox.append(maskRow, maskSwatches, maskName);
  root.append(maskBox);
  showMask();

  const select = (label: string, hint: string, choices: readonly number[], current: number, never: string, onPick: (n: number) => void): HTMLElement => {
    const field = el("div", "field");
    const id = `display-${label.replace(/\W+/g, "-").toLowerCase()}`;
    const title = el("label", undefined, label);
    title.htmlFor = id;
    const box = el("select");
    box.id = id;
    for (const n of choices) {
      const option = el("option", undefined, minutes(n, never));
      option.value = String(n);
      option.selected = n === current;
      box.append(option);
    }
    box.addEventListener("change", () => onPick(Number(box.value)));
    field.append(title, box, el("p", "field-hint", hint));
    return field;
  };
  root.append(
    select("Show Now Playing when idle", "While music plays and nobody has touched the computer, the full-screen Now Playing opens by itself.", NOW_PLAYING_CHOICES, prefs.nowPlayingIdleMinutes, "Never", (n) => save({ nowPlayingIdleMinutes: n })),
    select("Fade the screen to black", "When nothing is playing and nobody has touched the computer. Protects OLED screens; any key or mouse movement brings the picture back.", SLEEP_CHOICES, prefs.sleepMinutes, "Never", (n) => save({ sleepMinutes: n })),
  );
}
