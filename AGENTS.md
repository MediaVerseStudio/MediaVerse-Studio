# MediaVerse Studio - AI Project Guidance

Before changing code, read:

1. `Guiding Documents/MediaVerse Studio - Project Brief.md`
2. `Guiding Documents/Windows CD Ripping and MP3 Policy.md`
3. `Guiding Documents/Playback, Casting, and Platform Architecture.md`
4. `Guiding Documents/Third-Party Software and Licensing.md`
5. `Guiding Documents/Navidrome Tagging Compatibility.md`
6. `Guiding Documents/Feature Roadmap and Reference Review.md`

The original `.docx` files in `Guiding Documents` are background material. If they conflict with the Markdown specifications above, follow the Markdown specifications and flag the discrepancy rather than silently choosing.

## Project invariants

- Windows desktop is the first target. Android is a later target; do not make Windows-only capabilities prerequisites for Android library, playback, lyrics, or casting features.
- Keep the front end web-based and Chromium-compatible, but do not assume a Chromium-based WebView includes the same APIs or device integrations as the full Chrome browser.
- Keep platform-specific code behind narrow, documented interfaces. Do not expose C++ or DLL details throughout the Rust application.
- CD extraction must preserve and verify source PCM before any lossy encoding when possible. MP3 output is lossy and must never be described as bit-perfect.
- The default MP3 setting is LAME `-V0`; the user can choose CBR 320 kbps with `-b 320` / `--preset insane`.
- Treat CD ripping, metadata lookup, lyrics lookup, playback, and casting as separate services with explicit errors and cancellable background work.
- Do not overwrite or reorganize a user's files without clear user action. Prefer preview, confirmation, and recoverable operations.
- Protect API keys, access tokens, and private library data. Never commit credentials or echo secret values in logs, examples, or generated documentation.

## Rust formatting

- All Rust code uses standard `rustfmt` with its default settings (there is deliberately no `rustfmt.toml`). CI runs `cargo fmt --all --check` and fails if anything is unformatted.
- Before committing Rust changes, run `cargo fmt --all`, then `cargo fmt --all --check` should print nothing. The whole repository was formatted in one commit on 2026-11-16, so formatting never touches files you did not change; if it does, stop and look at why instead of committing or reverting it.
- Never mix formatting with a feature in one commit: if code somewhere is unformatted, format it in its own commit ("formatting only") and add that commit to `.git-blame-ignore-revs`.
- The repository's other languages have their own checks (`npm test` runs the TypeScript type check); do not run a Rust tool over them or the reverse.
- Do not run commands that rewrite many files (formatters, codemods, `git checkout -- .`) on a working tree with uncommitted work; commit or check `git status` first.

## Implementation expectations

- Follow the repository's existing patterns and keep changes focused.
- Prefer typed Rust interfaces, explicit errors, and tests for observable behavior.
- Keep long-running scans, fingerprinting, ripping, tag writes, and network operations off the UI thread. Report progress and support cancellation where practical.
- Check the relevant platform and third-party documentation before implementing integrations. Do not invent SDK APIs or claim a capability works based only on a shared browser engine.
- Before adding, copying, linking, or shipping any dependency, binary, codec, or online service, follow the licensing and provenance requirements in the third-party software guide and ask the owner. CDex/CDRip.dll, fre:ac's CD components, libcdio-sys and Tauri were evaluated and rejected; do not reintroduce them.
- Work on branches (`docs/workflow.md`): `main` is the stable branch and is never worked on directly; changes go to `develop` first and reach `main` only by an owner-approved pull request. Build from the issue tracker only after the owner has approved a summary (the `triage` skill).
- Ask the owner before every `git push`. Record accepted decisions in `docs/decision-log.md`. `docs/roadmap.md` is the plan (roadmap, testing, going public): keep it current when priorities or decisions change.
- Do not reverse engineer or redistribute binaries unless their provenance, license, and applicable permissions have been verified.
- Update the relevant guiding document when an accepted architectural or product decision changes.
