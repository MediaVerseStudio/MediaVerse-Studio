// Settings > Sound: volume levelling (worked out for whole albums by the loudness scan), gapless playback and crossfade, and the ten-band equalizer. The scan
// runs in the program's own background thread; this page only starts it and reads how far it has got. All text is set with textContent.

import { EQ_BANDS, EQ_LIMIT_DB } from "./audio-graph";
import { invoke } from "./desktop-bridge";
import { runJob } from "./jobs";
import { createProgress, progressCounts } from "./progress-bar";
import { el } from "./dom";
import { autoDjOn, setAutoDj } from "./auto-dj";
import { describeInfo } from "./native-output";
import { eqSetting, forgetLevels, nativeDeck, nativePrefs, saveEq, saveNativePrefs, saveSoundPrefs, soundPrefs } from "./sound";
import { MAX_CROSSFADE } from "./sound-handover";

type Mode = "off" | "gentle" | "standard";
type LevelStatus = { running: boolean; tracks_done?: number; tracks_total?: number; failed?: number; measured: number; mode: Mode };

export const LEVEL_CHOICES: { value: Mode; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "Each album is brought to the same loudness as a whole, so songs keep their balance within an album: a soft song stays softer than the loud one beside it." },
  { value: "gentle", label: "Gentle", hint: "The same, but only 60 % of the correction. Loud albums come down less and quiet ones go up less." },
  { value: "off", label: "Off", hint: "Songs play at the volume they were ripped at." },
];

export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass boost", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: "Treble boost", gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { name: "Vocal", gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { name: "Loudness", gains: [5, 4, 1, 0, -1, -1, 0, 2, 4, 5] },
];

const bandLabel = (hz: number): string => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

type LevelPreview = { albums: number; songs: number; largest_boost_db: number; written: number };
type LevelWritten = {
  total: number;
  written: number;
  already_right: number;
  changed_since_measured: number;
  failed: number;
  problems: string[];
  stopped: boolean;
  on_file: number;
  albums_written?: number;
  album_names?: string[];
  limit_reached?: boolean;
  removed?: number;
  had_none?: number;
};
type LevelAlbum = { folder: string; name: string; songs: number; boost_db: number; written: number };
type LevelMode = "write" | "undo" | "strip";
const LEVEL_COMMANDS: Record<LevelMode, string> = { write: "levelling_tags_write", undo: "levelling_tags_undo", strip: "levelling_tags_strip" };

