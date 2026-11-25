# Roadmap, testing plan and going public (kept by Claude; written 2026-11-19)

This is the one plan. `docs/outstanding.md` is the detailed list of things to try by hand; `docs/next-steps.md` is the diary of where each session stopped;
`docs/decision-log.md` holds the decisions and their reasons (D1 to D142); the Guiding Documents are the product rules. When this file and another disagree,
this file is the newer word: fix the other one.

## 0. Where the project stands (2026-11-23)

| | |
|---|---|
| **Goal** | A **public release and a beta test** on Windows, Android and Samsung TVs, then Google TV and Linux, listed in the Microsoft Store, Google Play and Samsung's TV app store (`docs/beta-testing.md`). The repository is planned to go public **very soon** (the owner's wish: this week); the website already invites testers. |
| **Branches** | `main` = stable and tested, `develop` = the next release being tested, `feat/` and `fix/` branches per issue (D179, `docs/workflow.md`). On 2026-11-23 the owner approved merging `develop` into `main` after testing the builds. |
| **Installed** | PC: the build of 2026-11-23 17:43 from develop (D180 to D185). Pixel: the build of 15:57 (artist list, square tick boxes). Both Samsung TVs: the build of 2026-11-23 afternoon. |
| **Version** | `0.9.0` (a beta; 1.0 will mean "ripped and tested by other people"), set everywhere on 2026-11-24 (D196) using `docs/version-bump-checklist.md`; builds are also told apart by the commit shown in Settings > About. The outside registrations (AcoustID first) must be updated to 0.9.0 before a build is shared. |
| **Tests** | `cargo test --workspace`, `npm test` (400+) and `npm run test:electron` (53) pass; `cargo fmt --check` clean. `tools/check-before-public.ps1` ends with "nothing found" (2026-11-23). |
| **Repository** | Private, organisation `MediaVerseStudio`. Licence GPL-3.0-or-later (D81); name protected by `TRADEMARKS.md`. Website: the public repository `MediaVerseStudio/mediaverse.studio` (GitHub Pages). |
| **Newest work** | Jellyfin as the shared hub and as the whole PC library (D170, D173), the lyrics editor with playback and AI timing (D172), the player's own controls and in-memory songs (D174), silent-song detection, the re-rip list and a varied lucky reel (D175); none of the newest was yet tried by the owner in the running program (`docs/outstanding.md`). |

What works is summarised in the Project Brief ("Status and order of work") and the README: secure ripping with AccurateRip, FLAC archive and LAME MP3s, MusicBrainz/gnudb/
Discogs/CTDB/AcoustID lookup, Fix tags with undo, the library, playback with time-stamped lyrics, Review (artwork, lyrics, album IDs, artists, audio check, defects),
the Samsung TV app, the Android app, casting (TV app, DLNA, Google Cast), TV sharing with pairing, the Jellyfin integration, the installer, and the Lyric AI (finds, checks, times and drafts lyrics).
## 1. Roadmap

Order of work follows the owner's priorities (D49): tag fixing, album art and band photos, lyrics; then the phone app; Google TV later. Each step says what has to be
true before it is done. Items marked **(owner)** need a decision or an approval first (AGENTS.md: dependencies, models, online services, every push).

### Step 1: finish the Lyric AI round (now)
1. **Look at the pass** the owner started (the first thing next session): General review should list the AI's picks with percentages, drafts for songs nobody has,
   and Suspected instrumental; spot-check by ear (`docs/outstanding.md`, section A, "Lyric AI").
2. **Approve in batches** with the tick boxes ("Tick the AI-checked at 90% or more"), a first batch of 20 to 50, a check in another player, then the rest. Back up the
   Music folder first; every write is journalled and a batch can be undone.
3. **Decide the default reader (owner):** the music-lyrics reader (no separator, about 35% less processing, 59 of 60 instrumentals against 48) or the original speech
   reader. If the music reader becomes the default, the Demucs separator and its unstated weights licence leave the default path.
