# Third-Party Notices

MediaVerse Studio is licensed under GPL-3.0-or-later. This file records the third-party components that a
build contains and the notices a binary release must carry. The source of truth for versions, checksums
and reviews is [`third_party/provenance.toml`](third_party/provenance.toml).

## Bundled in the test build

| Component | Licence | Shipped as | Release material required |
|---|---|---|---|
| libcdio | GPL-3.0-or-later | Static library in `mediaverse_cd_helper.exe` | Corresponding source, build script, licence text |
| libcdio-paranoia | GPL-3.0-or-later | Static library in `mediaverse_cd_helper.exe` | As above (licence review: decision log D7) |
| libiconv | LGPL | Static library in `mediaverse_cd_helper.exe` | Source, licence text, relinking information |
| LAME 4.0 | LGPL-2.0-or-later | `lame.exe` | Source archive and hash, local patch, build script, licence text |
| Electron (Chromium, Node.js) | MIT, plus the bundled projects' licences | The program's runtime | Electron's `LICENSES.chromium.html` and `LICENSE` |
| Rust crates (flacenc, claxon, nanomp3, lofty, rusqlite with SQLite, ureq, native-tls, md-5, rusty-chromaprint with rubato and rustfft, and their dependencies) | MIT, Apache-2.0, Unlicense, Unicode-3.0, public domain | Compiled into the sidecar | Generated licence inventory |

**Sharing a build (D88).** Every Windows build carries a `licenses` folder beside the program
(`tools/make-licence-pack.ps1`): the licence texts above copied from each component's own source, the
complete list of Rust libraries with their published licence texts, and how to get the source. The app
shows it under Settings > About. `tools/make-installer.ps1` also makes
`MediaVerse-Studio-Source-<commit>.zip` (our source at that commit plus the exact libcdio,
libcdio-paranoia, LAME and libiconv source archives); share it in the same place as the installer.
The web page bundles no npm packages apart from Vite's small module-preload helper (MIT).

## Lyric AI models (not in the installer today)

The Lyric AI runs ONNX models on the person's own computer. None of them is bundled in Setup at present: they are copied into `%APPDATA%\MediaVerse Studio\lyric-ai\models`
(and ONNX Runtime into `...\runtime`) by hand, and a model list with an in-app download is planned (`docs/lyric-models.md`, `docs/distribution-plan.md`). Nothing is
uploaded: the models run locally. Before any model is bundled or offered for download its licence text and origin must be in the `licenses` folder (D137).

| Model | Licence | Role | Status |
|---|---|---|---|
| ONNX Runtime (Microsoft) | MIT | Runs every model below | Supplied separately |
| Music-lyrics reader: `mrfakename/w2v-bert-2.0-music-lyrics-ctc`, as exported by `redbaty/ytm-lyrics-aligner` (ONNX, fp16) | MIT | **Default reader** (D151): matches, times and scores lyrics, hears instrumentals; reads the full mix | Training data is undocumented; accepted by the owner (D136). May be bundled in a second "with Lyric AI" download |
| Whisper large-v3-turbo (OpenAI weights, `onnx-community/whisper-large-v3-turbo`) | MIT | Drafts lyrics for songs nobody has them for | **Separate download only** (D151) |
| Speech reader: wav2vec2 large 960 h (fairseq, ONNX) | MIT | Original reader; needs the Demucs separator; selectable, no longer the default | Supplied separately |
| htdemucs (ONNX core) | Repository MIT; **weights' licence not stated** | Separator for the speech reader only | Not the default (D151) and never bundled or in the installer (D200); optional, supplied by the person, with a disclaimer wherever a download is offered: the weights' licence is not stated and they were trained on a research dataset (personal, non-commercial use) |
| Older photo reader: PP-OCRv5 server text detection and recognition (PaddlePaddle, ONNX; PaddlePaddle/PP-OCRv5_server_det_onnx and ..._rec_onnx, pinned revisions) | Apache-2.0 (stated on both official model pages) | Reads booklet photos line by line (D161); kept for people who already have it, no longer offered for download once the vision reader (D165) is installed | **Separate download only**, fetched by the program from the official repositories (about 170 MB); never in the installer. Its licence and notice must go in the licenses folder before it is offered in a release |
| Photo reader (vision): Qwen3-VL-4B-Instruct (Alibaba Cloud, Qwen team): `Qwen/Qwen3-VL-4B-Instruct-GGUF` at a pinned revision, the 4-bit model and the 8-bit picture encoder, used unchanged | Apache-2.0 (stated on the official model page) | Reads whole booklet photos for Lyrics by photo (D165) | **Separate download only** (about 2.95 GB), fetched by the program from the official repository with its size and SHA-256 checked; never in the installer. Notice text is written beside the files |
| llama.cpp `llama-server` (ggml-org, release b12613, Windows Vulkan build; includes ggml and the LLVM OpenMP runtime) | MIT (llama.cpp and ggml, copyright The ggml authors); LLVM OpenMP: Apache-2.0 with LLVM exceptions (its `LICENSE-LLVM-OpenMP` comes in the zip) | Runs the vision model on this computer only (a local server on 127.0.0.1 for the length of a reading) | **Separate download only** (39 MB), fetched from the official GitHub release with its size and SHA-256 checked; its MIT licence text is written beside it; never in the installer |
| Sylla (`radiant-lyrics/sylla-600m-v1`) | GPL-3.0 (bases MIT) | Line-level hints (not built) | **Separate download only** (D151); never bundled |

A model with a non-commercial licence (for example Meta's MMS aligner, CC-BY-NC 4.0) is never offered by the program; a person may add one by hand for their own use.
## Not used

CDex / CDRip.dll, fre:ac / BoCA CD components, libcdio-sys and Tauri were evaluated and rejected
(see `Guiding Documents/Third-Party Software and Licensing.md`). None of them is in any build.

No component is approved because of its file name. The provenance record and source verification
are required for every native component.
