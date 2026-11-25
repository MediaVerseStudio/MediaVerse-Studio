// Settings > Lyrics > Lyric AI (docs/lyric-ai-plan.md): where ONNX Runtime and the models are, and where each model runs. The models are not part of the
// program (they are large and optional): they sit in folders the person chooses, and any model set in the same form can be pointed at (a folder with
// `htdemucs-core.onnx`, `w2v.onnx` and `w2v.json`). Text is set with textContent.

import { invoke, open } from "./desktop-bridge";
import { el } from "./dom";

type Status = {
  ready: boolean;
  missing: string[];
  loaded: boolean;
  runtime: string;
  models: string;
  separator: string;
  reader: string;
  /** "wav2vec2" (the speech model on separated vocals) or "music" (a music-lyrics model on the full mix). */
  reader_model?: string;
  music_onnx?: string;
  music_vocab?: string;
  whisper_folder?: string;
  whisper_ready?: boolean;
  whisper_missing?: string[];
  library_folders: string[];
};

const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const folderOf = (file: string): string => file.replace(/[\\/][^\\/]*$/, "");

const PROCESSORS: { value: string; label: string; hint: string }[] = [
  { value: "cpu", label: "The processor", hint: "Works everywhere; a song takes about a quarter of its length." },
  { value: "cuda", label: "An NVIDIA graphics card (CUDA)", hint: "The fastest: a song takes a few seconds. Needs the CUDA libraries beside ONNX Runtime or in the folder below." },
  { value: "directml", label: "Any graphics card (DirectML)", hint: "Fast for reading the singing; not offered for separating it (it gives wrong results there)." },
];