/** Writes the levelling into the music files (ReplayGain tags) so Jellyfin and every device that honours them hear it, and puts the files back on request. */
function renderLevelWrite(root: HTMLElement): void {
  const box = el("div", "field");
  box.append(el("h4", undefined, "Let every device hear the levelling"));
  box.append(
    el(
      "p",
      "field-hint",
      "The levelling above is heard in this program. To hear it on the phone, the TVs and through Jellyfin too, it can be written into your music files as ReplayGain tags, the standard way players are told how much to turn a song up. Only the songs of albums that are turned up get tags; nothing is turned down; the sound itself is not touched. Each file's tags from before are saved first, so one button puts every file back exactly as it was. The tags are the ordinary ones (REPLAYGAIN_TRACK_GAIN, REPLAYGAIN_TRACK_PEAK, REPLAYGAIN_ALBUM_GAIN, REPLAYGAIN_ALBUM_PEAK), so foobar2000, Mp3tag and similar programs can read, change or remove them too, even without this program's list. The levelling measured here always comes from the sound, never from these tags. Afterwards ask Jellyfin to rescan the library. Writing takes a while on a network drive and can be stopped and carried on; pressing the button again later only writes what is new.",
    ),
  );
  const status = el("p", "field-hint");
  // Which albums: everything (the default), the first few that still need tags, or one chosen album.
  const scope = el("select");
  scope.setAttribute("aria-label", "Which albums to write");
  for (const [value, label] of [["all", "All albums that are turned up"], ["first", "Only the next few albums"], ["one", "One album I choose"]] as const) scope.append(new Option(label, value));
  const count = el("input");
  count.type = "number";
  count.min = "1";
  count.value = "5";
  count.setAttribute("aria-label", "How many albums");
  count.hidden = true;
  const albumPick = el("select");
  albumPick.setAttribute("aria-label", "Album to write");
  albumPick.hidden = true;
  const scopeRow = el("div", "field");
  scopeRow.append(scope, count, albumPick);
  const write = el("button", undefined, "Write the levelling into my music files…");
  const undo = el("button", "secondary", "Put the files back as they were…");
  const strip = el("button", "secondary", "Remove the levelling tags…");
  write.type = undo.type = strip.type = "button";
  const sure = el("div", "organize-sure");
  sure.hidden = true;
  const yes = el("button", undefined, "Yes, write it");
  const no = el("button", "secondary", "Cancel");
  yes.type = no.type = "button";
  const sureText = el("p");
  sure.append(sureText, yes, no);
  const progress = el("div");
  const stop = el("button", "secondary", "Stop");
  stop.type = "button";
  stop.hidden = true;
  const outcome = el("p", "field-hint");
  box.append(status, scopeRow, write, undo, strip, sure, progress, stop, outcome);
  root.append(box);

  let preview: LevelPreview | null = null;
  let mode: LevelMode = "write";
  let jobId: string | null = null;
  let albums: LevelAlbum[] = [];

  const showScope = (): void => {
    count.hidden = scope.value !== "first";
    albumPick.hidden = scope.value !== "one";
  };
  scope.addEventListener("change", showScope);
  /** What the choice means for the command: only the first few albums, or one album's folder. */
  const scopeArgs = (): Record<string, unknown> => {
    if (scope.value === "first") return { limit_albums: Math.max(1, Math.floor(Number(count.value)) || 1) };
    if (scope.value === "one" && albumPick.value) return { folder: albumPick.value };
    return {};
  };
  const scopeText = (): string => {
    if (scope.value === "first") return `the next ${Math.max(1, Math.floor(Number(count.value)) || 1)} albums that still need it`;
    if (scope.value === "one") return `the album "${albumPick.selectedOptions[0]?.textContent ?? ""}"`;
    return "every album that is turned up";
  };

  async function refresh(): Promise<void> {
    try {
      const listed = await invoke<{ albums: LevelAlbum[] }>("levelling_tags_albums");
      albums = listed.albums;
      const chosen = albumPick.value;
      albumPick.replaceChildren(...albums.map((a) => new Option(`${a.name} (${a.songs} songs, +${a.boost_db.toFixed(1)} dB${a.written ? ", written" : ""})`, a.folder)));
      if (chosen && albums.some((a) => a.folder === chosen)) albumPick.value = chosen;
      preview = await invoke<LevelPreview>("levelling_tags_preview");
      status.textContent = preview.songs
        ? `${preview.songs.toLocaleString("en-US")} songs on ${preview.albums.toLocaleString("en-US")} albums are turned up (by up to ${preview.largest_boost_db.toFixed(1)} dB). ${preview.written ? `${preview.written.toLocaleString("en-US")} songs already carry levelling written by this program.` : "None carries it yet."}`
        : preview.written
          ? `No album needs turning up at the moment. ${preview.written.toLocaleString("en-US")} songs still carry levelling written earlier.`
          : "Nothing is measured yet, or no album needs turning up. Measure your library first.";
      write.disabled = !preview.songs;
      scopeRow.hidden = !preview.songs;
      undo.hidden = !preview.written;
      strip.hidden = !preview.songs && !preview.written;
    } catch {
      status.textContent = "Writing the levelling needs the Windows program.";
      write.disabled = true;
      undo.hidden = true;
      strip.hidden = true;
      scopeRow.hidden = true;
    }
  }

  const ask = (next: LevelMode): void => {
    mode = next;
    if (next === "write") {
      sureText.textContent = `Tags will be written for ${scopeText()} (only the tags change; each file is written to a copy, checked, and then replaces the file). Close anything that is playing from the network share. Back up the music folder first if it is not already backed up.`;
      yes.textContent = "Yes, write it";
    } else if (next === "undo") {
      sureText.textContent = `${preview?.written.toLocaleString("en-US") ?? 0} song files will be put back as they were before the levelling tags were written.`;
      yes.textContent = "Yes, put them back";
    } else {
      sureText.textContent = `The four ReplayGain tags will be removed from ${scope.value === "one" ? scopeText() : "every measured song"}, whoever wrote them, without using this program's list of earlier values. Use it if that list is lost; otherwise "Put the files back" restores earlier values exactly.`;
      yes.textContent = "Yes, remove them";
    }
    sure.hidden = false;
    write.hidden = undo.hidden = strip.hidden = scopeRow.hidden = true;
  };
  write.addEventListener("click", () => ask("write"));
  undo.addEventListener("click", () => ask("undo"));
  strip.addEventListener("click", () => ask("strip"));
  no.addEventListener("click", () => {
    sure.hidden = true;
    write.hidden = false;
    scopeRow.hidden = false;
    void refresh();
  });
  stop.addEventListener("click", () => {
    if (jobId) void invoke("cancel_job", { job_id: jobId });
    stop.disabled = true;
  });
  yes.addEventListener("click", () => {
    sure.hidden = true;
    outcome.textContent = "";
    const bar = createProgress(mode === "write" ? "Writing the levelling" : mode === "undo" ? "Putting the files back" : "Removing the levelling tags");
    progress.replaceChildren(bar.element);
    stop.hidden = false;
    stop.disabled = false;
    jobId = null;
    void runJob<LevelWritten & { restored?: number }>(LEVEL_COMMANDS[mode], { confirm: true, ...scopeArgs() }, (p) => {
      jobId = p.job_id ?? jobId;
      const { done, total } = progressCounts(p);
      bar.set(done, total);
    })
      .then((done) => {
        const names = done.album_names ?? [];
        outcome.textContent =
          mode === "write"
            ? `${done.stopped ? "Stopped. " : ""}${done.written.toLocaleString("en-US")} songs written on ${(done.albums_written ?? 0).toLocaleString("en-US")} albums${names.length ? ` (${names.slice(0, 8).join("; ")}${names.length > 8 ? `; and ${(done.albums_written ?? names.length) - 8} more` : ""})` : ""}, ${done.already_right.toLocaleString("en-US")} already right${done.changed_since_measured ? `, ${done.changed_since_measured} left alone because they changed since they were measured (measure again)` : ""}${done.failed ? `, ${done.failed} could not be written (${done.problems.slice(0, 2).join("; ")})` : ""}. Ask Jellyfin to rescan so it sees the tags.`
            : mode === "undo"
              ? `${(done.restored ?? 0).toLocaleString("en-US")} songs put back${done.failed ? `, ${done.failed} could not be (${done.problems.slice(0, 2).join("; ")})` : ""}.`
              : `${done.stopped ? "Stopped. " : ""}Tags removed from ${(done.removed ?? 0).toLocaleString("en-US")} songs (${(done.had_none ?? 0).toLocaleString("en-US")} had none)${done.failed ? `, ${done.failed} could not be changed (${done.problems.slice(0, 2).join("; ")})` : ""}.`;
      })
      .catch((thrown) => {
        outcome.textContent = `Nothing more was written: ${(thrown as { message?: string })?.message ?? "something went wrong"}`;
      })
      .finally(() => {
        bar.stop();
        progress.replaceChildren();
        stop.hidden = true;
        write.hidden = false;
        scopeRow.hidden = false;
        void refresh();
      });
  });
  void refresh();
}

