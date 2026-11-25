# MediaVerse Studio

A free, open-source music library and player for people who still own CDs, and for everyone who wants their collection, with its covers and lyrics, on every screen in the house. It rips discs accurately (verified against AccurateRip), keeps an optional lossless FLAC archive, makes high-quality MP3s for everyday listening, and plays them with album artwork and lyrics together.

**Website and beta sign-up: [mediaverse.studio](https://mediaverse.studio)**

| Platform | State (0.9.0 beta, 2026-11-25) |
|---|---|
| **Windows 11** | The full program: rip, fix tags, covers and lyrics (with the Lyric AI), library, playback, playlists, casting. **Public beta: the installer is on the [Releases page](../../releases)** |
| **Android** | Playback app with Android Auto and casting; keeps the music you choose from your Jellyfin server on the phone, in step both ways. **Public beta: an `.apk` is on the Releases page** (install it directly; Google Play comes after its closed test) |
| **Samsung TVs** (Tizen) | An app for the remote that plays from your PC, a Jellyfin server or a USB drive. Working on real TVs, but **not a download yet**: Samsung only installs an app on TVs named in its developer's certificate, so other people get it through Samsung's store beta (`docs/beta-testing.md`); you can also build and sign it yourself for your own TV (`docs/tv-apps.md`) |
| **Google TV** | Next: the Android app laid out for the TV and its remote |
| **Linux** | Planned: an AppImage first (`docs/linux-plan.md`) |
| **Stores** | Planned: Microsoft Store, Google Play (after a closed test of at least 12 testers for 14 days) and Samsung's TV app store (`docs/beta-testing.md`) |

The Windows installer is not signed yet (code signing for free software needs a public repository first), so Windows SmartScreen says "Windows protected your PC": choose **More info**, then **Run anyway**. Each release has a `.sha256.txt` file to check the download and the matching source bundle (parts of the program are GPL or LGPL, so the source is offered with it).

**Jellyfin** is built in: the PC, the phone and the TV sign in to your own Jellyfin server with a code, and the server becomes the shared home for playlists and for songs you flag on any device. The PC can use the server's shared folder as its music folder (everything works, Jellyfin only rescans) or the server alone as its library (play and cast only). **Casting** works to TVs running the app, Google Cast devices and DLNA renderers, from a folder or from the server.

> **Status (0.9.0 beta, 2026-11-25):** the first public beta. It has been used on one large library and tried on a clean Windows 11 virtual machine, not by many people yet, so back up your music before using the tools that change files (each has an undo). Working on Windows: drive setup and
> calibration, secure ripping with AccurateRip, FLAC archive, LAME MP3 copies with tags, cover art and lyrics, MusicBrainz/gnudb/Discogs lookup, the library with tag editing, repair and review pages and a library organiser, playlists (also rule-based ones),
> playback with Now Playing, time-stamped lyrics, gapless and crossfade, a ten-band equalizer, volume levelling that never turns anything down (optionally written into the files as ReplayGain tags, with undo), optional exclusive (WASAPI) output and a mini player,
> casting, a single-file installer, the **Lyric AI** (finds, checks and times lyrics by listening, drafts lyrics for songs nobody has; AI models are separate, optional downloads), a lyrics editor with AI-assisted timing, an audio defect scan that also finds silent songs
> with a re-rip list, and the Jellyfin integration. The Samsung TV app and the Android app remember what was playing. **The plan (roadmap, testing, what is next) is [`docs/roadmap.md`](docs/roadmap.md);** the beta plan is
> [`docs/beta-testing.md`](docs/beta-testing.md); see also [`docs/next-steps.md`](docs/next-steps.md) and [`docs/decision-log.md`](docs/decision-log.md) (why each choice was made).

## Help test it

MediaVerse Studio is looking for beta testers on Windows 11, Android, Samsung TVs, Google TV and Chromecast, with or without a Jellyfin server, and Linux users for when that build exists. Install the beta from the Releases page and tell us what you find; the project gets what it needs to reach the stores (`docs/beta-testing.md` explains why and how). Please post questions, problems and ideas on the [issue board](../../issues/new/choose) (templates for a bug, beta feedback and an idea) rather than by e-mail, so others can see and help. Vulnerabilities go through GitHub's private reporting described in [`SECURITY.md`](SECURITY.md).
---

## For AI agents and contributors

> Read [`AGENTS.md`](AGENTS.md) and the [`Guiding Documents`](Guiding%20Documents/) before implementing
> anything. Do not add frameworks, native dependencies, third-party binaries or online services without
> asking first.

1. [`AGENTS.md`](AGENTS.md): project rules
2. [`Project Brief`](Guiding%20Documents/MediaVerse%20Studio%20-%20Project%20Brief.md): scope, boundaries, status
3. [`Windows CD Ripping and MP3 Policy`](Guiding%20Documents/Windows%20CD%20Ripping%20and%20MP3%20Policy.md): extraction, verification, LAME settings
4. [`Playback, Casting, and Platform Architecture`](Guiding%20Documents/Playback%2C%20Casting%2C%20and%20Platform%20Architecture.md): shell, playback, casting, Android
5. [`Third-Party Software and Licensing`](Guiding%20Documents/Third-Party%20Software%20and%20Licensing.md): what is used, rejected, or reference only
6. [`Navidrome Tagging Compatibility`](Guiding%20Documents/Navidrome%20Tagging%20Compatibility.md): tagging rules
7. [`Feature Roadmap and Reference Review`](Guiding%20Documents/Feature%20Roadmap%20and%20Reference%20Review.md): inspirations and what comes next
8. [`docs/roadmap.md`](docs/roadmap.md): the plan (roadmap, testing, going public); [`docs/README.md`](docs/README.md) lists every document
9. [`docs/architecture/`](docs/architecture/): ADRs 0001 to 0009

---

## Tech stack

| Area | Choice |
|---|---|
| Platforms | Windows 11 first; Android and Samsung TV apps built; Google TV next; Linux planned (`docs/linux-plan.md`); stores planned (`docs/beta-testing.md`); iOS later |
| Shell | Electron (D1), with an allowlisted IPC bridge |
| Core | Rust, reached through a JSON-lines sidecar process (ADR 0003) |
| Front end | TypeScript and Vite, plain DOM, no UI framework |
| Library data | SQLite (bundled), plus small JSON files for settings, history, flags and pins |
| CD reading | libcdio + libcdio-paranoia in a separate CD helper process (D4, ADR 0007) |
| Verification | AccurateRip v1 and v2 checksums with per-drive offset calibration (ADR 0004) |
| Lossless archive | FLAC via flacenc, decoded back with claxon and checked against Xiph's reference decoder |
| MP3 | LAME 4.0 (`-V0` default, `-b 320` optional), decoded back with nanomp3 |
| Disc lookup | MusicBrainz and gnudb; cover art from the Cover Art Archive (ADR 0006) |
| Lyrics | Tags, then a `.lrc` file, then LRCLIB (D28, D29); the Lyric AI (D127 to D142) listens to songs with ONNX models (music-lyrics CTC reader, Whisper for drafts), downloaded separately (`docs/lyric-models.md`) |
| Casting | Google Cast, DLNA and the Samsung/Tizen TV app as separate adapters (built, D76 to D80) |

## CD ripping in one paragraph

"Near-lossless" here means bit-perfect PCM extraction before any lossy encoding, where the disc and drive permit it. Each track is read securely, corrected for the drive's offset, and compared with AccurateRip; the result (matched, no match, unavailable) is reported honestly. The verified audio becomes an optional FLAC master in a separate archive folder and an MP3 in the music library. An MP3 is lossy and is never described as bit-perfect. Full policy: the ripping guide above.

---

## Repository layout

```text
.
├── AGENTS.md, CONTRIBUTING.md, LICENSE, TRADEMARKS.md, THIRD_PARTY_NOTICES.md
├── Guiding Documents/     Product, ripping, platform, licensing and tagging guidance
├── docs/                  Decision log, next steps, ADRs, design notes, CI, installer, release checklist
├── apps/
│   ├── sidecar/           Rust process the Electron shell talks to (jobs, settings, library services)
│   ├── cd-helper/         Native CD reader (libcdio, GNU target)
│   ├── android/           Android playback app (Kotlin)
│   └── installer-stub/    Self-extracting setup program for test builds
├── crates/
│   ├── domain/            Portable entities, IDs, value types, errors
│   ├── application/       Use cases and port traits
│   ├── host/              Library state and command dispatch used by the sidecar
│   ├── ripper/            Drive profiles, calibration, FLAC/MP3/ID3/LRC writers and checkers, defect scan
│   ├── accuraterip/       Checksums, disc IDs, database parsing, offset search
│   ├── disc-metadata/     MusicBrainz, CDDB/gnudb, settings, rate limits
│   ├── lyric-ai/          Lyric AI logic: text, alignment, identity by fit (pure, no models)
│   ├── lyric-engine/      Lyric AI engine: ONNX Runtime readers (speech, music-lyrics), Whisper, audio front ends
│   ├── tag-repair/        Fix tags rules and judgement
│   └── adapters/          library-filesystem, metadata-tags, persistence-sqlite
├── web/app/               Web UI (src/) and the Electron main process (electron/)
├── tools/                 Build, packaging, installer and check scripts (and the Python lyric-sync prototype)
├── third_party/           provenance.toml and source-intake rules (downloads are git-ignored)
```

---

## Build and run

The easiest way: double-click `Start MediaVerse Studio.cmd` (or run `tools\start-mediaverse.ps1`; `-Fresh` uses a
throwaway data folder, `-SkipBuild` skips rebuilding).

Tests and manual builds need a current Rust toolchain and Node.js LTS:

```powershell
cargo test --workspace                  # set MEDIAVERSE_LAME_PATH to a built lame.exe to include the MP3 tests
npm --prefix web/app install
npm --prefix web/app test
npm --prefix web/app run test:electron
```

Native parts are built separately: `tools/build-libcdio-mingw.ps1` then `tools/build-cd-helper.ps1` (needs MSYS2
UCRT64), and LAME with `tools/build-lame-4.0.ps1`. A test copy: `tools/package-windows.ps1`; a single-file
installer: `tools/make-installer.ps1` (see `docs/installer.md`). Release steps: `docs/release-checklist.md`.

---

## Safety and privacy

- Your audio files are authoritative until you approve a change. Tag, picture and lyric edits are confirmed
  first, and each file is replaced only after the new copy is checked.
- Listening history (for Home) is on until you switch it off in Settings; it never leaves your computer and
  can be cleared.
- Online lookups happen only for what you ask: a disc's table of contents for album details, and a song's
  title, artist, album and length for lyrics.
- API keys are entered in Settings and kept in your data folder, never in the program or the repository.

## License

MediaVerse Studio is free software, licensed under the [GNU General Public License, version 3 or (at your option) any later version](LICENSE).
Anyone who shares a copy or a changed version must share it under the same licence, with its source code, so
it stays free for everyone. Bundled components (libcdio, libcdio-paranoia, LAME, Electron and others) keep
their own licences; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`third_party/provenance.toml`](third_party/provenance.toml).

The name "MediaVerse Studio" and its logo are not covered by the GPL: changed versions need their own name. See
[`TRADEMARKS.md`](TRADEMARKS.md).

## Supporting the project

MediaVerse Studio is free and will stay free. It is made in spare time; there are no paid features, adverts or tracking. There is no donation link at the moment; if the project ever grows to need one, it will be announced here.

## Credits

Created and maintained by Kris Turner. Thank you to Jason Williams for the inspiration and encouragement to build it. The outside software the program builds on is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See also [AUTHORS.md](AUTHORS.md).
