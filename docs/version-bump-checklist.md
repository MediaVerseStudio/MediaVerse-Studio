# Version bump checklist: 0.1.0 to 0.9.0 (written 2026-11-20)

The version stays `0.1.0` until the first public release (D81 area, memory note "version stays 0.1.0"). When going public the version becomes **0.9.0** (a beta: 1.0 then
means "ripped and tested by other people"). This list is every place the number lives or has to be registered, found by searching the repository on 2026-11-20.
`docs/release-checklist.md` is the general list for any bump; this one is specific to the first.

## A. In the repository (change together, one commit)

| Place | What to change | Notes |
|---|---|---|
| `Cargo.toml` line 30, `[workspace.package] version` | `0.9.0` | Every Rust crate inherits it. Run `cargo build` so `Cargo.lock` follows. |
| `web/app/package.json` `version` (and its entry in `package-lock.json`) | `0.9.0` | |
| `crates/disc-metadata/src/lib.rs`, `ACOUSTID_REGISTERED_VERSION` | `0.9.0` | A test fails after the bump until this matches; see B1. |
| `apps/android/app/build.gradle.kts`: `versionName` | `"0.9.0"` | |
| `apps/android/app/build.gradle.kts`: `versionCode` | an integer that only ever goes up (it is 1 now) | Google Play refuses an upload whose `versionCode` is not higher than every earlier upload, **including test uploads**, so raise it for every upload, not just for 0.9.0. |
| `web/app/tv/public/config.xml`: `<widget ... version="...">` | `0.9.0` | The TV build reads the version from here (`vite.tv.config.ts`). Keep the package id `MVStudioTV` and application id `MVStudioTV.MediaVerse` exactly as they are: Samsung installs updates only over the same ids. |
| `tools/installer/install.ps1` line 78, `$version` | `"0.9.0"` | Shown in Settings > Apps. |
| `apps/sidecar/src/profiles.rs` line 71, and `crates/ripper` tests (`calibrate.rs`, `profile.rs`) | tests only; leave `0.1.0` unless a test is meant to follow the program | Drive profiles record the version of the program that measured them. |
| `docs/roadmap.md` (the Version row), `docs/gnudb-registration.md` ("version 0.1.0"), `docs/architecture/0003-sidecar-protocol.md` (example) | wording | Documentation only. |
| Release notes / changelog | add `0.9.0` | |

Check afterwards with `git grep -n "0\.1\.0"`; what remains should be tests, the archive and history.

## B. Outside the repository (register or update, in this order)

1. **AcoustID** (`docs/release-checklist.md` item 1): update the application registration to 0.9.0 *before* shipping, so lookups made by 0.9.0 are accepted. The key is never in the repository.
2. **MusicBrainz:** the User-Agent carries the version (`MediaVerseStudio/0.9.0 (contact address)`); the contact address is set in Settings, never in the program.
3. **gnudb:** the registered application name and version (`docs/gnudb-registration.md`).
4. **LRCLIB:** the user agent string (polite pace stays).
5. **GitHub:** a release tagged `v0.9.0` with the installer(s), the source bundle and SHA-256 files (a release file is limited to 2 GB); the repository description and README status paragraph.
6. **Google Play Console** (Android app `studio.mediaverse.app`): the app listing; each upload needs the higher `versionCode` (A above); the release name should read `0.9.0`; the testing track (see `docs/google-play-beta-testing-guide.md`). The Android Auto and cast declarations and the data-safety form are filled for this app, not per version, but must be reviewed when the version adds permissions.
7. **Google Cast Developer Console:** the receiver application "MediaVerse Studio" (id `0E81A85C`) has its own published page (not versioned like the app) but the registration is moved from "test devices only" to published when the receiver page is live (`docs/casting-plan.md`). The Google account that owns it is the project account.
8. **Samsung Seller Office (TV, Tizen):** the application's version in the submission must equal `config.xml`; the app title must equal the `<name>` label in `config.xml` ("MediaVerse Studio") or the pre-test fails; a new package must not overlap an existing one, and updates must reuse the earlier Tizen id. A **beta test** (Samsung's own, from 2021 TVs, installed on a TV with an activation code downloaded from the Seller Office) is the equivalent of Google's closed test.
9. **SignPath Foundation** (code signing, free for open source, needs a public repository): the project entry; the signing policy names the release; SmartScreen warnings stay until reputation builds.
10. **Microsoft Store (later):** the MSIX package version needs four parts (`0.9.0.0`).
11. **Website** (`mediaverse.studio` repository): the download page, version number, checksums and the "try this build" page.
12. **Jellyfin / other integrations:** none carries the program's version.

## C. After the bump

- `cargo test --workspace`, `npm test`, `npm run test:electron`, `cargo fmt --all --check`.
- Build everything from one clean commit: `tools\make-installer.ps1` (installer and source bundle), the Android release build, `tools\package-tv.ps1`.
- Settings > About must show `0.9.0` and the commit. Check the sidecar's `ready` message and a User-Agent in a request log.
- Update `docs/outstanding.md`, `docs/roadmap.md` and the memory note that says the version stays 0.1.0.