type OutputDevices = { available: boolean; devices: { id: string; name: string; default: boolean }[] };
let stopWatchingOutput: (() => void) | null = null;

/** The switch for exclusive (WASAPI) output and the choice of sound card (D186). */
function renderOutput(root: HTMLElement): void {
  const section = el("div", "field");
  section.append(el("h4", undefined, "Sound output"));
  const prefs = nativePrefs();
  const row = el("label", "check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = prefs.exclusive;
  const text = el("span");
  text.append(
    el("strong", undefined, "Exclusive output (WASAPI)"),
    el(
      "span",
      "field-hint",
      " Plays your FLAC, MP3 and WAV songs straight to the sound card, without Windows' mixer in between. Nothing is resampled to a fixed rate, 24-bit and high sample rates stay as they are, and at full volume the card receives exactly the bits in the file. Songs join on the very sample, so gapless albums have no gap at all. For bit-perfect sound keep the volume at the top and use the speakers' or amplifier's own volume.",
    ),
  );
  row.append(box, text);
  const deviceField = el("div", "field");
  const deviceLabel = el("label", "field-label", "Sound card");
  const select = el("select");
  select.setAttribute("aria-label", "Sound card for exclusive output");
  deviceLabel.append(select);
  deviceField.append(deviceLabel);
  const limits = el(
    "p",
    "field-hint",
    "While it is on, volume levelling, the equalizer, crossfade and the music glow do not apply (they change the sound), and other programs cannot use that sound card while a song plays. A song it cannot play this way (another file type, a card that refuses its format, a library on a server only) plays the usual way, so nothing stops. It takes effect at once.",
  );
  const status = el("p", "field-hint");
  section.append(row, deviceField, limits, status);
  root.append(section);

  const paintStatus = (): void => {
    if (!box.checked) {
      status.textContent = "";
      return;
    }
    const lines = [describeInfo(nativeDeck.lastInfo, null)];
    if (nativeDeck.lastProblem) lines.push(`Last time a song could not be played this way: ${nativeDeck.lastProblem} It was played the usual way.`);
    status.textContent = lines.join(" ");
  };
  stopWatchingOutput?.();
  const watch = (): void => paintStatus();
  nativeDeck.addEventListener("info", watch);
  nativeDeck.addEventListener("fallback", watch);
  nativeDeck.addEventListener("loadedmetadata", watch);
  stopWatchingOutput = () => {
    nativeDeck.removeEventListener("info", watch);
    nativeDeck.removeEventListener("fallback", watch);
    nativeDeck.removeEventListener("loadedmetadata", watch);
  };

  const save = (): void => saveNativePrefs({ exclusive: box.checked, device: select.value });
  box.addEventListener("change", () => {
    select.disabled = !box.checked;
    save();
    paintStatus();
  });
  select.addEventListener("change", save);

  void invoke<OutputDevices>("native_audio_devices").then(
    (reply) => {
      if (!reply.available) throw new Error("not available");
      const standard = reply.devices.find((d) => d.default);
      select.replaceChildren(new Option(standard ? `Windows' own choice (${standard.name})` : "Windows' own choice", ""));
      for (const device of reply.devices) select.append(new Option(device.name, device.id));
      if (prefs.device && !reply.devices.some((d) => d.id === prefs.device)) select.append(new Option("The chosen sound card (not connected)", prefs.device));
      select.value = prefs.device;
      select.disabled = !box.checked;
      paintStatus();
    },
    () => {
      box.disabled = true;
      box.checked = false;
      select.disabled = true;
      status.textContent = "Exclusive output needs the Windows program.";
    },
  );
}

export function renderSoundSettings(root: HTMLElement): void {
  root.className = "settings-block";
  root.replaceChildren(el("h3", undefined, "Sound"));
  renderOutput(root);

  // ---- Volume levelling
  const level = el("div", "field");
  level.append(el("h4", undefined, "Volume levelling"));
  level.append(
    el(
      "p",
      "field-hint",
      "Songs from different albums and eras play at very different volumes. Levelling measures every song once and plays each album at the same overall loudness. It looks at the whole album (songs ripped together), not each song alone, so a soft acoustic song is not turned up to match a loud one. Quiet albums, older recordings above all, are brought up toward the level of a modern recording, but never so far that their loudest passages become too loud. Nothing is ever turned down: an album that is already loud plays exactly as it was ripped. Nothing is written to your music files unless you choose to below.",
    ),
  );
  const status = el("p", "field-hint");
  const radios = el("fieldset", "settings-radios");
  radios.append(el("legend", "field-label", "How much to level"));
  for (const choice of LEVEL_CHOICES) {
    const row = el("label", "check");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "level-mode";
    radio.value = choice.value;
    radio.addEventListener("change", () => {
      void invoke("set_loudness_settings", { mode: choice.value }).then(() => {
        forgetLevels();
        void refresh();
      });
    });
    const text = el("span");
    text.append(el("strong", undefined, choice.label), el("span", "field-hint", ` ${choice.hint}`));
    row.append(radio, text);
    radios.append(row);
  }
  const meter = el("progress");
  meter.hidden = true;
  const measure = el("button", undefined, "Measure my library");
  measure.type = "button";
  measure.addEventListener("click", () => {
    measure.disabled = true;
    void invoke("scan_library_loudness").then(() => poll(), () => {
      status.textContent = "The library could not be measured. Is a music folder chosen under Library?";
      measure.disabled = false;
    });
  });
  // "Measure everything again": every song's sound is read afresh and its old result replaced (the measuring reads only the sound, never the tags or what the
  // player did to the volume, so this is for peace of mind, or after changing the music files outside the program).
  const again = el("button", "secondary", "Measure everything again…");
  again.type = "button";
  const againSure = el("div", "organize-sure");
  againSure.hidden = true;
  const againText = el("p", undefined, "Every song in the library is read again from its sound (the volume it is played at, and any ReplayGain tags in the files, play no part), and each old result is replaced as its song is done. It runs quietly in the background and can be stopped; songs not yet re-read keep their old result meanwhile. For a library of this size it takes a while.");
  const againYes = el("button", undefined, "Yes, measure everything again");
  const againNo = el("button", "secondary", "Cancel");
  againYes.type = againNo.type = "button";
  againSure.append(againText, againYes, againNo);
  again.addEventListener("click", () => {
    againSure.hidden = false;
    again.hidden = true;
  });
  againNo.addEventListener("click", () => {
    againSure.hidden = true;
    again.hidden = false;
  });
  againYes.addEventListener("click", () => {
    againSure.hidden = true;
    again.hidden = false;
    measure.disabled = again.disabled = true;
    void invoke("scan_library_loudness", { again: true }).then(
      () => poll(),
      () => {
        status.textContent = "The library could not be measured. Is a music folder chosen under Library?";
        measure.disabled = again.disabled = false;
      },
    );
  });
  level.append(radios, measure, again, againSure, meter, status);

  let timer = 0;
  let wasRunning = false;
  async function refresh(): Promise<void> {
    try {
      const now = await invoke<LevelStatus>("library_loudness_status");
      if (wasRunning && !now.running) forgetLevels(); // new measurements: the player asks for the gains again
      wasRunning = now.running;
      again.disabled = now.running;
      for (const radio of radios.querySelectorAll<HTMLInputElement>("input")) radio.checked = radio.value === now.mode;
      measure.disabled = now.running;
      meter.hidden = !now.running;
      meter.max = Math.max(1, now.tracks_total ?? 1);
      meter.value = now.tracks_done ?? 0;
      status.textContent = now.running
        ? `Measuring: ${now.tracks_done ?? 0} of ${now.tracks_total ?? 0} songs${now.failed ? ` (${now.failed} could not be read)` : ""}. This runs quietly in the background and can be left; it carries on where it stopped.`
        : now.measured
          ? `${now.measured} songs are measured. Measure again after adding music; only new and changed songs are read.`
          : "No song is measured yet. Measure your library to start levelling.";
      if (now.running) timer = window.setTimeout(() => void refresh(), 1500);
    } catch {
      status.textContent = "Levelling is only available in the Windows program.";
    }
  }
  function poll(): void {
    window.clearTimeout(timer);
    void refresh();
  }
  root.append(level);
  renderLevelWrite(root);

  // ---- Gapless and crossfade
  const joins = el("div", "field");
  joins.append(el("h4", undefined, "Between songs"));
  const prefs = soundPrefs();
  const gapless = el("label", "check");
  const gaplessBox = el("input");
  gaplessBox.type = "checkbox";
  gaplessBox.checked = prefs.gapless;
  gaplessBox.addEventListener("change", () => saveSoundPrefs({ ...soundPrefs(), gapless: gaplessBox.checked }));
  const gaplessText = el("span");
  gaplessText.append(el("strong", undefined, "Gapless"), el("span", "field-hint", " The next song starts as the last one ends, with no pause (live albums, mixes, classical). The next song is already in memory."));
  gapless.append(gaplessBox, gaplessText);
  const fade = el("div", "field");
  const fadeLabel = el("label", "field-label");
  fadeLabel.textContent = "Crossfade";
  const fadeBar = el("input");
  fadeBar.type = "range";
  fadeBar.min = "0";
  fadeBar.max = String(MAX_CROSSFADE);
  fadeBar.step = "1";
  fadeBar.value = String(prefs.crossfade);
  fadeBar.setAttribute("aria-label", "Crossfade length in seconds");
  const fadeText = el("span", "field-hint");
  const showFade = (): void => {
    const seconds = Number(fadeBar.value);
    fadeText.textContent = seconds === 0 ? " Off: songs do not overlap." : ` ${seconds} second${seconds === 1 ? "" : "s"}: the end of a song fades out as the next fades in.`;
  };
  fadeBar.addEventListener("input", showFade);
  fadeBar.addEventListener("change", () => saveSoundPrefs({ ...soundPrefs(), crossfade: Number(fadeBar.value) }));
  showFade();
  fade.append(fadeLabel, fadeBar, fadeText);
  joins.append(gapless, fade);
  root.append(joins);

  // ---- Auto-DJ
  const dj = el("div", "field");
  dj.append(el("h4", undefined, "Auto-DJ"));
  const djRow = el("label", "check");
  const djBox = el("input");
  djBox.type = "checkbox";
  djBox.checked = autoDjOn();
  djBox.addEventListener("change", () => setAutoDj(djBox.checked));
  const djText = el("span");
  djText.append(el("strong", undefined, "Keep the music going"), el("span", "field-hint", " When the last song in the queue starts, a few songs that fit (the same genre, artist or decade) are added, never one just played and not the same band twice in a row. Only music from your library."));
  djRow.append(djBox, djText);
  dj.append(djRow);
  root.append(dj);

  // ---- Equalizer
  const eq = el("div", "field");
  eq.append(el("h4", undefined, "Equalizer"));
  const setting = eqSetting();
  const onRow = el("label", "check");
  const onBox = el("input");
  onBox.type = "checkbox";
  onBox.checked = setting.on;
  onRow.append(onBox, el("span", undefined, "Use the equalizer"));
  const presets = el("div", "settings-actions");
  const bands = el("div", "eq-bands");
  const sliders: HTMLInputElement[] = [];
  const commit = (): void => saveEq({ on: onBox.checked, gains: sliders.map((s) => Number(s.value)) });
  EQ_BANDS.forEach((hz, i) => {
    const column = el("div", "eq-band");
    const slider = el("input");
    slider.type = "range";
    slider.min = String(-EQ_LIMIT_DB);
    slider.max = String(EQ_LIMIT_DB);
    slider.step = "1";
    slider.value = String(setting.gains[i] ?? 0);
    slider.setAttribute("aria-label", `${bandLabel(hz)} Hz, in decibels`);
    slider.addEventListener("input", commit);
    sliders.push(slider);
    column.append(slider, el("span", "field-hint", bandLabel(hz)));
    bands.append(column);
  });
  for (const preset of EQ_PRESETS) {
    const button = el("button", "secondary", preset.name);
    button.type = "button";
    button.addEventListener("click", () => {
      preset.gains.forEach((g, i) => {
        sliders[i]!.value = String(g);
      });
      onBox.checked = true;
      commit();
    });
    presets.append(button);
  }
  onBox.addEventListener("change", commit);
  eq.append(onRow, presets, bands, el("p", "field-hint", "The bands are 31 Hz to 16 kHz, up to 12 dB either way. The equalizer works on this computer's own playback (not on casts to a TV)."));
  root.append(eq);

  void refresh();
}