4. **Merge `lyric-sync` into `main`:** needs CI to pass on the branch (a pull request does it, see 2), the owner's say-so, and the third-party notes updated for the
   models. After the merge `lyric-sync` can be deleted.

### Step 2: Lyric AI, next (in order)
1. **Model list and download** (`docs/lyric-models.md`, "What has to be built" step 4): the manifest, in-app download with checksums, "add a model from a file", and
   "Test this model" (the benchmark). Today the model files are copied by hand into `%APPDATA%\MediaVerse Studio\lyric-ai\models`.
2. **Doubtful-line flags recalibrated (D150, done 2026-11-20)** against people-made time stamps; the 10% rule was kept. **(owner)** Decide whether to loosen it to 15% (100% group would pass 32 of 40 instead of 27; more songs written with some lines late).
3. **Better Whisper decoding:** beam search and a temperature fallback (the gap to faster-whisper is 25% against 32% median word error, mostly the bad tail of looping
   songs); word-level hints in the editor (which words Whisper was unsure of).
4. **Cover albums** in Step 2 for songs with no lyrics (today only the To review judge does it); the original artist guessed from an album's title.
5. **Songs whose written lyrics are another arrangement** (Little Sister): drafts cover them once the song is "nothing fits"; chorus-first search is in.
6. **Repeated chorus lines** the artist wrote out once (1876): needs repeated-section detection in the audio.
7. **Lines not sung as written** (live versions): needs a better line-level detector; the `*` marking stays off until one passes (Sylla is the best candidate: 96% of swapped
   lines at 10% false flags, **(owner)** provenance accepted D136, ONNX export still to do).