export function renderLyricAiSettings(root: HTMLElement): void {
  root.className = "settings-block lyric-ai-settings";
  const message = el("p", "field-hint");
  message.setAttribute("role", "status");

  async function draw(): Promise<void> {
    let status: Status;
    try {
      status = await invoke<Status>("lyric_ai_status", {});
    } catch (error) {
      root.replaceChildren(el("h3", undefined, "Lyric AI"), el("p", "result-warning", `Could not read the settings: ${errorText(error)}`));
      return;
    }
    const save = async (change: Record<string, unknown>): Promise<void> => {
      try {
        await invoke("lyric_ai_configure", change);
        message.textContent = "Saved.";
      } catch (error) {
        message.textContent = `Could not save: ${errorText(error)}`;
      }
      void draw();
    };
    const folderRow = (label: string, hint: string, current: string, choose: (folder: string) => void): HTMLElement => {
      const row = el("div", "field");
      row.append(el("label", undefined, label));
      const value = el("p", undefined, current || "Not chosen.");
      const pick = el("button", "secondary", "Choose the folder…");
      pick.type = "button";
      pick.addEventListener("click", async () => {
        const folder = await open({ directory: true, title: label }).catch(() => null);
        if (folder) choose(folder);
      });
      row.append(value, pick, el("p", "field-hint", hint));
      return row;
    };
    const processor = (label: string, current: string, key: "separator" | "reader", skip: string[] = []): HTMLElement => {
      const field = el("div", "field");
      const id = `lyric-ai-${key}`;
      const title = el("label", undefined, label);
      title.htmlFor = id;
      const select = el("select");
      select.id = id;
      for (const p of PROCESSORS.filter((x) => !skip.includes(x.value))) {
        const option = el("option", undefined, p.label);
        option.value = p.value;
        option.selected = p.value === current;
        select.append(option);
      }
      const hint = el("p", "field-hint", PROCESSORS.find((p) => p.value === current)?.hint ?? "");
      select.addEventListener("change", () => {
        hint.textContent = PROCESSORS.find((p) => p.value === select.value)?.hint ?? "";
        void save({ [key]: select.value });
      });
      field.append(title, select, hint);
      return field;
    };

    // Which model reads the singing. The music-lyrics models (w2v-BERT, trained on songs) read the full mix, so there is no separating step: faster and, on our tests,
    // better at telling which lyrics belong to a song and at hearing instrumentals. They are separate downloads, so the choice is the person's.
    const readerModel = (): HTMLElement => {
      const field = el("div", "field");
      const title = el("label", undefined, "Model that reads the singing");
      title.htmlFor = "lyric-ai-reader-model";
      const select = el("select");
      select.id = "lyric-ai-reader-model";
      for (const [value, label] of [
        ["wav2vec2", "Speech model on separated vocals (the original; needs the separator)"],
        ["music", "Music-lyrics model on the full mix (the default: faster, no separating step)"],
      ] as const) {
        const option = el("option", undefined, label);
        option.value = value;
        option.selected = (status.reader_model ?? "music") === value;
        select.append(option);
      }
      select.addEventListener("change", () => void save({ reader_model: select.value }));
      field.append(title, select);
      if ((status.reader_model ?? "music") === "music") {
        const names = el("div", "field-row");
        for (const [key, label, current] of [
          ["music_onnx", "Model file", status.music_onnx ?? "aligner-fp16.onnx"],
          ["music_vocab", "Letters file", status.music_vocab ?? "vocab.json"],
        ] as const) {
          const wrap = el("label", undefined, `${label}: `);
          const input = el("input");
          input.type = "text";
          input.value = current;
          input.size = 24;
          input.addEventListener("change", () => void save({ [key]: input.value.trim() }));
          wrap.append(input);
          names.append(wrap, document.createTextNode(" "));
        }
        field.append(names);
      }
      field.append(
        el(
          "p",
          "field-hint",
          (status.reader_model ?? "music") === "music"
            ? "Both files go in the Models folder above: an ONNX version of a music-lyrics model (for example aligner-fp16.onnx from redbaty/ytm-lyrics-aligner, an export of mrfakename/w2v-bert-2.0-music-lyrics-ctc, MIT licence) and its vocab.json. No separator is needed. Results from the two models are not mixed: songs checked with one are checked again with the other only when you ask (Also redo songs checked before)."
            : "The speech model (wav2vec2) hears the singing after the separator has taken the band away. The music-lyrics model reads the whole song and needs no separator.",
        ),
      );
      return field;
    };
    const state = status.ready
      ? el("p", "result-good", status.loaded ? "Ready, and loaded." : "Ready. The models load when a run starts (about two seconds).")
      : el("p", "result-warning", `Not set up: missing ${status.missing.join("; ")}.`);
    root.replaceChildren(
      el("h3", undefined, "Lyric AI"),
      el("p", "field-hint", "Finds the right lyrics for a song (under every likely spelling of its artist and title), checks them against the singing, and times them line by line; the ones it is certain of go into the songs by themselves. It needs ONNX Runtime and a set of models, which are separate from the program because they are large; the Review > Lyrics page has the Start button."),
      state,
      folderRow("Models", "The folder that holds the model files: htdemucs-core.onnx (separates the singing from the music), w2v.onnx and w2v.json (reads the singing); or, for the music-lyrics model, its ONNX file and vocab.json.", status.models, (folder) => void save({ models: folder })),
      folderRow("ONNX Runtime", "The folder that holds onnxruntime.dll (and, for a graphics card, its provider files).", folderOf(status.runtime), (folder) => void save({ runtime: `${folder}\\onnxruntime.dll` })),
      folderRow("CUDA libraries (NVIDIA graphics cards only)", "A folder with the CUDA and cuDNN libraries when they are not beside ONNX Runtime. Leave it alone for the processor or DirectML.", status.library_folders[0] ?? "", (folder) => void save({ library_folders: [folder] })),
      readerModel(),
      folderRow(
        "Whisper (drafts for songs nobody has lyrics for)",
        status.whisper_ready
          ? "Ready. Whisper writes down what it hears in a song that has no lyrics anywhere; the music-lyrics model then checks and times the words. Used only from Review > Lyrics, Step 3, and only for drafts you then check."
          : `Not set up: missing ${(status.whisper_missing ?? []).join("; ")}. Download from Hugging Face (onnx-community/whisper-large-v3-turbo, MIT licence, about 1.6 GB): onnx/encoder_model_fp16.onnx, onnx/decoder_model_merged_fp16.onnx, vocab.json and generation_config.json, into one folder (the default is a whisper folder inside the Models folder).`,
        status.whisper_folder ?? "",
        (folder) => void save({ whisper_folder: folder }),
      ),
      ...((status.reader_model ?? "music") === "music" ? [] : [processor("Separating the singing runs on", status.separator, "separator", ["directml"])]),
      processor("Reading the singing runs on", status.reader, "reader"),
      message,
    );
  }
  void draw();
  // The page shows the section again when its tab is chosen: read the state afresh then.
  document.querySelector("[data-settings-section=lyrics]")?.addEventListener("click", () => void draw());
}
