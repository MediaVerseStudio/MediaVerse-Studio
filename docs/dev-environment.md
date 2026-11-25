# Rebuilding the development environment (written 2026-11-19, from the owner's PC)

How to set up another Windows PC so it can build, test, package and install everything in this repository as it is now. Versions are the ones installed on the
development PC on 2026-11-19; newer patch versions are normally fine, but the Rust and Node lines have broken things before (Rust 1.100 broke CI on 2026-11-15, see
`docs/ci.md`), so move versions on purpose, not by accident.

Nothing in this file is a secret. **Secrets, certificates and keys are listed in section 9 and must be carried across by hand, never committed.**

## 1. What is needed for what

| To do this | Needs |
|---|---|
| Build and test the Rust program (sidecar, host, engines, installer stub) | Visual Studio Build Tools (MSVC), Rust stable |
| Build and test the web app, run the desktop app, run its tests | Node.js, then `npm install` in `web/app` (Electron, TypeScript, Vite) |
| Build the CD helper (libcdio, MinGW) | MSYS2 UCRT64 with GCC, Rust `x86_64-pc-windows-gnu` target |
| Build `lame.exe` | Visual Studio Build Tools (MSVC), the pinned LAME 4.0 archive |
| Make the Windows Setup program and the source bundle | PowerShell 7, Windows' own `tar.exe`, `rcedit` (downloaded by a script) |
| Build and install the Android app | JDK 17+ (25 is used), Android SDK, Gradle (comes with the project's wrapper) |
| Build and install the Samsung TV app | Tizen Studio, a Samsung developer certificate profile |
| Run the Lyric AI on the GPU | NVIDIA driver, ONNX Runtime 1.22.0 GPU build with CUDA 12 / cuDNN 9 libraries, the model files |
| Work on the Lyric AI research (calibration, comparisons) | The lab folder and its Python 3.12 virtual environment |
| Push, pull requests, CI | Git (GitHub Desktop's copy is enough), GitHub CLI, a GitHub login |

## 2. Base tools (one `winget` block)

Run in an administrator PowerShell. Package ids are the ones the development PC used.

```powershell
winget install --id Microsoft.PowerShell                 # PowerShell 7 (the scripts assume pwsh)
winget install --id GitHub.GitHubDesktop                 # bundles a git; see "git" below
winget install --id GitHub.cli                           # 2.102.1 here
winget install --id OpenJS.NodeJS.LTS                    # Node 26.13.0, npm 11.20.0 here
winget install --id Rustlang.Rustup                      # then see section 3
winget install --id MSYS2.MSYS2                          # then see section 4
winget install --id Oracle.JDK.25                        # JDK 25.0.5 here (Android needs 17 or newer)
winget install --id Microsoft.VisualStudioCode           # optional
winget install --id 7zip.7zip                            # optional (the scripts use Windows' own tar.exe)
winget install --id astral-sh.uv                         # optional: makes the Python 3.12 lab environment (section 7)
```

**Visual Studio Build Tools** (the installed one is "Build Tools 2026", 18.11): download the Build Tools installer from Microsoft and tick the workload
**Desktop development with C++** (MSVC x64/x86 build tools, Windows 11 SDK, CMake tools are optional). The .NET SDK that sits beside it on the old PC is not needed
by this project.

**git is not on PATH on the development PC.** Use GitHub Desktop's copy by full path
(`%LOCALAPPDATA%\GitHubDesktop\app-<version>\resources\app\git\cmd\git.exe`; the folder name changes with every GitHub Desktop update). Do not use the one inside
`C:\msys64\usr\bin`: it handles line endings differently and reports every file as modified. On a new PC it is simpler to install Git for Windows and have it on PATH,
with `core.autocrlf` left at the repository's own `.gitattributes` behaviour. Commit identity: use the GitHub no-reply address, not a personal one.

Then sign in: `gh auth login`, and sign in to GitHub Desktop. The repository is `MediaVerseStudio/MediaVerse-Studio` (private for now).

## 3. Rust

```powershell
rustup default stable                                    # 1.99.1 was current on 2026-11-19; 1.100.0 is also installed for testing
rustup target add x86_64-pc-windows-gnu                  # for the CD helper (section 4)
rustup component add rustfmt clippy                      # CI runs cargo fmt --all --check
```

The host toolchain is `x86_64-pc-windows-msvc`. Cargo lives in `%USERPROFILE%\.cargo\bin` (add it to PATH). There is no `rust-toolchain.toml` and deliberately no
`rustfmt.toml`. Routine for new Rust versions: `docs/ci.md` and the memory note "Rust update routine" (check for a new stable, test, rebuild).

Check: `cargo test --workspace` and `cargo fmt --all --check` in the repository root.

## 4. MSYS2 and the CD helper (libcdio)

The CD helper links libcdio and libcdio-paranoia built as static MinGW-w64 libraries; `configure` must run in the **UCRT64** environment (the plain MSYS shell targets
Cygwin).

```bash
# in the "MSYS2 UCRT64" shell
pacman -Syu
pacman -S --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-binutils mingw-w64-ucrt-x86_64-make \
                   mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-libiconv \
                   make autoconf automake libtool git
```

(GCC 16.2.0 and `make` 4.4.1 were installed here. The extra packages on the old PC, such as cmake, gdb, python and ninja, came with MSYS2 or other work and are not
needed by these scripts.)

Sources are **not** in git (`third_party/source/` is ignored). Download only the archives named in `third_party/provenance.toml` and check their SHA-256 with
`tools\verify-native-source.ps1`:

- `libcdio-68ea374f83d5e63122168e4e182b15ba10e0d2eb.tar.gz`
- `libcdio-paranoia-384f4dac7e211cce67a14f3df53fc596965b6c94.tar.gz`
- `mingw-w64-libiconv-1.19-1.src.tar.zst` (the source for the GPL notice; the MSYS2 package source)
- `lame-4.0.tar.gz` (SHA-256 `3DF5124D5AD3A98312FFD7BA6A9B36230E4F8A3E66D3CE0F425E336C32D216EB`)

Then, from the repository root:

```powershell
.\tools\build-libcdio-mingw.ps1        # static libraries into third_party\build\libcdio-native
.\tools\build-cd-helper.ps1            # mediaverse_cd_helper.exe (target x86_64-pc-windows-gnu, MSYS2 GCC as the linker)
.\tools\build-lame-4.0.ps1 -ArchivePath "C:\path\to\lame-4.0.tar.gz"   # lame.exe into third_party\build\lame-4.0 (MSVC)
.\tools\fetch-rcedit.ps1               # rcedit 2.0.0, used by the installer script (downloaded and checked)
.\tools\fetch-flac-reference.ps1       # the reference FLAC encoder, for the golden tests
```

Both scripts take `-Msys2Root` if MSYS2 is not in `C:\msys64`. The built outputs under `third_party/build/` are ignored by git; rebuild them on the new PC.

## 5. Web app, desktop app and tests

```powershell
cd web\app
npm install                    # Electron ^45.2.1, TypeScript ^5.8, Vite ^6.2 (see package.json; package-lock.json pins them)
npm test                       # type check + unit tests (315 on 2026-11-19)
npm run test:electron          # 43 tests
npm run sidecar:build          # builds the Rust sidecar the desktop app starts
npm run electron:start         # run the app from the source tree
```

`Start MediaVerse Studio.cmd` in the repository root starts the app the same way. The TV and phone front ends build with `npm run tv:build` and `npm run phone:build`.
The end-to-end screenshot scripts are `web\app\scripts\capture-*.cjs` (they run on a throwaway library, never the real music).

## 6. Packaging and installing

- **Windows Setup:** `tools\package-windows.ps1`, then `tools\make-installer.ps1` (also makes the source bundle). It needs `tar.exe` (part of Windows 11), `rcedit`
  (section 4) and the built LAME and CD helper. See `docs/installer.md`.
- **Android:** install the Android command-line tools and in the SDK Manager: platform **android-37.0**, build-tools **36.0.0 and 37.0.0**, platform-tools (adb), the
  emulator and the **Android Auto Desktop Head Unit** (`extras\google\auto`) if you test Android Auto; the SDK lives in `%LOCALAPPDATA%\Android\Sdk` (or set
  `ANDROID_HOME`). Gradle 9.8.2 comes through `apps\android\gradlew.bat`. `compileSdk 37`, `minSdk 30`. Build and install: `tools\build-android.ps1 -Install` with USB
  debugging on the phone (`docs/android-app.md`).
- **Samsung TV (Tizen):** install Tizen Studio to `C:\tizen-studio` (the installed one has the TV extension and many platform versions; the TV app needs the web
  application tooling and the Certificate Manager). Create a certificate profile in the Certificate Manager (a free Samsung developer account), switch the TV to
  developer mode (Apps panel, the PC's address), then `tools\package-tv.ps1 -CertificateProfile <name>` (`docs/tv-apps.md`, `docs/tv-screen-saver.md`). **The old profile
  and its certificate cannot be copied by a script; carry its files across (section 9) or make a new one and re-pair the TVs.**
- **Android Auto and cast testing:** `adb` from the SDK's platform-tools; device addresses are in the private local file, not in the repository.

## 7. Lyric AI: runtime, models and the lab

**In the app** (these live in `%APPDATA%\MediaVerse Studio\lyric-ai`, outside the repository; configured in Settings > Lyrics > Lyric AI or in `lyric-ai.json`):

| What | Where it came from | Size |
|---|---|---|
| `runtime\onnxruntime.dll` 1.22.0 plus `onnxruntime_providers_cuda.dll`, `_shared.dll`, `_tensorrt.dll` | the ONNX Runtime 1.22.0 **GPU** build (the files match the `onnxruntime-gpu` 1.22.0 package in the lab environment) | small |
| `runtime\` CUDA 12 / cuDNN 9 libraries (`cublas64_12`, `cublasLt64_12`, `cudart64_12`, `cudnn*64_9`, `cufft`, `curand`, `cusolver`, `cusparse`, `nvJitLink`, `nvrtc*`) | NVIDIA's CUDA 12.x and cuDNN 9 libraries (the lab's `torch 2.8.0+cu126` install carries the same set; copy them next to `onnxruntime.dll`) | about 1.4 GB |
| `models\aligner-fp16.onnx`, `models\vocab.json` | the music-lyrics reader (MIT; `docs/lyric-models.md`) | 1.1 GB |
| `models\whisper\` (encoder fp16, merged decoder fp16, `vocab.json`, `generation_config.json`) | `onnx-community/whisper-large-v3-turbo` (MIT) | 1.6 GB |
| `models\w2v.onnx`, `w2v.json`, `htdemucs-core.onnx` | the original speech reader and the Demucs separator (weights licence unstated, see the roadmap) | 1.4 GB |

On a new PC the simplest route is to **copy the whole `lyric-ai` folder** (about 5 GB) and `lyric-ai.json`, then fix the absolute paths inside `lyric-ai.json` (the
`runtime`, `models` and `library_folders` entries hold full paths). A NVIDIA driver (621.14 here, RTX 4090) is enough; the CUDA toolkit itself is not installed.

**Lab** (research only, not needed to build the program): the folder `MediaVerse-Lyric-Sync-Lab` beside the repository (scripts, calibration data, `judge-lab`) and its
Python 3.12 virtual environment `.venv`, made with `uv` (`uv venv --python 3.12`). Its exact package versions are in `requirements-freeze.txt` in the lab folder
(`pip freeze` from 2026-11-19); the main ones: torch 2.8.0+cu126, torchaudio 2.8.0+cu126, onnxruntime-gpu 1.22.0, onnx 1.23.2, faster-whisper 1.2.1, ctranslate2 4.9.0,
demucs 4.1.0, numpy 2.5.5, mutagen 1.48.1. Recreate with
`uv pip install --index-url https://download.pytorch.org/whl/cu126 torch==2.8.0+cu126 torchaudio==2.8.0+cu126` and then `uv pip install -r requirements-freeze.txt`
(edit the torch lines out of the file first). The lab's `models`, `cache` and `onnx` folders are large downloads and conversions; copy them rather than redo them if
disk and time allow.

## 8. Other tools that appear in the project

Ollama (0.40.16) and Python 3.15 are installed on the development PC for other work and are not needed to build this project. FFmpeg is **not** installed and not needed.
The test Jellyfin server and the home-server project live in their own folders (`Jellyfin-Test-Server`, `Home Assistant Computer`) and have their own notes.

## 9. What is not in the repository and must be carried across (privately)

Move these by a USB drive or an encrypted copy, never through the repository, chat or e-mail in the clear:

1. **Samsung Tizen certificate files** (author and distributor certificates and their password; Tizen Studio keeps them under its data folder, and the
   Certificate Manager can export them).
2. **The Android debug keystore**, if you want updates to install over the phone's current app (`%USERPROFILE%\.android\debug.keystore`); otherwise uninstall and
   reinstall once.
3. **The service keys:** the AcoustID application key, the Discogs token and the photo-service keys (TheAudioDB, Fanart.tv) are saved in
   `%APPDATA%\MediaVerse Studio\metadata-settings.json` (checked on 2026-11-19: this file holds them, plus the project contact address and the gnudb and MusicBrainz
   settings). Copying that one file carries them across; otherwise re-enter them in Settings. Registrations: `docs/release-checklist.md` (AcoustID, updated on
   every version bump) and `docs/gnudb-registration.md`. Keys never live in the repository.
4. **The app's data folder `%APPDATA%\MediaVerse Studio`** (library database `library.sqlite`, the lyrics review store, Lyric AI results, play history, playlists,
   settings, TV pairing in `library-share.json`). The TVs and phone are paired with this PC's key; copying the folder keeps the pairings, starting empty means
   pairing again.
5. **The Lyric AI model and runtime folder** (section 7) and the **lab folder**.
6. **The private local file with the home TVs' identifiers** (`Developer\Home TVs`), the test music library and the demo library (`MediaVerse-Demo-Library`).
7. **The music itself** and the rip archive (`archive_dir` in `settings.json`), with a backup taken first.
8. **Claude Code's memory folder** for this project (`%USERPROFILE%\.claude\projects\<project>\memory`), which holds the working notes; the folder name depends on the
   directory Claude is started from, so copy the files and let the new PC's Claude rebuild its index, or start it from the same relative path.
9. **Accounts to sign in to again:** GitHub (organisation `MediaVerseStudio`), the project Google account (Cast registration), the Samsung developer account.

## 10. Order of work on the new PC

1. Section 2 (base tools, Visual Studio Build Tools), then Rust (3), MSYS2 (4), Node (5).
2. Clone the repository, run `cargo test --workspace`, `npm install`, `npm test`, `npm run test:electron`. All three must pass before anything else.
3. Fetch the sources and build the CD helper, LAME, rcedit and the FLAC reference (4); run `tools\package-windows.ps1` to check the whole chain.
4. Copy the data and models (9, 7), start the app from the source tree and open the library.
5. Android (6) and Tizen (6) last, since they need the phone and TV in hand.
6. Run `tools\check-before-public.ps1` and the clean-PC install test from `docs/installer.md` on a separate virtual machine, not on this PC.

## 11. What I could not verify from the old PC

- Which exact CUDA and cuDNN packages the Lyric AI runtime libraries were copied from (the versions are visible in the file names; the source is inferred from the
  lab environment).
- The Tizen Studio extension list beyond what is installed (open Tizen Studio's Package Manager on the old PC and write the ticked items down before moving).
- Whether anything in `%APPDATA%\MediaVerse Studio` holds absolute paths that need changing besides `lyric-ai.json` and the `archive_dir` setting (the library
  database stores song paths; keep the music at the same path, or rescan).