8. **Sylla** as a second selectable model, **Whisper large-v3** as an optional bigger Whisper, a vocal-activity hint from the music model's own heads.
9. **Built 2026-11-20 (D152; not yet tried by the owner on the whole library): a library-wide check that flags obviously wrong lyrics (owner's wish, 2026-11-19):** run every song that has lyrics through the Lyric AI and list the ones whose words do not fit
   the singing (an instrumental with lyrics, another song's lyrics), for the owner to look at, never removed by itself. The first-line check found 3 such songs among 25 written by the
   AI, all with a fit below -2.8 (D149); that fit is the first thing to test. Needs "Every song" in Step 2 to be able to check lyrics already in the files (today it times plain lyrics).

### Step 3: library, ripping and tagging backlog (from `docs/outstanding.md`, section B)
- Ripping: refuse to start a rip without accepted or typed tags; a "rip audit"; a real scratched disc through the damaged-disc path; ~two dozen CDs still to rip with the
  new tools (including the 48 kHz albums' CDs, `48khz mp3 files.txt` in the Developer folder).
- Tagging and identification: write AcoustID/MusicBrainz ids into existing library files; the bulk "Write IDs" press on the real library; MusicBrainz connection in
  Settings; **(owner)** TheAudioDB / Fanart.tv photo sources (terms and keys).
- Library at scale: the stale `measure-large-library.cjs` script rebuilt and a timing on the 13.7 thousand-song library; the sidecar's second lane.
- Small jobs: Fix tags for "[Error]", "[no artist]" artists; compilations with no album-artist tag; a one-click "remove track numbers from titles" under Fix tags.
- **Gapless playback and crossfade (owner, 2026-11-23; plan only, nothing built).** Today each song is a separate `<audio>` source played from memory (D174), so the next song starts the moment the last ends, with a small gap. Two stages: (1) two `<audio>` elements, each through the existing analyser graph with its own gain; the next song is already in memory (D174), started a chosen number of seconds before the end while the gains cross over (Settings: crossfade 0 to 12 s, off by default; no fade on a manual next, a short fade on pause and stop, as Winamp's crossfade output did); (2) for sample-exact gapless, decode the playing and next song to `AudioBuffer`s and schedule the next with `start(time)` on the audio clock, trimming the encoder's silence at both ends. Needs: MP3 encoder delay and padding are only recorded in a LAME/Xing info header, and the library's files (checked on 2026-11-23: constant 320 kbps, no info header) have none, so the player would have to measure the leading and trailing silence itself (about 25 ms of decoder delay plus whatever the encoder padded) instead of reading it; a live album's songs that run into each other should not be faded (a per-album "no crossfade" or detecting a song that starts with no silence); seek, pause and the position all move to the audio clock; the visualizer, the cast hand-over and the editors' transport read the position and must follow. Several days of work and it needs ears to judge; do it with the owner listening.
  What Winamp's source shows (read 2026-11-23 from the public repository, `Src/Plugins/Output/out_ds`, `out_wave` and `Input/in_mp3`; studied only: its Winamp Collaborative License allows viewing and private changes, not copying into another program, so nothing was copied and ours is written from the idea): (a) **Gapless is one continuous output, not a clever decoder.** The decoder pushes PCM into the output plugin's ring buffer ahead of the speaker. At the end of a file the core asks the output `IsPlaying()`, which reports "no" when the audio still waiting in the buffer is shorter than a small threshold, so the next song is started while the tail of the last is still playing; the output is then closed with a "gapless end of file" hint, which leaves the buffer playing out instead of killing it, and the next `Open()` finds the device already open with the same format and simply keeps appending. A different sample rate, channel count or bit depth means waiting for the buffer to drain and reopening, which is the audible gap. (b) **Trimming is exact only when the file says how much to trim.** The MP3 input reads the encoder delay and padding from the LAME or VBRI header (or the iTunes `iTunSMPB` ID3 tag), cuts the delay plus the decoder's own 529 samples from the start, and holds back that many samples at the end so they are never played. A file with no such header gets no trimming at all (prepad and postpad stay 0): Winamp's gapless for those files is just the continuous output, leaving about 25 ms of decoder delay. (c) **Crossfade is two outputs at once.** The output's buffer is made at least as long as the fade. With "fade at end" on, `IsPlaying()` says "no" once the remaining audio is shorter than the fade time, so the next song starts at (end minus fade); the old output object is told to fade out and be forgotten (volume ramp, then release) while the new one is created at volume 0 and ramped up; the two play together and the sound system mixes them. Fades at the end and at the start switch gapless off, as the plug-in's own FAQ line says; there are separate fade times for pause, stop, the first start and a manual track change. What this means here: the Web Audio graph is the same shape (one output; each song a source with its own gain; the next song decoded ahead; the next started on the audio clock at end minus fade). It also means our header-less 320 kbps files get the same "about 25 ms" in Winamp's own scheme, so measuring the silence ourselves (the plan above) would go beyond Winamp and is optional; the first useful step is the continuous output with scheduled starts.

### Step 4: devices
- Phone (Pixel 11 Pro): Android Auto in the car, the playlists and eight-tab bar on a device, cast with the screen off, the corrected library copied across.
- TV and casting: the Den TV "no capability tags" test; the Living Room Amp; PC casting to the S95Fs; gapless casting; PC cast volume, seek, shuffle, repeat.
- **(owner)** Publish the MediaVerse Google Cast receiver (small fee, Google account) so any Cast device gets the lyrics page; later the Samsung and Google Play stores.

### Step 5: platforms and distribution (see `docs/distribution-plan.md`, `docs/linux-plan.md`)
- **Windows, two downloads:** without a model, and with the music-lyrics model included; Whisper (about 1.6 GB) stays a separate download.
- **Signing:** apply to the SignPath Foundation when the repository goes public (D137); the Microsoft Store (MSIX) as a second channel later.
- **Linux:** CI on Linux first, then an AppImage; Symphonia decoder (D137); the CD helper natively; friends as testers.

## 2. Testing plan

**Automated (every change):** `cargo fmt --all --check`, `cargo test --workspace`, in `web/app` `npm test` (includes the TypeScript check) and `npm run test:electron`.
End-to-end scripts on a throwaway library (never the owner's music): `web/app/scripts/capture-*.cjs` (lyrics review, automatic lyrics, and so on; they drive the real
page and take screenshots). Golden tests pin the numeric code to its references (the Whisper and music-reader front ends, the Demucs transforms, AccurateRip, FLAC).
Ignored tests run the real models on the owner's library read-only (`judge.rs`, `draft.rs`, `lyric_ai_e2e.rs`) and the lab (`MediaVerse-Lyric-Sync-Lab\judge-lab`) holds the
calibration and comparison scripts; their findings are in the decision log (D134 to D142).

**CI:** runs only for pushes to `main` and `spike/**` (Windows, about 11 to 22 of the 2,000 monthly minutes a run, `docs/ci.md`). **Gap:** `lyric-sync` has had no CI run.
Do this before the merge: add a `pull_request` trigger to `main` (done in `.github/workflows/ci.yml`), open a pull request from `lyric-sync` (or start the workflow by hand
for that branch from the Actions tab). A Linux job joins when the Linux work starts.

**By hand (the owner), in this order of value:** (1) the Lyric AI results (section A of `docs/outstanding.md`); (2) ripping a real disc end to end with the new lookup and
AcoustID; (3) the phone and TV items; (4) a **clean-PC install** of the Setup program on a virtual machine (never done; `docs/installer.md`).
Rules that keep the library safe: back up the Music folder before any bulk write; first run a new bulk tool with writing off and play a sample; write a small batch before the
rest; everything that writes is journalled so a batch can be undone.

## 3. Going public

The repository is private and is planned to open very soon. These must be true first; each line says who does it.

**Go-live day** (the owner decides the day; each step is small, in this order)
1. Run `tools\check-before-public.ps1 -AllowedEmails "contact@mediaverse.studio"` (it ended with "nothing found" on 2026-11-23) and re-read the two open boxes below (home TV identifiers; the old commits reachable through `refs/pull/*`).
2. Pick the first public version number, bump it everywhere with `docs/version-bump-checklist.md`, and update the AcoustID registration (`docs/release-checklist.md` item 1).
3. Push `main`; make sure CI is green on that commit; on GitHub: Settings > General > "Change visibility" to Public; turn on Issues (the templates in `.github/ISSUE_TEMPLATE/` are ready), Discussions if wanted, and "Report a vulnerability" or keep `SECURITY.md`'s e-mail.
3b. Turn on **branch protection** for `main` (Settings > Branches: require a pull request, require the CI check "test", no force pushes or deletions; the free plan offers it only once the repository is public) and make `develop` the branch pull requests start from. Add the issues link to the website's Support page (`https://github.com/MediaVerseStudio/MediaVerse-Studio/issues/new/choose`).
4. Fill in the repository's About box (description, website `https://mediaverse.studio`, topics: music-player, cd-ripper, lyrics, jellyfin, chromecast, electron, rust, tizen) and pin the Releases page.
5. Website repository: add the link to the public repository (see its README, "Before the application's repository goes public"), change the "moving to a public GitHub repository" sentence, commit and push.
6. Apply to the **SignPath Foundation** (needs the public repository), add the GitHub Sponsors link to the README and the website when it exists, and start the beta (`docs/beta-testing.md`: Windows first, then the Google Play closed test).
7. Build the two Windows downloads from the released commit with `tools\make-installer.ps1`, publish them as a GitHub Release with their SHA-256 files and the source bundle.
**Privacy and the repository** (`tools/check-before-public.ps1` is the check; `docs/release-checklist.md` item 6)
- [x] Commit metadata: the public repository starts from one snapshot commit with no earlier history (decided 2026-11-25, D200), so nothing from the old history, including what GitHub keeps reachable through its pull-request refs, is published; the old repository is kept private as an archive.
- [x] Tracked files: personal paths, the owner's first name and email addresses were scrubbed from the documents, scripts and test fixtures on 2026-11-20 (D154); placeholder addresses in test fixtures are on the script's allow list. No private network addresses, keys or secrets are tracked (checked).
- [ ] Home TV identifiers and the owner's device ids stay in the private local file, never in the repository (also true of the lab and handoff folders).
- [x] The script ended with "nothing found" on the snapshot (2026-11-25). Switching the repository to public is a one-way step that **(owner)** takes.

**Licences and notices** (`THIRD_PARTY_NOTICES.md`, `third_party/`, Guiding Document "Third-Party Software and Licensing")
- [ ] Every bundled or downloadable model has its licence text and origin in `licenses`: music-lyrics reader (MIT, training data undocumented, accepted D136), Whisper (MIT),
  Sylla (GPL-3.0, separate download only). A non-commercial model is never bundled or listed by default.
- [ ] Setup is shared together with its source bundle (GPL parts: libcdio, LAME, libiconv); `make-installer.ps1` makes both from a clean commit.
- [x] The Demucs weights' licence is "not stated" (decided 2026-11-24, D200): the separator is **not in the default path** (the music-lyrics reader and the Whisper rows do not need it and were as good or better on the full mix), it is **never bundled or in the installer**, and the speech reader that needs it stays a selectable option with files the person supplies. If an in-app download is added later it is offered as optional with a plain disclaimer (the code is MIT; the weights' licence is not stated and they were trained on a research dataset; personal, non-commercial use).

**Build, signing and release**
- [x] First public version number: **0.9.0** (beta), set 2026-11-24 (D196); the AcoustID application was re-registered at that version (D197).
- [ ] CI green on the commit that is released; clean-PC install test passed; the release checklist run top to bottom.
- [ ] Signing: apply to the SignPath Foundation (free for open source, needs a public repository); until it is signed SmartScreen warns ("More info > Run anyway").
- [x] The release `v0.9.0` (draft until the repository is public): the Windows installer, the Android `.apk` and the source bundle, built from one commit, with SHA-256 files. One Windows download for now (the Lyric AI models are not in it); a second "with Lyric AI" download waits for the model list (below).
- [ ] Models in the in-app list are fetched from their own pages with checksums (the model list and download are Step 2, item 1: needed before the "with Lyric AI" download is
  easy to use).

**Services and accounts** (rules in `docs/architecture/0006-disc-metadata-lookup.md`)
- [ ] MusicBrainz: user agent with a contact address (project address in Settings, not in the program); AcoustID: application registered at the released version; gnudb:
  registration; LRCLIB: polite pace and user agent. Never scrape Genius, AZLyrics, Musixmatch, Amazon, Bandcamp or Discogs images; never download the LRCLIB dump.
- [ ] Project accounts in place: GitHub organisation, Google account for the Cast registration, GitHub Sponsors link in the README and website (**owner**).

**People**
- [ ] README (status paragraph and screenshots), `CONTRIBUTING.md`, issue templates, a security contact; the website repository (`mediaverse.studio`) and its receiver page.
- [ ] A short "try this build" page for friends; Linux friends as testers once the AppImage exists.

## 4. Decisions waiting for the owner

| Decision | Needed for | My recommendation |
|---|---|---|
| Default reader: music-lyrics or speech | Step 1 | Music-lyrics, after the morning review |
| Rewrite history or start fresh for the public repository | Going public | Rewrite to the no-reply address, then re-run the check |
| First public version number | Going public | 0.9.0 (a beta) so 1.0 means "ripped and tested by others" |
| Whisper: separate download only, or bundled | Distribution | Separate (about 1.6 GB) |
| Sylla bundled or download only | Distribution | Download only until its GPL-3.0-only grant is checked |
| Cast receiver publication (fee) | Devices | After the first public release |
| TLS library for Linux, FFmpeg for WMA on Linux | Linux | rustls or OpenSSL (ask when started); no FFmpeg unless friends need WMA |
| TheAudioDB / Fanart.tv photo sources | Step 3 | Only if Wikimedia photos are not enough |
