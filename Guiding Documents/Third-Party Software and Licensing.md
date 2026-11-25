# Third-Party Software and Licensing

MediaVerse Studio is GPL-3.0-or-later (D81). Every outside component is either **in use** (reviewed, pinned and recorded in `third_party/provenance.toml`), **rejected**, or a **reference only** (studied for ideas; no code, binaries or assets copied).

Studying a project, running it as a separate program, linking its library, copying source and bundling a compiled binary are different choices with different obligations. A public repository is not permission to redistribute.

## In use

| Component | How it is used | Licence | Notes |
|---|---|---|---|
| libcdio, libcdio-paranoia | Static library inside the CD helper (`apps/cd-helper`) | GPL-3.0-or-later | Built from pinned source with MinGW (`tools/build-libcdio-mingw.ps1`). Six paranoia files carry only copyright lines; reviewed in D7 and approved. |
| libiconv | Linked statically by libcdio | LGPL | Record its exact source and notice before any public binary release. |
| LAME 4.0 | Separate encoder program (`lame.exe`) | LGPL-2.0-or-later | Built from the pinned archive (`tools/build-lame-4.0.ps1`). The main MP3 patents expired in 2017; confirm before a public release. |
| flacenc, claxon | FLAC encode and decode-back check | Apache-2.0 | Pure Rust (D9). |
| nanomp3 | MP3 decode-back check and defect scans | MIT OR Apache-2.0 | Pure Rust (D18). |
| lofty | Library tag reading and editing (`crates/adapters/metadata-tags`); independent reader in ripper tests | MIT OR Apache-2.0 | Never used to write FLAC masters (ADR 0005). |
| rusqlite (bundled SQLite) | Library database and defect scan results | MIT; SQLite is public domain | Recorded in provenance 2026-11-03 (D35). |
| rusty-chromaprint (in the build since 2026-11-16, D113) | AcoustID fingerprints, pure Rust | MIT (a port of Chromaprint, whose own code is MIT; its LGPL part is FFmpeg code this port does not use) | Approved 2026-11-03 (D35); tested 2026-11-16: fingerprints of two real songs were recognised by AcoustID (scores 0.98 and 0.97). |
| ureq with native-tls / schannel | HTTP and HTTPS through Windows' own TLS | MIT / Apache-2.0 | No cryptography library is bundled (D12). |
| md-5 | FLAC audio signature | MIT OR Apache-2.0 | |
| windows (Microsoft) | Windows-only: Media Foundation decoding for Convert to MP3 (`apps/sidecar/src/windows_decode.rs`) | MIT OR Apache-2.0 | Approved 2026-11-04 (D53). Decoding uses the codecs Windows itself ships and licenses (AAC, WMA, FLAC, WAV, and more with Microsoft's media extensions); no codec is bundled. PC only. |
| Electron | Desktop shell | MIT; bundles Chromium and Node.js, each with its own notices | |
| AndroidX Media3 1.11.1 (`media3-exoplayer`, `media3-session`) | Android app: playback, media session, Android Auto browse tree | Apache-2.0 | From Google's Maven repository. Pulls in Guava (Apache-2.0). Approved by the owner 2026-11-04 (D57). |
| AndroidX `webkit` 1.18.0, `core-ktx` 1.19.1, `activity-ktx` 1.13.0; Kotlin standard library | Android app: WebView asset loader and message channel, Android helpers | Apache-2.0 | Approved by the owner 2026-11-04 (D57). |
| Android SDK command-line tools, build tools, emulator, Desktop Head Unit; Gradle 9.8.2; Android Gradle Plugin 9.5.0 | **Build and test only**, never shipped | Android SDK License Agreement (Google); Gradle and AGP Apache-2.0 | Downloaded from Google and Gradle, checksums checked (D57). JUnit 4.13.2 (EPL-1.0) for unit tests only. |
| Xiph `flac` 1.5.0 tools | **Test only**, never shipped | BSD-3-Clause / GPL | Fetched and verified by `tools/fetch-flac-reference.ps1` (D14). |

Online services in use, each with its own terms: MusicBrainz and the Cover Art Archive, Discogs (with the user's own token; D50), gnudb, AccurateRip, LRCLIB, iTunes and Deezer search (D106), and AcoustID (the project's application is registered; song lookups by sound are off until the person switches them on). Their rules are summarized in `docs/architecture/0006-disc-metadata-lookup.md` and D29. Artwork may be fetched from the Cover Art Archive and from an iTunes or Deezer cover address those search replies already include (D133). Discogs images are not fetched; Discogs is opened in the browser with the required credit. Genius, AZLyrics, Musixmatch, Amazon and Bandcamp are not scraped.

## Rejected

| Component | Why |
|---|---|
| CDex / CDRip.dll | The pinned CDRip build compiles GPLv2-marked paranoia sources into a GPL-3.0-or-later wrapper; the combination is unresolved, and a prebuilt DLL cannot be verified. Replaced by libcdio-paranoia (D4). |
| fre:ac / BoCA CD components | They load the same CDRip DLL. Studied for job and component design only. |
| libcdio-sys (Rust crate) | Its secure-read build rejects MSVC and its GNU-target binding step fails (D6). Hand-written bindings in the CD helper are used instead. |
| Tauri | Replaced by Electron with a Rust sidecar (D1); its retired code is no longer in the repository (kept in the project's private archive only). |
| Gracenote | No API keys obtainable and its documentation unreachable (ADR 0006). The settings slot stays, reporting "not available". |

## References only

These shape behaviour and design. Their code, SDKs, binaries, artwork, icons, fonts and names are not copied. The Feature Roadmap says what each one teaches.

- **MIT or other permissive licences:** foo_openlyrics (lyrics model). Adapting any source would still need attribution, an exact revision and this review.
- **Copyleft:** Navidrome (AGPL-3.0: tagging and scanning model, no source copied), CUETools/CUERipper (GPL-2.0-or-later, C#), fre:ac (GPL-2.0), Rune (MPL-2.0).
- **Proprietary or closed:** foobar2000, Windows Media Player, Zune, Exact Audio Copy, MusicBee, Plex, Winamp. Winamp's source was published in 2024 under a restrictive licence that is not open source; treat it as closed. Its visualization ideas can be implemented with separately licensed open projects, each of which needs this review first.

## Rules for adding anything new

1. Identify the exact source repository, release or commit, and how any binary was produced.
2. Read the licence files, per-file notices, build instructions and bundled dependencies.
3. Decide the route: source reuse, dynamic linking, static linking, a separate program, or reimplementation from documented behaviour.
4. Confirm the route is compatible with GPL-3.0-or-later (that is, usable under GPL-3.0) and with how the program is distributed.
5. Pin the version and checksum, and keep the notices and source-offer obligations.
6. Keep the adapter narrow so the component can be replaced.
7. Ask the owner before setting `approved_for_build = true`, and log the decision in `docs/decision-log.md`.

Never download a binary from an unverified site or copy one from an installed program. Keep unsafe FFI in one small module and validate everything that crosses it.

## Releasing binaries

The installer (`docs/installer.md`) bundles LAME, libcdio, libcdio-paranoia, libiconv and Electron. Every release carries the corresponding source bundle (`tools/make-installer.ps1` makes it from the same commit: the program's source, the local patches, the exact third-party archives and the build instructions) and the licence notices (`third_party/README.md`, `THIRD_PARTY_NOTICES.md`), and the app has a licence screen. Get legal advice before a wider release.

## Credentials

Personal service keys (Discogs, TheAudioDB, Fanart.tv) are entered by the user and kept in the user's data folder. The project's own AcoustID application key identifies the program to AcoustID and is meant to ship with it: the packager supplies it at build time from a private file outside the repository and it is compiled into the released program (D197); it is never in the source, documentation, logs, screenshots or tests, and a source build starts without one. Nothing else secret is ever in the repository (D11, D12). Personal email addresses, passwords and logins are never stored by the program. Use placeholders in documentation.

## Upstream links

- libcdio: https://github.com/libcdio/libcdio
- libcdio-paranoia: https://github.com/libcdio/libcdio-paranoia
- LAME: https://lame.sourceforge.io/
- flacenc: https://crates.io/crates/flacenc
- claxon: https://crates.io/crates/claxon
- nanomp3: https://crates.io/crates/nanomp3
- lofty: https://crates.io/crates/lofty
- Electron: https://www.electronjs.org/

Licences and terms can change. Re-check the pinned revision and its dependency tree before each release.

## Jellyfin (added 2026-11-23)

Jellyfin (GPL-2.0 server, "jellyfin.org") is **not bundled, copied or linked**. MediaVerse Studio is a client of the server's public HTTP API, written in the project, and talks only to a server the person runs at a home-network address. Installing Jellyfin is left to its own installer; the program only finds, checks and opens it. Winamp's public source (Winamp Collaborative License: viewing and private changes only) was read in 2026-11 for ideas about gapless playback and crossfade; nothing was copied and nothing from it may be (see docs/roadmap.md).
