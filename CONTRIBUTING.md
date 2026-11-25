# Contributing to MediaVerse Studio

MediaVerse Studio is GPL-3.0-or-later. By submitting a contribution, you confirm that you have the
right to contribute it under GPL-3.0-or-later and that you identify any third-party material, license,
and attribution requirements.

Do not submit proprietary code, copied binaries, unverified DLLs, API credentials, copyrighted
test media, or code from a third-party project without its license and provenance details.

Native CD-ripping, encoding, metadata, lyrics, and casting integrations require a documented
source record in `third_party/provenance.toml` and the review gates in
`Guiding Documents/Third-Party Software and Licensing.md`.

## Ways to help

- **Test it.** Beta testers are what the project needs most right now: Windows 11, Android, Samsung TVs, Google TV or Chromecast, a Jellyfin server, Linux. See `docs/beta-testing.md` and https://mediaverse.studio/#beta.
- **Report a problem or an idea** with the issue templates (bug, beta feedback, idea); search the issues first in case it is already there. Vulnerabilities go to the private address in `SECURITY.md`, not a public issue. How issues are tracked is in `docs/workflow.md`.
- **Send a change.** Start from an issue that the owner has approved (`docs/workflow.md`), branch from `develop` (never `main`), open the pull request into `develop`, and read `AGENTS.md` and the Guiding Documents first; keep a change focused, add a test for what it does, run `cargo fmt --all`, `cargo test --workspace`, and in `web/app` `npm test` and `npm run test:electron`.
  New dependencies, models, binaries and online services need an owner decision first (`Guiding Documents/Third-Party Software and Licensing.md`). Decisions are recorded in `docs/decision-log.md`.