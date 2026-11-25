# Release checklist

Steps to do whenever the program's version number changes (`version` under `[workspace.package]` in
`Cargo.toml`, and `web/app/package.json`).

1. **Update the AcoustID application registration** at https://acoustid.org/application/38031 to the
   new version number. Then change `ACOUSTID_REGISTERED_VERSION` in
   `crates/disc-metadata/src/lib.rs` to the same value. A test
   (`the_acoustid_registration_matches_the_program_version`) fails after a version bump until that
   constant is updated, so the step cannot be forgotten silently.
2. Check that the other services' terms still match what `docs/architecture/0006-disc-metadata-lookup.md`
   records: MusicBrainz rate limit and User-Agent rules, AcoustID rate limit (3 requests per second)
   and non-commercial terms, and the gnudb application-registration requirement.
3. Run every test suite: `cargo test --workspace`, and in `web/app`
   `npm test` and `npm run test:electron`.
4. **Credentials stay out of the source.** The project's AcoustID application key (it identifies the program and is meant to ship with it) is compiled into the released program at build time: 	ools\make-installer.ps1 reads it from MEDIAVERSE_ACOUSTID_KEY or from the private file %USERPROFILE%\.mediaverse\acoustid-key.txt, never from the repository. A build made from the source without it starts with no key and the Settings page asks. Personal keys (Discogs, TheAudioDB, Fanart.tv) and MusicBrainz contact details are entered by the user in Settings. Check `git grep` for the key before publishing.
5. Published binaries need their corresponding source, patches, build instructions and notices
   (`third_party/README.md`).
6. **Personal data check.** Run `pwsh tools/check-before-public.ps1` (it automates most of this; see also GitHub issue #3). Before the repository is made public or a build is shared: confirm the
   repository visibility; run `git log --all --format='%ae' | sort -u` and make sure no personal
   email address appears (use the GitHub no-reply address; set `git config user.email` for this
   repository); `git grep` for email addresses, `password`, `token` and any real API key; check that
   test fixtures contain only made-up values. Keys and contact details belong in the user's own
   settings, never in the program or its documentation.
7. **FLAC reference check.** Run `pwsh tools/fetch-flac-reference.ps1` once, then
   `cargo test -p mediaverse_ripper --test reference_decoder -- --nocapture`. It must not say SKIPPED. It
   tests our FLAC files with Xiph's own decoder in strict mode (ADR 0005).
8. **Installer.** Run `tools\make-installer.ps1` and test `dist-installer\MediaVerse-Studio-Setup.exe` on a clean virtual machine (see docs/installer.md) before sharing a build; the shipped bundle must also carry the source and notices required by the third-party licences.
9. **CI on the commit being released.** CI runs for pushes to main and for pull requests into main (not for every push to a long-lived branch). Open a pull request, or start the workflow by hand from the Actions tab, and wait for it to be green before a build is shared or a branch is merged.
10. **Going public** has its own gates (privacy of the history, licences and notices, signing, services, accounts): docs/roadmap.md, section 3. Run pwsh tools/check-before-public.ps1 last; it must end with "nothing found".
