# Linux build (roadmap goal, plan 2026-11-18)

Owner (2026-11-18): many friends use Linux as their main system, so a Linux application is a goal for later. The owner has no computer set up for Linux at present.
This plan lists what is Windows-only today (from a search of the code on 2026-11-18), the steps, and how to test without a Linux computer. Nothing is built.

## State (2026-11-27): a first test build exists (D217)

The first run on GitHub built the program, installed the `.deb` on a clean Ubuntu 24.04 machine, started it, imported two test tones, read one through the player,
switched sharing on and saved screenshots. A few tests that wrote their paths the Windows way failed and were made to work on both systems.

Branch `feat/linux-build`. `tools/linux/package.sh` makes a `.deb` (Ubuntu 24.04 and newer) and a `.tar.gz`; the workflow `.github/workflows/linux.yml` builds them,
installs the `.deb` on a clean Ubuntu machine, starts the program and runs the tests. `tools/linux/setup-dev.sh` prepares Ubuntu or WSL to build locally
(`docs/dev-environment.md` section 11). Left out of the test build: the CD helper, LAME and conversion to MP3, and the Lyric AI and photo reader downloads. Nothing
has been tried by a person on a Linux computer yet.

The inventory below is from 2026-11-18. By 2026-11-27 much of it needed no work: the Windows-only Rust code already had stand-ins for other systems, and the HTTP
client uses the system's OpenSSL on Linux without a new dependency.

## What is portable already

Electron (Chromium and Node) runs on Linux. The Rust sidecar is standard Rust; its audio, tag, FLAC, MP3 (LAME is C and portable), lyrics, library and review code has no
Windows dependency except the items below. The web front end is the same. The TV and phone apps are unaffected.

## What is Windows-only today (inventory)

| Area | Where | Linux answer |
|---|---|---|
| **Decoding AAC/M4A/WMA/FLAC/WAV to convert to MP3** uses Windows' Media Foundation | `apps/sidecar/src/windows_decode.rs`, `convert_job.rs`, `mp3_job.rs` (the `windows` crate, `cfg(windows)`) | A decoder for Linux: the pure-Rust `symphonia` crate (MPL-2.0; ask the owner, AGENTS.md) or the system FFmpeg libraries (LGPL; ask). Keep the `windows_decode` interface and add a second implementation. |
| **CD drive access** | `apps/cd-helper` (libcdio static, built with MinGW), `apps/sidecar/src/helper.rs` | libcdio is a Linux library to begin with; build the helper natively (`tools/build-cd-helper` needs a bash twin). Drive access needs the user in the `cdrom` group (or udev rules); the offset/cache detection and the drive database carry over. Needs a real drive to test. |
| **Install and update** | `apps/installer-stub` (Windows, uses `tar.exe` and PowerShell scripts), `tools/make-installer.ps1` | An **AppImage** first (one file, no root, runs on most distributions), then `.deb`/`.rpm` and a **Flatpak** (sandbox: check CD-drive and network-share permissions). Auto-update is out of scope. |
| **Firewall check** (TVs cannot reach the program) | `web/app/electron/firewall.js` runs PowerShell, already returns "not blocked" off Windows | Detect `ufw`/`firewalld` and show the one command to open the port instead of changing it. |
| **Process priority** | `apps/sidecar/src/os_priority.rs` (has a non-Windows stub) | Already compiles; map to `nice`/`ionice` later. |
| **Write-only archive folder** | `crates/ripper/src/archive.rs` (`cfg(windows)` for file permissions) | POSIX permissions or an immutable bit; decide with the owner what "write-only" means there. |
| **TLS** uses Windows' own stack (SChannel) through the HTTP client | `apps/sidecar/Cargo.toml` | OpenSSL through the same crate on Linux, or rustls (a dependency decision to ask about). |
| **Data folder** `%APPDATA%\MediaVerse Studio` | Electron's `userData` (already per-OS), the sidecar's data dir | XDG: `~/.config/MediaVerse Studio`; check every place that builds a path by hand. Library paths with backslashes in saved lists (instrumental, review, pins) are keyed by full path: songs moved between systems need a path-prefix mapping. |
| **Build and test scripts** | `tools/*.ps1` (PowerShell) | PowerShell 7 runs on Linux; where a script is only needed on Windows say so, otherwise add a bash twin (`build-libcdio`, `build-cd-helper`, packaging). |
| **GPU for the Lyric AI** | ONNX Runtime with CUDA (NVIDIA) | CUDA works on Linux (an optional download as on Windows); ROCm (AMD) later. CPU always works. |
| **Cast and DLNA discovery**, the TV sharing server | `web/app/electron/*` (Node) | Portable; mDNS may need Avahi running. |

## Steps (in order of value for effort)

1. **Continuous integration on Linux** (GitHub Actions, `ubuntu-latest`): `cargo test --workspace` with the Windows-only parts behind `cfg`, the web and Electron tests. This
   alone finds most portability breakage and needs no Linux computer. (`docs/ci.md` describes the current CI.)
2. **Make the sidecar build and run on Linux** with the conversion feature off (library, review, lyrics, tags, playback sources, sharing all work); stub the decoder.
3. **Electron on Linux:** an AppImage built by CI; start, library, playback, Review, Settings. Testers: the owner's Linux friends (a short "try this build" page, no account).
4. **Decoder for conversions** (the `symphonia` or FFmpeg decision) so M4A/WMA/FLAC can be converted to MP3 as on Windows.
5. **CD ripping:** native libcdio helper, drive permissions guide, tested by a friend with a drive (the owner's drive tests carry over: the offset and cache logic is
   the same). Needs real hardware; a virtual machine with a USB optical drive passed through is possible but slow to set up.
6. **Packaging:** `.deb`/`.rpm`, a Flatpak, and the licence/source bundle as on Windows (`docs/distribution-plan.md`).
7. **Lyric AI on Linux:** ONNX Runtime and the optional CUDA/ROCm packs; the models are the same files.

## Testing without a Linux computer

- CI on Linux for every push (step 1).
- WSL2 with WSLg on the owner's Windows PC runs Linux GUI programs (good for checking the Electron build and the sidecar; no CD drive, no real GPU path guarantee).
- A virtual machine (Hyper-V or VirtualBox) for a full desktop and AppImage test.
- Friends as testers for hardware (CD drives, AMD GPUs, Wayland vs X11, different distributions).

## Open decisions for the owner

- Which distributions to name as supported (suggestion: Ubuntu LTS and Fedora, plus "AppImage runs elsewhere, untested").
- The decoder is decided: **Symphonia** (D137; WMA stays Windows-only, FFmpeg only if friends need it). TLS is still open (dependency approval).
- Whether Linux gets the same two downloads as Windows (without and with the bundled model).
