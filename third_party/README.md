# Native Source Intake

Place downloaded archives in `third_party/source/`; that directory is intentionally ignored by
Git. Do not commit upstream archives, unverified DLLs, encoder binaries, or build output
(`third_party/build/` is ignored too).

For each native component:

1. Download only from the URL recorded in `provenance.toml`.
2. Record the exact revision/archive and SHA-256 in `provenance.toml`.
3. Inspect the archive's top-level and bundled dependency licenses.
4. Record local patches and reproducible build commands.
5. Set `approved_for_build = true` only after the owner's review.
6. Use `tools/verify-native-source.ps1` before extracting or building the archive.

## Builds

- **libcdio and libcdio-paranoia:** `tools/build-libcdio-mingw.ps1` builds static MinGW-w64 libraries
  in the MSYS2 UCRT64 environment (configure must run there; the plain MSYS shell targets Cygwin).
  Then `tools/build-cd-helper.ps1` builds `mediaverse_cd_helper.exe` for `x86_64-pc-windows-gnu`.
- **LAME 4.0:**

  ```powershell
  .\tools\build-lame-4.0.ps1 -ArchivePath "C:\path\to\lame-4.0.tar.gz"
  ```

  The script verifies the pinned archive hash, applies the recorded encoder-only fix for an optional
  `mpg123` dependency, builds `Release|x64`, and copies `lame.exe` into `third_party/build/`. MSVC builds
  are not byte-reproducible, so the executable hash differs between builds (noted in `provenance.toml`).
  Watch for newer **stable** LAME releases (home page https://lame.sourceforge.io/index.php, GitHub mirror
  https://github.com/enzo1982/lame/releases); see the "Recurring check" note in `docs/next-steps.md`.
  Betas (such as 4.1 beta 1) are not adopted.
- **Xiph flac tools (test only):** `tools/fetch-flac-reference.ps1` downloads and verifies them for the
  reference-decoder test. They are never shipped.

## Releasing

Published binaries must be accompanied by their corresponding source, local patches, build
instructions, and required notices (see `THIRD_PARTY_NOTICES.md`).
