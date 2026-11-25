# Decision Log

Accepted design decisions for MediaVerse Studio, newest last. Each entry names the document that
holds the detail. Update this file whenever a decision is made or reversed. Entries keep their
original wording as a dated record; where a later decision changed one, its **Status** line says so.

## Current state in brief (updated 2026-11-02)

| Topic | Decision now in force | Entries |
|---|---|---|
| Shell | Electron with a Rust sidecar; Tauri archived | D1, D19 |
| CD reading | libcdio + libcdio-paranoia in a separate CD helper; CDex/CDRip.dll, fre:ac's CD route and libcdio-sys rejected | D4, D6, D7, D8 |
| Rip flow | Secure read, AccurateRip check, WAV, optional FLAC archive, MP3 (LAME V0 or CBR 320), WAV removed | D2, D3, D9, D18 |
| Tags | FLAC: plain text tags, `cover.jpg` and `.lrc` beside; MP3: ID3v2.3 with pictures and lyrics; one artist string and a year | D15, D16, D17, D20, D30 |
| Lookup | MusicBrainz and gnudb over HTTPS; Cover Art Archive; AcoustID registered, not used yet; Gracenote unavailable | D10 to D12 |
| Library | Browse, tag edit and batch edit, pictures and lyrics, Review page, defect scan, flags | D22, D24, D25, D30 |
| Playback | HTML audio over local files, queue, Now Playing wall, lyrics tab, LRCLIB on request | D20, D23, D26, D28, D29 |
| Home | History (on until switched off), pins, recently added | D26, D27 |
| Platforms | Windows first; Android playback app next; iOS later; phone ripping furthest out | D21 |
| Design | Zune-inspired, proposal awaiting confirmation; Winamp-style visualizer planned | D23, D31 |

## D1: Keep the Rust core and reach it from Electron through a sidecar (2026-10-31)

Electron stays an evaluated shell (ADR 0002); the Rust application and adapters remain the single
implementation, reached through a versioned stdio JSON protocol (ADR 0003). A Node rewrite was
rejected: Node cannot read audio CDs without a native helper anyway, the working Rust code and tests
would be discarded, and Android could not share the logic.
Status: implemented. Tauri was retired and archived in D19.

## D2: Rip to verified PCM (WAV) first; FLAC master and MP3 are both made from it (2026-10-31, corrected 2026-11-02)

Workflow: extract PCM, verify, write it to a WAV working file, then make the FLAC master (optional, D3)
and the MP3 copy from that same verified PCM; delete the WAV once every requested output has succeeded
(`keep_wav` overrides). Nothing is decoded on the way except the safety check that re-reads each FLAC
and compares it sample for sample with the WAV. The original wording said "write FLAC first"; the
code never did that, and a WAV working file avoids a pointless encode/decode round trip. Verification
results (extraction completed / local read checks / reference match / reference unavailable) are
reported separately, as the ripping policy already requires. Detail: `Guiding Documents/Windows CD
Ripping and MP3 Policy.md`.
Status: implemented. **Archive switch (2026-11-02):** a saved setting "Keep a lossless FLAC archive of
each CD I rip" (`set_archive_enabled`, default on, on the Settings page) decides whether a rip also
makes the FLAC master. Turning it off keeps the chosen archive folder. A `rip_disc` request may still
override it with `archive: true|false`. With it off, a rip is just rip, verify, WAV, MP3.
**Folder checks before ripping (2026-11-02):** `rip_disc` now refuses to start, before the disc is read, if
archiving is on and no archive folder is chosen (`archive_folder_required`), if the archive folder is the
same as, inside, or containing the Main Media Library (`invalid_archive_location`), or if the temporary WAV
folder is inside the library (`output_in_library`). Paths are compared by their real location, including
folders that do not exist yet. This keeps duplicate song files out of the music library.

## D3: Separate Media Library Archive location for FLAC masters (2026-10-31)

Saving the FLAC masters is optional. When enabled they are tagged and stored in a "Media Library
Archive" location that is configured separately from the Main Media Library (which holds the MP3s
used for playback). The two locations must be different and must not contain one another. The
archive is not scanned into the playback library unless the user chooses to. Files are never moved
or overwritten without user action.
Status: implemented (D9). The archive is write-only and never scanned into the library. Folder
naming: `<archive>/<album artist>/<album>/NN - Title.flac` (ADR 0005).

## D4: libcdio + libcdio-paranoia for extraction, AccurateRip for verification (2026-10-31)

libcdio and libcdio-paranoia (GPL-3.0-or-later) replace the CDRip DLL that CDex and fre:ac use,
resolving the CDRip licensing blocker. Accuracy plan: drive read-offset correction, paranoia secure
mode, a drive cache test, AccurateRip (or CTDB) comparison, and a per-rip log. AccurateRip/CTDB
usage terms must be checked before shipping. Detail: ripping policy and
`Third-Party Software and Licensing.md`.
Status: implemented (D6 to D9). CTDB is not used yet. AccurateRip terms still to be checked before a
public release.

## D5: Lyrics follow the foo_openlyrics model (2026-10-31)

Pluggable lyric sources tried in a user-ordered priority, synced (LRC) and plain lyrics, manual
search and edit, saved to the tag and optionally a sidecar `.lrc`. First source: LRCLIB. Plain
lyrics go to ID3 `USLT`, synced lyrics to `SYLT`, plus an optional `.lrc` file because many players
ignore `SYLT`. No scraping of lyric sites by default. Reference:
https://github.com/jacquesh/foo_openlyrics (check its license before copying any code; use it as a
design reference).
Status: partly implemented. Lyrics are read from tags, then a `.lrc` file (D28), and looked up on
LRCLIB on request (D29); typed or pasted lyrics are saved to USLT/SYLT (D22). Not built: a user-ordered
source list and bulk lookup.


## D6: Native libcdio build and ripper design references (2026-10-31)

Build libcdio and libcdio-paranoia from pinned source releases with MinGW (the `libcdio-sys` crate
is rejected for now: its secure-read build fails on MSVC and its GNU bindgen step is broken, per
`Third-Party Software and Licensing.md`). Wrap them in a narrow C interface used only by the
sidecar. The Rust target for the sidecar becomes `x86_64-pc-windows-gnu`; the Electron and Tauri
shells are unaffected.

Findings from reviewing CUERipper (CUETools, GPL-2.0-or-later, C#; `CUETools.Ripper.SCSI/SCSIDrive.cs`
and the CUERipper Settings wiki), recorded 2026-10-31:
- CUERipper has no cache detection or flushing and no offset calibration. It takes the read offset
  from the caller (looked up from the AccurateRip drive list) and depends on repeated reads.
  Calibration and cache testing are therefore our own design; EAC's documented approach is the
  reference for those.
- Ideas worth adopting: auto-detecting the read command and C2 mode by probing a sector and trying
  combinations (with per-model overrides); three effort levels (burst / secure / paranoid) with
  bounded retries and a log entry for any position that stays unresolved; an optional Test & Copy
  pass that compares CRCs of two full reads; per-bit voting across repeated reads; subchannel-based
  gap and index detection; showing CTDB and AccurateRip status separately.
- CUERipper's own caveat: burst mode results are not submitted to CTDB because some errors can go
  unreported. We should likewise label results by the mode that produced them.
- The code is C#, so it is a design reference, not something to link. GPL-2.0-or-later would be
  compatible with this GPL-3.0 project if any code were ever adapted; follow the provenance rules in
  the licensing guide first.
Status: implemented (native build below, CD helper in D8).

### D6 progress (2026-10-31)

The pinned libcdio and libcdio-paranoia sources were downloaded, SHA-256 verified, and built as
static MinGW-w64 libraries with `tools/build-libcdio-mingw.ps1` (MSYS2 UCRT64, GCC 16.2.0; only
`include` and `lib` are built). Two gotchas: configure must run in the UCRT64 environment (the plain
MSYS shell targets Cygwin and breaks the Windows drivers), and `doc/` is skipped because it needs a
texinfo setup we do not use. `approved_for_build` remains `false` in `third_party/provenance.toml`
until the project owner completes the license review; the build is not yet validated on a real drive.
Test drive: the internal drive of the development PC first; a USB drive and other internal drives
later (model and offset to be recorded per drive).

### D6 first hardware test (2026-10-31)

`tools/run-cdprobe.ps1` builds and runs a read-only probe (`tools/cdprobe/cdprobe.c`) against the
pinned libcdio build. Result on the development PC:
- Drive: ASUS BW-16D1HT (rev 3.11), `E:`, an internal Blu-ray writer. Reports CD-DA audio reads,
  MMC CD-DA reads, and CD-R/RW support; it does not report media-change events through libcdio.
- Disc: 12 audio tracks, leadout LSN 198077; the full TOC read correctly. libcdio labels the disc
  "DVD-ROM" on this drive, so disc mode must not be used to decide whether a disc is audio; use the
  track formats instead.
- Reading 75 sectors of track 1 twice returned identical data (CRC32 A539B0B6 both times).
- A single 75-sector (176,400-byte) read failed with Windows error 87 (mapped to "bad parameter").
  Reads of 16 sectors succeed. Cause is believed to be the SCSI pass-through transfer-size limit.
  (Correction, same day: the calibration test later measured a limit of 55 sectors, about 128 KiB,
  not the roughly 64 KB first guessed.) The ripper must read in small chunks and should query the
  adapter's maximum transfer length rather than assume a value.
- libcdio links against `libiconv` (character-set conversion); record its license and decide how it
  is linked before shipping.
- The probe does not use libcdio-paranoia, which is still awaiting license confirmation.

`third_party/provenance.toml`: libcdio is now `approved_for_build = true` (owner approved
2026-10-31); libcdio-paranoia stays `false` pending confirmation of the licensing of six files that
carry only copyright lines.

Next: cache-behavior test and read-offset calibration (using AccurateRip), then the ripper adapter.

## D7: libcdio-paranoia license review (2026-10-31)

Question: six libcdio-paranoia files carry only copyright lines (no license text). Findings from
the upstream repository (github.com/libcdio/libcdio-paranoia) and its history:
- The repository is GPL-3.0 (GitHub SPDX `GPL-3.0`, root `COPYING` is GPLv3). Its README says it is
  a port of Xiph's cdparanoia to libcdio.
- Its first import (2011-11-05) of `p_block.c` carried an explicit GPL-3-or-later notice from the
  maintainer (Rocky Bernstein) alongside Monty's 1998 copyright. The per-file license text was
  dropped in later commits before the 2024 reformat; the 2024 commit changed only the copyright
  year and formatting. This reads as header trimming, not a license change.
- The original Xiph cdparanoia III splits its licensing: the command-line tool is GPL, and the
  `paranoia` and `interface` libraries are LGPL (a search of the README text found LGPLv2.1; a 2008
  Xiph commit mentions moving the libraries to LGPLv3). The six files come from those library
  directories. LGPL code can be used under GPL terms (LGPL-2.1 section 3 allows applying the
  ordinary GPL, and a newer GPL version where one exists), so including them in a GPL-3.0-only
  project is consistent.
- I could not retrieve Xiph's own repository (HTTP 403 / 404), so the exact LGPL version shipped
  with the original 10.2 release is unconfirmed. This does not change the conclusion for a GPL-3
  project, but it is not independently verified.
- Useful finding: libcdio-paranoia includes cache-management code contributed by Robert Kausch
  (fre:ac's author) in 2014 ("add the cache management code"). Study it before writing our own
  cache test.

Conclusion: low risk for a free, non-commercial, GPL-3.0 project. This is not legal advice. If
certainty matters, ask the maintainers (open a GitHub issue) to restore per-file notices on those
six files.
Status: approved for build by the project owner on 2026-10-31.


### D6 test disc (2026-10-31)

Test disc for calibration: The Watchmen, "Brand New Day", 12 tracks. Disc IDs computed from the TOC
(AccurateRip id1 `0013232b`, id2 `00b35ece`, freeDB/CDDB `860a510c`). The AccurateRip database has
two pressings for this disc: one with confidence 24-26 per track and one with confidence 5 per
track (URL pattern
`http://www.accuraterip.com/accuraterip/b/2/3/dBAR-012-0013232b-00b35ece-860a510c.bin`; entry =
1 byte track count, three 32-bit ids, then per track 1 byte confidence, 32-bit CRC, 32-bit CRC for
frame 450). Track CRCs are in the AccurateRip v1 format (the lookup file does not say which
version each CRC uses; the calibration code must try both v1 and v2). Disc ID math that worked: id1 is the
sum of the track start LBAs plus the leadout; id2 is the sum of max(LBA,1) times the 1-based
position, leadout counted as position n+1; CDDB id uses LBA+150.
Next: rip track 1 with libcdio-paranoia, compute the AccurateRip checksum at several candidate
offsets, and compare with the database to confirm this drive's read offset.

### D6 calibration results (2026-10-31)

Tools: `tools/run-riptrack.ps1` (rips a track plus a margin through libcdio-paranoia to raw PCM,
read-only) and `crates/accuraterip` (checksums, disc IDs, database parsing, offset search; example
`calibrate`). Test disc: The Watchmen, "Brand New Day".
- **Drive read offset confirmed: ASUS BW-16D1HT = +6 samples.** Whole-track checksums for tracks 2
  and 3 matched the database at +6 for both pressings: pressing 0 (confidence 25-26) under the
  version 2 checksum, pressing 1 (confidence 5) under version 1. Track 5's sector-450 checksum also
  matched at +6. This validates the v1 and v2 implementations and the offset convention (positive =
  the track appears later in the drive output; discard that many leading samples).
- The database mixes checksum versions between pressings, so verification must try both.
- **Track 5 did not verify.** The paranoia (secure) rip and two plain rips all differ from each
  other past roughly sector 7,800-10,800 of the track, and none matched. Two plain rips of the same
  track disagree with each other, so reads are not repeatable there: likely disc wear or dirt, or
  drive trouble, not a checksum bug. Paranoia reported 10 skip events and thousands of fixups.
  Not yet diagnosed.
- **Bug found in our test harness:** `riptrack.c` removes `PARANOIA_MODE_NEVERSKIP` from the mode, so
  paranoia may give up on a sector and skip it. The real ripper must keep NEVERSKIP (bounded by a
  retry limit) and report any sector it could not read cleanly instead of skipping silently.
- Speed: secure mode took about 15 minutes for a 3:17 track; plain mode about 40 seconds.
- Not done: C2 error information, drive cache test (study libcdio-paranoia's cache code first), a
  pre-rip calibration command, the AccurateRip lookup in the sidecar.

### D6 retest with a clean disc (2026-10-31)

The scratched test disc was replaced with Operation Ivy, "Energy" (remaster), 27 tracks, one
AccurateRip pressing (confidence 11). Plain rips of tracks 5, 12 and 20 and a secure (paranoia,
never-skip) rip of track 6 all matched the database under the v2 checksum at offset +6. The secure
rip took 12 seconds for a 1:03 track. This confirms the pipeline end to end and that the earlier
failures were caused by the damaged disc: secure mode on a bad disc took ~15 minutes and still did
not verify. Offset +6 for the ASUS BW-16D1HT is now confirmed on two discs.
Open: whether the first and last tracks (which skip leading/trailing samples) verify.

### D6 drive cache test (2026-10-31)

How libcdio-paranoia handles the drive cache (reviewed in the pinned source): it does not detect the
cache. It models a fixed cache of `CACHEMODEL_SECTORS` = 1200 sectors (about 2.7 MB), adjustable
with `cdio_paranoia_cachemodel_size`, and reads about that many sectors elsewhere before re-reading
a region so that a re-read cannot be served from the cache. The code came from Robert Kausch's 2014
cache-management patch.

Measured behavior (`tools/run-cachetest.ps1`, `tools/cdprobe/cachetest.c`; ASUS BW-16D1HT, 
Operation Ivy "Energy" in the drive): read a sector, read N more sectors, re-read the first sector
and time it.
- Re-reads after up to 28 intervening sectors returned in about 0.3 ms (served from the drive cache).
- At 32 or more intervening sectors the re-read took 12-25 ms, the same as a short seek, so it came
  from the disc. The change is sharp (28 to 32 sectors).
- Estimated effective audio cache: about 30 sectors (roughly 70 KB), far below paranoia's 1200-sector
  assumption. Paranoia's default is therefore safe for this drive; it costs extra re-read time.
- An earlier run with a threshold relative to a cold (long-seek) read wrongly reported a multi-MB
  cache, because ordinary short-seek times looked "fast" next to a long seek. Use an absolute limit
  (a cache hit is well under 1 ms; a short seek is several ms).

Design consequences:
- Keep 1200 sectors as the default model. The pre-rip check should measure each drive and store the
  result in the drive profile; a smaller value (for example four times the measured size, with a
  floor) may be offered later as a faster secure mode, only after it is shown to still verify.
- Caveats: one access pattern was tested; firmware can behave differently on other patterns, and a
  USB bridge can add its own cache. Repeat the test on the USB drive and the other internal drives.
- If a drive reports a very large cache, the ripper must either use a larger model or warn that
  secure mode may not defeat the cache.

## D8: Built-in drive test and calibration, per drive profile (2026-10-31)

The app will test and calibrate each optical drive and store a profile per drive (identity from
vendor, model, firmware and connection type, not the drive letter). Steps: identify, read test
(including the maximum working transfer size), cache test, offset check against AccurateRip using at
least two matching tracks. Profiles are exportable; imported or suggested values stay unverified
until measured. Detail in `docs/architecture/0004-drive-calibration.md`.
Status: implemented (progress notes below). Not built: connection type, profile import/export.

### D8 progress (2026-10-31)

Owner chose the recommended path: a separate native helper executable (GNU target) for the libcdio
code, with the pure logic built and tested first. `crates/ripper` now holds the `OpticalDrive`
trait, profile types (with measured/suggested/manual provenance and stale-profile rules), the
calibration steps, and a `SimulatedDrive` (configurable offset, cache size, transfer limit, damage).
The simulated tests cover offsets of +6, -20, 0 and +667, small/none/very large caches, a missing or
wrong database entry (reported as unverified, never as measured), cancellation, unreadable discs,
and firmware-change invalidation. `mediaverse_accuraterip::find_offsets_fast` pre-filters offsets
with the sector-450 checksum, so a full plus-or-minus 2,940-sample search no longer needs 5,881
whole-track checksums.
Next: the native helper (libcdio adapter implementing `OpticalDrive`), then sidecar commands,
profile storage, and the Drive setup screen.


### D8: native helper built and run on real hardware (2026-10-31)

`apps/cd-helper` (`mediaverse_cd_helper`) wraps the pinned static libcdio, implements
`OpticalDrive`, and speaks the sidecar's JSON-lines format. Commands: `list_drives`, `read_toc`,
`calibrate` (emits `calibration-progress` events), `cancel`, `shutdown`. All `unsafe` is in
`src/native.rs` (hand-written bindings for 11 libcdio functions, checked against the pinned
headers). Build: `tools/build-cd-helper.ps1` (target `x86_64-pc-windows-gnu`, MSYS2 UCRT64 GCC as
linker, libcdio and libiconv linked statically; on other targets the crate compiles to a stub so the
default workspace build is unaffected). Rust's GNU target worked with the UCRT64 linker on the first
try; the exe runs with only System32 on its PATH.

Real-hardware result (ASUS BW-16D1HT, Operation Ivy "Energy", AccurateRip data supplied as hex):
- Offset: +6 samples, measured on tracks 2, 14 and 26 (v2 checksum). Matches the manual result.
- Cache: cached through 28 sectors, not at 32. Matches the manual result.
- Maximum transfer: 55 sectors (about 128 KiB).
- Repeat reads agree: yes. Whole calibration: 28 seconds, no warnings.
Known gaps: the connection type is always `unknown` (libcdio does not report it; Windows device
properties could supply it); the helper has no automated tests because they need a drive (the
logic is covered by the simulated-drive tests in `crates/ripper`); the sidecar does not start the
helper yet; profile storage and the UI are not built.

### D8: sidecar drive commands (2026-10-31)

The sidecar now exposes `list_drives`, `list_drive_profiles`, `calibrate_drive` (a background job
with `job-progress`/`job-finished` events) and `cancel_job` (ADR 0003). It starts a short-lived
helper process per job, looks the disc up in AccurateRip over plain HTTP with an on-disk cache
(a "not found" answer is kept for 7 days), and stores profiles as JSON files. The Electron
allowlist passes the new commands and events through.
- Tests: 7 end-to-end tests use the real sidecar binary with a fake helper (progress events,
  profile saved and re-supplied on the next run, disc missing from AccurateRip, unknown drive,
  cancellation, bad arguments) plus unit tests for profile storage and date conversion.
- Real run (real sidecar, real helper, live AccurateRip lookup, Operation Ivy "Energy"): offset +6
  measured on tracks 2, 14 and 26, cache 28-32 sectors, max transfer 55 sectors, 29 seconds,
  profile saved to `drive-profiles/asus_bw_16d1ht_unknown.json`.
- The evidence date is UTC, so a calibration late in the evening can show tomorrow's date.
- AccurateRip is queried with a descriptive User-Agent and cached, but its terms of use still need
  checking before production use (ADR 0004).
- Still open: connection-type detection, profile import/export, the Drive setup screen, and
  testing the USB and other internal drives (deferred by the project owner on 2026-10-31).

### D8: Drive setup screen (2026-10-31)

Built as a "Drive setup" page in the web UI. It lists drives (name, drive letter, firmware), shows
the stored profile in plain language, runs the guided check as a background job with a three-step
progress bar and a Cancel button, and shows the result and any warnings. Rules enforced in
`drive-format.ts` and covered by 13 unit tests (`npm run test:unit`): only a measured offset is
described as verified; suggested and manual values say they are not; a missing database entry tells
the user to insert a different disc; errors have plain-language text. All dynamic text is set with
`textContent`, never as HTML. Under Tauri the page only shows a message that drive setup is
unavailable, because those commands exist only in the sidecar.
- Verified by `npm run capture:drive-setup` (`web/app/scripts/capture-drive-setup.cjs`), which drives
  the real Electron app against the real drive with a throwaway data directory, saves screenshots,
  and exercises both a full check and a cancelled one. Results matched the earlier command-line runs
  (offset +6 on tracks 2, 14, 26; cache 28-32 sectors; 55-sector reads). It needs a disc in the
  drive and briefly opens a window.
- That run found and fixed three real defects: `electron/main.js` never started the sidecar (my
  earlier edit silently failed on line endings; the earlier Electron test only covered the client
  class, not `main.js`); a CSS rule overrode the `hidden` attribute so the progress box stayed on
  screen after a check; and the progress box sat below the drive card, off screen while running.
- Lesson recorded: edits made with string replacement must be verified by searching for the new
  text, and anything wired into `main.js` needs a run of the real app, not only unit tests.
- Open: a regression test that starts `main.js` automatically (the capture script is manual because
  it needs hardware); keyboard and screen-reader review of the page; mobile layout is untested.

## D9: Ripper, first slice (2026-10-31)

Secure ripping with offset correction, AccurateRip verification, WAV output and a rip log is built
and verified on real hardware; design in `docs/architecture/0005-ripping-pipeline.md`.
- Pure logic in `crates/ripper` (`rip.rs`, `wav.rs`, 29 tests including edge-of-disc padding,
  cancellation and honest summaries); the libcdio-paranoia reader is in the helper (`native.rs`);
  the sidecar exposes `rip_disc` as a job.
- Real results: tracks 1, 5, 6, 12, 22 and 27 of Operation Ivy "Energy" matched AccurateRip at
  offset +6 through the helper and through the full sidecar; WAV files were re-verified from disk by
  independent code (`crates/accuraterip/examples/wavcheck.rs`).
- FLAC encoder candidates checked on crates.io (2026-10-31): `flacenc` 0.5.1 (Apache-2.0, pure
  Rust, updated 2025-12, about 825k downloads) to encode; `claxon` 0.4.3 (Apache-2.0, pure Rust
  decoder) to decode every file back and compare it sample for sample; the reference libFLAC is
  BSD-3-Clause but needs a C build on each platform. Recommendation: flacenc plus claxon. Both are
  listed in `third_party/provenance.toml` with `approved_for_build = false` pending the owner.
- Rule adopted: an encoded FLAC is accepted only after it decodes back to exactly the source
  samples.

### D9 progress: FLAC masters and the Media Library Archive (2026-10-31)

Owner approved `flacenc` 0.5.1 and `claxon` 0.4.3 (provenance updated, with Cargo.lock checksums;
all of their transitive dependencies are MIT, Apache-2.0, Unlicense or Unicode-3.0). FLAC masters
are built and written to the archive as described in ADR 0005.
- Owner decisions applied: the archive is write-only and never part of the playback library (D3);
  it must be separate from and not nested with the Main Media Library; existing files are never
  overwritten.
- Verified on the real drive: tracks 6 and 22 of Operation Ivy "Energy" went disc to archive in 31
  seconds; the stored FLAC files, decoded by separate code (`crates/ripper/examples/flaccheck.rs`),
  matched AccurateRip (confidence 11) and carry correct tags. FLAC size is about 72% of the WAV.
- Two real defects were found by the checks themselves and fixed (see "Lessons recorded" in ADR
  0005): the tag-library/FLAC flag bug and the tiny-final-block rule.
- Process lesson, repeated: string replacements on files with CRLF line endings silently did
  nothing twice more; every edit now confirms the new text is present before moving on.
- Not done: MP3 encode, cover art and lyrics in tags, MusicBrainz lookup (tags come from the caller
  for now), the "Rip this disc" screen, WAV cleanup after the MP3 step, cancelling during the
  archive step (it only takes a few seconds per track).

## D10: Multi-source disc metadata with user-editable services (2026-10-31)

Owner request: look up track information from several sources (CDDB-style servers such as gnudb,
MusicBrainz, Gracenote), with settings for the user's own server, port and credentials, and
awareness of rate limits. Design and findings in `docs/architecture/0006-disc-metadata-lookup.md`.
- Built: `crates/disc-metadata` (disc ids, CDDB and MusicBrainz parsers, settings, rate limiter,
  merge; 38 tests including two real MusicBrainz responses as fixtures) and the sidecar commands
  `get_metadata_settings`, `set_metadata_settings` and `lookup_disc` (11 new end-to-end tests with
  fake MusicBrainz, HTTP-CDDB and CDDBP servers that also prove servers and ports can be changed).
- Verified live: MusicBrainz found both test discs, validating the disc-id algorithm. gnudb refused
  our application name; Gracenote's developer site was unreachable and its public keys are reported
  unobtainable. Neither is worked around.
- Pending owner decisions: approve TLS for the sidecar (native-tls / SChannel) so MusicBrainz can be
  reached; register a client name with gnudb; protect stored credentials at rest.
Status: all three settled in D12 (TLS approved; gnudb needs a contact email, registration email still
to send; API keys may stay in plain text).

## D11: AcoustID key, settings page, and structured IPC errors (2026-10-31)

Owner supplied the AcoustID application key for MediaVerse Studio (registration
https://acoustid.org/application/32223) and asked for a settings place where it is pre-filled but easy
to update, and for the registration to be updated with each new version.
- The key is stored only in the owner's local settings (`%APPDATA%\MediaVerse Studio`), never in
  source, tests or docs (project rule: no credentials in the repository). The Settings page shows it
  as Saved with Change and Remove. A shipped build starts with no key; the user or packager enters it.
- `ACOUSTID_REGISTERED_VERSION` plus a failing test make a version bump remind us to update the
  registration; `docs/release-checklist.md` lists the step.
- The app now has a fixed name (`MediaVerse Studio`) so its data folder is stable.
- Settings split into invalid (refused) and incomplete (saved, flagged, source reports needs_setup).
- Settings page built and driven in the real app. That run exposed a bug affecting every failed
  command: Electron IPC reduced the sidecar's `{code, message}` error to `[object Object]`.
  Replies are now envelopes (`electron/ipc-envelope.js`, tested) that the renderer re-raises as the
  same structured error Tauri gave. The Drive setup flow was re-run and still works.
- Not built: AcoustID fingerprint lookups (needs Chromaprint and a license review), credential
  encryption at rest (still plain text in the settings file; open since D10).

## D12: gnudb rules corrected, HTTPS enabled, privacy checks (2026-10-31)

Owner approved TLS, asked for the gnudb registration process to be investigated (supplying their saved
developer pages), and said database API keys can stay in plain text in the settings file while real
personal email, passwords and logins must be kept safe.
- **gnudb corrected.** I had concluded gnudb "only accepts registered client names". The pages say a
  valid-looking email in the hello string is what is required (`emailname emailhost.com app version`);
  our earlier 500 reply was caused by our missing email. The identity setting is now one contact email
  that feeds both MusicBrainz and gnudb. Also adopted from the pages: HTTPS by default, protocol
  level 6, HTTP 429 handling, `\n` `\t` `\\` escapes in records, and the `# Artid:` cover-art id.
  Registration is by email to info@gnudb.org (`docs/gnudb-registration.md`, draft message ready).
- **HTTPS built** (Windows' own TLS via native-tls); live MusicBrainz lookup over HTTPS succeeded.
- **Credentials stay in plain text** in the settings file, as the owner decided for database API keys
  (AcoustID key, Gracenote ids). Real email addresses, passwords and logins are different: none is
  stored by the program, and the contact email is user-entered, never pre-filled.
- **Privacy audit.** Repository is private; no tracked file or history content contains the AcoustID
  key or the owner's Gmail address; the only credential-word hits are code, rules and made-up test
  values. Finding: 24 of 47 commits (mostly this session's) carry the owner's personal Gmail address
  as author, because the global git config uses it; others use the GitHub no-reply address. Fixed
  going forward with a repository-local `user.email` set to the no-reply address; history was not
  rewritten (offered to the owner). The release checklist now includes this check.

## D13: FLAC tagging safety, reminders, contact address (2026-10-31)

Owner asked for care with FLAC tagging (stories of tags causing decoding and conversion errors), for
reminders to scrub personal keys before the repository goes public, and about which contact address to
use. Everything works first; scrubbing happens before going public.
- **FLAC safety** (details in ADR 0005, "FLAC tagging safety"): strict structure validator with audio MD5
  check, tag cleaning and size limits, exact tag verification, allowed block types limited to those we
  write. A bit-flip test found a real gap (a damaged tag-block header could turn into a cue-sheet block
  and the tags would silently vanish) that is now closed and tested. A real disc-to-archive run of
  three tracks passed all checks and independent decoding.
- **Reminders:** GitHub issue #3 "Before going public: scrub personal data and keys" on the private
  repository; `tools/check-before-public.ps1` (checks commit authors, files, and the real saved keys
  against the whole history without printing them); release-checklist item 6. At last run it reports one
  real finding: the personal Gmail address as author of 24 commits. History was not rewritten; options
  are noted in the issue (rewrite before publishing, or publish from a clean copy).
- **Contact address:** a project address on mediaverse.studio (email forwarding) is recommended; a
  GitHub link satisfies MusicBrainz only once public, and gnudb needs an email address. See
  `docs/gnudb-registration.md`.
- md-5 is now used directly (was already in the approved flacenc tree).

## D14: The reference decoder found a fault in every FLAC file (2026-10-31)

Owner approved fetching Xiph's official FLAC tools for testing. Verified download (pinned SHA-256,
Xiph's checksum list, and an identical copy from GitHub), extracted to a throwaway/ignored folder.
- **Result:** `flac --test --warnings-as-errors` rejected every file our encoder library produced, at
  every block size, although the audio decoded bit-exactly and all of our own checks passed. Cause:
  STREAMINFO's minimum block size counted the short final block (the format says it must not), so
  readers treated the stream as variable-block-size. Fix: minimum set to the maximum. Details and
  the full table of tagging defences are in ADR 0005.
- **After the fix:** 28 generated files (lengths from 16 samples to 10 s, plain and tagged) and three
  tracks ripped from the real disc pass strict mode; the reference decoder's output equals our ripped
  audio byte for byte; tags read correctly with `metaflac`.
- **Kept repeatable:** `tools/fetch-flac-reference.ps1` (verified fetch) and
  `crates/ripper/tests/reference_decoder.rs` (runs automatically when the tools are present, says
  SKIPPED otherwise); release-checklist item 7. The tools are never shipped.
- **Lesson:** an in-program decoder agreeing with an in-program encoder is not enough; always test
  against an independent reference implementation.

## D15: Keep the FLAC masters simple; richer tags go on the MP3 (2026-10-31)

Owner proposed doing only basic song, album, track number and artist tags in the FLAC, and adding the
more complex tags to the MP3 after the LAME step, to reduce the risk of corrupting FLAC files.
Assessment: adding a tag block to a new file is low-risk (audio frames are byte-identical; verified
with the reference decoder), but cover art is the largest and most variable block and the usual source
of player and converter trouble, and the failure costs are lopsided: a FLAC master cannot be rebuilt
without the disc, an MP3 can. Adopted, with sidecar files added: cover art as `cover.jpg` and lyrics as
`.lrc`/`.txt` beside the FLACs (nothing is lost, nothing touches the FLAC bytes). Details in ADR 0005.
Consequence: no embedded-picture code is needed for FLAC; the picture-block validator stays as a guard.

## D16: Chosen lookup results become FLAC tags; cover art saved as a file (2026-10-31)

Steps 1 and 2 of the agreed order are built (details in ADR 0005).
- A chosen album is turned into the plain text tag set agreed in D15, checked against the disc's track
  count, and verified tag for tag after writing. 36 new tests, including an exact-tags check.
- Cover art comes from the Cover Art Archive and is saved as `cover.jpg` beside the masters, never
  inside a FLAC. Images are untrusted: type, size and shape are validated, and bytes are written as
  received. 11 tests with a fake server (missing, wrong type, tiny, wrong shape, progressive,
  switched off, invalid id, repeat rip).
- Live run on the real disc: MusicBrainz lookup (HTTPS), chosen result, two tracks ripped and archived,
  both FLACs pass the reference decoder, and a real 1200 x 1091 cover (210 KB) was saved.
- Decision made on seeing that run: COMPILATION=1 only for Various Artists albums, not for MusicBrainz's
  "Compilation" label, which also covers one artist's best-of releases.

### D16 progress: LAME ready (2026-10-31)

Step 3 prerequisites checked: LAME 4.0 (already approved) was rebuilt from the verified archive with the
project's script (Visual Studio Build Tools) and runs. Its executable hash differs from the one first
recorded because MSVC builds are not byte-reproducible; noted in `provenance.toml`. The MP3 step
(encode from the verified audio, then the full tags, cover and lyrics, then reference checks) is next.

## D17: MP3 step settings, and manual images and lyrics in the library page (2026-10-31)

Owner accepted the MP3 plan: LAME from the verified audio (V0 default, 320 kbps CBR optional), ID3v2.3
tags (best Windows Explorer support), embedded cover at no more than 500 KB and preferably baseline
JPEG, checked with LAME's decoder as a second reader plus a frame-by-frame structure check.
New requirement for the library repair/management page: the user can **paste images** onto albums and
onto individual tracks, choosing for each whether it is the **album front cover, album back cover or
artist photo**, and can **paste or type song lyrics** for a track. The tagging code is therefore built
around picture kinds (ID3 picture types: front cover 3, back cover 4, artist 8) and lyrics (plain and
synced), so that page can reuse it; the page itself comes after the MP3 step.
## D18: MP3 copies built; LAME has no decoder here, so a second decoder is needed (2026-10-31)

Built: LAME encodes the verified WAV (V0 or CBR 320), the sidecar writes an ID3v2.3 tag in front
(text, cover and other pictures, plain and synced lyrics), and the file is then checked: tag
well-formed, frame chain unbroken to the last byte, Xing/Info frame count matches, and the playable
length (frames minus LAME's recorded delay and padding) equals the source length exactly. Tags are
also read by an independent reader (lofty, dev-dependency only) in the tests. Damaged copies are
rejected in tests. Typed or pasted lyrics (plain or .lrc) and extra pictures (front, back, artist)
travel with the rip request; per-track lyrics in a chosen album are passed through to the tag.

Finding: the LAME 4.0 build here is encoder-only, so `lame --decode` (the "second reader" accepted in
D17) does not exist. The decode-and-compare (SNR) check is therefore not done yet. Proposal awaiting
owner approval: add the pure-Rust `nanomp3` decoder (MIT or Apache-2.0) after a provenance and
licence review. Until then MP3 copies are described as "structurally verified", not "decoded and
compared".

**Owner approved nanomp3 (2026-10-31).** Built: every stored MP3 is decoded and compared with the
verified source (same sample count, 44.1 kHz stereo, signal-to-noise at least 15 dB). Measured on
music-like test audio: 33.5 dB (V0) and 30.6 dB (CBR 320); shifted or wrong-length audio is rejected.

## D19: Tauri shell archived; the ripper is a standalone module (2026-11-02)

Owner decisions. The Tauri desktop crate moved to `archive/tauri-desktop` and left the Cargo workspace; it
stays until every behaviour it covered (collection import and monitoring, tag read/write, tag-issue review) has
an equivalent test in the Electron application, then it can be deleted. The CD ripper is documented as a
standalone module with a defined interface (ADR 0007). Ripping **on Android and iOS devices with a USB optical drive**
(no Windows PC needed) is a wished-for future feature, set aside until the Windows and mobile apps are complete; ADR 0007
lists what a feasibility study has to check.

## D20: What comes next, and why (2026-11-02)

- **Order:** rip screen, then a minimal library (scan the Main Media Library, store in SQLite, browse artist,
  album, track), then the repair page (D17), then **playback before lyrics**.
- **Library right after the rip screen** because most media apps (Windows Media Player, foobar2000, MusicBee,
  Plex) show a ripped disc in the library the moment it finishes. Revisit once all pieces work.
- **Playback before lyrics:** synced lyrics need a playback position to follow, and playback is simpler (an HTML
  audio element over local files first). The OpenLyrics model (D5: sources in order embedded tags, local `.lrc`
  files, then LRCLIB; downloaded lyrics never overwrite existing ones; edits always save; searches for tracks
  that already have lyrics are skipped; preference for synced vs plain) is then applied on top. Only the
  high-level OpenLyrics documentation could be read this session; its source should be studied when lyrics start.
- **AccurateRip:** a missing reference is a warning, never a failed rip (implemented).
- **Rip failures:** a disc that disappears mid-rip is reported as `disc_lost`, a full disk as `disk_full`, and
  tracks already ripped are kept and named. Not yet built: a free-space check before ripping (needs either a
  small, reviewed Windows API call or an approved crate).
- **Library defect scan:** new wished-for feature (pops, clicks, dropouts), including tracks with no
  AccurateRip entry. Multi-disc ripping: framework should allow it, feature later.
- **Guiding documents updated** with status notes and corrections. Conflicts found and left for the owner:
  (1) the Navidrome note asks for multi-valued artist tags and a precise release date, but the ID3 writer
  writes one artist string and a year only (**resolved by the owner, 2026-11-02: keep the limited MP3 tags**,
  one artist string and a year; the Navidrome note carries a matching remark); (2) it prefers embedded covers, but FLAC masters keep `cover.jpg`
  beside them (D15), while MP3 copies do embed one; (3) the ripping policy's "fails verification may still be
  encoded, labelled unverified" is now done as warnings, but there is no persistent "unverified" label on
  files yet; (4) the Project Brief's delivery order no longer matches reality (noted in the document).

## D21: Platform priorities (2026-11-02)

Owner decisions.
- **Windows is the primary platform**, and CD ripping is a Windows feature first and foremost.
- **Android is wanted mainly as a playback app**: play your music away from home, then cast to the TV at home to
  show artwork and lyrics. So for Android the order is library browsing and playback, then casting with the
  artwork and lyrics view. **Ripping on Android is a wanted future feature** (owner, 2026-11-02): keep doors open
  for it, as long as that never harms the Windows version. In practice: keep the ripper split from the CD reader
  (ADR 0007), keep encoders, tag writers and lookups free of Windows-only code, and avoid new Windows-only
  assumptions in shared code.
- **iOS is a low-priority future path**, after Android.
- **Ripping on phones with a USB optical drive** (ADR 0007) stays the furthest-out idea, below all of the above.
- Consequence for design: the library, playback, lyrics and casting contracts must stay free of Windows-only
  assumptions (already required by AGENTS.md); the ripper may stay Windows-specific.

## D22: Library repair, first slice (2026-11-02)

The library page can now put pictures (front cover, back cover, artist photo) on a whole album or one track, and type or paste lyrics (plain or .lrc) for one track (`update_track_media`, `track_lyrics`; `id3::edit_tag`). Pictures pasted, dropped or chosen are re-encoded by the page to a baseline JPEG of at most about 450 KB and 1200 pixels so they fit the MP3 limit. Only MP3 files inside the music library with an ID3v2.3 tag (the kind this program writes) are edited; other tag versions are refused with a clear message, not guessed at. Each file is replaced atomically (written beside it, read back, audio compared byte for byte, then renamed) and failures are reported per file. A playing file is released first. Not yet: editing FLAC or other tag versions, a defect scan, bulk lyrics lookup.


## D23: Design direction, first slice (2026-11-02) - proposal for the owner to confirm

Status: the Now Playing wall and the Home page are built (D26, D27); the direction itself is still to
be confirmed.


From the Zune 4.0 screenshot, the 2009 review and the Rune project (see docs/design-inspiration.md): a full-screen **Now Playing** view with a warm-tinted collage of the library's album covers behind the current cover, artist (capitals), album, title and the queue, reachable from the player bar (built). Next candidates: a Quickplay-style home (New, History, Pins), accent colour taken from the cover, mini player with real volume. The collage is decoration only; all information is also real text, and everything stays keyboard-reachable.


## D24: Defect scan, first version (2026-11-02)

A scanner (`crates/ripper/src/defects.rs`, pure, no files) looks for clicks and pops, dropouts (digital silence inside loud music), stuck values and clipping in decoded audio; the sidecar decodes library MP3, FLAC and WAV files (`scan_defects` job) and the page shows per-track verdicts with a Listen button for each place. Tracks AccurateRip could not confirm (no reference, or no match) are scanned automatically during a rip, before the WAV is removed, and suspect ones produce warnings. **Honest limits:** it is an aid, not a verdict. A click is recognised only by the signature of one bad sample with calm audio around it, because a first, looser version flagged 34 false clicks in one loud punk track (real snare and guitar edges). The final version found none in that track (lossless and MP3) and finds injected single-sample clicks reliably when they are large (about 9 of 10 at 16000 and 10 of 10 at 24000 on a loud track; small ones are masked by loud music and mostly missed). Validated on one real disc track plus synthetic audio, so more real tracks (including damaged discs) are needed before trusting thresholds. Multi-sample bursts, repeated blocks and gentle crackle are not detected yet. Clipping is only counted. MP3 smears clicks, so a scan of the lossless copy is more sensitive.


## D25: Flag a track for review while listening (2026-11-02)

A Flag button in the player bar marks the track that is playing (pausing it) and asks what was noticed: audio problem, tags, cover or lyrics, wrong track, other, plus a note. The place in the song is remembered. Flags are kept in `flags.json` in the program's data folder (`list_flags`, `set_flag`; library files only; path stored as the library shows it), shown as a mark on track rows and on a Review page with Listen-where-noticed, Scan for defects, Pictures & lyrics and Done actions. Re-ripping a flagged track with extra error correction is planned (needs the original disc and a stronger secure-read mode). **For mobile:** the flag list must follow the library across devices, so it needs a stable track identity (not a file path) and a sync design; recorded here so the format is not mistaken for final.


## D26: Listening history, the Home page and the emphasised Now Playing wall (2026-11-02)

Owner request. **History:** a track counts as played after 30 seconds (or half of a shorter track); the sidecar keeps path, title, artist, album, last-played time and a play count in `history.json` (library files only, newest 3,000). It is **on until switched off** in Settings, where it can also be cleared; while off nothing is recorded; it never leaves the computer. This changes the Project Brief's earlier rule (no listening history by default); the brief now says so. **Home page** (Zune Quickplay-inspired, the first page): Recently played albums and Most played tracks (history on), New in your library (file dates), a shortcut to flagged tracks. Pins are not built yet. **Now Playing wall:** the playing album is the largest and brightest tile, then the albums in the play queue, then other albums by the playing artist, then the rest of the library dimmed, rebuilt as the music changes.


### D26 addendum: the wall varies tile sizes (2026-11-02)

Owner asked that the Now Playing wall use a variety of tile sizes, with emphasis carried partly by size, as in the Zune screenshot (a few large covers among many small ones, no uniform grid). `planWall` (`web/app/src/collage.ts`) now plans it on an 80 px grid: the playing album is a 5 by 5 tile (nothing is bigger), the first queued album 4 by 4 then 3 by 3 and 2 by 2, the artist's other albums 3 by 3 then 2 by 2, and the rest of the library varies from 1 by 1 (about half) to 4 by 4 (at most four) by a stable hash of the album folder, so the same library gives the same wall. Large tiles are spread among small ones, a small library is repeated at varied sizes, and brightness (playing, queue, artist, rest) supports the size emphasis. Checked in the real app with a made-up 16-album library. Ideas not built yet from the Zune review: tiles that slowly flip and a colour scheme that shifts over time.


## D27: Pins on the Home page (2026-11-02)

Albums can be pinned from the library (a Pin to Home button on each album) and unpinned from Home. A pin is the album's folder in the music library, kept in `pins.json` in the program's data folder (`list_pins`, `set_pin`; folders inside the library only, at most 200). The Home page shows a Pins shelf (newest pin first); albums that have left the library are skipped, not deleted from the list.


## D28: Lyrics in Now Playing (2026-11-02)

Now Playing has Queue and Lyrics tabs. The Lyrics tab shows the song's lyrics, looked for first in the file's tags (plain and time-stamped), then in a `.lrc` file with the same name beside it (`track_lyrics` returns `{plain, synced, lines, source}`). Time-stamped lyrics follow the song: the current line is highlighted and kept in view, and clicking a line jumps to it; plain lyrics scroll by hand; a note says where they came from. Not built yet: online lookup (LRCLIB) with confirmation, bulk lookup, a timing editor, importing a `.lrc` file into the tags. A personal test executable can be built with `tools/package-windows.ps1` (no new packaging tool; for testing on this computer only because of the licence terms of the bundled parts).


## D29: Online lyrics lookup from LRCLIB (2026-11-02)

Owner approved network use. In **Pictures & lyrics** (and from the Lyrics tab when a song has none) the button **Find lyrics online (LRCLIB)** asks https://lrclib.net (docs: lrclib.net/docs.md) for the song: first the exact signature (`/api/get`: title, artist, album and, for MP3s this program made, the length), then a search (`/api/search`), keeping similar songs within 5 seconds of the length, time-stamped lyrics first. **Nothing is automatic:** a lookup happens only when the button is pressed, it sends only title, artist, album and length, results only fill the lyrics box, and they are saved only when the person presses Save lyrics (a confirmation appears before the box's existing text is replaced). The User-Agent names the program, its version and the contact from Settings (or the project address); requests are spaced 500 ms apart; a 429 reply is reported with its Retry-After. Settings has a switch to turn the lookup off and shows the server address; only https (or http on this computer, for tests) is accepted. Checked live: LRCLIB returned the time-stamped lyrics for the test song, which were saved and read back. **Not built yet:** bulk lookup for an album or library, a review list for uncertain matches, caching of not-found answers, publishing corrections back to LRCLIB (never without a separate decision).


## D30: Feedback round 1 on the test build (2026-11-02)

Owner feedback after trying the first test build. Done so far: **navigation** is one always-visible top bar (Home, Rip a CD, Library, Review, Settings); **Drive setup** moved into Rip a CD (a Drive setup section that opens by itself when the drive has not been checked); **Tag issues** moved under Review; the **music collection box** now lives only in Settings. **Getting Started** on Home asks for what a new person must set: the music library folder (choose existing or create a new folder), whether to keep FLAC copies (and the archive folder, existing or new), and an email address with a plain explanation of what it is used for; optional extras (AcoustID key, gnudb registration) are listed with their purpose and a link that opens in the browser (only https links to the services' own sites are allowed). The box goes away when the three required steps are done; the same settings stay in Settings. **Packaging:** a failed rebuild had half-deleted the test copy that was running (it lost its CD helper); the packaging script now builds in a staging folder and swaps it in, and leaves a running copy untouched. Still to do from the feedback: Review sub-sections (flagged tracks with scan selection, missing artwork, missing lyrics, audio defects), the Listen sample length setting (8 s default, defect at the midpoint), tag-issue grouping and batch editing, and the tag editor changes (a Song performed by note and the compilation checkbox that sets Various Artists and TCMP).

### D30 addendum: Review sections, listening sample, tag issues (2026-11-02)

**Review** now has five sections: User flagged tracks (tick tracks, then scan the ticked ones for audio defects), Missing or uncertain metadata (the old Tag issues: grouped by what is missing, album folder, suggested artist, suggested album or current artist; tick tracks or a whole group and batch-edit them, where a filled-in field replaces the value on every selected track and a blank one keeps each track's own), Missing artwork and Missing lyrics (a library check for albums with no cover and songs with no lyrics, with the actions to fix them), and Audio defects (the last scan result of each song, kept in `defect-results.json` and trusted only while the file is unchanged; worst first, with a Scan the unscanned songs button). **Listen** for a defect plays a sample of the length set in Settings (8 seconds by default, recommended 5 to 12, accepted 3 to 30) with the defect at its midpoint, and stops by itself. **Tag editor:** Artist is described as Song performed by; Album artist has a checkbox that sets the album artist to Various Artists and writes the compilation flag. **TCMP** is the compilation flag frame first written by iTunes; it is not part of the official ID3v2 specification (the ID3 developer list confirms it is an Apple extension, usable in ID3v2.3, and widely read), so it is written as TCMP with the value 1 for MP3 (the library maps the same flag to COMPILATION in FLAC and cpil in MP4). The editor cannot read the flag back, so the box starts ticked when the album artist is already Various Artists, and an untouched box leaves the file's flag alone. **A fix found on the way:** editing tags with the old editor made the library write ID3v2.4, which this program's own picture and lyrics editor then refused; edits now keep ID3v2.3, the pictures and the lyrics (tested).


## D31: Documentation clean-up and Winamp as an inspiration (2026-11-02)

Owner request before feedback round 2. Every Markdown file was brought in line with the decisions above:
the guiding documents, README, ADRs 0001 to 0007, the notices and `docs/next-steps.md` no longer describe
Tauri, CDex/CDRip.dll, fre:ac's CD route or libcdio-sys as part of the program (they appear only as
rejected options), stale "not built" notes were corrected, and this log gained a summary table and
corrected status lines (entries keep their original wording). The reference projects are gathered in
one table in the Feature Roadmap (look and feel, library, lyrics, ripping). **Winamp** was added for its
music-reactive visualizations (AVS, MilkDrop): a planned, optional visualizer in Now Playing using the Web
Audio `AnalyserNode`, off-switchable, respecting reduced motion and never hiding the lyrics; Winamp
itself is closed, so any visualization engine goes through the third-party review first.
Found on the way, not yet changed (code, not documents): the `crates/adapters/platform-windows-cd` probe
still depends on the rejected `libcdio-sys` and is unused; `web/app/package.json` still lists the Tauri
packages; `provenance.toml` describes lofty as test-only although the library's tag adapter uses it.

### D31 addendum: Tauri code removed (2026-11-02)

Owner approved. The web app no longer depends on the Tauri packages (`@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/cli`); `desktop-bridge.ts` talks only to Electron's bridge and gives a clear message when the page is opened outside the program. Tauri wording was removed from code comments. Tests: 88 web unit, 10 Electron and the host tests pass; the Settings page was driven in the real app. `archive/tauri-desktop` stays until its behaviours have Electron tests (D19).

### D31 addendum: probe crate removed, lofty record corrected (2026-11-02)

Owner approved both. `crates/adapters/platform-windows-cd` (the first, read-only TOC probe, built on the rejected libcdio-sys and used by nothing since the CD helper replaced it) is removed from the workspace; libcdio-sys is no longer in `Cargo.lock`. The program still uses libcdio and libcdio-paranoia through the CD helper. `third_party/provenance.toml` now records lofty as a runtime dependency of the library tag adapter (linked into the sidecar) as well as a test reader, re-approved by the owner for that use; licence unchanged. All 249 Rust tests pass.

## D32: Feedback round 2 on the test build, and design decisions from the Zune screenshots (2026-11-02)

Owner feedback (document of 2026-11-02) and 19 Zune desktop screenshots (notes in `docs/design-inspiration.md`). **Bugs:** the defect scan refuses more than 1,000 files; the Getting Started library choice did not register; the defect results could not be closed (Close is pushed below the window); the top bar runs off the right edge in a narrower window. **Wanted:** defect results list only songs with findings, with a Mark as good that hides a song until the file changes; Review and defect scanning that handle tens of thousands to over 100,000 songs (batches, grouping by album and suspected album, batch correction); AcoustID fingerprinting to help automate tag repair; automatic album-art finding. **Design decisions:** the program stays in **dark mode only**; a minimal look with **square corners**; the tinted album-art **collage is the background of every main page**, not only Home; ambient motion as in Zune (occasional tile flips, a slow northern-lights tint shift, a soft visualizer glow along the bottom while music plays) with **OLED burn-in protection** (drift, dimming, reshuffle, fade to black when idle, a graphics-level setting); Settings gains a **Cast** section as a placeholder (replacing Zune's Xbox 360 page) until casting is designed. **Future:** a Burn page (mix CD or a playlist for a friend) and podcast management. **Order agreed:** Phase A (the bugs, the minimal dark look, the collage background), Phase B (large libraries, with an ADR first), Phase C (fingerprinting and artwork finding, Chromaprint needs a licence review).

### D32 progress: Phase A, first part (2026-11-02)

Built and checked in the real app with a 1,096-song library: **folder windows** now carry the title the page asks for (a fixed "Choose your music collection" title was the likely cause of the Getting Started mix-up: the archive and new-folder buttons showed it too); **Getting Started** shows "Saving…" while it works and shrinks each finished step to one line with Change; the **top bar** wraps instead of leaving the window (the real cause: the page grid grew to the width of the scrolling Home shelf, pushing the whole page wider than the window); the **defect scan** runs in batches of 500, so whole libraries scan (measured about 3 songs a second in the release build: about 6 minutes for 1,096 songs, about 4.5 hours for 50,000), lists only songs worth a listen, has a Mark as good that hides a song until its file changes (`set_defect_reviewed`), and stops when closed or on Escape (the sidecar's defect job could not be cancelled at all before; it now stops before the next file and keeps what it finished); the **minimal dark look** (square corners, see-through dark panels, Zune-style lower-case navigation); the **album-art wall behind every page** (grey covers coloured by a slowly drifting northern-lights tint, a tile flipping every 5 to 11 seconds, a fresh layout every 20 minutes, still under reduced motion, resting while Now Playing is open; Now Playing uses the same tint); a **Cast** section in Settings as a greyed-out placeholder. Not yet: the visualizer glow, idle dimming and fade to black, foreground drift in Now Playing, a graphics-level setting, the sectioned Settings and the dark first-run welcome. One sidecar test (`ripping_without_an_archive_folder_says_so_and_can_skip_archiving`) failed once and passed on every re-run; it shares temporary folder names between runs, to be made independent.

### D32 progress: Phase A finished (2026-11-02)

**Music glow:** a soft glow along the bottom of every page and of Now Playing breathes with the music (a Web Audio analyser on the player's own audio; measured against the music's own recent level so loud albums still move, measured 0.24 to 0.57 on a punk album) and fades out on pause, as in Zune. The `mediaverse-media` scheme is now CORS-enabled with `Access-Control-Allow-Origin` so the analyser can hear the sound; it still serves only audio files inside the library, and playback was re-checked. **Display and motion** (Settings): Full, Gentle or Still (Windows' reduce-motion always means Still), Now Playing opening by itself after a few idle minutes while music plays (default 5), and fade to black after idle time with nothing playing (default 30 minutes); kept in the page's local storage because they belong to this screen. **Burn-in care in Now Playing:** the cover block and side panel drift a few pixels over 24 to 30 minutes at every motion level, and the controls and pointer fade after 20 seconds without input. **Settings** is a list of sections on the left (Library, Rip, Lookups, Lyrics, Review, Display, Cast). **First-run welcome:** a dark full-window screen, once, while setup is unfinished: start playing (music folder only), set it up now (the same three steps as Getting Started, one component), or later. Checked in the real app with `capture-glow.cjs`, `capture-settings.cjs` and `capture-welcome.cjs`.

## D33: Large libraries, steps 1 and 2 (2026-11-03)

Design and measurements in ADR 0008 (synthetic libraries from `tools/make-test-library.ps1`; 20,000 songs). **Step 1:** a real bug fixed: tag-issue suggestions were made only during an import or rescan, so Review > Missing or uncertain metadata was empty after every restart; and the list drew every issue (2 s and 241,000 page elements at 20,000 issues, slowing every page switch), now closed groups, pages of 50 and 100, drawn only on screen (17 ms, 737 elements). **Step 2:** defect results moved from a JSON file rewritten for every song to `defect-results.sqlite` (the old file is imported once); a library-wide scan (`scan_library_defects`) runs in the background on up to four threads, saves each result at once, can be stopped and continued (also after a restart), and the page finds it again when you come back; Review > Audio defects shows the scan inline and a paged list. Measured: 20,000 short test songs in about 33 s on four threads; real songs about 12 a second on this PC (50,000 in about 70 minutes, was about 4.5 hours). **Found on the way:** the click detector finds single-sample clicks in MP3s encoded at V0 (this program's default) as well as in WAV, but MP3s at V5 smooth them away completely, so low-bitrate MP3s from other sources get little click detection; stated here as a limit. `rusqlite` (bundled SQLite) is now also used directly by the sidecar; it was already compiled into the program through the library database, but it has no entry in `third_party/provenance.toml` (a gap from the Tauri days, for the owner to record).

## D34: Overnight work: large-library refinements, suspected albums, finding artwork online (2026-11-03)

Owner asked for as much as possible overnight with permission to push. **Folder changes** (ADR 0008 step 3a): Windows change notifications instead of polling every file every 2 s (idle processor use with 100,000 songs from 11% of a core to 0), resync reads only changed files and sends nothing when no audio changed, and track IDs stay with their file. **Library page**: artists 120 at a time with a Find an artist box. **Suspected albums**: a Review grouping for one album tagged inconsistently (spelling, album artist, year, genre), with Edit this group pre-filled with the most common values; checked on the owner's library (read only), where it first proposed renaming every disc of a three-disc set to Disc 1: disc labels are now kept and never proposed. **Finding artwork online** (Phase C, no new component): in Pictures and lyrics, Find the cover online searches MusicBrainz by album and artist (and by title alone when that finds nothing, said on screen), shows front covers from the Cover Art Archive as previews, and the chosen one goes into the ordinary preview; nothing is saved until Save is pressed. Only the album and artist names are sent, with the same identification and spacing as ripping. Checked live: 3 covers for a compilation in about 12 s, a 1200 px cover prepared to 322 KB. **Not done:** AcoustID fingerprinting needs Chromaprint, a new component waiting for the owner's licence review (notes in `docs/next-steps.md`).

## D35: rusqlite and rusty-chromaprint approved after a licence check (2026-11-03)

Owner chose a pure-Rust fingerprinting library and asked for an online licence check of it and of rusqlite, to be considered resolved if nothing conflicts with GPL-3.0-only. **rusqlite** (with libsqlite3-sys and bundled SQLite): MIT, and SQLite is public domain (rusqlite README); used since the Tauri days but never recorded, now in `third_party/provenance.toml`. **rusty-chromaprint 0.3.0**: MIT per its crate metadata (the repository has no LICENSE file); its README calls it a port of Chromaprint, whose own code is MIT (Copyright Lukas Lalinsky; Chromaprint's LICENSE.md says only its bundled FFmpeg parts are LGPL-2.1), and the port uses rubato and rustfft (MIT OR Apache-2.0) instead of FFmpeg. Even LGPL-2.1 code could be used under GPL terms, so no conflict either way. Both recorded as approved. Still to verify when fingerprinting is built: that its fingerprints match AcoustID's.

## D36: Idea recorded: a MediaVerse Studio app on the TVs themselves (2026-11-03)

Owner's main goal is playing the library through the TVs to the hi-fi. Besides casting, he would like an app on the TV itself (Samsung Tizen and Google TV) that plays from the PC's library over the network or from a USB stick, ideally from the official stores, and at least installed on his own two Samsung S95F TVs (QN65S95FAFXZA, QN77S95FAFXZA). He also wants less bloatware, no autoplay of Samsung content and less tracking, while keeping security updates. Recorded in `docs/tv-apps.md` with routes to check (DLNA or a local web address the TVs can already play; our web page as a Tizen app in developer mode; the stores). Replacing the TV's own system is not a realistic or supported route and is not planned; the privacy settings and network-level blocking that keep updates working are noted instead. No research or testing done yet; device identifiers from the owner's photos are deliberately not stored.

### D36 addendum: TV apps are on the roadmap (2026-11-03)

Owner decision: TV apps for Samsung (Tizen store) and Google Play (Google TV) are part of the roadmap. First goal: Tizen developer mode on the owner's two S95F TVs and the MediaVerse Studio player installed on them, because it looks better than the TVs' built-in players and they cannot show lyrics with the music. Added to the Feature Roadmap and the platform list in the playback guide. The TVs' identifiers are kept in a private local file outside the repository, for the owner's own use.

## D37: Samsung Tizen Studio approved as a build tool for the TV app (2026-11-03)

Owner created a Samsung Developers account and is installing Samsung's Tizen Studio 6.1 (Baseline SDK) in the default locations (`C:\tizen-studio`, data in `C:\tizen-studio-data`), with its Package Manager extensions for Samsung TV and Samsung certificates. It is a development tool only: it packages and signs the `.wgt` and installs it on the owner's TVs in developer mode. None of it is copied into the repository or shipped with MediaVerse Studio; the TV app itself stays our own GPL web code. The signing certificates (author `.p12` and its password) are private and are kept out of the repository. Research notes in `docs/tv-apps.md`.

## D38: First TV app and library sharing on the home network (2026-11-03)

Owner asked for work on a TV media player while away. Built without any new component:

- **Library sharing** (`web/app/electron/library-share.js`, Settings > TV): **off by default**. When on, a small read-only web server (Node's own `http`, port 47700) answers only devices on the home network (private, link-local and loopback addresses); everything except a hello check needs an 8-digit access code shown in Settings (new code on request; 10 wrong codes lock that address out for 10 minutes). It lists the library and serves songs (with seeking), covers and lyrics, naming tracks by library ID: no file paths are sent, only each album folder's own name (to name compilations), and every file is checked against the library folder as the app's own player does. Windows may ask once to allow private networks.
- **TV app** (`web/app/tv`, built by `npm run tv:build` into `dist-tv`, packaged by `tools/package-tv.ps1`): a Tizen web app (package ID `MVStudioTV`, which must not change) for 1920 x 1080 and the remote: Albums, Artists, Songs, Now playing (cover, progress, synced or slowly scrolling plain lyrics, shuffle), Settings. Connects by typing the address and code (number buttons or an on-screen keypad); remembered after that. Compilations stay one album named after their folder; artists come from each song's own artist. OLED care: Now Playing drifts a little each minute, its buttons fade after 10 s, browse screens dim after 3 minutes (or switch to Now Playing while music plays).
- **Checked:** unit tests for the sharing server, grouping and remote navigation; a scripted run (`scripts/capture-tv.cjs`) against the owner's real 1,096-song library (read only, throwaway data folder) connected over the PC's home-network address, browsed and played with key presses only. `tizen package` made a valid `.wgt` with a throwaway test certificate (removed afterwards). **Not yet checked on a TV**: needs developer mode and the Samsung certificate; synced lyrics were not seen on screen (the test library has none).
## D39: TV finds the computer itself; one-time pairing replaces the access code (2026-11-03)

Owner feedback on D38: typing an address, port and an 8-digit code with the Samsung remote is too much; pick the
source from a list; a one-time 6 to 8 digit key is fine; lock out after 5 wrong codes, not 10. Done, with no new
component: the TV lists computers running MediaVerse Studio found on its home network; choosing one shows a
one-time 6-digit code on the computer (in a window over any page, with Refuse); the code typed on the TV earns a
random key the TV keeps (the computer stores only its hash, lists paired TVs in Settings > TV, and can remove
them). 5 wrong codes from an address lock it out for 10 minutes. Sharing API version 2 (D38 TVs must pair again).
Planned next, after trying them on a TV: USB drives and NAS (DLNA) sources, and the Now Playing redesign
(visualizer in the middle, cover at about a sixth of the screen swapping sides with the song details, a cover
collage background whose tiles slowly flip).

## D40: TV Now Playing redesign and a visualizer that works on the TV (2026-11-03)

Owner's design: visualizer in the middle, the cover at about a sixth of the screen changing sides with the song
details, and a background wall of album covers whose tiles slowly turn over. On the TV a Web Audio analyser on
the `<audio>` element hears silence (tested on the 65" S95F), so each song is decoded and analysed once when it
starts (own FFT, 48 bands, 25 frames a second; songs over 80 MB are skipped) and the bars follow the player's
clock. The computer now sends shrunk covers on request (`/api/cover/<id>?size=N`, Electron's `nativeImage`, no
new component) so the TV can show dozens. The app asks for `filesystem.read` and `externalstorage` to try USB
drives next. Installed and checked on the TV over the inspector (60 frames a second, low volume).

## D41: USB drives as a TV source (2026-11-03, built, not yet tried with a real drive)

The source list on the TV now also offers each mounted USB drive (`tizen.filesystem`, EXTERNAL storages,
refreshed when a drive is plugged in). Choosing one walks it for music (MP3, FLAC, M4A/AAC, Ogg/Opus, WAV; up to
30,000 files, 10 folders deep), reads each song's details from its first bytes (`tv/tags.ts`: ID3v2.2 to 2.4 and
FLAC Vorbis comments with the embedded cover, written for this app, no new component; file and folder names
otherwise) and plays the files directly. A folder picture (cover/folder/front.jpg or .png) wins over an embedded
cover. Lyrics are not read from drives yet. Checked: the tag reader on the 1,096-song test library (titles for
1,085, the rest from file names), the scanner against a stand-in for the TV's file functions, and every file
function on the TV itself with files in the app's own folder. Next: a real USB drive in the TV.

## D42: Jellyfin as a TV source; Jellyfin server installed on the owner's PC for testing (2026-11-03)

Owner approved setting up Jellyfin on this PC to test a Jellyfin source for the TV app (NAS plans: Samba, Plex
or Jellyfin; a TV web app cannot use Samba, while Jellyfin and Plex have documented web interfaces). Jellyfin
Server 12.4 (GPL-2.0, jellyfin.org; Windows zip, MD5 checked against repo.jellyfin.org, the executable is not
code-signed) runs from `C:\Users\<you>\Developer\MediaVerse\Jellyfin-Test-Server\jellyfin-12.4` with its data in
`tools\jellyfin-test-data`: a test user, the test library read only (no files written to it, internet metadata
off, embedded covers on). It is a test tool only: nothing from Jellyfin is copied into or shipped with
MediaVerse Studio; the TV app only talks to it over its web interface.
TV app: Jellyfin servers on the home network are found like MediaVerse Studio (each address asked, port 8096)
and listed as sources; signing in uses Jellyfin's Quick Connect (a code on the TV, entered in Jellyfin on a
phone or computer), so nothing is typed with the remote. Songs, covers (any size), streaming with seeking and
lyrics come from Jellyfin's web interface. Checked on the PC end to end against the test server (found, signed
in, 1,096 songs in 0.5 s, played) and the TV reaches the server. Plex next, then plain DLNA.

## D43: TV feedback round (2026-11-03, owner testing on the living room TV)

- The TV's screen saver is held off while music plays (Samsung AppCommon `setScreenSaver`, no privilege;
  checked on the TV) and allowed again on pause. The app's own OLED care stays.
- USB drives open after the first 100 songs or 3 seconds and fill in while browsing; each drive's song list is
  remembered (up to 8,000 songs) so the next start shows it at once while it is read again; the app reopens the
  drive at start-up when it was the last source.
- The visualizer analyses the first ~1.5 MB of a song first (a Range request, or cut from a local file), then the
  whole song: on the TV the bars rose about 1.4 s after the music began.
- Visualizer colours come from the playing cover (strongest colour family, blended in over two seconds; the
  app's orange for black-and-white covers), and the style changes with each song and every few minutes: bars,
  mirrored bars, a ring, a wave. With lyrics showing, the visualizer gives way to the desktop's glow along the
  bottom. The cover wall is a little brighter.
- Fixed: the highlight was lost when the source list was redrawn as a second source appeared.

## D44: Favorites, flags from the TV, genres and search (2026-11-03)

Owner asked for flagging and favorites on the TV, Play favorites (the first step towards playlists), a Genre
view and Search. Owner decision: marks made on the TV while playing from the computer are saved on the
computer. So a paired TV may now make exactly two kinds of change through sharing (`POST /api/flag/<id>`,
`POST /api/favorite/<id>`, bodies under 4 KB); everything else stays read only. Flags go to the desktop Review
list (reason, place in the song, "Flagged on the TV"); favorites are new in the desktop app too: the Rust core
keeps `favorites.json` (`list_favorites`, `set_favorite`, by library file like flags), the player bar has a heart,
the Library marks favorites, and Home offers Play favorites / Shuffle. With Jellyfin, Jellyfin's own favorites are
used (flags stay on the TV, as Jellyfin has none); with a USB drive both stay on the TV.
TV: heart and flag buttons on Now Playing (a chooser with the desktop's five reasons), marks beside songs,
Favorites (Play all, Shuffle), Genres (split on ; / , and merged across spelling; Play all, Shuffle, the albums)
and Search (a letter keyboard for the remote; also the number buttons; artists, albums and songs, every word
must match, names starting with the first word first). Checked end to end on the PC with the real test library.

## D45: "Who's listening?" profiles on each TV (2026-11-03)

Owner asked for a Netflix-style "who is listening" prompt so each person builds their own favorites. Owner
decisions: profiles live on each TV (the two TVs and the desktop app do not share them), no PINs, flags stay
the household's. The TV asks at start-up (the library loads behind it); up to eight people, each with an
initial and a colour; names typed with the letter keyboard; Edit people renames or removes (removing deletes
that person's favorites on the TV); "Continue without a name" on a TV with nobody set up. The listener's name
sits at the end of the tabs and reopens the picker. With a person chosen, favorites are theirs and kept on the
TV per music source (the computer, a Jellyfin server or a drive), replacing D44's favorites on the computer or in
Jellyfin for that person; without one, D44 applies. Flags still go to the source's list, signed "Flagged on
the TV by <name>". Checked end to end on the PC.

## D46: One turning cover wall for every MediaVerse Studio app; TV screen saver held harder (2026-11-03)

Owner: more variety in the wall's tile sizes; about one tile every 5 to 10 seconds slowly turning over to a
different album, fairly random but with every tile turning eventually; the same in all versions of MediaVerse
Studio. Shared code `web/app/src/cover-flip.ts` (tested): tiles turn in a shuffled order (each once before any
twice, never the same twice in a row), every 5 to 10 seconds, over 2.4 seconds, to an album not on the wall
where possible, cycling through all albums; tile sizes small/medium/large (a few large). The TV wall now uses
120 px cells with those sizes and leaves out albums without a cover; the desktop Now Playing wall keeps its
plan (playing album biggest, queue and artist emphasised) and its library tiles now turn the same way. Future
apps (Android) are to use the same rules.
TV screen saver: on the 65" S95F the TV accepted "screen saver off" yet showed it after 20 to 30 seconds of music,
so the request is repeated every 10 seconds while music plays, and a pause between songs no longer lets it back
(only a pause lasting 3 seconds does). To confirm on the TV.

- D46 follow-up (owner, 2026-11-03): the wall turns one tile every 5 seconds exactly; on the TV's Now Playing every accent (progress, highlighted button, Shuffle/Lyrics when on, the focus fill) follows the visualizer's cover colour; playback buttons are drawn icons (the TV drew the pause symbol as a blue emoji).

## D47: TV performance pass, a keep-awake clip, ripper helper fix, artist A-Z bar (2026-11-03)

**Ripper:** the sidecar looked for the CD helper next to itself first, where a plain `cargo build` leaves a placeholder that only says it needs the GNU build, so ripping failed with "The CD helper stopped unexpectedly" (shown twice). The GNU build output now comes first in a development tree; an installed copy is unaffected. **Library:** an A-Z bar down the right edge jumps to the first artist under a letter (# for numbers and symbols); covers load only as cards come into view.
**TV performance** (measured on the bedroom 65" S95F, Tizen 9, Chromium 120, 4 ARM cores, software raster; living room TV left alone at the owner's request). Steady playback was already 60 fps; the lag was at every song change: the first 20 s after starting an album had 23 frames over 50 ms and a 967 ms freeze; a song change 14 and 817 ms. Causes and fixes: the song analysis (2.3 s of processor time a song, competing with drawing on the TV's cores) moved to a background thread with precomputed FFT tables, the start of the song not analysed twice, and short rests between slices (now 0.2 s); cover wall tiles flat at rest and 3D only while turning (was about 300 picture layers composited every frame); the blurred backdrop hidden on Now Playing; the visualizer capped at 60 fps with time-based smoothing, colours blended only while changing, the glow set on its own element instead of restyling the whole screen each frame, gradients and colour strings reused. After: song start 57 fps average, worst 133 ms; song change 58 fps, worst 100 ms. What remains is drawing a new cover and text while the stage fades out to change sides. Lyrics mode not measured (the test album has no lyrics).
**Screen saver:** the owner observed that YouTube keeps the screen saver away only while full-screen video plays. A silent, dark, 4-second MPEG-4 clip (7 KB, `tv/public/keep-awake.mp4`, made with ffmpeg from a solid colour; ffmpeg used as a local tool only, not shipped) now loops behind everything while music plays on Now Playing, and stops on other screens and when the music stops. On the TV it plays without error and without interrupting the music; whether it holds the screen saver off is being watched.

## D48: Tag repair by identifying albums: design agreed in principle (2026-11-03)

The owner found the tag review's batch editor harmful (one group of 1,187 tracks missing a genre, with a form that could give them all one artist and album) and asked for intelligent grouping and suggestions with confidence, a compact Explorer-like list in pages, best matches first, disc-ID lookups from track lengths, fingerprint confirmation, Discogs for obscure editions, inspired by Mp3tag, MusicBrainz Picard, MediaMonkey and TagScanner. Design in ADR 0009 (album folders as the unit; evidence from the disc layout rebuilt from file lengths, AcoustID fingerprints, names, Discogs; a confidence score with the evidence written out; other editions to choose from; paged review with per-album, per-file and per-field checkboxes; only empty or placeholder values filled by default; undo journal). Mockup published for the owner (Fix Tags mockup). **Proved on the owner's files:** the lengths of the 12 files in `A Perfect Circle\eMOTIVe` (tagged only "Track 1".."Track 12") alone found eMOTIVe in seven editions through MusicBrainz's fuzzy TOC search, with genres. First code: `DiscToc::from_track_lengths` and `musicbrainz::toc_search_url` (tested). **Discogs:** findings in ADR 0009 (personal token; CC0 catalogue data vs restricted data; "Data provided by Discogs" beside its data; six-hour freshness; no Discogs images); the owner is setting up a token and should read the live terms once.

## D49: Priorities after the TV round; Pixel phone app and Google TV direction (2026-11-03)

Owner's priorities: (1) tag fixing (ADR 0009), (2) album art and band photos, (3) lyrics, all working well, before
new platforms. TV follow-ups since D47: the screen saver is held off only while music plays on Now Playing
(confirmed by the owner on the bedroom TV); a long pause now reopens the song where it stopped, with a watchdog
for a player that stops moving (checked on the PC; to try on the TV). Website: mediaverse.studio on GitHub Pages
from the public repository MediaVerseStudio/mediaverse.studio (HTTPS certificate pending); project e-mail
contact@mediaverse.studio.
**Phones (next platform):** a MediaVerse Studio player for the family's Google Pixel phones, like the TV app but
with playlists (the desktop's user playlists are still to be built, and will be shared in design) and with the
phone's own storage as its main library, not the computer. Shell and playback components (for example a web UI
in a native Android shell with the platform's media session for background playback and lock-screen controls)
to be proposed with a licence check before any is added.
**Google TV (later):** the Samsung TV app is to be duplicated for Google TV. Until then, TV code keeps everything
Samsung-specific (remote keys, screen saver, USB, network address, packaging) behind one small platform module so
a Google TV (Android TV) shell can supply its own, and shared code stays in plain web modules.

## D50: Fix tags built in testing mode; Discogs added; stability and performance fixes (2026-11-03, overnight)

Owner asked (2026-11-03, evening) for the tag repair logic to identify the library's defects with high confidence
without writing anything, the mockup to be testable in the morning, and a performance and stability pass, with
permission to push until morning. **Built:** the read-only library scan and Review > Fix tags (ADR 0009, "Built so
far"), Apply switched off. Matching handles a disc layout rebuilt from file lengths, a search by names, folders
missing a song or with an extra one (paired by track number, gaps lowering confidence and said), two-disc sets in
one folder, track numbers that repeat in the tags (the file names' numbers used; found on the owner's
`10,000 Maniacs\Our Time In Eden`, where `01 Noah's Dove.mp3` carries track 10's tags), real values that disagree
with the release (noted, never changed), and an album's original year taken from all its editions (the owner's
In My Tribe: 1987 files, a 1989 reissue). **Discogs:** a third source after both MusicBrainz searches, with the
owner's personal token stored only in his local settings (never in the repository), CC0 data only, never images,
"Data provided by Discogs" linked beside its suggestions, data older than six hours looked up again before it is
shown, and the required notice in Settings and on the website. The identification header now gives
contact@mediaverse.studio (owner's request: project address for project entries; the old settings file was kept
as metadata-settings.json.before-contact-change). **Stability:** Electron starts the sidecar again after an
unexpected stop (at most 5 times in 10 minutes); a panic in a background job ends it with an error and clears its
"running" marker; a panic while reading one folder is recorded for that folder and the scan goes on; TV sharing
answers a song file that has gone away with 404, checked without blocking. **Performance:** the player saves its
queue only when it changes and its position on its own (the whole queue every 5 s stuttered with large queues).
**TV:** safe resume after a long pause and a playback watchdog (D47 follow-up), checked on the PC only.

## D51: Fix tags writes on the owner's command; tag writer made safe; player fixes (2026-11-04)

The owner checked the first page of Fix tags and asked to apply the suggestions himself, page by page: Apply writes
only the ticked suggestions on the page shown, after a confirmation, and the last batch can be undone (journal in
tag-repair.sqlite: each field's value before and after; a field changed again since is left alone). Only fields
still empty or a placeholder when the file is opened are written, and an album whose files changed after the check
is not written at all. **Writer:** one routine for Fix tags and the tag editor: an MP3's own ID3v2 tag is edited
frame by frame (going through lofty's general tag rebuilt every frame, and old iTunes ID3v2.2 tags or ID3v2.4 UTF-8
tags came back with empty UTF-16 strings lofty itself cannot read); frames with an empty UTF-16 or UTF-8 string are
switched to Latin-1 when their text fits; the result is written to a copy, read back and compared (values and length),
and only then swapped in. The year is written as a real TDRC timestamp (TYER in v2.3): lofty's set_year stored a key
ID3v2 has no frame for, so years saved by the tag editor were silently lost in MP3s. Checked on copies of 699 of the
owner's songs (300 random, 400 one per album folder): all readable files filled, audio unchanged, undone exactly;
one file lofty cannot read at all is skipped, as the scan already reports it. **Review:** the "Missing or uncertain
metadata" tab is removed (owner's request; Fix tags replaces it). Page buttons at the top and bottom of Fix tags.
**Player:** the app answers byte ranges for its own audio (the file:// fetch did not, so the position slider could
not seek); the player bar stays on one row with long titles cut short (it grew and shrank between songs), and pages
leave room for its measured height (it covered the bottom of pages, including the Fix tags page buttons).
**Library count:** the 13,300 on Audio defects counts only MP3, FLAC and WAV; the library also holds the owner's 245
M4A files, which the defect scan cannot decode yet.

## D52: The library rebuilt like Windows Media Player, in the Zune look; one player bar everywhere (2026-11-04)

The owner found the library "bloated" and asked for Windows Media Player (Legacy)'s layout in the Zune software's
look, with the album-art collage kept behind it (darker than on Now Playing), after approving a mockup
(https://claude.ai/artifact/5eeR3gfqmBM8SaDX8xswJG). **Artists:** a wall of artists grouped under letter headings
with a jump bar; each shows a stack of up to three square album covers turned out behind each other, its albums,
songs, total time and main genre; a leading "The", "A" or "An" is ignored when sorting (a setting, on by default).
**An artist:** each album's square cover (shown whole, never stretched or cropped) beside its songs in one table,
albums ordered by year (or name), songs in columns the person ticks, orders and sizes (track number, title, length,
contributing artist, album artist, genre, year, bitrate, size, date added, disc, file type), sorted by clicking a
heading; click, Ctrl-click and Shift-click select songs, and a bar offers Play, Edit tags, Pictures & lyrics, Scan
for defects, favourite and flag (Play next and Add to queue wait for playlists; ratings are not stored yet). The
host now keeps each file's length, bitrate, disc number, size and creation time ("date added") with its tags, read
in the background once after start. **Player bar:** the same on every page; the cover and song open Now Playing (the
"Now playing" button is gone); previous, next, shuffle, repeat, favourite and flag are icons named by tooltips, in
every app from now on. Settings for the columns are kept on this computer (`mediaverse.library-view.v1`).

## D53: Convert to MP3 and one ID3 version (2026-11-04)

**Convert to MP3 (PC only):** Settings › Tags & files converts the library's non-MP3 songs (M4A/AAC, FLAC, WAV,
WMA, OGG/Opus where Windows can decode them) to MP3 beside them: Windows' own decoders (Media Foundation, through
Microsoft's `windows` crate, MIT/Apache-2.0, approved by the owner) to a temporary WAV, LAME at V0, tags and pictures
copied and read back, lengths compared; only then is the original moved to "<library> (converted originals)" with
the same folders. The owner's 245 AAC files were converted the same way the same day (with fre:ac's ffmpeg for the
decoding, a one-off on his computer), all 245 checked; originals in `C:\Users\<you>\Music (M4A originals)`.
**ID3 version:** every MP3 tag the program writes is ID3v2.3 (older players, the owner's iPod Classic among them,
misread v2.4); an advanced setting switches to ID3v2.4. A job in the same place rewrites the tags that are not the
chosen version (the owner's library: 2,176 v2.2 and 976 v2.4), changing only the version, through the same checked
copy as Fix tags. **Fix tags** suggestions follow the album's other tracks for album-wide fields and can be typed
over before applying (d2cca05).

## D54: Selecting songs as Windows Media Player does; security and performance pass (2026-11-04)

**Desktop:** songs are selected by click, Ctrl-click, Shift-click and Ctrl+A, and acted on from a right-click menu
(or the menu key / Shift+F10) as in Windows Media Player (Legacy): Play, Play next, Add to queue, Edit tags,
Pictures & lyrics, Scan for defects, favourites, flag, Properties, Open file location; an album cover has its own
menu. The selection bar is gone. The player can now queue songs next or at the end (saved in play order). Not in
the menu yet: Cast (casting is not built), Rate (no ratings), Delete (deliberately left out for now). **TV (and the
phone app later):** the modern Media Player's way: a tick box left of each song and a bar of actions once any is
ticked (Play, Play next, Add to queue, Add to favorites). **Untagged MP3s** can be given a tag from their file and
folder names (Settings › Tags & files), so Fix tags can then look them up.

**Security:** a strict Content Security Policy on the desktop page; the window cannot navigate away from the app's
page; every bridge handler answers only that page; permission requests are refused; "Open file location" only
for songs inside the library. Reviewed and left as they are: the TV share server (home network only, constant-time
code checks, lockout, hashed device keys, 4 KB request bodies, library-only paths) and the sidecar's path
commands (all checked against the library). **Performance:** selecting no longer redraws the artist page; grouping
the library is linear (it copied a growing list per song); the artist wall redraws when the lengths arrive; a
library sync no longer copies its record of every file; the lyrics lookup reads the song in its job, not on the
thread that answers every command.

## D55: TV playback after silence; the cover wall builds itself slowly (2026-11-04)

Measured on the living room TV: after any pause (a new queue started from silence, or Play after Pause) the TV's
player stops once, 1.5 s in, with the song already downloaded; a new queue started while music plays, or a skip,
never does. The cover wall is not the cause (it stalled with the wall hidden and no pictures loading); neither a
silent Web Audio tone nor a second, silent player prevents it. Reopening the song at once when the player waits
with more than 10 s downloaded turns the 2.5 s halt into about a third of a second (measured); the watchdog stays
as the backup. At the owner's request the Now Playing cover wall now starts black and fills in a few random tiles
at a time over 45 s once the song and visualizer are under way, loading each picture as its tile appears; tiles
turn over only once the wall is complete. The TV also gained a Queue tab, removing songs from the queue or
favourites, repeat, and lighter icon controls.

## D56: Fix tags suggests a genre when the release has none (2026-11-04)

Many identified albums had only one gap left, the genre, because MusicBrainz names none for the release, and the
page offered no way to fill it. At the owner's request a missing genre is now suggested from the genre most of the
artist's other songs have in the library (at least three songs, more than any other genre; genres written by
Apply count), else from MusicBrainz's genres for the artist (found by exact name, looked up once per artist and
remembered in `tag-repair.sqlite`, at most two new artists per page so a page never waits long). Without either,
the album shows an empty Genre box. The Genre box sits on the album's card without opening its files, offers the
library's genres to pick from, and typing there sets the genre for every song of the album. Apply still writes
only into empty or placeholder genres, and nothing is asked online while applying.

## D57: The Android app begins: a native Media3 player with the web front end (2026-11-04)

At the owner's request (a player for his Pixel 11 Pro playing music stored on the phone, Android Auto, and later
casting to the TV), the Android app was started in `apps/android` (`docs/android-app.md`). Playback is native:
AndroidX Media3 (ExoPlayer and a `MediaLibraryService`), so music plays with the screen off, in the notification
and lock screen, and in Android Auto, which draws its own screens from the library the service offers (Artists,
Albums, Genres, Songs). The phone's screen is the web front end (`web/app/phone`, sharing the TV app's library
grouping, search, visualizer and look) in a WebView, served from the app's own files and talking to the player
through one origin-restricted message channel. The phone's library comes from Android's media index, grouped with
the TV app's rules; the Rust core is left for later features (lyrics, tag repair, the share server). Two platform
facts shape the plan and were told to the owner: Android Auto does not allow custom media screens (no TV look in
the car; the split-view Now Playing card is automatic), and Samsung's TVs do not receive Google Cast, so casting
will go through our own TV app, with the phone offering its library like the PC does. Media3 and the AndroidX
libraries (all Apache-2.0) were approved by the owner the same evening.

## D58: The phone as the TV's remote ("play on the TV") (2026-11-04)

Samsung's TVs do not receive Google Cast (D57), so casting goes through our own TV app. The phone shares its
library with the TV app using the computer's share API and pairing (Settings > TV on the phone; Android 17's local
network permission is asked for when it is switched on). New in the API, on the phone only: a paired TV playing
from the phone asks for commands with a long poll (`GET /api/remote?after=<seq>`: play these songs from this song
and place, play/pause, pause, next, previous, seek; only the TV a command is meant for gets it, and a TV that just
connected is not sent old commands) and reports what it plays every 2 s (`POST /api/remote/state`). A computer has
no remote and answers 404, so a TV connected to a computer stops asking after one request. On the phone, Now
Playing shows a TV button while a TV is listening: it sends the queue and place to the TV and pauses the phone;
the screen then shows and controls the TV ("On <TV>"); the button again pauses the TV and carries on on the phone.
Tried on the emulator with the TV app's own client code standing in for the TV; not yet on the real TVs.

## D59: Fix tags: every tag editable, albums without a release fixable, titles tidied (2026-11-04)

At the owner's request ("I should be able to enter album properties and have them propagate to all the songs";
"I should be able to change or type over any of the tags"), Fix tags changes from filling gaps only to an editor:
- Every cell of an album's table is a text box, colour coded as before (orange suggestion with the old value struck
  through, white current value, yellow where the release spells it differently, its spelling offered as you type;
  typed values turn blue). A Disc column was added.
- The album boxes (Album, Album artist, Contributing artists, Genre, Year) set the value for every song of the folder;
  fields some songs still lack show their boxes on the card without opening it.
- Albums no release was found for get suggestions from their folder and file names (album from the folder, album
  artist from the songs or the folder above, each song's artist, track and disc number and title from its file
  name, genre from the library), shown as "No release found: check and edit".
- Titles carrying a track number, the artist's name or a web address get a tidied suggestion
  ("01.AFI - Prelude 1221 (Live Arena Long Beach CA) - www.file24ever.com" becomes "Prelude 1221 (Live Arena Long
  Beach CA)"); a number that is the song's name ("3 1/2", "1-800-273-8255") stays.
Safety rules: plain suggestions still only fill empty or placeholder tags; a typed value or a tidied title may
replace a real value, but only if the file still holds what the scan saw; numbers that are not numbers are refused
and reported; only the folder's own files are written; every write is journalled and can be undone.

## D60: Fix tags: confirmed "Untitled" songs; a year written over a full date (2026-11-05)
- A placeholder-looking value the release also has (blink-182's "Untitled" on Dude Ranch) stays on the page,
  highlighted "same as release: confirm" (owner: "they should still be highlighted ... and I should still be able
  to confirm"). Apply writes nothing for it but remembers it per file and field (`confirmed_values`); a later check
  does not list it while the file keeps that value.
- Writing a year into an ID3v2 tag holding a full date (TYER+TDAT, "2010-11-30") left the old date beside the new
  year (lofty replaces a date frame only when it holds the same date), so the read-back check refused the file.
  The old date frames are removed first.

## D61: Album pictures and Missing artwork reworked; covers at most 1000 pixels; cover search order (2026-11-05)
Owner's requests after using Review > Missing artwork:
- Missing artwork is one compact line per album: Album, Album artist, Year, Tracks, and "Add artwork". The Play
  album button is gone. Saving a picture updates the list at once, without reading the whole library again (it
  used to stay listed until the tab was opened again, and every save re-read every song's tags).
- The Album pictures dialog (also used from the library) shows three squares, Front cover, Back cover and Artist
  photo, with the pictures the songs already have and their size in pixels (and on how many of the songs, or
  "cover file in the folder"). Each square takes a pasted, dropped or chosen picture, can be deleted, shrunk to
  1000 pixels or cropped to a square; changes wait for Save changes.
- Pictures are stored at most 1000 × 1000 pixels (was 1200 on the longest side). A non-square picture is shrunk so
  its longest side is 1000 and "Crop to square" (centre, 1000 × 1000) is offered. A library-wide tool to shrink
  existing pictures over 1000 pixels (with undo) was also asked for: the next step.
- Finding a cover online, in the owner's order: MusicBrainz and the Cover Art Archive, each release with a match
  percent (MusicBrainz's score, less 15 for another track count, 5 for another year, 20 when found by title
  alone); 95% or more is offered as "Approve", which saves it as the front cover in one step. Below that, and when
  Discogs is set up, the album's page on Discogs is offered to open in the browser: Discogs' images are restricted
  data under its API terms (ADR 0009), so the app never fetches them; the person copies the cover from Discogs'
  own page and pastes it. Then a web image search (Google Images, "artist album year album artwork") in the
  person's browser, after a one-time permission. When MusicBrainz or the Cover Art Archive is slow (8 seconds) or
  busy, or nothing is found, the page says so and opens the web search straight away.

## D62: Full-size pictures in the album folder, small JPEGs in the songs; low-resolution and over-size reviews (2026-11-05)
Owner: "album artwork saved in the album folders can remain larger than 1000x1000 pixels, but embedded artwork within
the MP3 tags should be limited to 1000x1000 pixels or less ... jpeg ... less than 500kb, and ideally, less than
200kb. We don't want to overcompress ... displayed near their native resolution on large 4k TV screens."
- Pictures inside the songs: JPEG, at most 1000 × 1000. Quality: the best from 92 down to 80 that fits 200 KB; if
  none does, the best of those under 450 KB (the tag writer's limit is 500 KB); only then lower, down to 50.
- A picture saved from the Album pictures dialog is also kept at its own size in the album folder as `cover`,
  `back` or `artist` `.jpg` (a JPEG as it is, anything else as a 95% JPEG; cropped when Crop to square was used).
  The folder files it replaces (for the cover also `folder.*` and `front.*`) are moved to
  `<app data>/replaced-pictures` with a list of where they came from, never deleted. A cover that exists only
  as a folder file gets "Put in the songs" (the folder file is left as it is).
- Ripping follows the same rule: the Cover Art Archive's 1200 px cover goes in the folder; the songs get its
  500 px JPEG (the archive offers no 1000 px size, and the app has no image library to resize in Rust).
- Many programs store the cover as ID3 picture type 0 ("Other"): it now counts as the front cover everywhere,
  and a new or removed front cover replaces it.
- Review > Artwork (was Missing artwork) has three lists: Missing; Low resolution (best cover under 500 × 500, or
  under 1000 × 1000 by choice; "nothing is wrong with them"), each with Replace artwork; and Too large in the
  songs (over 1000 pixels, PNG, or 500 KB or more) with Fix and Fix all. Fixing stores the picture again as above
  and keeps the full size in the folder when the folder has no picture of that kind at least as large. Every
  fix is journalled (`<app data>/picture-batches`: each song's old pictures, stored once each, and the folder
  files moved or written) and "Undo the last fix" puts it all back.

## D63: Oversized images grouped; Save & Close in the pictures dialog; back covers with the front (2026-11-05)
- Artwork > "Too large in the songs" is now "Oversized images", grouped by each album's worst picture: Need resizing
  (over 1000 × 1000), Too much data: 500 KB or more, PNG pictures (convert to JPEG), Too much data: 200 to 500 KB.
  Each group has "Fix these N"; the 200 to 500 KB group can be ignored (a remembered tick box). Rows whose cover is
  under 500 pixels also get "Find a better cover". Fixing never makes a picture smaller than it is (only over 1000
  pixels is shrunk), always ends as JPEG, and leaves a JPEG alone when storing it again would not make it smaller.
- The pictures dialog: "Cover database search" (was "Find the front cover online"); at the bottom, always in sight,
  "Undo and Exit" and "Save & Close" (they replace Close and the Save changes / Undo changes buttons; Save & Close
  also keeps lyrics typed for a single song). Approve or Use this fills the squares; nothing is written until
  Save & Close.
- Choosing a release asks the Cover Art Archive once for its picture list and fills the Back cover square too when
  it has one (owner: approve them together, without more searching). The archive has no artist photos.

## D64: One page layout everywhere; damaged tags read leniently; macOS clutter ignored (2026-11-05)
- Every page has the library's layout (owner: "the font and page usage style from the library page extended across
  the other pages", like Zune and Windows Media Player): the library's width (up to 110rem) with narrow margins,
  the same dark panel and darker collage, and one large, light, lowercase title ("welcome back", "rip a cd",
  "review", "settings") instead of a caption plus a title. Review's sections are lowercase links. The library's
  panel stops short of the A–Z bar and long artist names end in "…".
- The pictures dialog's heading is the album (or song) with its artist, year and number of songs below.
- A tag with one damaged frame (a date that is not four digits) hid every tag of the file; tags are now read again
  leniently when the normal read fails. Folders whose files cannot be read are listed in Fix tags with the reason.
- macOS AppleDouble files ("._song.mp3") and `__MACOSX` folders are skipped by every scan.
- Fix tags: a suggestion that differs only by zero-padding or capitals ("Track 1" / "Track 01") is a confirmation
  that keeps the file's spelling.

## D65: Automatic covers in the background; large-picture web search; one look on TV and phone (2026-11-05)
- Artwork > Missing and Low resolution: "Automatic covers" (owner: "run the artwork checking in the background,
  however slowly it needs to, and approve matches for any database hits that are 100%. It should first try to fix
  all the missing artwork albums, then the low resolution albums"). Only 100% matches are taken; a low-resolution
  cover only for a bigger one; the back cover too when the songs have none; one MusicBrainz request per album
  (no previews), a pause between albums; each album looked up once (30 days); journalled with "Undo the automatic
  covers". It runs while the program is open.
- When MusicBrainz refuses three albums in a row it pauses and says so. On 2026-11-05 MusicBrainz was refusing
  requests with this program's User-Agent (with the owner's contact) while answering others: it limits clients that
  ask a lot. The program does not change its identity to get around that; it waits.
- The browser image search asks Google for large pictures (Tools > Size > Large).
- TV and phone apps: lowercase navigation and light titles, like the desktop. The phone's library skips macOS
  AppleDouble files and __MACOSX folders. Settings' section list is lowercase too.

## D66: Lyrics beyond the exact album; TV low-power pass; Wagon Christ's "Track N" titles (2026-11-05)
- Lyrics (owner: the words are the songwriter's, found on other albums or with the original of a cover): the
  LRCLIB lookup now offers the artist's other versions (plain words; time-stamped lyrics only from a version of the
  same length), tries the title without version words ("(Live)", "[Remastered]", "feat."), and finally the same
  title by any artist (original or cover, plain words). Each is labelled; nothing is saved without the person.
  Plan and sources considered: docs/lyrics-plan.md. Scraping sites that forbid it (Genius, AZLyrics, Musixmatch)
  is ruled out.
- TV app low-power pass (owner: older and weaker TVs, a Google TV port, not overheating when left on all day): no
  CSS blur (a 32 x 18 canvas stretched instead), visualizer at most 30 fps, progress bars by transform, times and
  lyrics positions written only when they change. Notes: docs/tv-performance.md.
- Fix tags: a placeholder-looking title its own file name also gives ("01 - Wagon Christ - Track 1.mp3" titled
  "Track 1") is right; file-name titles lose the artist's name in front. Folders not identified or complete are
  checked again once when the checks change (SCAN_VERSION).

## D67: Automatic lyrics; status-flagged ID3 frames edited; one artist however it is spelt (2026-11-05)
- Review > Missing lyrics > Automatic lyrics: LRCLIB's sure answers only (exact match, or the artist's own version of
  the same length), in the background, journalled and undoable; never replaces existing lyrics. See
  docs/lyrics-plan.md.
- ID3 frames with only status flags (Windows Media Player's TLEN "discard if altered"; 315 MP3s in 51 albums of the
  owner's library) are read and edited; only compressed, encrypted or grouped frames are refused. Tags this program
  writes are still checked strictly.
- Artists: the TV, phone and Android Auto list a song under its album artist (on a Various Artists compilation, its
  own artist without "feat." guests); the desktop merges names that differ only in capitals, accents or apostrophes.

## D68: Likely lyrics kept for review, with confidence and a timing editor (2026-11-06)
- Owner: "if it's an exact match, the lyrics can be embedded in the mp3. If it's a possible match, keep the lyrics as
  their own files and give me a way to play them with handles on each line … a button to reject … confirm … embed".
- The automatic lyrics still embed only sure answers. Every other answer with words (another version, another
  artist's recording, a length that could not be compared) is kept in `<data>/lyrics-review/<key>.json`, up to eight
  candidates per song with a confidence score (0–99 from the lookup; 100 only for LRCLIB's exact match).
- Review > Lyrics > To review: a compact list, best first. Review opens the editor under the row: play the song, move
  a line earlier/later (¼ s, Shift 1 s), give it the current time ("now"), shift all lines, or time plain words with
  Tap (or T). Confirm saves into the song: .lrc text when every line has a time, plain words otherwise. Reject moves
  to the next candidate; rejected candidates are not offered again.
- Songs looked up before this change are asked about once more (after the new ones) so their likely matches are kept.
- Later (owner): adjust plain lyrics during normal playback, and automatic syncing.

## D69: TV Now Playing with lyrics redesigned; the OLED still-picture screen saver; building the queue (2026-11-06)
- **Screen saver cause (likely):** Samsung's OLED TVs start their own Screen Saver when "the same still image" stays
  on screen for about 2 minutes, and it "cannot be disabled" (Samsung support: "How Samsung OLED TV displays are
  protected with Logo Detection and Screen Saver"). It is separate from the app-level screen saver that AppCommon
  `setScreenSaver`, the Tizen Power API and the keep-awake clip hold off. Only songs with lyrics were affected because
  the visualizer then gave way to a faint glow, leaving the picture nearly still. Fix: with lyrics, a band of mirrored
  bars (the song's own levels, or a slow wave while there are none) moves along the bottom at all times. The other
  holds stay. To confirm on the bedroom TV.
- **Lyrics layout (owner):** lyrics are the focus, across the whole width; the cover is small (200 px) in a top
  corner, left or right in turn with each new song; title on one line and artist · album · year on a second, beside
  the cover; nothing overlaps. While the next song's lyrics are fetched the layout stays as it was (no flash); a
  change of layout fades in. Songs without lyrics keep the earlier three-column layout (cover, visualizer, details).
- **No swapping mid-song (owner):** the cover and details change sides only with a new song (the 4-minute swap is
  gone); the minute-by-minute drift stays for OLED care.
- **Building the queue (owner):** album, artist, genre and favourites pages have Play next and Add to queue beside
  Play/Shuffle (Play still replaces the queue). OK on a song while music plays asks: play from here (replaces the
  queue), play next, add to the end, or cancel; with nothing playing, OK plays at once as before. Ticked songs keep
  their Play next / Add to queue bar.
- D69 follow-up (owner, same day): with lyrics the glow from the bottom of the screen returns instead of the bars, so
  the lyrics get the whole middle; it is brighter (opacity 0.3 to 1.0, was 0.15 to 0.85) and sways side to side
  about every 40 s, so a quiet song still changes the picture (to watch: if the screen saver comes back, the glow
  is not enough movement). Details reversed: artist · album · year on top, the title under it, nearest the lyrics.
  Ten lyric lines in view (40 px words on 54 px lines, faded only at the very edges).
- D69 second follow-up (owner, same day): the screen saver is resolved (owner). The lyrics box's gradient mask showed
  on the TV as dark bands that surged as synced lyrics jumped: no mask now; a line only partly inside the box fades
  out on its own. Plain (unsynced) lyrics rise like credits: the first line starts at the bottom of the box, the
  last reaches the top as the song ends. Settings > Songs without lyrics: "Visualizer in the middle" (default) or
  "Glow from the bottom" (calmer), kept on the TV.
- Cover colours (owner felt the accents were mostly the app's orange): measured on 300 of the owner's covers, 20%
  fell back to orange and about 45% more chose reds and browns (sepia photos, skin, wood, old paper). Pixels now
  weigh by saturation to the fourth power and muted browns count for a third, so a vivid accent beats a large muted
  area (1876 Pow Wow Punk Rock II: red logo, was tan); covers with almost no colour get silver instead of orange
  (43 of 300, mostly black-and-white photos). Orange remains only when a cover cannot be read. Shared with the phone.
- D69 third follow-up (owner, same day): the screen saver came back about 2 minutes into a song with plain lyrics,
  which then scrolled smoothly a pixel or so at a time; synced lyrics (a line's jump every few seconds) had held it
  off. The TV seems to judge movement frame to frame. Plain lyrics now step up one whole line at a time (700 ms),
  still timed to rise from the bottom of the box to the top over the song. To confirm on the TV.

## D70: The keep-awake clip plays through Samsung's own player, AVPlay (2026-11-06)
- The OLED screen saver still came with plain lyrics after the line-by-line change. Research: Samsung OLED panel
  protection (2 minutes of a still picture) is not affected by AppCommon `setScreenSaver`; it is held off by media
  playing in Samsung's player. Another Tizen app (tessel-tizen-tv, issues #126/#132) had the same problem during
  slideshows, and its tester confirmed a hidden AVPlay clip fixed it. Owner: YouTube shows the screen saver when
  only part of the screen is video.
- Measured on the bedroom TV through the Web Inspector: our HTML `<video>` keep-awake clip said "playing" but stood
  at 0.1 s while music played, so only a moving picture (visualizer) had kept the screen saver away. An AVPlay clip
  (the same 4 s black MP4, from the installed package, `tizen.filesystem.resolve("wgt-package")` + `toURI()`) plays
  and loops alongside the `<audio>` music and across song changes; starting the HTML clip as well froze it.
- Now: AVPlay plays the clip while music plays (under the page, never seen), released after a 3 s pause or when
  the app is hidden; a clip found not moving is restarted every 10 s. The HTML clip is only the fallback where
  AVPlay is missing. Verified on the TV: plays across song changes, released on pause, back on play. Whether it
  holds off the screen saver: owner to confirm.
- D70 confirmed (owner, 2026-11-06): the screen saver stays away with the AVPlay clip. Full notes, history, rules
  and the TV debugging how-to: `docs/tv-screen-saver.md`.

## D71: Building the queue in every app (2026-11-06)
- Owner: from any artist, album or song, choose to play it (replacing the queue) or add it to what is playing.
- TV: done in D69 (buttons on album/artist/genre/favourites pages; OK on a song while music plays offers play from
  here, play next, add to the end). Installed on both TVs (living room at the owner's request).
- Desktop (it had Play next / Add to queue only on the right-click menu of songs and albums on an artist page):
  the artist page now has Play next and Add to queue buttons beside Play all and Shuffle; artists on the library
  wall have a right-click menu (Play all, Shuffle, Play next, Add to queue, Open); Home's album tiles and Most
  played songs have Play / Play next / Add to queue on right-click; Favorites has Add to queue. Now Playing's queue
  can take songs out (an × on hover, or right-click > Remove from queue; not the song playing), saved like any
  other queue change (`PlayQueue.remove`, tested).
- Phone/Android: songs and albums already had More > Play next / Add to queue; artist and genre pages and
  Favorites now have it too.
- Not yet built into the running desktop app (owner streaming from it); the next start picks it up.

- Owner (follow-up, 2026-11-06): on the PC keep the interface clean, icons and small buttons; mouse and keyboard
  users get right-click. So the artist page's Play next / Add to queue buttons and Favorites' Add to queue button
  are gone again; the artist's name and Play all (and Play favorites) offer them on right-click instead. The TV and
  phone keep their buttons (remote and touch).

## D72 - Desktop highlight colour: from the cover in Now Playing, chosen in Settings elsewhere (2026-11-06)

- Owner: the PC's highlights should follow the album cover on the Now Playing page, as on the TV; elsewhere the
  orange stays the default, with a colour picker in Settings to change it.
- `src/accent.ts` sets `--accent` (and a readable `--accent-ink`, near-black or near-white by contrast) on
  `<html>`. While Now Playing is open it is the cover's colour, read from a 32 x 32 copy with the TV's rule
  (`tv/visuals.ts` `paletteFromPixels`, middle shade; black-and-white covers give silver, an unreadable cover the
  chosen colour). Closing Now Playing goes back to the chosen colour. `--accent` is a registered property so
  changes fade (0.9 s). The music glow in Now Playing takes the colour too.
- Settings > Display: "Highlight colour", 16 swatches of bright and neon 70s/80s/90s shades (owner, 2026-11-06,
  instead of a free colour picker): MediaVerse orange (default), tangerine, harvest gold, laser lemon, electric
  lime, neon green, turquoise, cyan, electric blue, ultraviolet, lavender, electric purple, hot magenta, neon pink,
  flamingo, neon red (`ACCENT_CHOICES` in display-prefs.ts; a test keeps each at 4.5:1 or more on the dark
  background). Stored with the other display choices (`mediaverse.display`, `accent`); anything else reads as orange.
- A few fixed tints (the Fix tags chip background, edited-cell orange) stay as they were.

## D73 - The desktop window remembers its size and place; no "Undo the automatic lyrics" (2026-11-06)

- Owner: the window should open where and how big it was, but never off screen or too large to reach the window
  buttons. Windows does not do this for the app; `electron/window-state.js` saves the normal bounds and whether
  it was maximized to `<userData>/window-state.json` (on move, resize and close) and, at start, fits them to the
  screens there are now: kept wholly on the screen holding most of it (inside the work area, above the taskbar),
  shrunk to that screen if bigger (another resolution or scaling), centred on the main screen with the saved size
  if its screen is gone. `fitBounds` is unit tested; checked in the running app (moved window restored after a
  restart; a saved place off every screen and larger than it opened fitted to the screen).
- Owner: remove "Undo the automatic lyrics" (unclear, and one click could undo thousands of songs). The button is
  gone; the batch id and the change journal are still kept, so a run stays recoverable if ever needed.

## D74 - Playlists, a library search for artists, albums and songs, and Play all / Shuffle (2026-11-06)

- Owner: playlists as in Windows Media Player: right-click artists, albums and songs to add them to a playlist or
  make a new one, and a Playlists tab in the library to view and manage them.
- Stored by the sidecar in `<data dir>/playlists.json` (`playlists.rs`, like favorites): `list_playlists`,
  `save_playlist` (a whole playlist: create without `id`, else replace; names unique ignoring case; only library
  files kept, others counted as `dropped`), `delete_playlist`. Kept on this computer; the TV/phone could be
  served them later through the library share.
- Library: "artists | playlists" in the title (Zune style). Playlists: the list down the left (New playlist,
  right-click: Play, Shuffle, Play next, Add to queue, Rename, Delete), the chosen one's songs on the right in play
  order (#, title, length, artist, album); click/Ctrl/Shift select, double-click or Enter plays, drag to
  rearrange, Alt+Up/Down, Delete removes, right-click: Play, Play next, Add to queue, Add to playlist, Remove from
  playlist, Move up/down, Open artist. Songs no longer in the library stay listed, greyed.
- "Add to playlist ›" (New playlist…, then up to 15 most recently changed playlists) on every song, album and
  artist menu (library wall, artist page, search results, Home, Now Playing's queue). Now Playing's queue menu
  also has "Save the queue as a playlist…". The right-click menu gained submenus for this.
- Search (owner: typing "car" should show Yellowcard under artists and also Adam Sandler's "Ode to My Car"):
  artists, then albums, a line, then songs (capitals and accents ignored; first 300 songs). Play all and Shuffle
  beside it play the whole library in wall order, or what the search found.
- Not done yet (for the owner): exporting playlists as .m3u8 files for Navidrome/Jellyfin; dragging songs onto a
  playlist from elsewhere in the library; playlists on the TV and phone.

## D75 - 20 highlight colours on every app; lighter pages; fuller cover colours; navigation order (2026-11-06)

- The highlight colours grew from 16 to 20 (peach, mint, sky blue, bubblegum added) and moved to
  `tv/accent-choices.ts`, shared by the desktop (Settings > Display), the TV (Settings > Highlight colour, kept per
  TV) and the phone (Settings, kept per phone). On the TV and phone the colour is used outside Now Playing and as
  the visualizer's colours when a cover's cannot be read; Now Playing still follows the cover. A test keeps every
  colour at 4.5:1 or more on the dark background.
- Owner: Home, Rip a CD and Settings were too dark (two dark layers: the shade over the collage and each page's
  own panel). Those pages' panels are now see-through, the shade lighter, and text has a soft black glow; boxes
  inside keep a lighter panel. The collage keeps more of each cover's colour (grey-out 35% instead of 100%, the
  drifting tint at 40%).
- Owner: Home sometimes jolted or flashed. Home was emptied and rebuilt after every song, favourite, flag and
  library change; it is now built off screen with its covers ready and swapped in only when something changed.
  The collage's 20-minute new layout fades instead of switching at once.
- Navigation: home, library, review, rip a cd, settings.
- Selection and menu highlights follow the chosen colour (they were fixed orange).

## D76 - "Play on the TV" from the desktop, reusing the TV app's Now Playing (2026-11-06)

- Owner: alongside playlists, look at casting to a TV or speaker; when casting to a TV, reuse the TV app's interface.
- The computer's library share now answers the TV app's remote (`GET /api/remote`, `POST /api/remote/state`, the
  phone's protocol from D58), for paired TVs only. The desktop player bar has a TV button: "Play on <TV>" sends the
  queue, the song and the position to a TV that has the app open on this computer's library and pauses the
  computer. The button is then the TV's remote (pause/play, next, previous, "Bring the music back here",
  "Stop on the TV"). Playing on the computer takes the music back. The TV shows its own Now Playing (wall,
  lyrics, cover colours, AVPlay keep-awake). No new component.
- Unit tested; not yet tried with a real TV (needs the PC app restarted). Settings > Cast says what works now.
- DLNA/UPnP and Google Cast for devices without the app: proposed in `docs/casting-plan.md`, decisions left to
  the owner (order, a Cast library dependency, an optional Cast developer registration, a discovery switch).

## D77 - DLNA casting to TVs and speakers, written in-house (2026-11-06)

- Owner: follow the casting plan (DLNA first, own code), with a Settings switch that allows searching the network.
- Research (`docs/casting-plan.md`): the Node DLNA libraries are dormant (dlnacasts 2016, upnp-mediarenderer-client
  archived 2018, node-ssdp 2020 and it depends on the `ip` package, which has security advisories);
  upnp-client-ts (2023, MIT) was the reference. So `electron/dlna.js` is ours: SSDP search for MediaRenderers
  from each home-network address, description XML (name, AVTransport control address; refused if it points to
  another host), and SOAP SetAVTransportURI (with DIDL-Lite title, artist, album, cover), Play, Pause, Stop,
  Seek, GetTransportInfo, GetPositionInfo. Only home-network addresses are ever contacted.
- The library share serves renderers `/cast/<token>/audio|cover/<id>`: a random token per session (12 h), home
  network only, library songs only, with DLNA streaming headers; it needs "Share my library with TVs" on.
- Desktop: Settings > Cast has "Look for TVs and speakers on my home network (DLNA)", off until turned on. The
  player bar's TV button lists app TVs and DLNA devices; for DLNA the computer sends one song at a time, follows
  the device every 2 s, plays the next when one ends, and the button is its remote (pause/play, next, previous,
  bring back, stop). Playing on the computer takes the music back.
- Tested with a fake renderer (unit tests). A real search on the owner's network found the living room TV
  (QN77S95F) and the WiiM Amp Ultra (read-only status asked; nothing played). Playing on them is for the owner
  to try.

## D78 - Playlists as XSPF and M3U8 files, imported by artist and title (2026-11-06)

- Owner: share playlists between devices and friends, independent of where files are, skipping missing songs.
- Export: XSPF (artist, title, album, length, track number and the file location) or M3U8 (file locations with
  #EXTINF), chosen in the save dialog. Import: XSPF, JSPF (ListenBrainz) and M3U/M3U8. Each entry is found by
  its file when it is in this library, else by artist and title (case, accents, "feat." and bracketed notes
  ignored), preferring the same album, then a length within 10 s. Songs not found are skipped and counted.
  `src/playlist-files.ts`, tested.
- Possible later: MusicBrainz recording IDs in the export (when tags carry them) for exact matches.

## D79 - Licence: GPL-3.0-only, the custom non-commercial licence removed, the name protected (2026-11-06)

- `LICENSE.md` held a custom non-commercial "source-available" licence (based on CC BY-NC), while `LICENSE`,
  the guiding documents, `Cargo.toml` and `package.json` all say GPL-3.0-only. The two could not both hold:
  the CD helper ships libcdio (GPL-3.0-or-later) inside it, and the GPL does not allow added restrictions such
  as "non-commercial".
- Owner: everything needed must ship in the installer on every platform, and copies and forks must stay free;
  the project is free and supported only by donations. GPL-3.0's copyleft does that (anyone sharing a copy or
  fork must share the source under the same terms); it allows the bundled LGPL/MIT/BSD/Apache components and
  the app stores planned (Google Play, Samsung, Microsoft Store). It cannot forbid charging for copies; no open
  licence can.
- Done: `LICENSE.md` removed (`LICENSE` is the unmodified GPL-3.0 text, checked against gnu.org); README says
  what the licence means and that the project is donation-supported; `TRADEMARKS.md` keeps the name, logo and
  domain the author's (changed versions need their own name). Donations (GitHub Sponsors) are unaffected by
  the GPL. This is not legal advice.

## D80 - Google Cast, written in-house; the two approved components not needed (2026-11-06)

- Owner approved `castv2` and `multicast-dns`. On a closer look `castv2` (2019) brings `protobufjs`, a large
  library with its own security history, only to encode one small message type; the whole protocol is TLS to port
  8009, 4-byte-length frames, the seven-field "CastMessage" protocol buffer and JSON commands, and discovery is one
  mDNS question. So `electron/googlecast.js` does both with Node's own TLS and UDP: no new component, and both
  approvals remain unused.
- Same interface as DLNA (discover, load, play, pause, stop, seek, status), so the TV button treats them alike:
  one song at a time through Google's Default Media Receiver (CC1AD845; works on every Cast device, shows cover,
  title and progress), the next when it ends. Stop also closes the player so the TV returns to its home screen.
  A device that speaks both (the Samsung S95Fs, the WiiM amp) is offered once, by Google Cast.
- Search is under the same Settings > Cast switch, now "(Google Cast and DLNA)". Only home-network addresses are
  contacted; the TLS certificate is not checked (Cast devices use Google's device CA, not a public one).
- Tried for real: discovery found the 65" and living room S95Fs, the Den TV (TCL Google TV) and the WiiM Amp
  Ultra; a song from the library played on the Den TV (position counting, pause, stop, back to its home screen).
  The MediaVerse receiver (0E81A85C, the TV app's look) is next; until its page is published Google's player is
  used.

## D81 - Licence: GPL-3.0-or-later; guiding documents brought up to date (2026-11-06)

- Owner: no strong view on "only" or "or later"; fine with allowing later GPL versions as long as nothing needed
  now is restricted. "Or later" keeps GPL-3.0 as the minimum and lets recipients also use any later GPL version;
  every bundled component allows it (libcdio and libcdio-paranoia are themselves GPL-3.0-or-later; LGPL, MIT,
  BSD and Apache-2.0 parts combine with GPL-3.0). Changed: Cargo.toml, package.json, the TV app's config.xml,
  README, CONTRIBUTING, THIRD_PARTY_NOTICES, TRADEMARKS, the third-party guide and the website. Past review notes
  that say "compatible with GPL-3.0-only" stay as written (still true).
- Owner asked for the guiding documents to be updated: Project Brief (licence, donations, platforms built,
  playlists, casting, current order of work), Playback and Casting guide (what is built, and the D80 change: the
  Cast protocol is spoken directly on Windows because Electron has no official sender; Android keeps the official
  SDK), Feature Roadmap (status as of 2026-11-06).

## D82 - Playlists on the TV and the phone (2026-11-06)

- Owner: playlists on the TV and phone now (Cast testing will wait on the HTTPS certificate).
- TV app: a Playlists tab. The library share answers `/api/playlists` (the PC's playlists as track IDs in order,
  songs no longer in the library left out); the TV reads them with the library and again whenever the tab opens,
  and plays them with Play all, Shuffle, Play next, Add to queue and the usual song rows. From a USB drive or
  Jellyfin the tab explains that playlists come from the computer; an older PC answers 404 and the tab says so.
  Read-only on the TV for now (making playlists from the remote can come later).
- Phone app: its own playlists, kept on the phone (WebView storage): a Playlists tab, New playlist, "Add to
  playlist…" in every ⋯ menu, a playlist page with Play, Shuffle, Play next, Add to queue, Rename, Delete, and ⋯ on
  each song to move it up or down or take it out. Each entry keeps title, artist, album and length besides the
  Android ID, so playlists survive Android renumbering the music (found by artist and title, as imported
  playlists are on the PC). `phone/phone-playlists.ts`, tested. Importing XSPF files on the phone needs an Android
  file picker (Kotlin) and waits for the real-phone test.

## D83 - The MediaVerse Cast receiver page published; the PC prefers it (2026-11-06)

- Owner approved publishing the receiver once the website had HTTPS (the certificate was issued the same
  afternoon). `cast/receiver.html` in the website repository, live at https://mediaverse.studio/cast/receiver.html:
  the cover large with a blurred, cover-coloured backdrop and a slowly breathing glow, artist, title, album, a
  progress bar in the cover's colour, and lyrics that follow (synced lines light up; plain ones roll up through
  the song); everything drifts slowly for OLED screens. Google's receiver library (required) plays the music; the
  song, cover and lyrics come from the PC. The website's privacy page says so.
- `electron/googlecast.js` now asks for the MediaVerse receiver (0E81A85C) first and falls back to Google's
  Default Media Receiver per device; the PC sends the song's lyrics with it (customData, at most 400 lines).
  Checked: an unregistered device (the 65" S95F) refuses the launch at once with LAUNCH_ERROR NOT_FOUND, so the
  fallback costs nothing. Not yet seen on the registered Den TV: it went offline before the test.
- Until the receiver is published in the Cast console only registered devices get it; once it is tested on the
  Den TV, publishing it (Cast console) gives every Cast device the MediaVerse look.

## D84 - TV app: a Library tab, search beside it, the queue under Playlists, a back strip, PC-style artists (2026-11-06)

- Owner: the top bar was crowded (the listener's name ran off the screen). Now: now playing, library, search,
  favorites, playlists, settings, then the listener. Library holds artists · albums · genres · songs as large
  lowercase pivots at the top (Zune style), remembering the last one; the Queue tab is gone and "Now playing
  queue" is the first entry on the Playlists page (the queue page itself is unchanged).
- Search sits beside Library (it already had the remote's letter keyboard and artists/albums/songs results); its
  artists now use the same tiles as the artist wall, and a line separates songs, as on the PC.
- Back: a narrow strip down the left of any page with somewhere to go back to (artist, album, genre, playlist,
  queue), mirroring the letter bar on the right, so Back is one press to the left instead of a climb to the top.
- Artists as on the PC: up to three album covers in a small turned stack, newest on top, beside the name, albums,
  songs and genre; covers asked for at 200 px and loaded lazily; 48 tiles per chunk. Measured on the bedroom S95F
  (904 artists): first draw 0.14 s, a letter jump about 0.1 s, script memory unchanged (10 MB); covers fill in over
  a few seconds as the PC sends small copies, as on the album grid.
- Follow-up (owner, same day): the TV shows only the newest album's cover per artist, flat, with no stack or
  tilt (three covers per artist was a waste on the TV). First screen: 48 pictures instead of 81, drawn in 0.10 s.
  Installed on both TVs (bedroom launched for the check; living room installed, not launched).

## D85 - Desktop library: an albums view, pinned headings, clickable breadcrumbs (2026-11-06)

- Owner: the PC is the standard for library handling, but compilations (album artist "Various Artists") could
  not be reached. The library now has artists · albums · playlists: albums lists every album (1,094 in the owner's
  library, 59 compilations among them) by title under letter headings with the letter bar; a click opens the
  album's artist page (compilations: "Various Artists") scrolled to that album; right-click plays or queues it.
- The heading (artists · albums · playlists, count, search, Play all, Shuffle) stays at the top of the window;
  the playlist count is gone from it, and so is "Sort and columns" (it stays on the artist page as Columns, where
  the song table is). On an artist page "library › artists (or albums) › name" stays at the top, both links go
  back, and the song table's column headings sit just under it (the bar's height is measured into
  --lib-bar-height).
- Checked in a copy of the app on a copy of the data (screen capture was unavailable, so by reading the page).

## D86 - Program icons from the logo, emblem + lettering in the top bar, no menu bar (2026-11-07)

- Owner: the logo with its title was too hard to read at the size of the desktop top bar; the artwork should be
  larger with the lettering beside it, and the program still showed Electron's icon. The top bar now shows the record
  artwork (4.4 rem high) with the logo's own "MediaVerse Studio" lettering to its right, both cut from the master
  artwork with black made transparent, in place of a small copy of the whole logo and a plain-text title.
- Program icon: a simplified redraw of the record (copper record, waveform through it, teal band; the artwork's small
  "Lyrics" / "cartoons Line" text left out) in three detail levels for 16-20, 24-40 and 48+ px. One script
  (tools/make-brand-assets.ps1, using the app's own Electron, no new tools) makes the Windows .ico (window, taskbar,
  shortcuts, Settings > Apps), the Samsung TV icon and the Android launcher icons. Sources in brand/.
- The File / Edit / View / Window menu is gone (Menu.setApplicationMenu(null)); page zoom (Ctrl + / - / 0) is kept by
  a key handler; reload and developer tools only when run from source. Text-box copy/paste needs no menu on Windows.
- Open: the renamed electron.exe still embeds Electron's icon (visible only in the install folder); fixing it needs
  rcedit (MIT), a new build tool awaiting the owner's approval.

## D87 - The Electron spike becomes `main` (2026-11-07)

- Owner: the PC and Samsung TV versions are mature enough for friends to beta test; the spike is the baseline from
  now on, and future experiments branch from it.
- `main` was fast-forwarded to the spike branch (the old `main` held only the four starter commits, all already in
  the spike's history, so nothing was lost). The spike's last commit is tagged `spike-final`.
- Pull request #1 (media-enrichment POC) was closed as superseded; #2 (README/.gitignore alignment with the earlier
  Rust/Chromium plan) was already merged (its commits are in main). Their tips are tagged `archive/media-enrichment-poc` and
  `archive/docs-align-with-rust-chromium-approach`, so the work can still be checked out; the owner deleted the old branches on GitHub the same day.

## D88 - Licences folder, Settings > About and a source bundle, so testers can be given the program (2026-11-07)

- Owner approved preparing the release material before friends beta test. Every Windows build now has a `licenses`
  folder beside the program (tools/make-licence-pack.ps1): GPL text for MediaVerse Studio; libcdio and
  libcdio-paranoia COPYING, LAME COPYING/LICENSE, libiconv COPYING.LIB, MinGW-w64 runtime, winpthreads and GCC
  runtime exception texts, all copied from the components' own sources; the 88 Rust libraries compiled into the
  programs with their published licence texts (three that publish none are used under their Apache-2.0 option);
  Vite's MIT text; README.txt with the component list, where the source is, and a three-year written offer
  (contact@mediaverse.studio). The script fails rather than ship an incomplete folder.
- Settings > About: emblem and lettering, version and build commit, the licence statement, "Open the licences folder".
  The contact address is plain text, because the app opens only its https allow-list.
- tools/make-source-bundle.ps1 (run by make-installer.ps1) makes MediaVerse-Studio-Source-<commit>.zip: git archive
  of the commit plus the exact libcdio, libcdio-paranoia, LAME 4.0 (hash matches provenance) and MSYS2 libiconv
  1.19-1 source archives, with checksums. Share it in the same place as the installer: the repository is private, so
  a GitHub link would not reach testers. No source bundle is made for a build with uncommitted changes.

## D89 - rcedit gives the program file and the setup program their icon and name (2026-11-07)

- Owner approved rcedit (Electron's resource editor, MIT, build-time only). tools/package-windows.ps1 now sets the
  icon and the version text (product name, description "MediaVerse Studio", version from package.json) inside the
  renamed electron.exe, so Explorer, Task Manager and pinned taskbar buttons no longer say Electron; make-installer.ps1
  gives MediaVerse-Studio-Setup.exe the icon too. tools/fetch-rcedit.ps1 downloads v2.0.0 and checks its SHA-256
  (recorded in third_party/provenance.toml).

## D90 - Settings > Jellyfin: a helper for setting up a Jellyfin server (2026-11-07)

- Owner: the installer should eventually help people set up Jellyfin; put a Jellyfin helper in the PC program's
  settings. Settings > Jellyfin finds servers on this computer and the home network (Jellyfin's UDP discovery on 7359,
  plus a direct try of http://127.0.0.1:8096 for a local server that does not answer broadcasts), shows each one's
  name, version and whether Quick Connect is on (the TV app signs in with it), and opens a found server's web page
  (home-network addresses only).
- With no server: step-by-step setup. "Download Jellyfin for Windows" opens jellyfin.org/downloads/windows; the person
  runs Jellyfin's own installer. We do not download or run installers ourselves (no verification chain to rely on,
  and Jellyfin's installer handles its own updates). Then: Jellyfin's first-run page, the music folder to add (with a
  Copy button), Search again.
- With a server on this computer: checks Windows Firewall and offers "Let TVs reach Jellyfin", two narrow rules (TCP
  8096, UDP 7359, private networks only) through Windows' administrator prompt, like Settings > TV's rule (commit 5009ae9).
- The search runs only when the tab is opened, not at every start. Checked against the owner's server (found by name,
  version 12.4.0, Quick Connect on, firewall open). The no-server path was not seen live (the owner's server was running).

## D91 - A review for speed: file records kept across restarts, a packed TV list, wider TV search (2026-11-10)

The owner asked for a look over the whole project for optimizations. Everything was measured on the owner's library
(13,476 songs) before anything was changed; only what the measurements showed was touched. No new components.

- **Start-up read every song's tags again** (2.7 s with the disk cache warm, more after a cold start), then sent
  the whole library a second time. Each file's size, date, length, bitrate, disc and creation time are now kept in
  `library.sqlite` (`file_records`), so a start reads only files that changed while the program was closed, and the
  first library reply already has the song lengths. `FILE_READ_VERSION` (crates/host) is raised when the tag reading
  changes. Detail: ADR 0008, step 3b.
- **A folder change reported during a running sync was dropped.** The running sync is now followed by one more.
  Found by reading the code; not reproduced in a test (the window is short), checked live on a throwaway folder.
- **The TV's library list** is made once per library and sent gzip-packed to whoever accepts it (3.3 MB to 0.7 MB);
  covers asked for together share one read and shrink.
- **The TV searches a home network wider than 254 addresses** (the owner's mesh network is 255.255.252.0): its own
  254 addresses first, then the rest, at most four blocks. Relies on Samsung's `getSubnetMask()`; without it the
  search is as before. Not yet tried on a TV.
- **Measured and left alone:** sidecar commands (cover 1 ms, lyrics 3 ms, library 140 ms, ID3 survey 0.66 s), the
  desktop page (start 243 ms, Library 62 ms), the TV's list building and search (5 to 11 ms on the PC). The sidecar
  answers one command at a time; a second lane for covers and lyrics was considered and not built, since nothing
  measured is slow enough to be felt at this size.

## D92 (2026-11-10): compilation-only artists are guests; the phone reads folder pictures; swipe-away stops the music

- **Artists list (owner's choice, option 3 of the 2026-11-06 question).** An artist is listed when they have an
  album of their own. Songs on a Various Artists compilation are filed under their album; their artists are *guests*:
  not on the Artists list (PC, TV, phone, Android Auto) but found by search. An artist's page adds a line and
  "<artist> also appears in:" with the compilations carrying their songs (a compilation-only band opens straight to
  that list). Rule: `web/app/tv/library.ts` (`filedArtist`, `buildGuestArtists`), `web/app/src/library-format.ts`
  (`guestOf`, `alsoAppearsOn`, `guestArtists`), `LocalLibrary.kt` (`filedArtist`). An album with no album-artist tag
  is not a compilation to this rule, so its artists are still listed one by one.
- **Phone cover pictures.** With no embedded cover, the phone looks in the song's folder for cover, folder, front,
  albumart (then any name with cover/front/folder, never "back"). Needs `READ_MEDIA_IMAGES` (asked once after the
  music permission; "Select photos" cannot cover the Music folder). Checked on the owner's Pixel: 16 of 16 albums
  with a `cover.jpg` now show it; 80 of 548 folders have a picture file at all.
- **Swipe-away on the phone stops the music** (owner, 2026-11-10); the place in the queue is kept.
- **Open:** a live visualizer from a Media3 `AudioProcessor` (no recording permission) was proposed, not built.

## D93 (2026-11-11): background colour mask setting; compilations shown whole on the artist page

- **Colour mask (owner's request).** Settings on the PC (Display), TV and phone: "Background colour mask" on/off and,
  below it, its colour: *Drifting* or one of the 20 highlight swatches (`web/app/tv/background-mask.ts`, shared;
  each device keeps its own choice). On washes the cover wall with one colour (the desktop's Zune look), off shows
  the covers in their own colours (the TV's look). Each app starts with the look it already had (PC on; TV and phone
  off). Drifting changes hue slowly on the PC only; on the TV and phone it is a still blend, to keep them light. The
  TV and phone have a wall on Now Playing only, so the mask applies there; the PC's wall is behind every page.
- **"Also appears in:"** now lists each compilation in its entirety (PC and phone; the TV's tile already opens the
  whole album), so the whole album or just the artist's song can be added to a playlist. Play all and the page's
  summary still count only the artist's own songs.
- **Not yet seen on a screen:** the mask on the TV and phone (CSS blend layers), and the PC's settings rows.

## D94 (2026-11-11): casting from the phone (Google Cast and DLNA), phone settings, no cover wall on the phone

- **Casting from the Android app (owner's request: Google and Samsung TVs to start).** The phone's TV button lists, besides
  TVs running the MediaVerse app, every Google Cast device and DLNA renderer found on the home network, and plays the
  queue on one with the same commands (play from here, pause, next, previous, seek). Written here, no component, as
  ports of the computer's `googlecast.js` and `dlna.js`: `CastWire.kt` (the CastMessage protocol buffer, framing),
  `CastClient.kt` (TLS connection and receiver session; the MediaVerse receiver first, Google's Default Media Receiver
  when a device refuses it), `Dlna.kt` (SSDP, description, AVTransport SOAP), `CastHub.kt` (finding devices with
  NsdManager and SSDP, one queue per device, polling, loading the next song), `CastService.kt` (a foreground
  service with a notification while casting, so Android does not freeze the app).
- **Song and cover links** for a cast device carry a random token made when the phone first casts in a run of the app
  (`ShareServer.castUrl`); they open only audio and covers, from the home network only. With sharing switched off the
  phone's server runs only for these links and answers nothing else, not even pairing.
- **Samsung TVs:** the 2025 S95F speaks Google Cast (found on port 8009, plays through Google's player; it does not
  know the MediaVerse receiver, which is registered to test devices only) and DLNA. A device offering both is listed once, as Cast.
- **Cleartext HTTP is allowed in the app** (`network_security_config.xml`): UPnP and the phone's song links are plain
  HTTP on the home network, and the app refuses any other address.
- **Proven on the owner's bedroom Samsung TV (65" OLED):** discovery of 4 Cast devices (both S95Fs, Den TV, the amp),
  play, next, pause, stop, the next-song poll, the foreground service. **Not proven:** the Den TV (it did not accept a
  connection while it was off or asleep), the amp, DLNA playback (found the living room TV and the amp but no
  DLNA-only device to try), the MediaVerse receiver's lyrics page (needs a registered device), the phone's own screens
  for this (tried through a debug-only `adb` hook, not by tapping).
- **Phone settings** now also show the music counts and a "Look for new music" button, the TVs and speakers found,
  and an About line. **The cover wall and the colour-mask setting were removed from the phone** (the wall was not
  visible and not wanted on the phone; D93's mask stays on the PC and TV).
- **Debug builds only:** `adb shell am start -n studio.mediaverse.app/.MainActivity --es cast_test "<device name>"
  [--es cast_action play|pause|toggle|next|previous|stop]` plays the library's first songs on a device. The screen
  must be on.

- **D94 follow-up (2026-11-11, after the owner's first try on the bedroom TV).** Found: after the first song the TV went to its
  black "Cast" screen and the next song never followed. Cause: when a song ends Google's player reports an empty status
  (no media) rather than "finished"; the hub now treats "stopped after playing, with no media or near the end" as ended
  and loads the next song (proved by starting a song 12 seconds from its end: it moved on by itself). The device
  names a TV announces ("65" OLED") cannot be changed from here, so each can be given the owner's own name in Settings >
  TVs and speakers (kept on the phone). Bringing a cast back to the phone now stops it on a Cast or DLNA device
  (closing the player, so the TV returns to what it showed) instead of leaving it paused. Tried by tapping on the phone: the TV
  button and device list, casting from the list, skip, pause, bringing it back (the phone continued where the TV was),
  the Settings page and renaming. The Den TV was off (no answer to a ping from the PC either); the amp and DLNA playback were not
  played (it would have sounded in the living room).

- **D94 follow-up 2 (2026-11-11).** The cast notification has a **Stop** button; the phone's mini bar says "On <name>" while
  casting; shuffle and repeat act on the cast queue (`CastQueue.kt`, unit tested) and their state comes back to the page.
  Found and fixed by trying it on the bedroom TV: (1) Android hid the cast notification because the app never asked for
  **notification permission** (it asks once now, with the images permission); (2) **Stop could be followed by the next
  song** (the watcher read the TV's "stopped" answer to our own stop as the song ending); a stopped session now sends
  nothing more. Tapped through on the phone: casting from the list, shuffle, repeat, the mini bar, the notification Stop.

## D95 (2026-11-14): phone feedback round: cast volume, device chooser, Musicolet-style features

Owner feedback after a trip (rental Google TV with no sound, Bose speaker with no volume control, one-device cast
starting by itself, Android Auto opening on the phone). Research on Musicolet, Poweramp, MediaMonkey and Pulsar is in
`docs/android-feedback-2026-11-14.md`.

- **Cast chooser:** the "Play on" list always shows (also for one device) with a Cancel line.
- **Volume on the TV or speaker:** Google Cast `SET_VOLUME` (also un-mutes) and DLNA RenderingControl
  `SetVolume`/`SetMute`, shown as a slider on Now Playing while casting; the device's level is read back. The phone's
  hardware volume keys do not drive the device yet (needs a Media3 session with remote volume).
- **Bar at the bottom:** previous, play/pause and next first, then title, "artist · album" and "Next: ...". Shuffle,
  repeat and the extras stay on the full Now Playing screen. No skip-10-seconds buttons: the position bar does that.
- **Landscape:** Now Playing puts the cover left and the controls right; slimmer bar and tabs.
- **From Musicolet and the others:** sleep timer (minutes with a 20 s fade, or "when this song ends"; runs in the app
  process), play counts (a song counts at half its length or 30 s) with Most played / Recently played / Recently
  added / Not played yet lists, queue saved as a playlist, an equalizer per output (speaker, wired, USB, each
  Bluetooth device by name; Android's own effect, no new component).
- **Android Auto:** nothing changed for "open full screen from the split view" yet. The session has a phone
  `sessionActivity`; Android Auto's legacy browser uses one for all controllers, so it cannot be set per controller.
  To be tested with the Desktop Head Unit (needs "Start head unit server" on the phone) or in the car.
- **Not done (ideas kept):** several named resumable queues, A-B repeat, bookmarks, synced-lyrics editing, PC library
  sync (ratings, play counts), crossfade, Android Auto action buttons for favourite.

### D95 addendum (2026-11-14, evening): checked on the Android Auto Desktop Head Unit and the bedroom TV

- **Android Auto opens full screen.** On the Desktop Head Unit the app comes up as a full media app (Artists, Albums,
  Genres, Songs, covers) and tapping the small Now Playing card opens the full-screen player. So the design needs no
  change; what happened in the car was most likely the sideloaded-app rule (before Unknown sources was on, Android Auto
  did not treat the app as a car app and sent the tap to the phone).
- **Shuffle, repeat and a new favourite heart** show on the full-screen player only (the split-view card keeps
  previous / play / next). They had been missing because the buttons were given secondary slots; with the default slots
  Media3 passes them to Android Auto as custom actions. The album now shows beside the artist ("Artist · Album").
- **Phone volume keys control the cast device.** Android only routes the keys to a remote session while the app really
  plays sound, so the cast service holds a remote volume session (with an empty callback, which the platform needs) and
  plays silence. Tested on the bedroom TV: the key moved it 5% to 10% (the TV reports controlType "master").
  The TV's own stream volume is always 1, so the device volume is read from the receiver status instead.
- **A-B repeat, bookmarks (a place and a note per song), saved named queues that resume from their place.**
- **Still not built:** synced-lyrics editing (the phone has no lyrics yet at all, so this waits for lyrics on the
  phone), PC library sync (ratings, play counts, playlists), crossfade (Media3 has no built-in crossfade; the app plays
  gapless).

## D96 (2026-11-14): flagged tracks shared across devices; several library sources; lyrics on the phone

Owner ideas, recorded before building. **Flags as a playlist:** every app keeps flagged tracks as a playlist named "Problem tracks" so a track flagged on the phone, the TV or in the car can be reviewed later at the computer, without the PC app running. With a Jellyfin library the playlist lives on the Jellyfin server (written through its playlist interface, as the signed-in user); otherwise each device keeps its own list and merges it with the computer's when they meet. **Accepted trade-off (owner):** a playlist holds only songs, so the reason, note and place in the song are lost for flags made away from the computer; the computer's own `flags.json` still keeps them for flags made there (D25). Matching between devices is by artist, album and title (as playlist import does), never by file path, and songs a device does not have are skipped. **Sources:** the phone and the TV get a list of sources (This phone or USB drive, plus Jellyfin servers, later the PC app) with a default the owner chooses (a USB drive read slower than the network). When a source is reachable the device syncs flags with it; when a flagged song has been fixed in the library, the device offers a one-tap "Update n tracks" to download the new version (saved beside the old one first; it never overwrites silently). Build order: phone sources and a Jellyfin client, flag buttons and the Jellyfin "Problem tracks" sync, the desktop Review page reading it, re-sync of fixed songs, then the PC app as a source. Jellyfin's playlist calls were checked against the owner's test server (see the result below).

**Lyrics on the phone (built):** the app reads lyrics from the song's own tags (`Lyrics.kt`): MP3 ID3v2 SYLT (synced) and USLT (plain), FLAC Vorbis comments (SYNCEDLYRICS, LYRICS, UNSYNCEDLYRICS), M4A ©lyr; plain text written as "[mm:ss.xx] words" counts as synced. Tried on 60 songs from the owner's phone: 42 synced, 11 plain, 7 none, no read errors. Now Playing has a Lyrics button (remembered) that shows the lyrics in place of the cover: synced lines scroll with the song and the current one is lit, tapping a line seeks there, plain lyrics scroll by hand. The phone's TV share endpoint now serves the same lyrics to the TV app. Not yet: .lrc files next to songs (Android's music permission does not let the app read them; needs a folder grant), lyrics from Jellyfin on the phone, and editing.

**D96 result: Jellyfin playlist calls checked (2026-11-14, Jellyfin 12.4 on the owner's PC, signed in by Quick Connect as the test user).** Create (`POST /Playlists` with Name, Ids, UserId, MediaType Audio), list (`GET /Playlists/{id}/Items?userId=`, each entry has its own `PlaylistItemId`), add (`POST /Playlists/{id}/Items?ids=&userId=`, 204), remove (`DELETE /Playlists/{id}/Items?entryIds=` with `PlaylistItemId`, not the song ID, 204) and delete (`DELETE /Items/{id}`, 204) all work for an ordinary signed-in user; `GET /Playlists/{id}` returns `OpenAccess`, `Shares`, `ItemIds`, and `/Playlists/{id}/Users` answers, so sharing with other users exists on this version. A throwaway playlist was used and removed; the owner's playlists were not touched. Lyrics on the phone were checked on the owner's Pixel: plain lyrics scroll, synced lyrics light the current line (instrumental gaps show a note symbol).

**D96 progress (2026-11-14, evening): phone flags and Jellyfin sync built.** *Sync method (owner agreed):* each device uploads only its new flags as its own playlist named `Problem Playlist YYYY-MM-DD HH:mm (device)` (year first so Jellyfin's lists sort by time; owner's example was month first). Own playlists never clash when the phone and the TV sync at once. The computer (not built yet) folds those inboxes into the master playlist "Problem tracks" and removes them; "Done" on the computer removes a song from the master. A device drops a flag only when it was uploaded and is in neither the master list nor any inbox (so a flag still waiting for the computer is never lost), and it adopts songs the master names that it also has. A song the server has no match for stays on the phone and is retried (not uploaded, never cleared). Songs are matched by artist and title, then album, then length. Unflagging on the phone a song the server still lists is remembered ("dismissed") so it does not come straight back. **Built on the phone:** a flag button beside the heart on Now Playing, Settings > Problem tracks (count, list, tap to remove) and > Jellyfin server (address, Quick Connect, Sync now, Sign out), automatic sync a few seconds after flagging, when the app comes to the front, and when the network returns. Requests to the home network go through a small relay in the app (`HomeHttp.kt`, private addresses only, because the page is https and may not fetch plain http itself). Tried on the owner's Pixel and test Jellyfin: found the server, signed in with Quick Connect, flagged a song, sync ran ("not on the server" path, as that song is not in the test library). **Not built yet:** playing music from the server on the phone, the TV's flag sync, the computer's Review page reading the playlists and clearing flags, re-sync of fixed songs, the PC app as a source.

**D96 progress: the computer's side built (2026-11-14, night).** Settings > Jellyfin > "Shared problem tracks" on the desktop signs in to the Jellyfin server with Quick Connect (the address is offered from the server search), then syncs at start, every five minutes, and a few seconds after any flag change (`problem-sync.ts` logic, `problem-sync-ui.ts` screen). Each round: (1) reads the master playlist "Problem tracks" and every "Problem Playlist …" inbox; (2) adds the inbox songs, and flags made on this computer (found on the server by artist, title, album), to the master list, creating it if missing; (3) removes from the master list songs marked **Done** on the Review page (the flag store reports removals; they are kept as due until a round succeeds, so Done works offline); (4) deletes the merged inbox playlists (playlists only, never songs; nothing is deleted before the merge was written); (5) flags on the Review page the master-list songs this computer's library has (reason "other", note "Flagged on a phone or TV (shared problem list)"; no position). Songs on the list the library lacks, and flags here the server has no song for, are counted in the message. Both ends match by artist and title (then album). Playlists named otherwise are never touched. Limits: a flag stays on the Review page only for files in this computer's library; Done on the computer clears phones and TVs at their next sync; the TV does not flag yet.

## D97 (2026-11-15): Jellyfin review; Review > Artists (artist names, artist photos); photo on the artist's stack

Owner's brief: Jellyfin already covers much of what MediaVerse set out to do; use its powers where it is present, stay a
complete stand-alone program, share one library. The full comparison, what is Jellyfin's to own and what is ours, and the
ordered next steps are in `docs/jellyfin-review.md`. Principle adopted: **stand-alone first, Jellyfin-enhanced**: every
feature works from the files alone; a signed-in Jellyfin server is one more source, never a requirement.

- **Finding that started it:** Jellyfin keeps artist photos, biographies and IDs in its own metadata folder
  (`metadata\artists\<name>\folder.jpg`, `artist.nfo`), never in the music folders or the songs; so the owner saw them only in Jellyfin.
- **Owner's choices (asked for in the brief):** artist photos go into the MP3s as the Artist picture (ID3 type 8) and are the image
  on top of the artist's stack on the wall; a tool for an artist spelt two ways ("AFI" / "A.F.I.") only if it is useful in general.
- **Artist names (built):** Review > Artists finds names that differ only in punctuation, spacing, capitals, accents, "&"/"and" or a
  leading "The", suggests the commonest then plainest spelling, and rewrites the Artist and Album artist tags that are exactly one of
  the other spellings (`rename_artist`; journalled, each file checked before it replaces the old; `undo_artist_rename` skips
  tags changed again since). General rather than one-off because the mistake is common and nothing else sees it.
- **Artist photos (built):** `track_artist_photo` reads the Artist picture (or `artist.jpg` in the song's or artist's folder); the wall
  lays it on top of the album stack. Review > Artists > Artist photos uses the Quick Connect session from Settings > Jellyfin:
  `GET /Artists/AlbumArtists` for names and picture tags, `GET /Items/{id}/Images/Primary` for the picture (home-http gained a
  binary mode), matched loosely to the wall's artists, written with `update_track_media` under one batch (Undo through
  `undo_picture_batch`). Artists whose songs already carry a photo are skipped unless "Replace" is ticked.
- **Checked:** unit tests (name grouping, matching, binary relay, sidecar rename and undo, photo reading); the real program on a
  throwaway library (photo embedded, read back, on the right tile only; rename and undo on real tags; screenshots). **Not checked live:**
  the two Jellyfin calls (needs the owner to approve a Quick Connect code); both endpoints answer 401 on Jellyfin 12.4.
- **No new components** (Jellyfin is already an approved source; no new service is contacted). **Needs the owner's approval before any
  code:** a stand-alone photo source (Wikimedia via MusicBrainz/Wikidata, TheAudioDB, Fanart.tv) and writing MusicBrainz IDs into tags.
- **Found, not mine:** `drives_rip::an_archive_that_ends_up_inside_the_library_is_not_written_to` fails on this PC (it imports the whole
  `%TEMP%` folder as a library, so it depends on what is in Temp); it failed before this change too.


## D98 (2026-11-15): Android Auto queue choices; more reliable phone covers

First drive in the Defender (13-inch screen): Auto works better. Two findings: (1) no way to add to or replace the queue from the
browse lists; (2) many albums showed a grey square on Now Playing although the files carry covers.
- Inside every artist, album and genre list the car now offers **Play all**, **Shuffle all** and **Add all to queue** (media ids
  `act:<play|shuffle|add>:<list>:<key>`). "Add" appends and hands the unchanged queue back so the song keeps playing.
- Covers: `ArtProvider.cover` used only Android's thumbnail call plus the album folder picture, and remembered "no cover" forever.
  Now: thumbnail, then the picture read straight from the tag (`MediaMetadataRetriever`), then the folder picture, then another song
  of the same album that has one (so an orphan track shares its album's cover); "no cover" is trusted for an hour only.
  Cause not proven (not reproduced off the phone); the old permanent "no cover" cache is the likeliest. To test: install, open the car view.


## D99 (2026-11-15): MusicBrainz IDs in the tags, written in bulk where the match is exact

Owner's rules: batch-apply IDs to albums with exact matches; albums with a different track count, missing tracks or different
song names are set aside for review; editions (country, year, remaster) are common; the review must never be thousands of rows.
- New tags (`TagField::MusicBrainzReleaseId`, `MusicBrainzReleaseGroupId`): ID3 TXXX "MusicBrainz Album Id" and "MusicBrainz Release
  Group Id" (as Picard/Navidrome/Jellyfin read them). Written through the same checked copy-and-compare as every tag write.
- `crates/tag-repair/src/judge.rs`: an album is **exact** when every song pairs with a track (same count, none missing or extra),
  every title and length agrees (per-song fit >= 88), confidence >= 80 and no warning. Verdicts: **Ready** (one exact edition, or the
  one whose year the files carry: release ID + release group ID), **AlbumOnly** (several editions fit alike: the album's group ID is
  certain, the edition is not, so only the group ID is written), **Review** (reason in words: tracks missing, extra songs, song names
  differ, lengths differ, two different albums fit, no release, fewer than 3 songs).
- `apps/sidecar/src/mb_ids.rs`: scan job (toc search, then name search; ~1 request/second; results in `<data>/mb-ids/results.json`,
  resumable, nothing asked twice), apply (fills gaps only; a chosen release replaces; journal in `<data>/mb-ids/batches/<batch>`),
  undo (restores unless changed since), dismiss. Commands `scan_mb_ids`, `list_mb_ids`, `apply_mb_ids`, `undo_mb_ids`, `dismiss_mb_ids`.
- Review > **Album IDs**: counts, "Check the library", "Write IDs into N albums" (confirm, Undo), and a short paged list of the albums set
  aside, each with a choice of the closest releases ("Use this release") or "Leave alone".
- Checked in the real app on a throwaway library with live MusicBrainz queries (albums with made-up lengths correctly set aside).
  Not yet seen on the real library: how many of the ~1000 albums come out Ready / AlbumOnly / Review.
- Next (same decision): orphan songs brought into line with their album using the ID (genre, year, cover, track names) in Fix tags;
  artist IDs; the free artist-photo sources (Wikimedia via MusicBrainz, then TheAudioDB/Fanart.tv); a MusicBrainz connection in Settings.

D99 amendment (same day, after the first real-library check, 110 albums): (1) a few songs with other lengths no longer block an exact
match when every title agrees and most lengths do; one odd title out of six or more is tolerated; "Track numbers repeat" and "Album
name differs" warnings are ignored; a clearly better of two albums wins; (2) set-aside reasons now name the warnings; (3) folders
with fewer than 3 songs are counted ("single-song folders left out") and not listed; (4) each answer keeps the closest releases and
their evidence (`proposals`) and a `rules` number, so changing the rules judges everything again offline (`rejudge`) instead of asking
MusicBrainz again (an hour for ~1000 albums). Real-library first look (150 albums): about 1/3 ready, 1/3 album-only, 1/4 set aside.
Also fixed: the CI failure (`an_archive_that_ends_up_inside_the_library_is_not_written_to` imported the shared temp folder).


## D100 (2026-11-15): Review > Match-up (songs that disagree with their own album)

Owner's wish: orphan songs corrected and brought back in line with their album (genre, artwork and so on), through Review.
Fix tags already fills a song's *empty* album-wide tags from its album; this covers songs whose values *differ*, or that lack the cover.
- `album_align.rs`: scan (job; folders of 3+ songs; a value said by >= 60% and >= 2 songs is the album's, the rest are orphans) for Album,
  Album artist, Genre, Year, and "no embedded cover while most songs have one". Compilations (Various Artists) keep each song's genre/year.
  Nothing is written by the scan. `align_album` writes only those four fields (checked copy-and-compare, journalled);
  `undo_album_align` restores unless changed again. The cover is copied with the existing `update_track_media` (+ `undo_picture_batch`).
- Panel `album-align-panel.ts`: one card per album (worst 300), one button "Make N songs match", Leave alone, Undo.
- Checked in the real app on a throwaway library (genre and cover fixed, undone). Not yet run on the real library.
- Not covered (deliberately): moving a song into another folder, renaming files, matching track titles to MusicBrainz (Fix tags does titles).


D100 amendment: **free artist photos from Wikimedia Commons** (Review > Artists > "Free photos (Wikimedia)"), no server needed.
`artist_photos_wiki.rs`: MusicBrainz artist (by name, exact loose match, score >= 90) -> its url-rels (an "image" link, else the Wikidata entry) ->
Wikidata P18 -> Commons `Special:FilePath/<file>?width=1000` (700, 500 if over 450 KB). About one MusicBrainz question per artist-step per second;
answers (photo or none) are cached in `<data>/artist-photos/results.json`; photos in the same folder, with the Commons file name and page kept as
credits. Writing embeds the cached photo as the Artist picture (same journal + Undo as other pictures). Live-checked for AFI and Blink-182.
**Licence note (owner to decide):** Commons photos are free but mostly CC BY / CC BY-SA, which ask for the author's credit; the credits are kept
beside the cache, not inside the MP3s. Wikidata's P18 images are the community's chosen photo for the artist. TheAudioDB and Fanart.tv (to fill
the gaps) are not built yet and need the owner's go-ahead on their terms and keys. A startup bug (the block read the song list before it existed)
was found by running the real app, not by tsc: always run the real app for UI wiring.


## D101 (2026-11-15): feedback round

- **Artist names use MusicBrainz's spelling.** New job `check_artist_names` asks MusicBrainz for each exact spelling in the library (artist search,
  exact loose match, score >= 90) and remembers the answer in `<data>/artist-names/canonical.json`. The suggestion is now the official spelling
  (even when no song uses it), not the commoner one; single names that are not spelt officially are listed too. Names are kept exactly as tagged, so
  "AFI" and "AFI " (stray space, no-break space, curly apostrophe) are separate spellings, shown with a visible marker and a note, and the rename tool
  compares ignoring spaces at the ends. (Note: "P!nk" and "Pink" are not a punctuation-only difference; the "!" stands in for a letter.)
- **Album IDs show how and why**: each album records how it was matched ("disc layout": the song lengths found it in MusicBrainz's disc ID data; or "names")
  and shows the evidence like Fix tags (titles agree k of n, lengths match k of n, warnings), with Set aside / Ready / Album only / Written lists.
  Albums checked before this change show "not recorded"; checking again from scratch records it.
- **Lyrics finder** now says "Your song: Artist — Title (Album, 4:12)" and, per candidate, how much longer or shorter it is than the song.
- **Photo credits** (owner): kept in the program's data folder (`artist-photos/results.json`: Commons file and page), not written into the MP3s. The library is
  for personal use across the owner's devices, not for sharing or resale.
- The error windows ("EPIPE: broken pipe") came from my throwaway test scripts printing into a closed pipe, not from the program.


## D102 (2026-11-15): damaged discs are read again, described plainly and flagged; rip genres

Owner: the disc with smudges and fine scratches must have its errors detected, fixed where possible, flagged where not, and the user clearly told.
- **Bounded, honest reading** (`cd-helper`): the secure reader uses `cdio_paranoia_read_limited` (default 20 re-reads per block), so a bad block can
  no longer hold a rip for ~15 minutes or abort it: a block that cannot be read is counted as skipped, filled with silence, and its sector is noted
  (`first_problem_lsn`/`last_problem_lsn`; the track report gives `problem_span_ms`). A drive that stops answering (25 failures in a row) still stops the rip.
- **Re-reads** (`rip_job.rs`, `disc_health.rs`): a track that did not match AccurateRip, had skipped blocks or cache doubts is read again, up to three reads
  in all (40, then 80 re-reads per block), the better read replaces the WAV (matching AccurateRip first, then fewer skipped blocks), stopping as soon as it matches;
  at most 12 tracks and 25 minutes of extra reading per disc; Cancel works throughout.
- **`disc_health`** in the rip result: state good / suspect / damaged, a headline, per-track state (recovered, unconfirmed, suspect, damaged) with plain reasons
  ("12 blocks of audio could not be read between 1:12 and 1:15 even after 3 reads"), and what to do (clean the disc from the centre outward, try another drive,
  replace the track from another copy). A damaged disc is the first warning ("DISC PROBLEM: ...").
- **Rip page**: a red/amber box above the results, a "Disc read" column per track, and "Re-reading track 5 (read 2 of 3)" while it works.
- **Flags**: the MP3 of each track still damaged or suspect is added to Review > Flagged tracks (reason: audio) with the note and the place in the song.
- **Rip tags**: the MusicBrainz disc lookup now asks for genres, so the ripped MP3s get the album's most-voted genre (Title Case). Verified on a real disc:
  27 of 27 tracks matched AccurateRip (confidence 11), secure read, no repairs; year and cover embedded; the MusicBrainz lookup is the primary tag source and
  gnudb (CDDB) the secondary (it answered "no entry" for this disc; its logic is covered by tests with mock servers).
- The first rip test also showed: with MusicBrainz rate-limiting (503), a lookup returns no candidates and a rip started without choosing tags writes
  "Unknown Artist / Unknown Album" MP3s into the library. Follow-up: the Rip page should refuse to start without tags the person has accepted or typed.


## D103 (2026-11-15): the Rip page shows every track at once, and each release with its cover and edition details

Owner: the lookup should show all the disc's tracks without scrolling, and bring up the album art and release information at the same time, so the right
edition is chosen before the rip and the tags are right from the start.
- **Tracks:** the track list no longer sits in a scrolling box; it flows into as many columns as fit (a 27-track disc shows all 27 at once).
- **Editions:** the lookup used to merge every MusicBrainz release of an album into one entry (so a random edition's year and cover won). Now each MusicBrainz
  release is its own candidate with its date, country, label, catalogue number, barcode, format and status (`AlbumInfo.release`; the disc ID lookup also asks for
  `labels`); a CDDB entry joins the first candidate that describes the same album. When several releases of one album match, the first is ticked so a rip can start,
  and the page asks the person to check it against the case.
- **Covers:** each candidate shows its front cover (small, from the Cover Art Archive through the new `cover_preview` command, fetched once per release).
- Each card says whether this exact disc is listed (disc ID match) or only the same album by name and track count.
- Checked by injecting the same markup into the real page (no disc was readable at the time); the logic is covered by unit tests.


## D104 (2026-11-15): honest disc health, a defect scan that stops crying wolf, and a drive history

Owner: a new CD "did not rip properly" (every track "Damaged") although the MP3s sounded right, and the audio defects page listed the same stuck sound a dozen times per song.
- **Cause, defect scan:** "stuck" findings were runs of 64+ identical frames (1.5 ms), which a decoder produces in quiet starts, fade-outs and near-silence; 18,244 of them (plus 98,212 clipping marks) put 4,597 of 13,432 songs on the list. A stall now needs a held value of 6 ms or more with loud music on both sides; clipping is counted but never decides the verdict, and clipping in both channels is one finding. `ENGINE_VERSION` 2: results stored by the old scanner are marked stale (`PRAGMA user_version`) and scanned again. The list also merges findings of one kind within 1.5 s into one line ("3 times close together").
- **Cause, "Damaged" disc:** a track that merely failed the AccurateRip comparison was called damaged. The Skints disc read with zero unreadable blocks and identical repeat reads; AccurateRip's one entry (seen 8 times) matches the audio only when shifted 6 samples, i.e. another pressing. Now: a clean no-match is read once more and, when the reads agree sample for sample, stops there (`read_agreement`); `pressing_shift` searches +/-5,880 samples (neighbour tracks give the margin, silence pads the disc's first and last edge inside AccurateRip's skipped region) for a match. States: `shifted` (audio proven, other pressing), `unmatched` (consistent clean read, unconfirmed), `damaged` only for unreadable blocks, reads that disagree or a doubted cache. Those states do not flag the MP3s.
- **Drive history:** `drive-history.json` (last 300 events) records per rip: tracks matched / shifted / differing / unconfirmed, unreadable blocks, cache doubts, re-read tracks, and rips lost to `no_disc`/`read_failed` after the disc was known. Drive setup shows the totals and plain notes (repeated failures, a drop in confirmed tracks, more read problems lately), with "Clear drive history". It states what was counted and does not diagnose.
- Not decided: the exact-6-sample shift equals this drive's offset; the other verified discs matched at the +6, so it is treated as a pressing difference, but it is a coincidence worth watching. (Settled 2026-11-16: the next new disc matched AccurateRip directly at +6.)


## D105 (2026-11-16): more ways to find an album, a disc change refreshes the page, and the rip safety check

Owner: a new disc (Random Hand, self-titled, 2023) gave "no match found" though MusicBrainz has the album; the album choices and track list should refresh when a disc is put in; combine with the rip safety check.
- **Why no match:** MusicBrainz has the release (10 tracks, 2023-09-29) but no disc ID on it, so the exact lookup finds nothing, and the "similar table of contents" search only compares against releases that have at least one disc ID. gnudb had no entry either.
- **Lookup steps now:** exact disc ID, then the similar-TOC search (before, only Fix tags used it); and if the fuzzy question is refused (rate limit) the page now says so instead of "no match".
- **Search by name** (new `search_albums` job, a box on the Rip page): MusicBrainz release search by typed artist and album, keeping releases with a medium of exactly this disc's track count (best score, official first, at most six, each fetched in full); plus Discogs when the person has switched it on with their own token (same rules as Fix tags; the card says "Data provided by Discogs (discogs.com)"). Results are "same album, this disc is not listed" and are never picked automatically.
- **Disc change:** `disc_probe` (table of contents only) is asked every 5 s while the Rip page is showing and nothing is using the drive; a different disc clears the choices and starts the lookup by itself; "No disc in the drive" / "not an audio CD" are shown.
- **Rip safety:** (1) a match that is not this exact disc must be confirmed with a tick ("These details match my disc") before the Rip button works; (2) the sidecar refuses `rip_disc` with `tags_required` when files would be tagged (FLAC archive or MP3) and no chosen album or typed album + artist came with it, so "Unknown Artist" files cannot happen from a script or a stale page. Nothing is read from the disc in that case.
- MusicBrainz answered 503 to every request for hours on 2026-11-16. The reply carried `X-RateLimit-Zone: global` and "The MusicBrainz web server is currently busy": MusicBrainz's own overload, not a limit on this program (corrected the same night in D107; the app's messages now say "busy or limiting requests right now").
- Not built: other free sources (CD-Text on the disc itself; AcoustID fingerprinting after the rip) need more work and a decision.


## D106 (2026-11-16): iTunes and Deezer join the name search

Owner: "I'm ok with automated searches of additional sources like Amazon, Bandcamp, iTunes, and Deezer."
- **Built:** iTunes (Apple Search API: `search` then `lookup?entity=song`, paced 3 s) and Deezer (`search/album` then `album/{id}`, paced 1.1 s), both public and keyless, run with every search by name, beside MusicBrainz and (with the person's token) Discogs. Only single-disc albums with exactly the disc's track count are offered; they are digital editions ("Digital release"), inexact, never picked automatically, and need the "These details match my disc" tick. Each card says where it came from. A failing source reports its own error and does not stop the others. No search terms leave the computer except the typed artist and album, and only when the person presses Search. No cover is taken from these (covers can be added afterwards with Review > Artwork).
- **Not built, on purpose:** Amazon (its product API is only for approved affiliate accounts) and Bandcamp (no public API; reading its pages would be scraping against its terms). Both stay out unless a legitimate access route appears.
- (D107, the same night, follows this entry.)
- Checked live: *Timeless & Dimeless* by WitchDoktors is not on MusicBrainz, iTunes or Deezer; Discogs (with the owner's token) had it with 14 titles, UK 2019, Tribal Vibes, TVCD102.


## D107 (2026-11-16, night): CUETools Database, sharing a disc, and more artist photo sources

Owner: plan "add this disc to MusicBrainz" and gnudb; explore the CUETools Database; see the artist photos integrated; commits allowed, check CI afterwards.
- **CUETools Database (CTDB)** is now a lookup source (`crates/disc-metadata/src/ctdb.rs`): one keyless request to `db.cuetools.net/lookup2.php?version=3&ctdb=1&fuzzy=1&metadata=extensive&toc=...` (plain http; the TOC is our sector numbers joined by colons, lead-out last) returns the album from MusicBrainz, Discogs and freedb for this layout *and similar ones*. Its data is public domain (cue.tools/wiki/CTDB), the service is run by volunteers and is sometimes down, so a failure is silent. Answers are inexact (confirm tick) and de-duplicated against what MusicBrainz already gave; only used when MusicBrainz is the real musicbrainz.org (tests and own servers skip it). Checked live: it answers a real disc with metadata (the Ettella Diamant fixture), 404 for the WitchDoktors disc. **Not built, worth doing:** CTDB also holds rip checksums (`trackcrcs`, `confidence`), a second check of a rip beside AccurateRip.
- **Share this disc (Rip page, "Share this disc so the next lookup finds it"):** shown when the disc's layout is known and not already listed exactly. (1) *Attach this disc to a MusicBrainz release*: opens `musicbrainz.org/cdtoc/attach?toc=1+N+leadout+offsets` (offsets = sector + 150); it needs a free MusicBrainz login (checked: it redirects to the login). (2) *Add this album to MusicBrainz*: a local page built in Electron's main process (`musicbrainz-seed.js`, fields validated and escaped, posts only to musicbrainz.org) fills MusicBrainz's Add Release form (title, artist, date, country, label, catalogue number, barcode, tracks with lengths from the disc's table of contents); the person logs in, checks and presses Enter edit themselves. (3) *Send to gnudb*: `submit_gnudb` builds a gnudb entry (revision 0, UTF-8, DISCID, DTITLE, DYEAR, DGENRE, TTITLE, EXTD, PLAYORDER) and POSTs it to `.../~cddb/submit.cgi` with Category, Discid, User-Email, Submit-Mode: submit, Charset: UTF-8. gnudb's rules are kept: the person's own email (typed, remembered only in their browser storage), no placeholder titles, a confirmation that states what is sent and that it cannot be taken back, nothing sent otherwise. **Not tested against the live gnudb** (it has no test mode); tested against a local fake server. The gnudb registration email (docs/gnudb-registration.md) is still unsent; gnudb accepts unregistered programs with a real address but warns about generic names.
- **Artist photos, more sources:** after Wikimedia, artists with no photo are tried on TheAudioDB (`artist-mb.php?i=<mbid>`, `strArtistThumb`) and Fanart.tv (`/v3/music/<mbid>?api_key=`, best-liked `artistthumb`), each only when the person has typed their own key under Settings > Artist photos: more sources. The photo's source and page are kept in the program's data folder (never in the songs); a "no photo" answer given before a key existed is asked again once one is set. **Untested against the real services** (no keys here).
- MusicBrainz's 503s on 2026-11-16 were its own overload (`X-RateLimit-Zone: global`, "currently busy"), not a limit on this program; the app's messages now say "busy or limiting requests right now".


## D108 (2026-11-16): one outbound-request scheduler, stage 1 (the gate)

Owner: asked for all outside-service requests to go through a scheduler (rate limits, priority for what the person is waiting on, retries, alternate sources); approved a staged plan; dropped the idea of a local memory of ripped discs (each disc is ripped once).
- **Found:** every outside call already went through one per-source limiter (`MetadataState::wait_turn`, minimum gap, `Retry-After`, back-off up to a minute), but it checked the clock under a lock, slept, and recorded afterwards, so two threads asking at once (a library scan plus a lookup) both fired together and could pass MusicBrainz's roughly one request per second per address.
- **Stage 1 (built):** `RateLimiter::take` checks and records in one step; `wait_turn` loops (sleeps at most 250 ms, then asks again), so each source has a single stream of requests whatever the number of threads, and a refusal recorded while a caller sleeps holds that caller back. Tests: the limiter's `take`, and three-thread tests for spacing, independent sources, and refusal while waiting.
- **Stages to come (owner agreed to the order):** (2) priorities: interactive / on-screen / bulk, the next free slot always going to the most urgent waiter, bulk work pausing while the person is on the Rip page; (3) time-boxed retries: an interactive lookup waits about ten seconds, then says "busy, still trying" and fills in later; bulk jobs retry quietly and survive a restart; (4) one visible status line per source. Alternate sources stay an ordered list per task, not the scheduler's business. Possible later: a few hours' cache of web replies (not a database of ripped discs). Then candidate scoring by track lengths (as beets does) and AcoustID after the rip.


## D109 (2026-11-16): ideas taken from beets, OneTagger and Jellyfin for the review pages

Owner asked what the other programs do better and approved items 1 to 4; item 5 is a low-priority idea; item 6 was refused.
- **Left alone (Fix tags):** "Leave as it is" on any album card sets it aside: its stored result is kept, it is not listed with the albums needing a fix, and no scan reads it again; the chip "Left alone (N)" lists them, and "Check it again" takes one back (its row is forgotten, so the next check reads it as new). Cause of the owner's Wagon Christ - Studio Session 1 coming back: the stored result was from before the checks that accept "Track 1" to "Track 11" (no scan had been run since 2026-11-05, so no row carried `scan_version`); run on the real folder today the check says "complete". The lock keeps it quiet whatever the checks learn later.
- **Also replace values that differ (Fix tags):** a switch on the Apply bar, off by default. On, the release's spelling of each value that differs (the yellow ones) is added to the writes as if typed, except for unticked files or fields or what the person typed; the file must still have what the scan saw, every write is journalled, Undo puts the old values back. Lyrics and Album IDs already only fill gaps, so no switch there.
- **Missing & copies (new Review tab):** worked out from the library already loaded, nothing scanned or written. Albums whose track numbers skip some (per disc; compilations marked and hidden by default; needs two numbered songs; at most 20 holes); songs found twice (same artist and title, lengths within 3 s): real copies (same folder, or the same album twice; identical files marked) and the same song on other albums. Each entry opens its folder; nothing is deleted. On the real library (13,646 songs) it found 29 albums with holes and 50 copy groups. The library does not hold "track N of M", so an album missing only its last song is not seen.
- **Track lengths in lookups:** tracks now carry a length from MusicBrainz, Discogs, iTunes and Deezer (gnudb and CTDB give none); each candidate is compared with the disc's own lengths (from its table of contents), within 3 s a track. All tracks agreeing (at least four, nearly all listed) is a "strong" fit: shown in plain words, placed ahead of other inexact choices (an exact disc ID match still leads), and the "These details match my disc" tick starts ticked when that album is chosen (the person can untick it). Few agreeing is a warning.
- **Refused (item 6):** moving files that a tagger could not identify. The owner's rule: never move a file because its details were not found; the review pages should let the person capture an untagged file where it is and offer many ways to tag it (search by name across all sources, copy from another album, type, tags from the file name or folder, listening). Roadmap, not built: today a not-identified album can be edited by typing, and "Leave as it is" keeps it quiet.
- **Item 5 (low priority):** re-sync tags from MusicBrainz when its entry has been corrected, for albums with written IDs; never automatic.


## D110 (2026-11-16): the request scheduler, stages 2 to 4 (priorities, busy answers, a status line)

Continues D108. `apps/sidecar/src/scheduler.rs` now holds every outside service's gate (it replaced the limiter map in `MetadataState`).
- **Priorities:** each request has one of three: *interactive* (a disc lookup, a search by name, a gnudb send, a comparison the person asked for), *visible* (the default), *bulk* (library scans: Fix tags, Album IDs, Match-up, artist names, Wikimedia photos). Per source, the most urgent waiter goes first (arrival order within a priority), and bulk work stands aside for ten seconds after an interactive request to the same source, so a lookup's follow-up questions are not stuck behind a scan. The priority belongs to the thread: `Drives::dispatch` sets it from the command name (`priority_for`) and `start_job` copies it into the job's thread, so no call site passes it.
- **Busy answers, not long waits:** the lookup's requests (MusicBrainz, CDDB servers, iTunes, Deezer, CTDB) use `wait_turn_for_person`: an interactive request waits at most eight seconds, then fails with `rate_limited` ("MusicBrainz is busy right now; trying again in about N seconds"). The Rip page then asks again by itself after 15, 30, 60, then 120 seconds, at most eight times, unless the person has already picked an album; a request the person makes starts the count again. Bulk jobs keep waiting as long as it takes (backing off up to a minute per refusal, as before); Fix tags already retried its own MusicBrainz and Discogs questions, and folders that still failed are tried again by the next check, so nothing new is stored for them.
- **Status line:** `source_status` returns each service asked so far: ok, slowed (the last answer was a refusal), down (three refusals in a row), seconds until the next try, requests waiting. The Rip page (under the lookup) and the Review page show it, worst first, only while on screen, every five seconds.
- Not built: remembering unanswered bulk requests across a restart (a scan already resumes where it stopped), and a cache of web replies.


## D111 (2026-11-16): Album IDs "Compare" with a release, adopt values, flag a disc for a re-rip

Owner (reviewing AFI - Black Sails in the Sunset): the release dropdown gave statistics (track lengths matching, titles agreeing, editions fitting) but no way to see the release's values against the files'. Wanted: a side-by-side view, cycling through the releases with the dropdown; to adopt the database's values where things differ; to flag a disc for a re-rip; and a suspicion that song lengths a few seconds off may mean a problem while ripping.
- **Compare (Review > Album IDs, on every card with releases):** "Compare with my files" opens, under the dropdown, a table of the album-wide values (album, album artist, year, genre: yours and the release's) and one row per song (track number, title, artist, length, each yours and the release's, and the difference in seconds); differences are coloured and each has a tick. Changing the dropdown loads the other release. Songs are aligned to release tracks by the Fix tags matcher; release tracks with no song are listed as missing; a song not on the release says so. The release is fetched from MusicBrainz as an *interactive* request (D110: it gives up after eight seconds with "busy") and kept in memory for ten minutes, so cycling back costs no request.
- **Adopt:** "Tick all differences" / "Clear ticks" / "Use the release's values (N)". Only ticked values are written (album-wide values go into every song; title, artist and track number per song), after a confirmation; each write is journalled in the Fix tags journal, so "Undo that" (and Fix tags' "Undo it") puts the old values back. The MusicBrainz IDs are still written by the existing "Use this release", kept separate because its undo is the Album IDs one.
- **Length hint:** most songs within 1.5 s of the release and a few off by up to 30 s: "a section may have been skipped or damaged" (shorter), "extra or repeated audio, or a different cut" (longer); most songs off: "probably another edition or pressing, not a ripping problem". This is a hint, not a verdict: a different pressing also differs by seconds.
- **Re-rip flags:** "Flag this disc for a re-rip…" (reason pre-filled from the hint, editable) keeps the album in `rerip-flags.json` in the data folder; Review > Missing & copies has a fourth chip "To re-rip (N)" with Show in folder and Remove the flag. Nothing happens to the files.
- Checked live against a local stand-in for MusicBrainz (the real one was answering "busy"): the full path from the Album IDs card to the table, the hint, flagging and the list worked; the stand-in and the flag were removed afterwards. Adopt and undo were tested on temporary MP3 files, not on the library.


## D112 (2026-11-16): "Search other sources by name" for albums nothing identified (Fix tags)

Follows the owner's rule that an unidentified file is captured where it is and given many ways to be tagged (see D109, item 6).
- On a Fix tags card with no release found (or only the "check and edit" proposal made from the folder names), "Search other sources by name…" opens artist and album boxes (filled from the folder names) and runs the Rip page's name search for the folder: MusicBrainz, Discogs (with the person's token), iTunes and Deezer, each limited to releases with as many tracks as the folder has songs (`search_folder_album`, an interactive job in the scheduler). The folder's own song lengths are compared with each result like a disc's, so a result whose lengths agree says so.
- "Use these details" types the picked album's values into every song of the table (title, artist, album, album artist, track number, year, genre), songs in track order against the album's tracks one to one; the person checks them, changes what is wrong, and presses Apply as always (journalled, undoable). Nothing is written by the search, and no file is moved.
- Checked live on the real WitchDoktors folder: MusicBrainz answered "busy" (reported, not hidden), Discogs found the album with 14 tracks.
- Still to come on this theme: copy tags from another album in the library, tags from the file names with a pattern, fingerprint (AcoustID) identification of single files.

## D113 (2026-11-16): AcoustID check after the rip

The owner asked for AcoustID after the rip (it was the next item on the review list; the component, rusty-chromaprint, was approved in D35).
- **What it does:** when AcoustID is switched on and keyed in Settings, every ripped track is fingerprinted from its verified WAV file (the first two minutes, as the service uses) and AcoustID is asked what recording it is. The answers are compared with the titles chosen for the disc: each track is "the song you chose", "a different song" (with the chosen track whose title it carries, so a wrong order is visible), "recognised but no title to compare", "not in the database" or "could not be checked". The disc gets a one-line verdict, and when the audio points at a different album (most recognised tracks share another studio album) its best guess is shown.
- **A report only:** nothing is written or changed because of it. A "mixed" or "different" verdict is added to the rip's warnings; with AcoustID off, nothing is asked and nothing is shown. It runs before the WAV files are removed and before encoding, and stops after three failures in a row, so an AcoustID outage cannot hold up or fail a rip.
- **Politeness and privacy:** goes through the request scheduler as source "acoustid" (the Settings gap, at least 334 ms; three requests a second at most). The application key travels in the request body, not the address, and is removed from any error text. Only the fingerprint and the track length leave the PC, never the audio or the file names.
- **The D35 check passed:** fingerprints made by rusty-chromaprint (preset "test2", the default of AcoustID's own fpcalc) of two real library songs decoded from MP3 were recognised by the live service (scores 0.98 and 0.97), including picking the right recording when the service listed a different one first. The crate is now pinned (=0.3.0) and recorded in provenance, the notices and the licensing guide.
- **Also built:** `fingerprint::from_file` reads MP3 and FLAC as well as WAV (through the defect scanner's decoder), the groundwork for identifying single library files.
- **Not done (next options):** using the fingerprints to name tracks of a disc nothing else knows; the same check for existing library folders (Review); writing the AcoustID and MusicBrainz recording ids into the MP3s.

## D114 (2026-11-16): Copy tags from another album, and tags from file names with a pattern (Fix tags)

Two more ways to tag an album nothing identified, where it sits (see D109 item 6, D112); both approved by the owner on 2026-11-16, the second "asking the user to select the format if it isn't obvious to the program".
- **Copy tags from another album:** the person types some words; albums of the library that match are listed (those with as many songs as the folder first); ticking which tags to copy (titles, artists, track and disc numbers, album, album artist, year, genre) types them into the table song for song in track order. Titles and numbers are copied only when both albums have the same number of songs. Pure library data (the page already holds it), nothing is fetched.
- **Tags from file names:** the usual patterns (`%track% - %title%`, `%track% %title%`, `%track%. %title%`, `%disc%-%track% %title%`, `%artist% - %title%`, `%track% - %artist% - %title%`…) are tried on every file name of the folder. When exactly one fits all of them it is used without asking; when several fit (such as `01 - AFI - Song`, which `%track% - %title%` also reads) or only most do, the person chooses from a list with examples, or types their own pattern with a live preview. A pattern that "fits" only by swallowing a separator or by taking a track number for an artist is not counted. Underscores in a name without spaces read as spaces. Files that do not fit are left as they are.
- Both type values into the table; the person checks them and presses Apply (journalled, undoable). Nothing is moved.
- Note: reading tags from file names for albums without a release already existed as the automatic "From the folder and file names" suggestion; this adds choosing the pattern.

## D115 (2026-11-16): AcoustID names untitled tracks after a rip, and writes recording ids into new files

The owner asked for fingerprints to name the tracks of a disc nothing else knows, and for the AcoustID and MusicBrainz recording ids to be written into new MP3s "so long as the tagging follows standards and isn't going to cause any issues when the library or songs are put into other software".
- **Naming:** after a rip, a track whose chosen title is blank or a placeholder ("Track 3") takes AcoustID's title when the service is very sure (0.9) and offers one name for every recording it lists. It is reported ("Named by AcoustID… check against the case"), shown in the results table, and used for the MP3 and FLAC file names and tags. A title the person chose is never replaced.
- **Ids, in the standard places:** MP3 (ID3v2.3, in-tree writer): the MusicBrainz **recording** id as a `UFID` frame owned by `http://musicbrainz.org`, and the AcoustID as `TXXX` "Acoustid Id", exactly as Picard writes them. FLAC archive masters: `MUSICBRAINZ_TRACKID` (the recording id) and `ACOUSTID_ID`, Picard's Vorbis names. Not written: the fingerprint itself, or release or release-track ids (AcoustID does not know the edition; the Album IDs page writes those).
- **Only when sure:** the ids go in only for a track whose audio agrees with the title chosen (0.85) or that was named as above; never for a track that sounds like a different song. A malformed id is refused by the writer.
- **Checked for other software:** a test reads the written files with lofty (the tag library behind much of the Rust ecosystem), which finds the recording id as MusicBrainz's recording id and the AcoustID, and confirms that editing another tag later keeps both. UFID is the frame the ID3v2.3 specification provides for exactly this, so players that do not know it ignore it.

## D116 (2026-11-16): Audio check of the library, and "Identify by listening"

- **Review > Audio check:** AcoustID listens to a sample (5 songs, spread from the first to the last) of each album folder with 3 or more songs and says whether they are what their tags say. It runs as a background library job that goes through the request scheduler as bulk work, can be stopped, keeps its results (`audio-check/results.json` in the data folder) so albums already checked are skipped unless they changed or "Check everything again" is pressed, and gives up after three albums in a row get no answer. Lists: different songs (likeliest wrong first), untitled songs named, not in AcoustID, could not be checked, agree, left as they are. "Listen to every song" checks one album in full.
- **Changes only on request:** a song that sounds like a different song, or an untitled one, can be ticked to take AcoustID's title ("Use AcoustID's titles"): journalled, undoable from Fix tags, and only for files in that folder. "It is fine" takes an album out of the list (alternate title, a live version). Nothing is moved or deleted.
- **Fix tags > "Identify by listening…":** for an album nothing identified, AcoustID listens to every song; "Use these song names" types the names into the table (the artist only where a song has none), and when most songs share an album AcoustID suggests, "Search for…" starts the name search with it.
- Checked live on real albums: AFI "A.F.I." (5 of 15 sampled, all agreed, including a long title AcoustID spells out in full) and the WitchDoktors album the databases do not know (AcoustID does not know it either, reported plainly).
- Commands (5 more, 98 in all): `check_folder_audio`, `scan_audio_check`, `list_audio_check`, `dismiss_audio_check`, `apply_audio_names`.

## D117 (2026-11-16): Lyrics search understands track numbers in titles and instrumentals

Found by probing LRCLIB for a random sample of the 1,689 songs with no stored candidates, then for the ones whose titles carry a track number (owner: look at whether fixing their tags would improve the search; then "implement them").
- **What the probe showed:** 158 of those songs had a track number in the title tag ("14 Donut Dan", "1. All For Nothing"); with the number off, LRCLIB had lyrics for 105 of them (69 timed). Songs with the artist's name in the title (35, mostly compilations) gained nothing. About 1 in 6 of the sample is marked instrumental by LRCLIB. Most of the rest are not on LRCLIB under any spelling.
- **Lookup:** a title that starts with a track number and finds nothing as written is asked about once more without the number (`title_used` in the answer). A title found as written is never asked twice ("99 Red Balloons" is safe).
- **Instrumental:** when LRCLIB's exact match, or the artist's own recording of the same length, is instrumental, the song leaves Missing lyrics and is listed under **Instrumental**, where "Not instrumental" puts it back and remembers that, so the lookup does not mark it again. Nothing is written into the song (no other program sees a change); the list is `lyrics-instrumental.json` in the data folder.
- **Track numbers in titles:** a new view under Missing lyrics lists them with the title they would get, all ticked; "Fix the ticked titles" writes them, journalled in the Fix tags journal (Undo there), and only if a title is still what the list showed. The rule is `tidy_title_for_track`: what Fix tags already tidied, plus a leading number equal to the song's own track number.
- **Asking again:** songs asked about before this change (and not already holding likely lyrics) are asked once more by the automatic lyrics, after the songs never asked about.
- **Commands (5 more, 103 in all):** `list_lyrics_instrumental`, `mark_lyrics_instrumental`, `unmark_lyrics_instrumental`, `find_tidy_titles`, `apply_title_tidy`.
- **Lesson:** a handoff to another session should state the owner's needs and give the data, not prescribe methods or source limits (the first lyrics handoff did, and failed).

## D118 (2026-11-16): All Rust code is formatted with standard rustfmt, and CI checks it

- **What happened:** the Rust code had never been run through rustfmt, so running `cargo fmt --all` while adding D117 reformatted 115 files at once, five of which held uncommitted work. It was undone, with the owner's say-so for the files that held work; nothing was lost.
- **Decision (owner: "this project is meant to be built in Rust ... make sure this sort of mistake isn't so easy to have happen"):** format the whole repository once, in its own commit with no behaviour change (the whole workspace test suite passes before and after), and keep it formatted. The settings are rustfmt's defaults (no `rustfmt.toml`).
- **Guards:** CI runs `cargo fmt --all --check` before the tests; `AGENTS.md` has a "Rust formatting" section (format before committing, never mix formatting with a feature, never run whole-tree rewrites on a tree with uncommitted work); the formatting commit is listed in `.git-blame-ignore-revs` so `git blame` still shows who wrote a line and why.

## D119 (2026-11-16): Home page order, no Most played, doubled shelves fixed, "I'm feeling lucky" jukebox

- **Decision (owner):** drop the Most played shelf from the PC Home page; put New in your library at the top; put something fun in the middle: an "I'm feeling lucky" button that spins a horizontal jukebox of album covers and starts a new random album.
- **Order now:** New in your library, Pins, Feeling lucky?, Favorites, "flagged for review" note, Recently played.
- **Bug found:** every shelf appeared twice. Home is rebuilt after every song, favourite and library change, and the rebuild kept its page-in-progress in one shared variable, so a second rebuild that started while the first was waiting for the history made both add their shelves to the newer page. Each rebuild now has its own page-in-progress. Checked in the app: rapid page switches no longer double anything.
- **The jukebox:** about 34 covers scroll past a marker and slow to a stop on the chosen album (4.8 s; no animation when the system asks for reduced motion), the album is highlighted, then plays from its first song. The album is chosen among those not in the last 60 albums played (all of them when history is off or everything was played lately). Before the first spin the window shows empty discs, so the page looks the same each rebuild. The choice and strip are pure and tested (`luckySpin`).
- **Jukebox, second round (owner, same day):** it starts full of random albums (31 covers) instead of empty discs; the covers are the same size as the other shelves' (9.5 rem); the settle has a casino-style wiggle (overshoots the album, swings back, each swing smaller); the marker is now a box in the accent colour (same as the buttons); every cover is clickable (plays that album, with the same right-click menu as the tiles). The box and the centre cover stay in the middle of the window at any width because the stylesheet places the reel from `--i` (the number of the centre cover) instead of a script measuring pixels. Cause of the artwork blanking after about 30 s: the page rebuilds itself when a play is recorded, and the rebuilt jukebox was empty; the reel's covers are now kept between rebuilds, and rebuilds wait until a spin ends (a rebuild in mid-spin froze the animation in testing).
- **Phone:** the Most played automatic list is removed from the phone app too (owner, same day); Recently played, Recently added and Not played yet stay. It shows in the phone app after the next phone build and install. Listening history (Settings) still feeds Recently played and the spin; its text was updated.

## D120 (2026-11-17): Lyrics lookup uses the library's song lengths and a wider artist search

- **Decision (owner: "start with the length_ms lyrics decision, let's find more matches"):** the lyrics lookup (`lookup_lyrics`) now takes the song's `length_ms` from the library tags. Before, only an MP3 this program had made had a known length, so every other song's best answer was "length unknown" (confidence capped at 72) and went to To review. A search answer within 5 seconds of the song's own length now counts as the same recording and is saved automatically; the file is no longer read for every lookup when the library gave the length. The answer now carries `song_duration` (the lyrics finder already expected it; the sidecar never sent it).
- **More matches:** when the artist-and-title search finds nothing, the lookup tries the first artist of a list ("A feat. B", "A; B", "A, B", "A / B"; "A & B" stays whole), then LRCLIB's free-text search (`q=`). Only answers whose title and artist are the same after spelling, "The", "&" and punctuation are ignored count as the artist's own recordings.
- **Re-asking:** songs asked before this change (the 30-day memory) are asked again: first those with likely lyrics waiting in To review (their length may now settle them), then the songs LRCLIB did not know. A song whose lyrics are now saved automatically leaves To review (`remove_lyrics_review` also accepts a song path).
- **Risk accepted:** a recording within 5 seconds of the library's length and with the same artist and title is taken as the same recording; time-stamped lyrics from a slightly different edit could be a little off. Everything is journalled and the song can be re-timed in the lyric tools.

## D121 (2026-11-17): Heat and power pass: capped visualizer, 38 bars, calmer phone timers

- **Decision (owner):** the visualizer never needs more than 60 drawings a second, and the TV and phone versions can have 10-25% fewer elements if that helps.
- **Found:** the phone's visualizer drew on every screen refresh (up to 120 a second on the Pixel) and kept looping while paused; the TV had already been capped at 30 (D66) but the phone never got that. The Kotlin side also posted the position to the page every 500 ms though the page counts the time itself.
- **Done:** one shared cap (`VIS_FRAME_MS` 32 ms = 30 a second; the song analysis only has 25 frames a second, so 60 would draw nothing new) for the TV and the phone; the phone draws nothing while hidden and stops its loop once paused and settled; the bars went from 48 to 38 (-21%; every style's work grows with them; the bass and body ranges that drive the glow are now fractions of the band count); the phone's position message every 2 s instead of 0.5 s (a real change is still sent at once), the page's own tick and the device poll do nothing while the app is hidden. Measuring on the Pixel's temperature is still to do (not measured here).

## D122 (2026-11-17): Casting parity: the phone sends lyrics, a lighter receiver page, a shorter gap between songs

- **Owner's goal:** casting should give the smoothest playback, the best audio quality and the same lyric playback from the phone and from the PC.
- **Audio quality:** both senders hand the device the original file (no re-encoding), so the sound is the file's own. Nothing to change.
- **Lyrics (gap found):** the PC sent the song's lyrics to the MediaVerse receiver page (`customData.lyrics`), the phone never did, so a TV showed lyrics when the PC cast but not the phone. The phone now reads the song's tag lyrics (`Lyrics.read`) and sends the same shape and limits (400 lines of 200 characters, 20,000 characters of plain words). The receiver follows the device's own play time, so lines cannot drift from the sound.
- **Receiver page (website repo, `cast/receiver.html`):** the 60 px blur over a screen-sized cover and the 24 px blur on the glow (the same two costs found on the Tizen TVs in D66) are gone: the cover is drawn once into a 32 x 18 canvas that the screen stretches; the progress bar moves by `transform`. Checked by rendering the page here with a stand-in for Google's framework; **not yet seen on a Cast device**.
- **Gap between songs:** both senders load the next song only after seeing the end (phone: every 1.5 s, PC: every 2 s). Both now ask every half second in the last ten seconds, so the next song starts sooner. A true gapless hand-over needs the device to hold the next song (Cast `QUEUE_LOAD` with preloaded items, DLNA `SetNextAVTransportURI`); that is a bigger change, tied to shuffle and repeat, and is on the roadmap (`docs/outstanding.md`).
- **Still missing on the PC (not on the phone):** volume, seek, shuffle and repeat for a cast device.

## D123 (2026-11-17): PC and TV pass: components stay out of each other's way, less memory

- **Owner's goal:** none of the PC's components tripping over one another; the TV apps not over-stressing small processors and RAM.
- **Found on the PC:** (1) library-wide background work (defect scan workers, audio check, MusicBrainz ID/photo/name checks) ran at normal processor and disk priority beside playback, the page and rips; only the *outside-service* requests were arbitrated (the D108 scheduler). (2) The glow visualizer ran on every screen refresh and wrote its two values on the document root, which restyles every element that could inherit them. (3) The page printed "11 job-finished listeners" at every start (one per panel, for the life of the page: not a leak). (4) The sidecar still answers one non-job command at a time (a cover waits behind a slow command): unchanged, a second lane remains on the list.
- **Done:** bulk jobs and the scan workers enter Windows' background mode (`os_priority.rs`: lower processor, disk and memory priority together, undone when the thread ends; the `Win32_System_Threading` feature of the already approved `windows` crate, no new dependency); the glow is read at most 30 times a second, writes only changed values, and sets them on the two glow layers instead of the root; the listener limit is raised for the preload bridge. **TV:** the song analysis uses one mono copy (see `docs/tv-performance.md`), recordings over 12 minutes are skipped.
- **Not measured:** none of this was timed on a TV, a phone or under a real rip; each change removes work that is known to exist.

## D124 (2026-11-17): Gapless casting, and volume, seek, shuffle and repeat from the PC

- **Owner:** fix or implement the casting gaps as far as possible without asking.
- **Gapless (Google Cast, phone and PC):** a song is loaded as a one-song queue (`QUEUE_LOAD`) and the song that follows is put behind it (`QUEUE_INSERT`; the device fetches it 20 s ahead), so the device starts it by itself. The sender notices the device's own item number change and moves its queue on without loading anything; a device that refuses a queue gets plain loads (as before). Repeat-one and the last song are loaded the old way. Shuffle and repeat change which song follows, so the current song is loaded again at its place (about a second of rebuffering, only when the button is pressed). Between two songs the device passes through "idle" for a moment, so a song counts as ended only after three stopped answers when one was queued. A queue insert made right after a load can meet `INVALID_MEDIA_SESSION_ID` (the device has not announced the session yet): it is retried for up to three seconds.
- **Verified on the bedroom TV (65" OLED, Google's receiver):** the phone (the device went from item 1 to item 2 at 184/184 s, then to the next, shuffle reloaded at 22 s and queued the next) and the PC's sender (a script playing two public test files: item 5 to 6, volume read back). Not yet heard by a person.
- **DLNA:** still one song at a time (no DLNA-only device in the house to test `SetNextAVTransportURI`); the faster end-of-song check from D122 applies.
- **PC controls:** the TV button's menu for a cast device now has Back/Forward 15 seconds, Shuffle, Repeat, Louder and Quieter (the device's own volume, read every fourth poll), as the phone has. DLNA volume (RenderingControl) was added to the PC's DLNA code; Cast volume uses the receiver's `SET_VOLUME`. The queue rules are in `cast-queue.ts` (the same as the phone's `CastQueue`).
- **Not solved:** the Den TV (needs to be on; "no capability tags" is Google's registration side), the Cast receiver page seen on a real registered device.

## D125 (2026-11-17): Now Playing stuck scrolled up (fixed); Now Playing takes the TV's layout when lyrics show

- **Bug (owner's screenshot):** during a song with lyrics the whole Now Playing page slid up, hiding its top, with no scrollbar to bring it back. Cause: the lyric highlight called `row.scrollIntoView({ block: "center", smooth })`, which scrolls every scrollable ancestor of the line as well; Now Playing (`position: fixed; overflow: hidden`) counts, because a hidden box can still be scrolled by script and the cover wall inside it is taller than the window. The queue list had the same call.
- **Fix:** Now Playing is `overflow: clip` (cannot be scrolled at all), the wall is clipped, the queue list scrolls itself, and time-stamped lyrics are moved by a transform (the current line is put in the middle, the ends rest at the box's edges, lines partly outside the box fade out), as on the TV. `scripts/capture-now-playing.cjs` plays a 40-line song and checks that nothing scrolls and the line stays within 1 px of the middle (it did: 0 to 1 px).
- **Layout (owner: "copy the Samsung television version, maybe smaller fonts"):** with lyrics showing, a small cover and the details (artist · album, then the title) sit at the top left, the lyrics run across the width below, centred, 1.2 to 1.9 rem (scaling with the window height), the current line in the cover's colour, larger and bright; the wall behind is dimmed. The Lyrics tab is chosen by itself for a song that has lyrics unless you last chose Queue by hand (remembered); a song with no lyrics shows the queue layout. Plain (untimed) lyrics are an ordinary list to scroll.

## D126 (2026-11-17): Timed lyrics start in the middle; lyrics size slider

- **Owner:** the first lyric line started at the top of the box and the list only began to move once the line reached the middle; the size is right, but add a slider in Settings with today's size as the middle and three steps either way.
- **Done:** the list is moved so the current line is in the middle wherever it is in the list (the first lines are moved down to put them there, the last lines end there; before the first line is sung, line 1 waits in the middle; seeking back before it does the same). Settings > Display has "Lyrics size in Now Playing": a 7-position slider, standard in the middle, 10% smaller per step down (to 70%), 14% larger per step up (to 142%), applied at once through `--np-lyric-scale` and kept with the other display choices (`lyricsSize` in `display-prefs`). Checked in the test profile: line 1 at the middle (0 px off), the slider sets 1.42 at +3 and saves it.

## D127 (2026-11-17): Lyric AI is built into the program, models as optional downloads (plan: docs/lyric-ai-plan.md)

- **Owner:** build the lyric finding, checking and timing into the application, with the models as separate downloads (the best and fastest for this PC and library by default, other models selectable, including a file picked from disk); keep the program slim; the AI should look at looser matches (World War III / World War 3), decide which found lyrics are the right ones, use them as the baseline words and then time them; no listening needed for matches over about 90%.
- **Findings that shape it:** the aligner's own letters verify lyrics about as well as Whisper (no speech-to-text model needed); the aligner exports to ONNX exactly and runs on the CPU and on any GPU (DirectML); the vocal separator exports with its STFT/ISTFT left to the program, is exact on the CPU (7x real time) and on NVIDIA through CUDA (115x), but DirectML gives wrong output for it. So: ONNX Runtime loaded dynamically (not shipped in the installer), the GPU runtime and the models are optional downloads, the CPU always works.
- **Started:** `crates/lyric-ai` (pure logic: text and title variants, CTC forced alignment, line flags, letter 4-gram identity score and decision rule), checked against the Python prototype by a golden test on 20 s of real singing (identical line starts, ends, words and flags). Next: audio and ONNX inference (needs the owner's approval of the `ort` and `rustfft` crates), sidecar commands, Settings > Lyrics AI model manager, Review integration. Work stays on branch `lyric-sync` until it proves itself; the Demucs weights' licence has to be confirmed before it is offered by default.

## D128 (2026-11-17): The lyric engine runs in Rust (ONNX Runtime), on the owner's GPU

- **Approved by the owner:** the `ort` crate (pinned `=2.0.0-rc.10`, matches ONNX Runtime 1.22; `load-dynamic`, so ONNX Runtime is loaded from a download and is not in the installer; MIT or Apache-2.0) and `rustfft` (MIT or Apache-2.0); and use of Demucs on this PC now (the weights stay an optional download, licence to be confirmed before it is offered by default).
- **Built:** `crates/lyric-engine`: a band-limited resampler (torchaudio's defaults), Demucs's STFT, mask and inverse STFT (checked against Demucs's own output on a fixture: within 1e-4), chunked separation with the same overlap-add weights as `demucs.apply`, the letter reader in 24 s windows, `Provider` (CPU, CUDA, DirectML; DirectML is not used for the separator, which it computes wrongly). The example `analyse` runs a whole song through the chain.
- **Measured on this PC (RTX 4090), a 151 s song:** separation 2.2 s on CUDA (30.3 s on the CPU), letters 1.0 s (14.6 s on the CPU), alignment 0.03 s: 3.2 s in all, about 47x real time, 45 s on the CPU alone. The line starts are the Python prototype's (28.58, 31.78, and the "stretched first word" flag on "You're bent..." at 36.28).
- **Next:** sidecar commands and a job (decode with the sidecar's own decoders, model files and ONNX Runtime from the models folder, progress and cancel), the loose lyric search with the identity decision, Settings > Lyrics AI (models, hardware, download), and Review integration.
## D129 (2026-11-17): Artist names: your choice is remembered, and the list is right after one click

- **Owner:** with two spellings listed, one being MusicBrainz's but not the band's own, choosing the other and pressing Use should clear the name from the list; it did not, and it took several clicks before all the songs agreed.
- **Cause 1 (name never cleared):** after the rename every song carried one spelling, but MusicBrainz's spelling differed, so the list put the name back ("MusicBrainz spells this artist ..."). The list had no memory of the person's decision.
- **Cause 2 (several clicks):** `rename_artist` rewrites the files; the library the page reads learns of the new tags from the folder watcher's background scan. The page redrew at once from the old library, and did not redraw when the scan finished, so only the next click showed the new state.
- **Fix:** a decision is remembered (`Settled` in `artist-names.ts`, kept with the page's other choices): after "Use this spelling" the name is settled and not listed again while its spellings stay as they are; the chosen spelling beats MusicBrainz's as the suggestion if the name returns (a new song with another spelling). A new "Leave as it is" button settles a name without changing anything. After a rename the page rescans the library and waits for it before redrawing; the list also redraws when the background scan reports (`library-updated`). Undo puts the previous decision back. Checked in the real app: one click, the name left the list in 100 ms and stayed gone (`scripts/capture-artist-names.cjs`).

## D130 (2026-11-17): The lyric AI in the sidecar: identity by fit, the loose search, and the analysis job

- **Identity by fit replaces the letter reading.** Comparing a candidate with the aligner's greedy letter reading failed on a fast 57 s hardcore song (the right lyrics scored no better than a random record). Instead each candidate's words are forced into the audio and scored by how much worse they fit than the best path of any letters (`Alphabet::fit`, per letter, 0 perfect): the right lyrics beat every one of 8 wrong ones in 39 of 40 songs (median -1.4 against -4.8), and with the cut-offs (floor -3.5, margin 0.3; sure at -2.0 with margin 1.0) the true lyrics among 8 wrong ones were 37 sure, 2 likely, 1 none and no wrong text was ever chosen. Texts that are mostly inside one another (a record with a few lines more or fewer) are the same song, not rivals. Rust numbers match the Python's to 5 decimals (golden test).
- **Loose search** (`lyrics_lookup::loose_candidates`): the title as written and in other spellings (numbers and Roman numerals both ways, "&"/"and", track number, bracketed notes, "feat."), with the artist as written and without a "feat." list, then free text, then the title alone; quick by default (stops at the first record by the same artist with lyrics), up to 60 candidates, the artist's own first.
- **The job** (`lyric_ai_analyse`, with `lyric_ai_status`, `_configure`, `_results`, `_apply`; Bulk priority, background mode): per song it reads the tags and lyrics, decodes, listens (separation on the configured processor, letters), then: timing the song already has is checked (fits / shifted / drifts / does not fit; shifted or drifting timing gets a re-timed LRC); lyrics without timing are checked against the recording and timed; a song with no lyrics is tested for a voice ("probably instrumental") or gets candidates from the loose search, the best chosen by fit and timed. The rule for "no listening needed": the words are certain (sure) and at most a tenth of the lines are flagged; everything else goes to Review > Lyrics > To review with its flags (`lyric_ai_to_review`). With `apply_sure` (and a batch id) the sure results are written through `update_track_media` (journalled, undoable). Staged results are in `<data>/lyric-ai/results`.
- **Checked end to end** through the sidecar's protocol with the real models on the owner's GPU (`tests/lyric_ai_e2e.rs`, ignored unless the models are named in the environment): Bad Religion's "World War III" (a file with no lyrics) against 75 real LRCLIB records of three spellings of the title: the Bad Religion lyrics were chosen (fit -2.69; best other artist -3.24), timed (3 of 20 lines flagged) and sent to review because the fit is below "sure" on this extreme song.
- **Not yet built:** Settings > Lyrics AI (models, hardware, downloads, picking a model from a file) and the Review buttons ("Find and time lyrics" for an album or the library, the report, "apply what is sure"); the models' installation is a settings file (`lyric-ai.json`) for now.

## D131 (2026-11-17): Lyric AI panels, systematic spelling variants, first real-song trial

- **Owner:** MusicBrainz's names differ from tags in small ways (curly or straight apostrophes, long dashes, a leading "The", a "!"), which explains many missed exact matches; make the whole process automatic so thousands of songs are not reviewed by hand.
- **Spelling variants** (`text::plain_punctuation`, `text::name_variants`): look-alike characters made plain; artists and titles also tried without "!" / "?" / apostrophes, with or without a leading "The", "&" and "and". `loose_candidates` searches a few of each (likeliest first) and counts every spelling as the artist's own when comparing records.
- **Job changes:** a song with no singing is listed under Review > Instrumental by itself (nothing written to it); a song asked about in the last 30 days is skipped unless `again` is passed; each distinct lyric text is forced into the song once, at most 30 per song (a song with 55 records no longer takes minutes).
- **Panels:** Review > Lyrics has a "Lyric AI" box (scope: songs with no lyrics or every song; Start/Stop; live counts; certain results written by themselves, journalled under one batch id; a button to the leftovers). Settings > Lyrics > Lyric AI has the model, ONNX Runtime and CUDA folders and the processor for each model. Still to build: a download manager and "add a model from a file" with a self-test; the models are copied by hand for now (`%APPDATA%\MediaVerse Studio\lyric-ai`, set in `lyric-ai.json`).
- **First real trial** (`tests/lyric_ai_trial.rs`, 60 random songs with no lyrics, real LRCLIB, RTX 4090, release build, 6 s a song, nothing written): 10 certain (17%), 9 with the right lyrics but over 10% doubtful lines, 3 already fitting, 10 not on LRCLIB at all (checked by hand: it really has none), 20 where records exist but none fit the singing (right: they are other artists' songs with the same title), 0 wrong matches seen. So LRCLIB's coverage, not the matching, is the limit: about a third of these songs can ever get lyrics from it. A debug build is 15 to 20 times slower; use release.
- **Open:** whether to apply the 9 right-words songs with 10-25% doubtful lines (the doubtful lines would be timed approximately); needs a listen test before the rule is loosened. Other lyric sources (the tags' own text, Genius/Musixmatch are not allowed by their terms) for the 41 songs LRCLIB cannot help with.

## D132 (2026-11-18): Missing lyrics order, instrumental list, backdrop reload, Match-up cards

- **Owner:** many songs under Review > Lyrics > Instrumental are probably not instrumental, and there was no way to play them; the two lyrics boxes (Automatic lyrics, Lyric AI) did not say which to run first; the build showed broken images instead of the collage; Match-up should look like Fix tags.
- **Instrumental list:** a play button on the left of each row, "Not instrumental" on the far right so it is not hit by accident while moving to the next song.
- **Missing lyrics:** a "Recommended order" note (Step 1 Automatic lyrics, then Step 2 Lyric AI on what is still missing, then To review and Instrumental; "Every song" only later, to check timing). The boxes are titled "Step 1" and "Step 2", Step 1 comes first, and in both the Start/Stop button is on the left with the title to its right. Lyric AI's scope reads "Only songs with no lyrics (recommended)" / "Every song (slower ... for later)".
- **Broken backdrop images (cause):** `forgetCovers()` revoked the cover object URLs but the backdrop kept them and, with an unchanged library signature, did not rebuild. `onCoversForgotten` (cover-art.ts) now tells the backdrop, which clears the wall and reloads the covers after half a second. Not seen on a screen yet; a build in flight at that moment could still use the old URLs.
- **Match-up:** a Fix tags style card per album with a table of song, tag, current value (struck through) and what it will become, covers included.

## D133 (2026-11-18): Easier artwork and lyrics for discs already owned; TV key stays out of addresses

Owner: managing a library of music already owned on CD should fill in album details, artwork and lyrics without typing them from the sleeve. Earlier notes that blocked that were more cautious than the law or the services' terms. Owning a CD does not license copying Genius, AZLyrics, Musixmatch, Amazon, Bandcamp, or Discogs images. Those stay out.

- **Artwork search** (`artwork_search.rs`): tagged MusicBrainz release id first, then barcode, catalogue number, then a few artist spellings, then the title alone (a penalty). A pressing that has a Cover Art Archive front is kept over a duplicate that does not. If that pressing has no front, the release group's front is tried. Below a sure match (95), iTunes and Deezer cover addresses already in their search replies are fetched (hosts `*.mzstatic.com` and `*.dzcdn.net` only; the slow full-album lookup is not done just for a cover). This changes D106's "no cover is taken from these" for those two address fields only. Discogs stays a page to open in the browser, with the required credit; its images are not fetched. Review's automatic covers use the sure-match line (95), not a perfect 100.
- **Lyrics** (`lyrics_lookup.rs`): a version within 5 seconds is still the same recording. Within 20 seconds the time-stamped lyrics are kept and marked `needs_alignment` / `other_version` (the person can nudge them). Farther than that, the time stamps are dropped and only the words are offered. Automatic lyrics still saves only an exact match. A one-song lookup that finds nothing on LRCLIB, and only when the dialog asks (`follow_works`), looks up the MusicBrainz work and tries the other artists who recorded it. Automatic lyrics does not do that. Successful LRCLIB replies are remembered for 30 days under the data folder. The LRCLIB dump is not downloaded (about 125–250 GB).
- **One web client** (`lookup.rs`): redirects are not followed by the library. At most three hops, and only to the same host, a subdomain of a dotted parent, or between coverartarchive.org and archive.org. The `Authorization` header is dropped when the host changes. A request body is not sent on to a redirect.
- **TV sharing:** pairing starts only after Settings > TV > Pair a TV (five minutes), or while that TV is already pairing. The device key is accepted only as `Authorization: Bearer` or `X-MediaVerse-Key`, never in the address. Song and cover addresses, which cannot send a header, use a short-lived ticket (12 hours, one live ticket per device, audio and cover only). The TV app reads that ticket from the reply and puts only `?ticket=` on those two addresses.


## D134 (2026-11-18): The Lyric AI judges the To review list; Home shelves without scroll bars

- **Owner:** the many "To review" suggestions were never checked by listening. "Same length timed" ones are good but the first line's start is often a little off; "length not compared - timed" ones at about 82% are mostly good but may need re-timing; live tracks stray from the written words; remixes do not line up; below about 60% the suggestions were really poor (the Catbite / Laura Jane Grace tracks on the Operation Ivy live album at 54% were all wrong: none was the original Operation Ivy lyrics). Wanted: the local AI compares the suggestions with what is sung, picks the best fit, matches the timing above 60%, and puts a song back in the list when nothing fits.
- **Built** (`lyric_ai/judge.rs`, command `lyric_ai_judge {min_confidence = 60, apply_sure, batch, again}`, Review > Lyrics > Lyric AI > "The To review list"): for each entry whose best suggestion is at least 60%, every suggestion's words are forced into the singing and scored by the same identity-by-fit rule as D130. Fit is certain: the pick is timed and written (journalled, undoable, entry removed). Fit is likely: the pick replaces its suggestion at the top of the entry, already timed, for a person to confirm. No suggestion fits: the song is searched again exactly like a song with no lyrics (title alone and other spellings, so a cover album's songs are found under the original artist), and if that fails the entry is left as it was. Judged songs are skipped for 30 days (`again` overrides).
- **Timing:** a suggestion's own time stamps are kept when they fit the singing (median offset and drift within the D130 limits), except that the first line moves to where the singing starts when they differ by 0.25 s or more. Otherwise every line takes the singing's time.
- **Lines not sung as written:** a line whose letters were mostly not heard (line score under 0.2 and under half the song's usual line) gets a leading `* ` in the written lyrics (live versions that stray). If over 30% of the lines would be marked, none is, because the aligner is simply unsure of the song; the song then goes to a person. The 0.2 / half thresholds are a first guess, to be calibrated on real songs; a song with any marked line is never written by itself (a person confirms it first, with the `*` visible).
- **Dry run on 40 real To review songs** (spread over the list, release build, RTX 4090, about 4 s a song, nothing written, no internet): of the 22 at 57% or more, 21 had a suggestion that fit the singing (fit -0.75 to -3.09; the other has no singing, probably instrumental); 9 were certain, 6 of them with no marked line (so only those 6 would be written by themselves), the rest likely with 2 to 10 doubtful or marked lines. Of 18 at 54%: 12 had no fitting suggestion (the search-again step was not run in this dry run, so it is untested on real data), 4 had no singing found (probably instrumental), 2 had a likely pick. Run again with `LYRIC_JUDGE_DATA` and `LYRIC_JUDGE_N` (see the test in `judge.rs`).
- **Home:** "New in your library" and "Recently played" no longer scroll sideways; the row fills the page width like "Feeling lucky?" and tiles that do not fit are left out of that row.
- **Not built (longer term, owner):** (1) songs where the artist writes out the chorus once and sings it several times (an artist's own downloads, 1876): detect repeated sung sections in the audio and put the repeated lines back into the written lyrics. (2) Remixes: compare against the original's lyrics but expect different structure; no special handling yet, they simply fail the fit and stay in the list. (3) Using the album title to guess the original artist of a cover album before searching (the title-alone search covers the common case).
### D134 addendum (2026-11-18, evening): calibration on real data, and what changed

Run while the owner was away; data and scripts in `MediaVerse\MediaVerse-Lyric-Sync-Lab\judge-lab` (`calib*.jsonl`, `analyse_calib.py`, `analyse_windows.py`, `search-again.log`, `catbite.log`). All read-only on the library and the data folder.

- **Bug found and fixed:** the judge gave a suggestion's own time stamps to `to_lrc`, which writes every start 0.2 s early for the aligner's lateness, so kept timing came out 0.2 s early. The stamps now get the 0.2 s back (tested through `to_lrc`). The 0.2 s itself holds: across 3,378 lines in 97 songs the median offset between the aligner and agreeing human stamps is 200 ms.
- **Agreeing time stamps prove the words.** On 160 songs spread over the list: another song's synced lyrics put on a song agreed with the singing in 0 of 70 cases (at most 0.08 of lines within 0.7 s of the usual offset), against 39 of 67 right best suggestions (0.59 to 1.0). Words that only "likely" fit (-3.5 to -2.0) are now certain when at least half the stamped lines are within 0.7 s of the usual offset (18 of 52 likely songs in the sample). Wrong lyrics are above the fit floor (-3.5) in 9 of 70 cases but never above "sure" (-2.0).
- **First line:** after allowing for the 0.2 s lateness, 8 of 31 agreeing songs have a first line 0.25 s or more from the singing (most are later, up to 0.8 s); two are 16 and 19 s away, which is more likely the aligner or an intro marker. The first line now moves only by 0.25 to 3 s.
- **`*` on unsung lines switched off** (`MARK_UNSUNG_LINES`): the line-score rule marked 2.5% of live lines and 3.1% of studio lines. A window of three lines scored against just its own stretch of audio (`Engine::window_fits`) is also not enough: songs with 10% or more windows 2 worse than the song's median were 4 of 26 live and 4 of 35 studio. The worst single stretch is worse in live tracks (median -4.6 against -3.7; a quarter of live songs below -8.7 against about a tenth of studio), which may help as a "listen here" hint for a person, not as something to write. Real line-by-line detection would need a better model than the reader's letters (needs the owner's approval of any new model).
- **Search again, on real LRCLIB:** on 40 entries at 54% or less, 11 got a pick (the others found nothing; noisy live audio makes every candidate score near -3.5 and none stands out, which is the right answer). The covers case works: Guttermouth's "Happy Loving Couples" (Joe Jackson's) fit -1.1 and certain. On the Catbite / Laura Jane Grace tracks (54%, Operation Ivy covers, 21 entries): 9 now have the Operation Ivy lyrics chosen (Sound System, Freeze Up, Take Warning, Artificial Life, Room Without a Window, Bankshot, Smiling, The Crowd; fits -1.6 to -2.2), 7 stay unsettled (Jaded, Unity, Caution, Big City, One Of These Days, Here We Go Again, Story Time: best fits -2.8 to -6.9 with no clear winner). In most cases the Operation Ivy lyrics were already among the suggestions, only ranked low by the confidence score. That is why a new choice, "The whole To review list, below 60% too", exists: the 60% cut-off would have hidden exactly these.
- **Safety of "certain" below 60%:** there are no time stamps to corroborate with there (stamps are dropped for other versions and artists), so only the fit rule applies (at or above -2.0 and 1.0 clear of any other text): none of 70 wrong texts reached -2.0, so at most about 4% of wrong texts could pass at 95% confidence, and the margin rule makes it rarer. Worth a listening check on a first batch with "write" unticked.
- **Not done / ideas:** an album-level consensus (the same original artist found for most of an album's songs, to look for the rest under that artist); trying the first words of the album title as the artist for cover albums; chorus re-insertion (needs the audio's repeated sections); remixes.
### D134 addendum 2 (2026-11-18, evening): instrumental confirmation, a better model found and tested, cover albums

- **Instrumental confirmation.** On Review > Lyrics > Instrumental each song has "Confirm instrumental" (after playing it), and one button confirms every song LRCLIB lists. Confirming writes the language tag `zxx` (ISO 639-2 "no linguistic content": `TLAN` in ID3, `LANGUAGE` in FLAC) through the tag patcher (new `TagField::Language`; only that field changes, the genre and audio stay, and the previous value is kept for undo). The song leaves the list and stays out of Missing lyrics; "Show the confirmed" lists them and "Not instrumental" restores the old language tag. The Lyric AI skips songs tagged `zxx`. The genre is deliberately not used as the marker.
- **Better studio model: found and tested** (`MediaVerse-Lyric-Sync-Lab\judge-lab`, scripts `identity_test.py`, `ctc_model_test.py`, `detector_test.py`, `live_vs_studio.py`, `baseline_timing.py`; 40 library songs with human-timed lyrics; nothing added to the program). No model exists that is trained specifically for English punk, rock and industrial; two music-lyrics CTC models (both w2v-BERT 2.0, about 0.6 B parameters, characters, trained on music, usable for forced alignment on the **full mix**, so no vocal separation step) were compared with the program's current wav2vec2 reader (separated vocals):

  | | current wav2vec2 | `mrfakename/w2v-bert-2.0-music-lyrics-ctc` (MIT) | `radiant-lyrics/sylla-600m-v1` (GPL-3.0) |
  |---|---|---|---|
  | Right lyrics rank first among 12 wrong ones | 39/40 | **40/40** | 39/40 |
  | Timing: lines within 0.5 s of the song's own offset (human stamps, a noisy proxy) | 83.1% | 85.0% | 83.0% |
  | Aligner's usual lateness | +165 ms | +155 ms | **about 0 ms** |
  | Swapped lines caught at 5% / 10% false flags (a stand-in for a singer straying) | 30% / 56% | 28% / 79% | **79% / 96%** |
  | Live tracks' median line score against studio (real To review songs, words confirmed by agreeing stamps) | (2.5% vs 3.1% of lines low) | 0.54 against 0.79 | 0.32 against 0.41 |

  Whisper large-v3 (MIT, already in the lab) on the same vocals catches swapped lines about as well as the current reader on its own (69% at 10% false flags, hearing nothing for about 14% of genuine lines); combined with the current reader 82%.
  **Findings:** every model identifies songs well (no wrong text chosen above "sure" in any test); timing against human stamps does not separate the models (about 83 to 85%: the stamps are the limit); line-level detection is where the new models are clearly better, but real live tracks also score lower for reasons that are not straying (crowd, a mix), and 7 to 12% of genuine studio lines still score low, so **no model is accurate enough to write `*` into lyrics by itself**; a hint in the review editor ("lines the AI is unsure were sung as written") is realistic. **Not adopted.** Using one in the program means an ONNX export (a community one exists: `redbaty/ytm-lyrics-aligner`, MIT, fp32/fp16/int8), the SeamlessM4T-style audio front end written in Rust (a golden file for testing it is provided), new calibration of every cut-off (the fit scale changes: right lyrics about -0.4 instead of -1.4), and the owner's approval of the model and its licence/provenance (`mrfakename`: MIT, training data undocumented; Sylla: GPL-3.0 weights, trained on commercial recordings with human-timed lyrics, data not released). Recommendation: `mrfakename` as the reader for matching and timing (fewer steps, better identity), Sylla only as the line-level hint if its provenance is acceptable.
- **Cover albums** (`cover_artists` in `lyric_ai/judge.rs`, second pass of the judge job). An album is a cover album when one other artist makes up most of the lyrics found under other artists (at least three songs and 60%), or when the album's title names that artist and two songs were found under it. Then (1) a pick by that artist is certain when few lines are doubtful, and (2) songs where nothing fitted are searched for under the original artist (`lyric_ai_song_as`). Artist names are compared allowing a typo in longer names ("Overation Ivy"). Real-data dry run on the 28 songs of "Operation Ivy Live at The Empty Bottle (Laura Jane Grace/Catbite)": the album was recognised and "Operation Ivy" found; searching under it settled 6 of the 7 songs that had matched nothing (Jaded and Unity at certain-level fits; Big City, Caution, Here We Go Again, One Of These Days likely; Story Time still nothing). Together with the 9 settled before, 15 of the album's 16 hard songs now have the right lyrics. The result line in the Lyric AI box says how many albums were recognised as covers.

## D135 (2026-11-18): Model list and selection, two Windows downloads, Linux as a roadmap goal

- **Owner:** open to using both lyric models; the person should be able to download and select their own model, so keep a list of known models ranked by test result with links or a download mechanism; when the program goes public, two PC downloads (without any model, and with the best licence-compatible model included); plan a Linux build for friends who use Linux (the owner has no Linux computer set up yet).
- **Asked and measured:** does `mrfakename` do better with the vocal separation step? No: on the same 40 songs identity is 40/40 either way, timing 85.0% on the mix against 83.8% on separated vocals, and swapped lines caught at 10% false flags 79% against 59%. Sylla is the same (identity 39/40 either way, lines 96% against 95%). Skipping separation saves about 35% of the processing on the owner's GPU (25.5 minutes of music: separation 14.4 s + current reader 4.4 s = 18.7 s, against 12.2 s for the new model on the mix; separation about 106x real time, the new model about 125x), about 8.2 h against 5.3 h per 10,000 four-minute songs. CPU-only speed of the new model is not measured. Skipping it also drops the 174 MB separator and its unstated weights licence, but the instrumental test uses the separated voice: the model's own vocal-activity head is the candidate replacement (to be tested).
- **Plans written (not built):** `docs/lyric-models.md` (known models and their ranking, how the ranking is made, the manifest, download, add-your-own and benchmark design, the build order, open questions), `docs/distribution-plan.md` (the two downloads and what goes in the bundled one), `docs/linux-plan.md` (what is Windows-only today, the steps, testing without a Linux computer).
- **Decisions still to take:** the provenance of both models' training data; whether Sylla (GPL-3.0 weights) may be bundled or only offered as a download; the fp16/int8 accuracy; the Linux decoder and TLS dependency choices; code signing before going public.

## D136 (2026-11-18): Model provenance accepted; both models selectable

- **Owner:** the training-data provenance of `mrfakename/w2v-bert-2.0-music-lyrics-ctc` and `radiant-lyrics/sylla-600m-v1` is acceptable for use on the owner's own library and for letting users choose them. `mrfakename` may be bundled in the "with model" download; Sylla may be used as the line-hint / benchmark model if its licence is acceptable. The speed gain from skipping vocal separation is wanted.
- **Still open:** whether bundling GPL-3.0 weights next to a GPL-3.0-or-later program is clean (until checked, Sylla is a download in the model list, not bundled); Linux decoder (Symphonia vs FFmpeg: asked; owner has no opinion); code signing (explained to the owner; decide before the first public release).

## D137 (2026-11-18): Both models selectable and a separate download; Symphonia; signing route

- **Owner:** keep `mrfakename` and Sylla both as options, Sylla as a separate download (not bundled); use **Symphonia** for decoding on Linux; apply to the **SignPath Foundation** for signing when the repository goes public; look into the Microsoft Store (researched: see `docs/distribution-plan.md`, free MSIX re-signing, packaging work and checks listed there).

## D138 (2026-11-18): Lyrics page reorganised; clearer counters; cover albums shown

- **Owner feedback after trying the build:** the Lyric AI box flickered and reloaded when confirming instrumentals; tab switches were slow; the counter ("to look at later: 555") was unclear; no cover-album indicator was visible; Steps 1 and 2 stay on every tab, so the page should be reorganised with the text moved into info windows and Step 3 split in two tabs; asked whether the Track numbers tab is needed.
- **Page:** Step 1 and Step 2 are cards with their title, an ⓘ button (a formatted floating window holds all the explanation; `info-popup.ts`) and the Start button underneath; they are built once and never redrawn when the tabs or lists change (the flicker). Two tabs under them: **General review** (every song that still needs lyrics in one list: songs with suggestions first, best first, then songs with nothing found yet; Review opens the existing editor with the drop-down of suggestions, plus **Find lyrics** inside it and for songs with no suggestions) and **Suspected instrumental** (as before, with Confirm instrumental). The Missing tab is gone (General review replaces it); the sidecar's review list is cached between tab switches (reading about two thousand entries was the slowness) and read again after a run, a save or "Check the library again".
- **Counters:** written into / **ready to check** (a timed result waiting in General review, certain or not) / nothing found or nothing to do / instrumental. With "write" unticked, certain results are also put in General review (they were hidden and counted as nothing). Tested (`lyric-ai-counts.test.ts`).
- **Cover albums:** the run says "Cover albums recognised: ..." as soon as one is found; the entries of a recognised album carry `cover_of` (kept when an entry is saved again) and the list shows a "Cover of ..." badge.
- **Track numbers in titles tab removed:** the lyrics lookups already try the title without the number, so it needed no manual step for lyrics. The tidy command (`find_tidy_titles`, `apply_title_tidy`) is still in the sidecar; a one-click "remove track numbers from titles" belongs under Fix tags if it is wanted.
- **Not done yet:** the cover-album second pass runs for the To review list only, not for Step 2 on songs with no lyrics.

### D138 addendum (2026-11-18, evening): the list follows the AI; chorus-first search

- **Owner feedback:** the first 500+ entries show 100% and spot checks are good; a new run seemed to start where the last stopped; Pearl Jam "Little Sister (Pulled the Covers)" (79%) has lyrics that all start with the first verse while the song opens with the chorus; some LRCLIB-timed entries are not well timed; the list should update as the AI works and show the match rising after the AI compares the singing with the lyrics.
- **Explained:** the 100% entries are AI-picked and re-timed (the AI's pick is promoted to the top of its entry); entries still showing "timed" without that are LRCLIB's own timing, not yet checked; running "The To review list" re-times them (its own stamps are kept only when they agree with the singing, otherwise the singing's timing is used). The new run "started in the same place" because songs checked in the last 30 days are skipped.
- **Built:** the General review list refreshes by itself every few seconds while the AI works (not while a song is open for review; scroll position kept); an AI pick is labelled "AI-checked against the singing" with a match percentage that shows how well the words fit (certain 100; otherwise 70 to 95 by fit); the progress shows how many songs were skipped as already checked, and "Also redo songs checked before" checks them all again (use it after an improvement, such as the timing fix).
- **Chorus-first search** (`arrangements`, `repeated_block` in `judge.rs`): when a suggestion fits the singing poorly, the AI also tries it with its repeated block (the chorus) moved to the front or placed before the first verse, and keeps that only if it fits at least 0.4 per letter better. Tested on small cases. On the real "Little Sister" entry it did not apply: those 22 written lines fit at -7.0 and contain no repeated chorus, so the lyrics found are for a different arrangement of the song, not just a different order. Songs like that need lyrics drafted from what is sung (a transcription model), which is future work; until then they stay in General review unchanged.

## D139 (2026-11-18): Batch approval in General review

- **Owner:** select songs in batches: tick one, shift-click further down and everything between is ticked, then a button to approve and save to the songs.
- **Built** (`lyrics-select.ts`, `lyrics-review.ts`): a checkbox before each Review button for songs with suggestions; shift-click ticks (or unticks) the whole stretch between two rows; a box in the header ticks every shown song with suggestions; "Tick the AI-checked at 90% or more" for the common case; **Approve and save to songs** saves the *first* suggestion of every ticked song (the AI's pick comes first) into the song, time-stamped when it has times, as one journalled batch (`approve-<time>`), then takes the song off the list. A confirmation says how many were saved, how many are plain words and how many were not AI-checked. Songs that fail stay in the list with the reason. Selection survives the list refreshing itself, and the automatic refresh pauses while anything is ticked so rows do not move under the clicks. Tested: range selection (unit test) and the whole flow on a throwaway library (`capture-lyrics-review.cjs`).

## D140 (2026-11-19): The music-lyrics reader is built into the engine (opt-in)

- **Owner:** work on the steps needed to adopt the new lyric models (he had thought it was done).
- **Done** (`docs/lyric-models.md`, build order steps 1 to 3 and part of 5 and 6):
  - **ONNX:** the community export `redbaty/ytm-lyrics-aligner` (MIT) of `mrfakename/w2v-bert-2.0-music-lyrics-ctc` was downloaded to the lab and its checksums verified. fp16 on the GPU matches the original model (letters agree on 99.8 to 100% of frames, median log-probability difference 0.006) and reads a 28 s window in 0.1 to 0.3 s. The int8 file needs an ONNX Runtime operator (`ConvInteger`) that the Python build lacks: not used.
  - **Front end in Rust** (`crates/lyric-engine/src/seamless.rs`): the Kaldi-style filter banks of `SeamlessM4TFeatureExtractor`, no Python. Tested against the exporter's golden file (`tests/fixtures/frontend-golden.json`, MIT, from the same repository): largest difference 0.00017.
  - **Reader abstraction:** `ReaderModel` (`Wav2Vec2` = separator plus speech reader, the default; `MusicBert` = the music reader on the full mix, no separator) in the engine; `BertReader` reads 30 s windows with 2 s context. Settings (`lyric-ai.json`): `reader_model` (`wav2vec2` or `music`), `music_onnx`, `music_vocab`, chosen in Settings > Lyrics > Lyric AI; file names only, no folders; the status lists exactly the files the chosen reader needs. The owner's setting is not changed: it stays on the original reader until he opts in.
  - **Calibration, per model** (`FitLimits` come from the reader in use): on 160 To review songs the music reader fits right lyrics (own stamps agree) between -1.68 and 0 (median -0.56) and wrong ones between -5.6 and -2.05 (median -4.1); the speech reader: right -3.3 to -0.6, wrong up to -2.8. Music reader floor -2.0 (every right text passes, no wrong one) and certain at -1.4 (97% of right, no wrong one). It decides "certain" for 75 of 160 songs against 42 for the speech reader, with the same agreement on which songs are right (40 of 70 against 39 of 67).
  - **Instrumental rule without the separator:** the share of 20 ms frames in which the reader hears letters, on the mix: at most 3% means probably instrumental. 59 of 60 instrumentals caught, 0 of 60 songs with lyrics flagged (the old rule caught 48 and flagged 1). Songs with lyrics hear letters in 6 to 17% of the frames.
  - End to end on real entries through the sidecar's own judge: right lyrics fit at -0.2 to -1.3, with 0 to 3 doubtful lines in the songs that agree.
- **Speed:** with no separation step, about 35% less processing on the owner's GPU (measured earlier).
- **Not done:** the line-flag rules (`flag_lines`: a long unsure first word, a gap inside a line) were tuned on the speech reader's scores and are not recalibrated for the music reader (it flags fewer lines; the timing against human stamps is the same, 85% within 0.5 s); the manifest, the in-app download and "Test this model" benchmark; Sylla's ONNX export; a vocal-activity or "sung" hint from the model's own heads; the model files are copied by hand into the Models folder for now (download from the redbaty repository: `aligner-fp16.onnx` and `vocab.json`).

## D141 (2026-11-19): What the first full pass showed, and the fixes

- **Owner's pass (about 1,100 of 2,000, then stopped):** about 150 "nothing found or nothing to do", 7 "could not be read"; asked for a look at what the model heard against the lyrics.
- **Unreadable songs:** 24 of the saved errors were 48 kHz MP3s (the defect scanner's decoder refuses anything but 44.1 kHz; the Lyric AI used it); the rest were dropped connections to LRCLIB (`tls_failed`, `connection_failed`) that were remembered as "checked" for 30 days. **Fixed:** the Lyric AI decodes with its own listening decoder that brings other sample rates to 44.1 kHz (`decode_for_listening`), and a song that could not be read is no longer remembered (38 old error markers removed from the data folder so those songs are tried again; the one whose file is gone was left).
- **Where nothing fitted (487 of 1,086 songs with no lyrics, 127 of 1,120 on the To review list):** a re-run of 45 of them against the real LRCLIB with the music reader rescued only 3. Reading what the model heard beside the best candidate: most (about 70%) have no record of their own on LRCLIB, so the candidates are other artists' songs with the same title ("Hard Feelings" by Fleetwood Mac for a punk band's song): refusing them is right. The rest: live stage banter (Catbite's "Story Time"), wordless or processed vocals, spoken parts, and a few songs whose own record exists but fits poorly (live or other versions).
- **Small defects found and fixed:** two records of the same song (same artist and title, lyrics worded a little differently) were refused as rivals (7 of about 600 refused songs; Deftones' "Rapture" fitted at -2.21 and -2.25): they now count as one song (`merge_same_song`); a "likely" match was given to a song in which the reader heard letters in 2% of the frames (a short text over silence fits cheaply): the judge now sends songs with almost no singing to Suspected instrumental instead of looking for lyrics.
- **What the model hears, measured** (40 library songs, raw reading against the true lyrics): the music reader's greedy reading has a median word error of 36%; Whisper large-v3 (MIT) on the separated vocals 23%, better in 39 of 40 songs. So lyrics drafted from the audio (for the roughly two thirds of failed songs that nobody has lyrics for) are worth building, on Whisper rather than on the music reader's own reading; typical errors are glued or split words, unstressed words ("an" for "and"), and non-words in sustained or screamed notes. Not built: it needs Whisper in the program (a model of 1 to 3 GB, ONNX or whisper.cpp) and a way to correct the words in the review editor, which edits times only today.

## D142 (2026-11-19): Whisper drafts for songs nobody has lyrics for

- **Owner:** add Whisper as another separate downloadable model and make use of it; list the 48 kHz songs (65 MP3s, listed in the lab: `judge-lab/out/non-44100-mp3s.csv`; converting them is optional now that the Lyric AI reads them).
- **Model:** `onnx-community/whisper-large-v3-turbo` (OpenAI's MIT-licensed weights, ONNX export): `onnx/encoder_model_fp16.onnx` (1.27 GB), `onnx/decoder_model_merged_fp16.onnx` (344 MB), `vocab.json`, `generation_config.json`; a separate download, like the music reader. Turbo was as good as the full large-v3 on 20 songs (median word error 32% against 36%) and five times faster; hallucination guards did not help; separated vocals were worse than the plain mix (36% against 32%), so no separator is needed. About 110 times real time on the GPU, 2.1 s for a 70 s excerpt through the Rust code (20% word errors there).
- **Rust** (`crates/lyric-engine/src/whisper.rs`): Whisper's log-mel front end (matches transformers' features to 0.000008, golden test), the encoder and a greedy decoder with the merged decoder's key/value cache (one placeholder position for the first step: ONNX Runtime builds no empty tensors), GPT-2 byte-level token decoding, 30 s windows, a loop stop. Not done: beam search, timestamps (a first attempt at timestamp decoding with seeking was worse, median 58%, and was dropped), temperature fallback; the gap to faster-whisper's tuned search (25% against 32%) is mostly the bad tail of songs where greedy decoding loops.
- **Drafts** (`lyric_ai/draft.rs`, command `lyric_ai_draft`, Step 2 option "Songs nothing was found for: write a draft by listening (Whisper)"): the song is listened to by the music reader (it must be the chosen reader), Whisper transcribes the mix, the words are cut into lines, the music reader scores how well they fit the singing and times them. **The draft's fit predicts its word errors (correlation -0.88, 40 songs)**: -0.5 or better is "good" (about one word in five wrong), down to -1.0 "fair", below that "poor" and not kept. Match percentage 80 down to 40. A draft goes only to General review (label "AI draft from listening: check the words", source `whisper-draft`), never into a song by itself; songs with suggestions already are left to the judge; songs with almost no singing go to Suspected instrumental instead. The review editor got a pencil next to every line to correct its words (times stay).
- **Real data** (30 songs where nothing fitted on LRCLIB): 14 good drafts, 8 fair, 5 poor (not kept), 3 probably instrumental; about 5 s per song. Drafts read like the real lyrics.
- **Settings:** `whisper_folder` (default a `whisper` folder inside Models), status `whisper_ready` and the files missing, a row in Settings > Lyrics > Lyric AI.
- **Not done:** a one-click download (the manifest and download mechanism of `docs/lyric-models.md`), beam search, and word-level hints in the editor (which words Whisper was unsure of).

## D143 (2026-11-19): One roadmap; documents made consistent

- **Owner:** make sure there is a clear road map for the project, testing and going public; check the documentation is consistent.
- **Done:** `docs/roadmap.md` is the one plan (state, roadmap in five steps, testing plan, going-public gates, decisions waiting for the owner); `docs/README.md` indexes every document and says how to keep them consistent. Stale statements fixed: "not installed / not pushed" notes in `docs/outstanding.md`, the README's status (2026-11-07), ADR range (0001 to 0007, now 0009), tech stack rows (casting "not built", lyrics), repository layout (android, lyric-ai, lyric-engine, tag-repair), the lyric plans' "nothing chosen yet / not built" lines, the distribution plan's pending provenance question (accepted D136), the Project Brief's "remaining order", the release checklist's run-together items 7 and 8 (and new items 9 and 10), AGENTS.md (points to the roadmap).
- **Found while checking going public** (`tools/check-before-public.ps1`): the repository is private; old commit metadata holds personal emails (24 commits a personal address, 3 commits a second personal address: decide between rewriting history and a fresh history); personal user-folder paths in 5 files and the owner's first name in 11 files; five fixture placeholder addresses are now on the script's allow list. **CI had never run on `lyric-sync`** (it covers `main` and `spike/**` only): the workflow now also runs for pull requests into `main`.
## D144 (2026-11-19): A Lyric AI run says why songs fail, and stops when the same failure repeats

- **Found:** the owner's whole-list pass (To review, "also redo songs checked before") went through the list in seconds with "could not be read: 407" and Stop took several tries. After restarting the app and running Check library, the same settings worked (35 of 2,012 done normally). A dry run of the judge on the real list worked (engine, models, audio fine). **The cause was not proven:** the panel showed only a count, and failed songs are not saved anywhere. The first suspect, "no library folder chosen", is unlikely on reflection, because the folder is stored in the database and loaded at start. Other suspects: the engine failing to load (GPU), or a state that a restart clears.
- **Changed:** the panel now shows the first failure reason beside the count ("could not be read: 407 (reason)"); the three runs (analyse, judge, draft) stop by themselves after 10 songs in a row fail with the same message (`FailStreak`, `MAX_SAME_FAILURES` in `lyric_ai.rs`) and the summary says why (`aborted`). Mixed failures or a song that works in between never trigger it.
- **Next time it happens:** the reason is on the panel; write it into this entry.

## D145 (2026-11-19): Approving a suggestion that is already in the song counts as done

- **Found:** the owner ticked about 650 songs at 90% or more and approved them: 407 saved, 224 "could not be saved: this song already has lyrics". Checking the 224 on disk: 222 already carry timed lyrics (SYLT), 220 with the same words as the suggestion; their files were last written on 2026-11-17/18 by the earlier Lyric AI runs that wrote the certain results. The overnight redo then put them back under To review, because that run does not write.
- **Changed:** a batch write of timed lyrics into a song that already holds timed lyrics with exactly the same words (case, punctuation and timing ignored) now succeeds without writing and without a journal entry (so undoing the batch never removes lyrics the batch did not add); the song leaves the list. Songs whose existing lyrics differ are still refused, as before: lyrics are never replaced in a batch.
- **Still open:** the judge should not put a song under To review when its suggestion is already in the song (it should drop the entry itself); the 80-90% group (start of the track off, live versions with phrases the written lyrics lack) belongs to Step 2 items 5 to 7 of the roadmap.

## D146 (2026-11-19): A first line squeezed in at the start is never "sure"; the first timing diagnostic

- **Diagnostic** (`a_timing_diagnostic_by_match_band`, an ignored test; read-only, songs timed afresh without the AI's earlier timing): 39 songs at 100% against 39 at 80 to 89%. At 100%: median 0% of lines doubtful, 38 of 39 sure, 13% live-ish albums. At 80 to 89%: median 14% doubtful, 27 of 39 review, 33% live-ish. Doubtful lines are commonest at the start (19% of the first tenth of the lines, 13% in the middle, 16% at the end); the first line is doubtful in 9 of 39 songs against 2 of 39.
- **The owner's "start of the track is off" is one concrete fault:** the first line is placed under a second into the song while the next line starts 8 s or more later (Break Free 0.3 s then 17.6 s; Red 0.4 then 12.0). 5 of 39 songs at 80 to 89%, 0 of 39 at 100%. One of the five (Disarm) was "sure": the share rule (10% doubtful) lets a single doubtful line through.
- **Changed:** `first_line_stuck` (`lyric_ai.rs`): such a result is never "sure" (both the judge and the Step 2 analysis), so a person looks at it. Nothing already written is changed.
- **Already written:** a scan of the 8,057 batch-written songs with timed lyrics found 139 with this shape: 114 from the automatic lyrics (LRCLIB's own timing, `lyrics-*` batches), 25 from the Lyric AI (15 in the 2026-11-19 approval, 10 in earlier runs). List: `Developer\songs-with-first-line-at-start.txt`. Some may be genuine; to be checked by ear.
- **Not done (a repair, not only a guard):** re-time that first line (search for where the singing starts before line 2) so more of the 80 to 89% songs reach "sure". It needs the owner's ear on the five songs above and the 25 written ones to know whether the first line is really wrong, and a vocal-activity hint (roadmap Step 2, item 8). Live albums are a third of the 80 to 89% band: lines the artist did not sing as written (Step 2, item 7).

## D147 (2026-11-19): Another record of the same lyrics counts as done; pages in General review; Step 2 tick boxes

- **Found:** after D145 the owner still saw 27 songs refused ("this song already has lyrics"), starting with Crashland and All Fantastic Images. Both hold timed lyrics written by an earlier Lyric AI run, and the suggestion now first in the list is another LRCLIB record of the same song ("like a beautiful place" against "like such a beautiful place"; a spoken "instrumental" marker in another). Of the 1,367 entries in the list, 30 had lyrics in the file: 12 identical words, 19 with 90% or more shared words, 8 with 70 to 90%, 3 different.
- **Changed:** a batch write into a song that already holds timed lyrics succeeds without writing (and without a journal entry) when 90% or more of the words are shared in order (`SAME_LYRICS_SHARE`, longest common run of words; `word_similarity` in `library_media.rs`). Lyrics that differ more are still never replaced in a batch, and the refusal now says how much matches ("this song already has different lyrics (72% of the words match)"). To replace them the owner opens the song with Review.
- **Step 3 (General review) now has pages of 100 songs** (`pager.ts`, `pager-pages.ts`) instead of "show 200 more": Previous, page numbers, Next, above and below the list, and "Showing 801–900 of 1,600 songs". Up to eight pages are all listed; more: the first and last page, the current page with two each side and "…" (page 8 of 16: 1 … 6 7 8 9 10 … 16; near either end the first or last six pages are listed; a gap of one page shows that page). The current page is in the accent colour. Ticks stay when the page changes; "Tick the AI-checked at 90% or more" now ticks the songs on the current page only.
- **Step 2 (Lyric AI) box:** the two tick boxes ("Write the results that are certain", "Also redo songs checked before") stand one under the other below Start and Work on, so the second no longer moves with the window width; a line under them says a song checked in the last 30 days is skipped unless "redo" is ticked. No separate "clear results" button: that tick box does the same without deleting records.

## D148 (2026-11-19): A first line lit from the start is a small fault; what matters is lyrics shown late or gone early

- **Owner's first answers (songs 1 to 6 of the first-line check):** 4 of 6 are a spoken or counted intro (live tracks: first line really sung at about 31 s, 17 s, 13 s, 14 s) and 2 really do start that early (Ballyhoo!, Catbite, the latter with a long gap to line 2). Their words: a first line lit from the start of the song "doesn't really hurt the playback of the lyrics and is easy to overlook. It's not as nice as having it perfectly timed. The real issue with time synced lyrics is having the lyrics so badly timed that the lyrics haven't shown up yet or have already scrolled off the page."
- **Consequence for D146:** the "first line stuck at the start" shape is mostly a live-track intro, not a timing failure. The guard that keeps such a result from being "sure" is likely too strict (it keeps harmless songs in the review list). To decide after more answers: turn the guard into a mark only, or keep it only when other lines are also doubtful. The measure that counts is how far lines are from the singing in the middle of the song, not the first line.
- **Check page:** `Developer\first-line-check.html` got a fifth verdict, "Talk/intro first" (with the time line 1 is really sung), so intros are told apart from "Wrong" (lyrics badly timed); the owner's answers for songs 1 to 6 are pre-filled.

## D149 (2026-11-19): The first-line shape is harmless (D146 undone); weak-fit "sure" results are reviewed

- **Evidence:** the owner checked 47 of the 139 songs with a first line at the start (all 25 written by the Lyric AI and 22 by the automatic lyrics) in `Developer\first-line-check.html`: 33 open with talking, a count-in or an instrumental part (or the lyrics begin with a line that is not sung: a note, "(instrumental)", the title), 11 really start that early, 3 had lyrics that do not belong to the song, and **none was badly timed**. Where a time was given (33 songs) the second line was within 6 s of the real singing in 30. The owner: "a very slow process for humans", so no more of the list is to be checked.
- **Changed (undoing D146's block):** `first_line_stuck` is still recorded in the result but no longer keeps a result from being "sure". The shape is not a fault.
- **The real faults found:** three songs written in the 2026-11-19 approval batch (`approve-1795139815259`), all marked "sure" by the judge: Joystick! "Semicolon" (an instrumental), Kill Lincoln "Coming Or Going" (the lyrics are not this song's) and Meat Beat Manifesto "Teargas" (samples, an instrumental). Their fits were -2.91, -3.47 and -3.23; the right songs in the same list were all above -2.8. They were "sure" because agreeing time stamps count as proof (`corroborated`).
- **Changed:** agreeing stamps make the words certain only when the fit is also at least -2.8 (`CORROBORATED_MIN_FIT`, `corroborates` in `judge.rs`). Of the 719 "sure" results on record, 26 are below it, so a few more songs get a look and none get less. The thresholds come from 25 songs; if a pass shows good songs falling out, revisit.
- **Done afterwards (owner's say-so):** the lyrics (USLT and SYLT) were removed from the three songs through the program's own tag writer (`lyrics: {clear: true}`); nothing else in their tags changed, and copies of the three files from before are in `Developer\lyrics-removed-backup-2026-11-19`. The owner wishes the whole library could later be run through the AI to flag obviously wrong lyrics (roadmap, Step 2, item 9).
- **Not done:** the two instrumentals (Semicolon, Teargas) were not marked instrumental. The 80 to 89% group's real problem is not the first line; a measure from songs the owner calls badly timed (lines late or gone early) is still missing, and the first-line check found none.

## D150 (2026-11-20): The doubtful-line flags were recalibrated against people-made time stamps; the 10% rule stays

- **Why:** the 80 to 89% group stayed in review because of its share of doubtful lines (median 19%), and nobody knew whether those flags meant anything: they were tuned on the speech reader.
- **Measured (new ignored test `a_flag_calibration_run`, read only):** 80 songs from To review whose suggestion carries people-made time stamps were timed afresh with the music reader and every line's start compared with its stamp (36 songs, 1296 lines, kept where the stamps agree with the singing as a whole: median error within 0.5 s of the song's usual offset). 8.9% of those lines are more than 2 s from their stamp.
  - **The old flags were nearly worthless:** 10.7% of lines flagged, 18% of them really off, 20% of the off lines found; per song the share flagged even ran the wrong way (correlation -0.27 with the share really off). The old "gap of 1.2 s early in the line" was wrong 87% of the time (held notes and breaths).
  - **The line score is the best single sign:** under 0.1 is 72% right on 2.2% of lines; under 0.2 is 51% on 5.4%; a first word held over 2 s is 71% right.
- **Changed (`flag_lines`, `crates/lyric-ai/src/align.rs`):** flag a line heard poorly (score under 0.2, new flag "line barely heard"), a first word over 2 s or over 1 s and unsure, and a gap over 3 s (was 1.2 s) early in the line. On the same lines that is 8% flagged, 50% of them really off, 43% of the off lines found, and per song the share flagged now follows the share really off (+0.44). New unit tests in `align.rs`; the golden test no longer compares flags (they are not the prototype's any more).
- **Changed (`doubtful_lines`, `judge.rs`):** when a suggestion's own stamps are kept (they agree with the singing) the written time is the people's, so a line the aligner doubts counts only when the aligner and the stamp disagree by more than 1.5 s.
- **Effect on the judge (40 songs per band, no stamps of their own, read only):** 100%: 27 sure (was 38; median 4% flagged, 11% at the upper quarter); 90 to 99%: 16 sure; 80 to 89%: 4 sure (median 19% flagged). More songs go to a person because the flags now find real faults, not because the songs are worse.
- **The 10% rule is left as it is (owner's choice if it should change):** only about 43% of the really-off lines are caught, so a song with 15% flagged lines probably has more than 7% lines off; loosening the rule writes more songs with some lines clearly late. At 15% the 100% group would pass 32 of 40 and the 90 to 99% group 27 of 40.
- **Not done:** a marker for lines that are off but not flagged (recall is 43%); the vocal-activity hint (roadmap, Step 2, item 8) is the next candidate for finding them.

## D151 (2026-11-20): Owner's answers to the open questions

- **Merge `lyric-sync` into `main`:** approved (pull request #4, merge commit, not squashed).
- **Default reader is the music-lyrics reader.** `reader_model` now defaults to `music`; the speech reader (and with it the Demucs separator) stays selectable and is kept when chosen. A computer with no model files shows what is missing in Settings > Lyrics > Lyric AI. Demucs leaves the default path. `THIRD_PARTY_NOTICES.md` now lists every model with licence and status.
- **The 10% doubtful-line rule stays (D150).** The owner can tick extra songs in General review and approve them.
- **Whisper and Sylla are separate downloads, never bundled.** The program should help: the person may download the model from the project's own copy (a GitHub release holding the MIT/GPL licence text and the files; a release file is limited to 2 GB, Whisper's two ONNX files are 1.27 GB and 0.34 GB), or download the latest revision themselves from the model's own page and tell the program the folder. Either way the SHA-256 is checked before the model is used. Not built yet (roadmap Step 2, item 1).
- **Library-wide wrong-lyrics check:** wanted. The person chooses whether songs already marked instrumental are included or left out. It lists, never removes (roadmap Step 2, item 9).
- **Phone share server gets a pairing step** like the computer's ("Pair a TV" / "Pair a speaker"): nothing may pair until the person arms it.
- **Going public:** the history is rewritten to the GitHub no-reply address now (a fresh history may still be chosen before the repository goes public); personal paths and the owner's first name are scrubbed from the docs; no date is set. When going public the version becomes 0.9.0 and `docs/version-bump-checklist.md` lists every place to change (including the Google and Samsung/Tizen developer entries); `docs/google-play-beta-testing-guide.md` explains the testing record Google asks for.
- **Later:** TheAudioDB and Fanart.tv artist photos (a future session). Linux decisions wait; Rust-native libraries are preferred when well supported.

## D152 (2026-11-20): Library-wide wrong-lyrics check, and an engine crash fixed

- **Built (Review > Lyrics, a new card under Step 2, "Check the lyrics already in your songs"):** commands `lyric_ai_wrong_check` (a background job), `lyric_ai_wrong_results` and `lyric_ai_wrong_dismiss`; module `apps/sidecar/src/lyric_ai/wrongcheck.rs`; page `web/app/src/lyric-wrong-panel.ts`. Every MP3 that already has lyrics (plain or timed, at least 12 words) is listened to and its lyrics are forced into the singing with the music-lyrics reader. Lyrics that fit worse than -2.8 (the D149 threshold) are listed with their fit; "The lyrics are fine" keeps a song off the list. **Nothing is ever changed or removed.**
- **Owner's choice, as asked:** a tick box "Include songs marked as instrumental" (off by default; lyrics on a song marked instrumental are exactly what the check can catch, but they can be left alone). A second box redoes songs checked in the last 30 days. Results are kept in `lyric-ai/wrongcheck`.
- **The verdict:** "does not fit" (fit under -2.8), or "no singing" when the singing detector doubts there is singing *and* the words do not fit (or cannot be placed). Words that fit are never listed, whatever the detector says: first version listed 6 of 17 industrial and sample-heavy songs (Nine Inch Nails "Ruiner", "La Mer") only because the detector doubted their screamed vocals; they fit at -2.0 to -2.3.
- **Checked on real songs (read only, `a_real_data_check_of_lyrics_already_in_songs`):** the three songs with wrong lyrics removed on 2026-11-19 (copies in `Developer\lyrics-removed-backup-2026-11-19`) are all caught (fits -7.64, -3.47, -5.65); of 48 songs from the first-line check playlist none was listed; the weakest right ones were -2.79 (Dropkick Murphys "Watch Your Back"), -2.72 and -2.54, so the threshold has little room: a few live or sample-heavy songs may be listed by mistake, which is why a person decides.
- **Engine crash fixed (`crates/lyric-engine/src/models.rs`, both readers):** when the last 30-second window of a song left almost nothing after its 2 s of context, the first kept frame lay past the model's output and slicing panicked ("range start index 92100 out of range for slice of length 91179"). Found on the first real run of this check; the same code runs in Step 2 and the judge. The start is now clamped to the frames the model returned.

## D153 (2026-11-20): The phone needs "Pair a TV or speaker" before anything can pair

- **Why:** the computer only lets a TV start pairing after someone presses Pair a TV (D133), but the phone's own share server answered `/api/pair` from any device on the home network once sharing was on.
- **Changed (`ShareServer.kt`, `MainActivity.kt`, phone `main.ts`/`native.ts`):** `/api/pair` answers 403 `not_armed` ("On the phone, open Settings > TV and press Pair a TV or speaker") until the person presses the new button in Settings > TV; that opens pairing for 5 minutes for one device and closes again after a successful pairing (or when sharing stops). A device already pairing keeps going. The button shows "Pairing is open" with the minutes left. The browser mock in `native.ts` follows the same steps.
- **Built, not installed:** the debug APK builds (`tools\build-android.ps1`); it is not on the phone. The TV app shows the server's message for `not_armed`; **not tried with a real TV.** A speaker (Cast or DLNA) never pairs, so the button's second name only tells people where to look.
## D154 (2026-11-20): `lyric-sync` merged into `main`; the commit history was rewritten to the no-reply address

- **Merged:** pull request #4 (merge commit; CI green on the final head). `main` now holds the Lyric AI round (D120 to D153). The `lyric-sync` branch still exists on the remote and may be deleted.
- **History rewrite (owner's instruction):** every commit that carried one of the two personal addresses (27 commits) now carries `a GitHub no-reply address`, as author and committer, through `git filter-branch` on all branches and tags. File contents are identical (no diff against the old `main`); every commit hash changed and was force-pushed (`main`, `lyric-sync`, four tags). **Hashes written in earlier docs, diary entries and notes (for example `50557fa`, `42980db`, `d78ca96`) are the old ones**; the full old history is in the mirror `Developer\MediaVerse\repo-backup-before-history-rewrite-2026-11-20.git` (a bare clone, to be kept until the owner is sure).
- **Not changed:** author *names* (they are the owner's full name and a second name on 3 commits); only the email addresses were asked for. `tools/check-before-public.ps1` now ends with nothing found for addresses.
- **What the rewrite cannot do:** GitHub keeps read-only references to the old commits under `refs/pull/1/head`, `refs/pull/2/head` and `refs/pull/4/head`, and cached commit addresses may work for a while. They cannot be deleted by the owner (only GitHub Support can purge them). **So this rewrite does not make the old addresses unreachable on GitHub.** For a public repository either ask GitHub Support to purge the pull request references and cached views, or publish a fresh history (a new repository, or this one recreated), which the owner already keeps open.
- **Scrub of the tracked files (same day):** personal paths, the owner's first name and the addresses were removed from the documents, scripts and test fixtures; the check reports no personal-looking addresses in tracked files.
## D155 (2026-11-20): Song length decides which pre-timed lyrics to prefer, never whether the words are right

- **Owner's rule:** the most important evidence is the artist's name and the song's name, or finding out that the song is a cover of another and checking against the original's lyrics. The library's song length only helps choose the best pre-timed (time-stamped) lyrics among the candidates.
- **Was:** `confidence()` in `apps/sidecar/src/lyrics_lookup.rs` took 92 minus the length gap for the artist's own recording, and 70 minus up to 20 for another version of it, so a live or re-released version of the right song with a very different length scored 50, below the Lyric AI's default floor of 60: the AI never listened to it. Another artist's recording (a cover's original) scored 50 too.
- **Now:** the artist's own song of that title scores 84 whatever its length; a length within 5 s (the time stamps fit) adds 8, within 20 s (they can be lined up) adds 4; no length to compare earns no bonus. Another artist's recording of that title (the original of a cover) scores 56, which with the title match reaches the judge's floor of 60, so covers are judged by listening by default, after the artist's own. The same title as written, the same album and time-stamped lyrics still add a little. `rank()` is unchanged: the same length first, time-stamped first among those, then the closest length. LRCLIB's exact request still includes the length; when it finds nothing the search by names goes on regardless of length (that was already so). Which result Step 1 writes by itself is unchanged (a sure match only).
- **Effect:** more songs with a right-words record of another length are judged by the AI by default (they were under 60 and skipped); the AI still decides by listening, and writes only certain results.
- **Test:** `confidence_follows_the_names_and_length_only_picks_the_pre_timed_version`.
## D156 (2026-11-20): Commit emails are the project address; a second rewrite

- **Owner's instruction:** use `contact@mediaverse.studio` instead of any personal address. Every commit in this repository and in the website repository (`mediaverse.studio`) that carried a personal address or the GitHub no-reply address of D154 now carries `contact@mediaverse.studio` (author and committer), rewritten with `git filter-branch`, contents identical (no diff against the previous `main`), and force-pushed (all branches and tags). Commits made by GitHub's web merge keep GitHub's own committer address. `tools/check-before-public.ps1` reports nothing found for addresses. Both repositories' local `user.email` is now the project address (the machine's global Git setting was not changed).
- **Backups (kept until the owner is sure):** `Developer\MediaVerse\repo-backup-before-history-rewrite-2026-11-20.git` (before D154), `repo-backup-before-email-rewrite-2-2026-11-20.git` (between the two rewrites) and `website-repo-backup-before-email-rewrite-2026-11-20.git`. All hashes in notes written before 2026-11-20 evening are old.
- **Still true (see D154):** GitHub keeps the old commits under `refs/pull/*` of the main repository until GitHub Support purges them; author *names* were not changed.
## D157 (2026-11-20): Cancelling a rip works even when the drive is stuck

- **What happened (owner's re-rip, same day):** a speck of dirt (probably) held the secure reader on track 11 for a very long time; Cancel did nothing visible; the owner ejected the disc and put in another, and the page stayed on "Cancelling…" for good. Found while it was still stuck: `mediaverse_cd_helper.exe` had used 530 s of CPU in 46 minutes and was then in a kernel wait with one thread; the sidecar had asked it to cancel and was waiting for its answer.
- **Cause:** (1) the helper looked at the cancel flag only between *segments* of 750 sectors (`read_track`), not inside a segment, and one segment on a damaged spot is up to 750 sectors x 20 re-reads x the drive's own recovery time; (2) a single `cdio_paranoia_read_limited` call cannot be interrupted at all, so once the drive hung in one the helper never reached its next check; (3) the sidecar, after asking for the cancel, waited for the helper's answer with no limit, so the page waited with it.
- **Changed:** (a) the secure reader checks the cancel flag before every sector (`SecureReader::read`, `LibcdioDrive::cancel`, set by `run_rip`), so a cancel lands within one sector's re-reads; (b) **hard fallback in the sidecar** (`apps/sidecar/src/helper.rs`, `HelperHandle`): after a cancel request the helper has 15 seconds; if the process is still running it is ended and the job finishes as "cancelled" ("The drive was busy with a read it could not break off ... Tracks already ripped are kept."); every job that uses the helper (rip, re-reads, drive check) gets this; each track is written only when complete, so ending the helper loses just the track in progress; (c) the rip page says when nothing new has happened for 2.5 minutes ("the drive is probably struggling with a scratch or a speck of dirt. Cancel stops it...") and, if a cancel takes more than 20 s, says the helper is being ended.
- **Tests:** `a_helper_that_does_not_stop_after_cancel_is_ended` and `a_helper_that_stops_by_itself_is_not_troubled_again` (a stand-in process). **Not tested on a real damaged disc or an ejected one:** the per-sector check lives in the native helper (GNU build), which has no hardware-free test; try it with the same disc.
- **Not changed (owner's choice):** the first pass still allows 20 re-reads per sector (paranoia's default); a retry pass uses more (`40 x (pass - 1)`). A shorter first-pass limit and a time limit per track (give up on a track, mark it, go on to the next) would stop a dirty spot from costing so much time; the later retry pass could then try harder. Not decided.
## D158 - CD-Text read from the disc (2026-11-20)
- The owner's new MxPx disc ("Living in the Chaos") was in no database, but Windows Media Player listed all 13 titles in capitals. Cause: the disc carries CD-Text (names stored on the disc itself); Media Player reads it and MediaVerse did not (D107 listed it as "not built").
- The CD helper now reads CD-Text (libcdio `cdio_get_cdtext`) and adds it to its `read_toc` reply. The lookup turns it into an album candidate (source "cd-text", exact: it is this disc), used only when no database matched the exact disc. Capitals-only text is turned into title case ("THE GOOD DAYS" -> "The Good Days"); mixed-case text is left alone. No year, genre or cover art come from it.
- Not yet tried against a real disc (the app was running).

## D159 - Editable album table on the Rip page (2026-11-20)
- Owner: the hand-entry form (one tiny titles box) was poor, and a found album should look like the tag editor's album view. The Rip page's step 2 now shows one table for both a chosen release and an album entered by hand: album, album artist, genre and year boxes, then a row per track with a tick (rip it), number, editable title, editable artist and the disc's length. What is ripped is this table: a chosen release with the person's edits, or the typed album (sent as a candidate with source "manual", so per-track artists work too).
- Smart fill: changing the album artist carries down to the tracks that had the old one (or none); a track with its own artist keeps it. "Paste all the track titles at once" fills the rows (numbers in front are dropped only when every line has one in order, so "99 Luftballons" stays whole).
- Choosing another release marks what it changed against what was shown: outlined boxes (hover shows the previous value) and one sentence naming the differing fields and tracks. Capital-only differences do not count.
- Logic is in web/app/src/rip-album-edit.ts (unit tested); the page is rip-page.ts. Not yet seen on screen by the owner.

## D160 - CD-Text is the base of a lookup (2026-11-20)
- Owner: the disc's own text should be the gold standard, with the online databases filling the gaps for identification and tagging. (CD-Text had been ignored only because D107 left it "not built"; it was never a choice.)
- A lookup now starts from the CD-Text names (album, artist, each title and track artist). An online release with this disc's number of tracks whose titles agree (at least 4 in 5, ignoring capitals and punctuation) is kept wearing the disc's names, and keeps what the disc cannot say: year, genre, cover art, edition, ids. Where an online name is only the same name set better (capitals, typographic apostrophes) the online spelling is kept. When every title agrees the release counts as this exact disc. A release that disagrees is shown as another album, behind. With no agreeing release, the disc's own album comes first on its own.
- D158's rule "only when no database matched" is replaced by this.

## D161 - Lyrics by photo (2026-11-20)
- Owner: the CD booklet's lyrics (stylized fonts, several song pages in one photo, rarely cropped) should be read from photos and added to the album's songs; a local model, a separate download; whole pages or several pages at once.
- Built: `crates/page-reader` reads a photo with PP-OCRv5 server detection and recognition (PaddlePaddle, Apache-2.0, ONNX through the same ONNX Runtime as the Lyric AI), finds each line's own direction and size (so a tilted page reads straight), cuts the lines out of the original photo and reads them. Layout logic (plain code, tested) groups lines into sheets, splits sheets whose widest lines reach over each other, ignores stray text far from a sheet (a keyboard in the photo), takes the large letters at the top as the title, keeps stanza gaps, gives capitals-only words sentence case, and matches titles to the album's songs by how alike the names are (each song and sheet once).
- The reading is repaired with a word list counted from the lyrics already in the library (3,000 songs spread over the library, kept in the data folder): run-together words are cut, a swash "C" read as "(" or dropped and a "U" read as "V" are put right, a dropped letter is put back, and a line with unknown words is replaced by a clean near-copy elsewhere in the same song (choruses). A fully known line is never changed.
- Result on the owner's four MxPx booklet photos (13 songs): every song found and matched to the right track by title (one script title read with two wrong letters and still matched); about 30 seconds for four photos on the CPU after the first run; the words are close but not perfect (a few wrong or missing letters per song), which is why they go to To review and not into the songs.
- Nothing is saved into a song by this feature: the page (Review > Lyrics > Add lyrics from booklet photos) shows which sheet matched which song (changeable), lets the person edit the words, and sends them to To review as a "photo" candidate (played, corrected, timed and confirmed there).
- Models are never in the installer: `lyric_photos_status` / `lyric_photos_download` fetch three files (about 172 MB) from the two official PaddlePaddle repositories at pinned revisions and checked for exact size into `<models>/page-reader`. New dependency (owner approved the feature and a local model; the crate is small and standard): `image` 0.25 (MIT or Apache-2.0), JPEG and PNG only. A second reader for handwriting (Florence-2, MIT) is possible later.
- A "choose several pictures" window was added to the program's window code (`mediaverse:choose-pictures`).
- Not tried yet: the download button against the real servers (the files were fetched by hand for the tests), the page on screen, and GPU speed.

## D162 - Lyrics page order and the lyrics editor window (2026-11-20)
- Owner's feedback: the lyric step boxes ran over one another (three columns with wide drop-downs), and the booklet lyrics in a narrow text box in the card were unusable.
- Page: the steps are one under the other, in order: 1 Automatic lyrics (quick online lookup), 2 Add lyrics from booklet photos, 3 Lyric AI, 4 Review and approve (the tabs and list below, under their own heading). "Check the lyrics already in your songs" is kept but folded under Step 3 as a collapsed section: it is a different job from the AI's "Work on" choices (it listens to songs that already have lyrics and lists those that do not fit; the AI step finds, picks and times lyrics), so it was not removed.
- Editor: Edit opens a large window over the page: the cut-out photo of the booklet page the words came from (zoom -, +) beside a text editor in a large Segoe UI font, with Previous/Next song. The sidecar now returns each panel's crop (a JPEG, at most 1600 px) with its words. Spell checking uses the system's spell checker through the text box (red underlines); the program's right-click menu in any text box shows suggestions, "Add to the dictionary", and cut/copy/paste (`electron/edit-menu.js`, tested).
- Ideas recorded, not built: more online lyric sources and a legal way to search web pages; prompting for booklet photos while a CD is ripping (the album is not in the library until it is ripped); the Android app taking the booklet photos and sending them to the PC (or reading them on the phone) and merging the results into the library.

## D163 - Resumable photo lyrics, and what the owner's corrections taught the reader (2026-11-20)
- Owner reviewed the first songs of MxPx "Living in the Chaos": the editor format was decent, but the reader missed many commas and never got "don't" right, so each track took long to correct; "Open To review" seemed to do nothing; they wanted to save progress and continue later.
- Corrections measured: four songs corrected by the owner (138 lines) against the reader's output: 39% of lines exact. Errors were missing commas, lost apostrophes ("dont", "ive", "ill"), lost capitals ("saturday", "tv"), some run-together words still joined ("Ifwe": a rule against cuts into tiny words was too strict), a swash "C" lost at the start of a word ("ops"), and plain misreadings ("are" for "fire", "nal" for "nail").
- Added `Habits` (crates/page-reader/src/habits.rs): learned from the library's lyrics, it restores apostrophes (only when the library writes the word that way at least five times as often), capitals ("Saturday", "TV", "I'm") and commas (a pair of words that usually has one; or a word that usually follows a comma after a word that often has one, tuned on the owner's four songs: 16 of 44 missing commas restored, 9 added that were not there). It never changes a letter of a word. Also: cuts into tiny words are allowed ("If we", "I don't"); a lost leading "c" is put back ("cops").
- Result on the same four songs: 56% of lines exact (from 39%). What is left is mostly real misreadings, which need a reader that weighs each word by its neighbours; not built (idea: word-pair counts from the library to choose between candidate words).
- Progress is kept: the work on an album (photos read, which page is which song, the words as corrected, which songs are ticked) is saved in the data folder as it is changed (`lyric_photos_session_save/load/forget`) and comes back when the album is chosen again, also after the program is closed. Songs have a Checked tick; "Save progress" saves at once; "Send the checked songs to To review" sends only the ticked ones (before, all songs were sent, including unedited ones). "Open To review" became "Go to Step 4: approve" and scrolls to Step 4 (it had nothing to show because Step 4 is on the same page).
- The owner's saved work on this album was prepared for the return: the improved reading of all 13 songs, their corrected words for songs 1 to 4 (ticked, already sent), and songs 5 to 13 with the new reading ready to correct. Nine songs (5 to 13) had been sent to To review with the old unedited reading; sending them again from the page replaces those entries.

## D164 - Better ways to read lyric photos: tested (2026-11-21)
- Owner's request: the OCR was not acceptable (two decades behind); find three better ways and test them on new booklets (Random Hand, Bad Religion "How Could Hell Be Any Worse", Propagandhi "Victory Lap" and "At Peace", Choking Victim "No Gods - No Managers") and the MxPx photos. Nothing was built into the program; this is measurement. Scripts: `tools/photo-reader-lab`.
- Measure: for the MxPx songs the owner corrected by hand: share of words right. For the other albums there is no hand-corrected text, so the reference is the lyrics already in the library's files (from online lookups): similarity of the read to the reference, best photo per song, only songs the photos cover (51). Those references sometimes differ from the booklet (Bad Religion's booklet differs from the web text), so the second measure is for comparing methods, not an absolute score.
- Today's reader (PP-OCRv5 plus the library vocabulary and habits), MxPx: 88% of words right. Raw PP-OCRv5 on the new albums: mean similarity 55.
- Way 1, a vision-language model reads the whole photo (Qwen3.8 27B with vision, already in the owner's Ollama, 17 GB, about 10-20 s a photo on the RTX 4090): MxPx 98.6% of words right (13 errors in 951 words; 129 of 138 lines exact); mean similarity 86 over all albums. No page cutting, no column logic, ignores the mouse-mat text that the layout step picked up. Resolution 4096 instead of 3072: no change. A second "check this against the photo" pass: no change (it returns the same text). Thinking mode: 89 (better on the sideways Propagandhi page).
- Way 2, turn the photo upright first: some booklets are photographed sideways (the camera's rotation tag says upright). The vision model's own answer to "which way is up?" was wrong or random, and reading text for plausibility fails (it invents lyrics in any orientation). What works: the page reader's letter confidence at 0/90/180/270 degrees (sideways pages score about 3x higher at the right turn; prefer 0 unless the best turn is 15% better). Upright whole-photo reading: mean similarity 92.6 (28 of 51 songs at 95 or more), Propagandhi "At Peace" 76 to 97.
- Way 3, a small specialist OCR model: GLM-OCR (0.9 billion parameters, 2.7 GB, MIT licence, via Ollama), about 8 s a photo: mean similarity 92.3 on upright photos, equal to the 27B model. Weaknesses: the booklet's swash "C" read as "(" or lost (the existing vocabulary step fixes this class), and it dropped lines in places (a repeated chorus of five lines), so it needs a line-count check. It prints no song headings, so songs are found by matching the track titles in the text.
- Tried and not worth it: overlapping tiles (helps dense pages a little, hurts the rest, and needs merging), panel crops from the current layout (it cut the mouse-mat text out as a "panel" and split songs across panels), disagreement between two reads as a "doubtful line" flag (the models make the same mistakes; it caught 4 of 9 wrong lines at best).
- The booklets print each lyric line ending in " . " in dense paragraph layouts (Bad Religion): the reading keeps them as sentences; a split on that mark would restore the lines.
- Recommendation: a "Photo reader (vision)" download built on a small vision model, turn photos upright with the existing reader, read the whole photo, then the existing vocabulary/habits steps (caps, apostrophes, swash C) and title matching. Open choice: how the model is run (the program needs a runtime for it: use Ollama if installed, or ship llama.cpp, MIT).

## D165 - The vision photo reader, built in (2026-11-21)
- Owner's decisions: it is fine to ask the person to rotate a photo that was taken sideways (easy for a human to spot); if the reader can be embedded with no licence problem, enable it; it stays a separate download with an automated helper that also handles program updates, without fetching the big model again; Ollama is not the standard (most people do not have it).
- Licences checked: llama.cpp (MIT, copyright The ggml authors) runs the model as `llama-server` on 127.0.0.1 only, for the length of a reading; Qwen3-VL-4B-Instruct (Alibaba Cloud's Qwen team, Apache-2.0 on the official model page). Nothing is in the installer. Notice rows in THIRD_PARTY_NOTICES.md; the two notice texts are written beside the downloaded files.
- Why Qwen3-VL-4B and not GLM-OCR (the D164 recommendation): in the program's own pipeline on the owner's hand-corrected MxPx songs GLM-OCR was about 88% of words right (it skips parts of songs with repeated choruses, as it also did through Ollama), Qwen3-VL-4B read 96.6% of words right on the first six songs with the same measure (the 27B model read 98.1%). Download: the 4-bit model (2.50 GB) and its 8-bit picture encoder (0.45 GB) plus the 39 MB runtime: about 2.99 GB.
- Download and updates (`vision_reader.rs`): files live in the models folder under `photo-vision`: `model/` (kept across program updates) and `runtime-<build>/`. Each file is pinned (address, size, SHA-256, written in the code); a half-finished download is resumed (`Range`); a wrong file is removed. After a program update that moves to another llama.cpp build only the runtime (39 MB) is fetched, the status says "update" and the page offers "Update the photo reader (N MB)"; older runtimes are removed. A model file is fetched again only if its own pinned file changes. The runtime zip is unpacked with Windows' own `tar.exe` (no zip library). SHA-256 is a small built-in implementation (tested against the standard vectors), not a new dependency.
- Reading (`lyric_photos_read`): each photo is turned by the person's rotation (0/90/180/270, set with Turn left/right buttons beside a small preview, `lyric_photos_preview`; kept with the saved work), sent at up to 3072 px, and the answer is cut into songs by the album's own track titles standing alone on a line (a title must be nearly the whole line: "No way not me" is not the heading of "Not Me"), capitals-only print becomes sentence case, the decorative "C" read as a bracket is repaired from the word list, run-on paragraphs are cut into sentences, then the existing word list repairs and the capitals/apostrophes habits (not the comma habits: the model keeps the printed commas) and repeated lines are made alike. The editor shows the whole photo beside the words (a panel has no cut-out of its own).
- The model can get stuck repeating a chorus for ever when it reads with no randomness at all (about half of the pages read greedily did). The answer is streamed and a reading going round in circles (the last one to four lines repeated six times) is stopped and begun again with a little randomness (temperature 0.5; a repeat penalty drops real repeated lines, so it is the last resort); up to eight tries.
- The older line-by-line reader stays as the fallback for people who already have its models; the page offers the new reader as a download.
- Real runs: the whole path (download with a resumed half-finished file, checksum, unpack, start, read the four MxPx photos) was run through the real sidecar protocol (`a_real_download_and_read_with_the_vision_reader`, ignored; needs about 3 GB and real photos).

## D166 - Photo reader: song pages cut out, large photo preview (2026-11-21)
- Owner's feedback after the first test: the thumbnail beside the turn buttons was too small to judge a rotation, and the editor showed the whole photo, not the song's page.
- Photos: the small picture is bigger (150 px) and a click opens it large (up to 1800 px) with Turn left/right still at hand (lyric_photos_preview takes max_side).
- Pages: after reading, the vision model is asked for the box around each song's lyrics (`bbox_2d` on a 0-1000 scale, which Qwen3-VL answers accurately and in a fraction of a second per song), and that part of the turned photo is cut out (a small margin, up to 1800 px) as the panel's picture. A missing or implausible box falls back to the whole photo. Checked on all 13 MxPx songs.


## D167 - Verse breaks from the page read again; Lyric AI shows what was chosen (2026-11-21)
- Owner's feedback: the photo matching was much better but missed breaks between verses; and after pressing Start the Lyric AI page should show what had been selected.
- The whole-photo reading drops most stanza gaps (a different prompt did not help). Each song's cut-out page read by itself keeps them: on the owner's six corrected MxPx songs 31 of the 37 gaps were found (9 before), with 5 extra. The second reading is used only for its gaps: `borrow_breaks` lines the two readings up (lines count as the same when 80% alike, at least 60% must line up) and puts each gap after the line it follows; no word changes. Cost: one more short reading per song (about 4 minutes for the 13 MxPx songs in all).
- Lyric AI: while it runs and after it finishes, the page shows "You chose: Work on: ... Write the results that are certain into the songs: yes/no. Also redo songs checked before: yes/no." (the choices were hidden while it ran).


## D168 - Lyric AI: corrected photo words get timed, tribute albums, instrumental flag (2026-11-21)
- Owner's review of the first full run: (1) MxPx "Nervous Energy": his corrected words (90%, no timing) stayed first while the AI's timed pick of a near copy of them scored 86%. (2) A Noise cover of Rancid's "Solidarity" got only unrelated suggestions; Rancid's original was never searched for. (3) An instrumental had been given invented words and timing, with no way to say so.
- Judge: when words read from a booklet photo (source "photo") fit the singing within 0.4 per letter of the best suggestion, they are the ones forced into the singing and timed, instead of another record's copy. They keep the match they were shown with (never below 90%), and replace the untimed photo entry rather than sitting beside it. Not "sure" on their own: they are only written automatically when the fit says so.
- Tribute albums: an album title that names the original ("A Tribute to Rancid", "Rancid Tribute", "Songs of ...", "Plays ...") makes the original the cover artist for every song of that album, whichever band plays it (counting songs per artist never reached three on such an album). In the cover pass a song whose pick is not by the original is now searched for under the original, not only a song with no pick; a result by someone else replaces nothing that already had a pick.
- Instrumental flag: "This song is instrumental" in the To review editor and "It is instrumental" in "Check the lyrics already in your songs" remove the song's lyrics, set language zxx (confirmed instrumental, so the Lyric AI and lookups skip it), and drop its suggestions / list entry. Asks first; Not instrumental (Suspected instrumental > confirmed) reverses the tag.
- Not done: verse breaks in timed lyrics. Timed (LRC) lyrics saved in the song carry no blank lines by design (textToSave), so an AI-timed pick shows no breaks even when the words it came from had them.

## D169 - Lyrics in two phases: match (Step 3), time (Step 4); word-processor timing editor (2026-11-22)

Owner: songs whose lyrics the band put into the MP3 (untimed, often from Bandcamp) should be a 100% match once timed, yet were not in the 90-100% list. "Wrong lyrics are always going to be bad, while poorly timed lyrics are something we can work on improving gradually." Split the work in two: matching the words to the song, then timing them; words that came from the band or were confirmed go straight to timing. Step 4 may be run many times, also on songs already timed, with a much lower bar for writing.

- Why they were not at 90-100%: the old "file" path treated the words as certain but then sent the song to review when more than 10% of its lines were flagged (section labels, "(x2)", a chorus written once), and a reviewed result is shown at 70-95% from the fit. Found while checking: the batch write (`update_track_media` with a batch) refuses any song that already has lyrics, so such a song could never have been written automatically.
- Settled words (`lyric_ai/trust.rs`): the program never writes lyrics into a song that has some, and journals every lyrics write (`lyrics_added` in `picture-batches/<batch>/journal.tsv`). A song with untimed lyrics and no journal line therefore holds the band's own words; keys are the last three path parts so the move to `M:\` does not matter. 323 of the owner's 2,946 untimed songs (2026-11-22). Words a person confirms in To review are recorded in `lyrics-confirmed.txt` (`lyric_ai_confirm_words`) and count as settled too. Risk: a lyrics write made without a journal would be taken for the band's.
- Step 3 (Match) skips settled untimed songs. Step 4 (Time, `lyric_ai_time`, `lyric_ai/timing.rs`): chooses songs with untimed settled words, optionally the program-found untimed ones (`include_found`), optionally songs that already have timing (`retime`, which uses their own line texts), whole library or one playlist. Section labels (`[Chorus]`, `(Instrumental)`, `Verse 2`) are not timed and a trailing `(x2)` is cut from the timed line; they stay in the plain lyrics.
- Write: new `LyricsChange::Synced` replaces only the SYLT frame; the USLT (the band's words, labels and layout) is untouched. The old timing is kept in the batch journal (`synced_replaced`) and `undo_picture_batch` puts it back (the oldest record per song wins). Written when at least 80% of the lines are placed and at most 25% are doubtful (Step 3: 10%) and the words fit the singing (a poor fit waits in General review, timed). No 30-day skip.
- Timing editor (`lyric-timing-editor.ts`, rules in `lyrics-edit.ts`): the To review editor is now one word-processor-like area: select several lines, copy, cut, paste them between other lines (pasted lines have no time; press now), Enter splits a line, Backspace/Delete join, Ctrl+Z/Ctrl+Y, Ctrl+Enter times the caret's line and moves on, a time button and a "now" button on every line, red spell-check underlines and the existing right-click suggestions. Tried in a browser harness (Enter, typing, copy/paste of whole lines, undo, now, Backspace join, cross-line delete, red underline); the right-click menu and playback were not tried there.
- Page numbering: Step 3 Match, Step 4 Time, Step 5 Review and approve.
- Not done: line times cannot be typed or nudged by a small amount in the editor yet; timings of copied lines are not carried (deliberate: a repeated chorus is sung at a new time).

## D170 (2026-11-22): Jellyfin is the shared home for flags and playlists; the computer is the fallback

Owner: the TV (and phone) play from the Jellyfin server and the computer edits the same files on the share, so flags and playlists should be shared through Jellyfin, with the computer's own lists only when there is no server. Most of it already existed (D96: phone flags and the computer's Review sync through the "Problem tracks" playlist); two halves were missing.

- **TV flags (new):** with Jellyfin as the source, a flag now goes to Jellyfin (`tv/marks.ts` `jellyfinMarks`, `tv/jellyfin.ts` `flagInJellyfin`): into the computer's master "Problem tracks" playlist if it exists, else into this TV's own inbox "Problem Playlist <time> (TV)" (the computer folds inboxes into the master). TV song IDs are Jellyfin's own, so no matching is needed. Unflagging takes the song off every flag list. The TV reads its flagged songs from those lists, so a song marked Done on the computer clears on the TV, and a flag made on a phone shows on the TV. A copy on the TV covers the server being away; flags kept on the TV from before (never sent) go up at the next load. Reasons and positions are not kept in Jellyfin (D96 trade-off).
- **TV playlists (new):** with Jellyfin as the source the Playlists tab lists the Jellyfin user's playlists (flag lists excluded) instead of asking for the computer.
- **Computer playlists to Jellyfin (new, `src/playlist-sync.ts`):** each sync round (start, every 5 minutes, a few seconds after a playlist changes) the computer's playlists are made on the server, songs matched by the last three parts of the file path (so `M:\` and the server's own path agree). Songs added or removed here since the last round are added or removed there; songs added on the server and playlists made on the server are left alone. Never touches the flag lists.
- **Not done yet:** reading Jellyfin-made playlists back into the computer's Playlists page, and editing Jellyfin playlists on the computer directly (Jellyfin first, computer list only without a server); Jellyfin favourites on the computer; TV playlists are still read-only. The computer must be signed in to Jellyfin (Settings > Jellyfin > Shared problem tracks) with the same Jellyfin user the TV uses.
- **Possible bug logged:** the TV froze after the Home key once on the living room TV (not reproduced on either TV; see outstanding.md, section B).

**D170 addendum (2026-11-22, later): two-way playlists and the review's fixes.**
- **Playlists, both ways (`src/playlist-sync.ts`):** replaces the one-way copy. Per playlist a three-way merge against what both sides held at the last round: a song added on either side is kept on both, a song taken out on either side is taken out of both, the first time (no last round) nothing is taken out. Playlists made on the server are brought into the computer's list (songs its library has). Deleting or renaming a synced playlist here deletes its server copy (the playlist only, never a song); a playlist deleted on the server is **not** deleted here (the next round makes it on the server again), so a server problem can never empty the computer's lists. Not run while the library is unread; nothing is deleted while the computer's own list is empty (it may not be read yet). One playlist failing does not stop the others; a playlist changed here while the round waited is left for the next round instead of being overwritten. Songs whose paths end alike under two artists (deeper layouts) are treated as unmatched, never as one another.
- **TV:** an unflag made while the server is away is remembered (`unflagging`) and taken off the server at the next load, so it cannot come back; flags and unflags re-read the TV's copy before writing; playlist/flag calls send 50 songs at a time; switching source clears the old source's playlists.
- **Step 4 approval keeps the band's words:** a timing result sent to To review carries `band_words`; approving it (one song, or bulk) calls `update_track_media` with `keep_words: true`, which replaces only the timing (`set_synced_lyrics`, journalled, Undo works) so the labels and layout stay. If the person changes the words in the editor, it is saved as their text as before; if only some lines are timed, it asks for all lines to be timed first.
- **Section labels:** a line in square brackets is a label; a line in parentheses only when it names a label word, so backing vocals like `(Ooh, ooh)` are sung and timed. Step 4's "waiting in General review" counts only songs that really have a timing; near-silent songs are counted separately.
- **Provenance cache** is dropped when words are confirmed and when a Step 3 or 4 run starts.
- **Known limits (not fixed):** words embedded into a file at rip time (`mp3_job.rs`) or before every lyrics write was journalled have no journal line, so they count as the band's own; the 323 list may contain a few of those. Reasons and positions of flags made on TVs and phones are still lost (D96).

## D171 (2026-11-22, late): one default Jellyfin server; one lyrics editor; artwork-only dialog; a faster, remembering library check

Owner feedback after trying D170 on the real setup (library on the Jellyfin share, `M:\`).

- **One default Jellyfin server (Settings > Jellyfin).** The page listed the test server on this PC next to the home server, and the separate "Shared problem tracks" box silently used whichever was found first (a server on this PC sorts first). Now each found server has **Use this server** (the default, marked) and **Hide** (the test server; "Show N hidden servers" brings them back); sign-in, Sync now, Sign out and the playlist/flag sync are drawn inside the page for the default server, with no box of their own (`jellyfin-settings.ts`, `problem-sync-ui.ts`, `jellyfin-desktop.ts` `chosenServer`). A computer already signed in to a server before this keeps it as the default; changing the default signs out of the old one. New setting: after something is saved here, the server is asked to rescan its library 30 s later (`POST /Library/Refresh`, needs an administrator's account; the message says so if refused), default on.
- **Settings > Library: "Using a Jellyfin server".** Explains the two ways: the music folder is the server's shared folder (recommended: ripping, tag/cover/lyrics edits all work because the program changes the files itself; Jellyfin only has to rescan), or the server alone with no folder (playing and casting only, because Jellyfin does not let other programs change its files). A button goes to the Jellyfin tab. **The "server alone" mode was only described then; it is built in D173.**
- **One lyrics editor, with playback and timing, everywhere.** The old "Pictures & lyrics" dialog only had a plain text box. Now "Lyrics…" (flagged tracks, the library's right-click menu and song rows, Now Playing's no-lyrics link, and the rows of Review > Lyrics for songs with no suggestions) opens the Review editor for that song in its own window: the lyrics the song has now (timed or not), play, tap/Ctrl+Enter timing, word-processor editing, **Search online** (LRCLIB: what it finds is added as choices), Save, Remove the lyrics. The song's own words are kept when only the timing changes (`keep_words`, D169). The Review tab "Missing lyrics" is now **Lyrics**.
- **Artwork dialog is artwork only** (title "Artwork"; the lyrics box and the lyrics search were removed from it). The flagged-tracks page has **Lyrics…** and **Artwork…**; the library menu has both.
- **"Checking your library…" was slow because the library is on a network share.** The scan opened every song and read its whole tag (covers included: about 2 GB for 13,849 songs, about 27 MB/s over the share) one file at a time, plus about seven file-existence checks per song. Now: 12 songs are read at once, a folder's cover is looked at once per folder, and what each song's tag held is remembered (`<data>/library-gaps-cache.json`, by size and modified time; folder covers by their files' size and time), so only changed songs are read again. Measured on the real library, optimised build, with a Lyric AI run going: first scan 74 s (the one-at-a-time way was an estimated 3.5 minutes), every later scan 11 s.

**D171 addendum (2026-11-22, night): songs stored under the old library path; photo-read lyrics without times.**
- **A review song would not play (MxPx "Nervous Energy"):** its review entry (like about 5,000 stored paths: Lyric AI results and judgements, lyrics review entries, play history, favorites, playlists, the instrumental list) still pointed at the old library, `C:\Users\<name>\Music\...`, from before the library moved to `M:\`. Playback and every edit refuse a file outside the current library, so those songs could not be played or saved. Fixes: (1) `resolve_in_library` (Rust) and `resolveAllowedAudio` (Electron) now accept such a path when the same song exists under the current library, found by the last five, four, three or two parts of the path (never a path that climbs out or a file that is only reachable through a link out of the library). (2) `tools/rebase-stored-paths.ps1` rewrites the stored paths and renames the hash-named files (FNV-1a of the path) to match; at least artist, album and file name must agree, so two songs are never mixed up; dry run by default; with `-Apply` (program closed) it copies everything it touches to `path-rebase-backup-<time>` first. It leaves the batch journals alone (Undo must act on the files they name). Run on 2026-11-22: see the outstanding list.
- **Photo-read words had no times:** the Lyric AI times the words read from a booklet photo as a separate candidate (source `lyric-ai`), and the untimed `photo` candidate ranks first. The editor now carries the times across line by line (`carryTimes`, nearly equal lines match, in order) when the chosen candidate has none and another has, says how many lines took a time, and leaves the rest to "now". Bulk approve does the same when the timed candidate covers every line.
## D172 (2026-11-23): the lyrics editor keeps its own playback controls; the Lyric AI times a song together with the person

- **Playback controls in the editor.** The editor's window is modal, so the player bar behind it could not be clicked, and timing a line means going back a few seconds again and again. The editor now has its own: play/pause, back 5 s / 1 s and forward 1 s / 5 s, a seek bar with the time (m:ss / m:ss), a speed choice (normal, ¾, ½; the pitch is kept), Space (outside the words) and Alt+Left / Alt+Right (Shift: 1 s). The player gained `resume`, `state` (paused, length, speed) and `setRate`; the speed goes back to normal when another song loads.
- **"Lyric AI: time the lines" (per song, in the editor).** The AI listens to the song and times the lines in the editor without writing anything (the person saves). Lines the person timed by hand (a tap, now, Ctrl+Enter, a nudge) are marked in the accent colour and are **fixed points**: they stay exactly where they were put, and the AI places the others between them (`align_anchored`: each stretch between two fixed lines is aligned only inside that stretch of the song, so a few right lines stop the rest from drifting into the wrong verse). Either side can go again: time the first lines and let the AI do the rest, or let it run first, fix a few lines, run it again. Shift-click times every line again, ignoring the hand timing. "Undo the AI's timing" puts the lines back. The reply says how many lines it timed around how many of the person's, how many it could not place (they take the time of the line above) and how many look doubtful; if the words fit the singing poorly it says the lyrics may be wrong.
- **Quick the second time.** The song's listening (about a minute: vocals separated, letters read) is kept for the last song (by file, size and modified time), so the second and third run on the same song only repeat the placing, which takes moments. The command is `lyric_ai_time_lines {path, lines:[{text, ms?, mine?}]}`; it is a job at normal (not bulk) priority, so it does not wait behind a library run; the engine is shared, so it waits only for the song being listened to.
- **Not tried:** on the real engine. The aligner change is tested on a synthetic signal (fixed lines, two fixed lines, nonsense fixed lines, a stretch too short); the real listening needs the models and a song.

## D173 (2026-11-23): the Jellyfin server alone as the library (playing and casting)

Owner: "let's build a Jellyfin-only mode for the Windows PC app" (the Library tab had described it since D171).

- **Choice.** Settings > Library > "Using a Jellyfin server": **Use the Jellyfin server as my library** (needs the sign-in made under Settings > Jellyfin) / **Use my music folder**. It is kept in the page's storage and the page starts again, so every list reads the new library (`library-mode.ts`). The music folder itself is left as it was.
- **Songs come from the server** (`jellyfin-library.ts`): all songs read a page of 1,000 at a time (title, artists, album, album artist, genre, year, track and disc number, length, date added). A song is named `jellyfin:<album id>/<song id>` (`loose-<song id>` for a song with no album): that looks enough like a path that every view that groups by folder groups by album, and favorites, playlists, flags and history keep working unchanged (the sidecar accepts such names, `is_server_song`; folder paths are checked as before). The commands that read the folder (`library_snapshot`, `rescan_collection`, `collection_status`, `recent_files`, `track_cover`, `track_artist_photo`, `track_lyrics`) are answered from the server at the page's bridge (`server-routing.ts`); any other command that names a song of the server is refused with a plain message ("needs your music in a folder"). "Rescan library" reads the list again (it does not ask the server to rescan its disks: that needs an administrator).
- **Playing.** The player asks for `mediaverse-media://jellyfin/<song id>`; the program fetches `/Audio/<id>/stream?static=true` with the saved sign-in and passes the byte range on, so the seek bar works (`electron/jellyfin-stream.js`). The sign-in is told to the program once and stays in its memory; it is never in an address the page can read. Only a server on the home network is used (same rule as `home-http.js`), and the id must be 32 hex digits.
- **Casting.** Google Cast and DLNA devices are given a link to the server itself (`/Audio/<id>/stream?static=true&api_key=<token>`, cover from the album, lyrics for Google Cast from the server's lyrics), because a TV cannot send a header. The device is on the home network, as the server is; **the sign-in is visible to the device in that link**, which is how Jellyfin's own cast works too. TVs running the MediaVerse app ("Play on the TV") are not offered in this mode: they play from this computer's files; the TV app plays from the server itself.
- **Covers and lyrics** come from the server (the album's picture; the server's lyrics, read from a .lrc file or the file's tag). Now Playing says when the server has none.
- **Flags and playlists** sync with the server as before, matching by song id exactly in this mode (the server's songs are listed under their names, not by file path).
- **Not offered in this mode** (hidden or refused, because Jellyfin does not let other programs change its files): Rip a CD, Review except the flagged tracks, editing tags, Artwork…, Lyrics…, Scan for defects, Properties, Open file location, getting started and the first-run folder prompt, the Settings tabs Tags & files, Rip, Lyrics and Review. The TV tab (sharing the folder with TVs) stays and still means the folder.
- **Not tried:** against the real server and in the running program (the program was not started). Unit tests cover the naming, the paging, the lyrics, the routing, the stream relay (range, sign-in, refused addresses, errors) and the sidecar's acceptance of the names. First things to check on the real setup: the list loads (13,849 songs: how long), a song plays and seeks, covers show, casting to a TV works, flags and playlists still sync.
## D174 (2026-11-23): the player bar's own controls, and songs held whole in memory

Owner: the PC's playback controls were the browser's own (they showed a download item and a playback-speed menu, which make no sense here), and moving about in a song or going to the next one sometimes buffered.

- **Controls.** The browser's controls are gone. The bar has a play/pause button in the accent colour (square-cornered, like the rest of the program), the elapsed time, a thin progress bar filled in the accent colour (as on the TV), the length, a mute button and a volume bar (`player.ts`, style at the end of `style.css`). The progress moves every frame while playing. The editor's seek bar (D172) has the same look. The playing-speed choice stays only in the lyrics editor, where slowing a song down helps to time a line.
- **Songs are read whole into memory before they play** (`audio-cache.ts`), so seeking inside a song and starting the next one never wait for the disk, the share or the server: the file is fetched once through the same `mediaverse-media` address and played from an in-memory address. The next two songs in the queue are read ahead (one after another, in the background, once the current one is loaded), and the one before is kept for "previous". Memory: at most 10 songs and 600 MB, the least recently used go first, never the playing or the next ones; a song kept for over 10 minutes is read again; a song whose file is about to be edited is let go (`stopIfPlaying`). A song not loaded ahead (the first one, or a jump) shows "Loading…" for the moment the file takes (a few seconds for a big file over the network); if the read fails or takes over 4 seconds the song is streamed from the file as before.
- **Not done:** truly gapless playback between songs (the next song starts the moment the last ends, from memory, with the small gap any two audio sources have); the TVs and the phone are unchanged.
## D175 (2026-11-23): silent songs in the defect scan, a re-rip list, a lucky reel that settles differently each time

- **Silent songs (`crates/ripper/src/defects.rs`).** The audio defect scan has a new finding, **Silent**: a song at least a second long whose loudest sample is no louder than 8 steps of 16 bits (about -72 dB) has no sound at all. It is the only finding for such a song, its verdict is Suspect, and it is shown as "No sound at all". Silence that is only part of a song (a hidden track after a long gap), or a quiet song, is not flagged. Found by looking for the Bad Religion song the owner flagged (D170): 8 of 13,849 library songs are silent from start to end (see the outstanding list). The scanner's version number went from 2 to 3, so scan results saved by the older scanner are scanned again (the library scan runs in the background and can be stopped and continued); songs ripped from now on are checked too, and a silent rip is warned about by name ("rip it again").
- **A re-rip list.** Review > Audio defects now has, above the results, "No sound at all: N songs on M discs" with two buttons: **Put them in the playlist "Needs re-ripping"** (made, or added to, skipping songs already there) and **Flag their M discs for a re-rip** (the existing re-rip flags of D111, listed under Review > Missing & copies > To re-rip, with the reason filled in). A playlist is the practical list: it already is on the TVs and the phone through the Jellyfin sync (D170), it can be played to hear the fault, and a song leaves it with one click when its disc has been ripped again; the disc flags are what to take to the shelf. A silent track that is meant to be (Geogaddi's last track) is dismissed with Mark as good.
- **The lucky reel (Home > Feeling lucky?).** The slide past the album and the wiggle back were the same every time. Each spin now picks one of four ways to come to rest, with its own distances and timings: **overshoot** (slides past, wiggles back with 2 to 4 shrinking swings), **short** (stops just short and creeps onto the album), **bounce** (slides well past, springs back over the other side) and **tick** (barely overshoots and snaps into place); the spin takes between 4.2 and 5.6 seconds along one of three curves (`luckySettle`, tested). Reduced-motion settings still skip the animation.
## D176 (2026-11-23): goals for the first release, the website, and preparing the repository to go public

Owner: promote the apps as they are, get people to join a beta test so the project can expand to more platforms and reach the stores (Google Play, Microsoft Store, Samsung's TV app store), and prepare the repository to go public very soon (possibly this week).
- **Goals recorded** in the Project Brief, the Playback, Casting and Platform guide, the Feature Roadmap and the README: public release on GitHub, then the **Microsoft Store**, **Google Play** (closed test of at least 12 testers for 14 days first) and **Samsung's TV app store**; a **Google TV** app from the Android app; **Linux** builds; Jellyfin as a first-class partner (shared hub and server-alone library); free, open source, private by design.
- **Website (`mediaverse.studio`, its own repository):** a platform strip with honest state pills (working, in testing, next, planned), a Jellyfin "Connect" feature, the Lyric AI and its timing editor, casting, the re-rip list, a beta call that says plainly why testers matter for the stores, and a four-column roadmap; the privacy page covers the Lyric AI, Jellyfin (including the token in cast links) and the Android app; the support page explains how each beta track works. The website says "the source code is moving to a public GitHub repository" until it is; the link is added on go-live day (its README lists the steps).
- **Going public:** `docs/roadmap.md` section 3 has a "go-live day" list (check script, version number, CI, visibility, About box, website link, SignPath, Releases); `tools\check-before-public.ps1` ended with "nothing found" on 2026-11-23. Added `SECURITY.md`, issue templates (bug, beta feedback, idea; blank issues off) and a "Ways to help" section in `CONTRIBUTING.md`; `docs/beta-testing.md` is the beta plan (tracks, order of work, feedback records, honest labels). Still open for the owner: the first public version number (recommendation 0.9.0), whether to rewrite history, the home TV identifiers check, the GitHub Sponsors link.
## D177 (2026-11-23): the Android app keeps chosen music from the home Jellyfin server on the phone

Owner: sync with the local Jellyfin server when on the home Wi-Fi, choose which files or folders to keep on the phone (as a cloud-storage app lets you choose which folders to keep on a computer), so flagged songs go up and the latest song edits come down; songs can be added to or removed from the phone's library; playback is from local files; files and playlists sync to the server.
- **Screens (phone web UI, `phone/home-sync-ui.ts`):** Settings > "Keep music from the server on this phone" opens **Music from your home server**: Sync now / Stop, a switch "Sync when I get home" (when the app opens or the phone joins Wi-Fi, at most every 15 minutes), the list **Kept on this phone** (each with its song count and size and a ✕ that asks first), and the pickers **Artists** (tick one for everything by them; › opens their albums), **Albums**, **Playlists**, and a switch for **the whole library**. An empty phone offers "Get music from my home server".
- **A round (`phone/home-sync.ts`, tested):** read each choice's songs from the server (artist, album, playlist, all), plan, then fetch and remove. New songs are fetched; a song whose file was **edited on the server** (the server's ETag changed, or its size when there is none) or whose phone copy is gone is fetched again; a song no longer chosen is taken off, unless another choice still keeps it; a song the server no longer lists is taken off too, except that **more than 25 (or a fifth of what is kept) vanishing at once is taken for a fault** (an offline share answers with an empty library) and they stay. Nothing is taken off unless the whole server read succeeded and the round was not stopped; the record of what was fetched (`mediaverse.phone.home-manifest`) is saved after every song, so an interrupted round loses nothing; three failures in a row stop it.
- **Where songs go (native, `HomeSync.kt`):** the phone's Music folder, `Music/MediaVerse Home/Artist/Album/NN - Title.ext`, written through Android's media index (so the player, Android Auto and the TV share see them at once) from a temporary file (a failure part-way leaves the old copy), home-network servers only; deleting touches only songs under that folder. A song fetched again has a new id on the phone: its heart, play count, flag and playlist entries follow it.
- **Playlists, both ways (`phone/phone-playlist-sync.ts`, tested):** the three-way merge of the PC (`mergeSongs`): a playlist made on the phone is made on the server (the TV and computer see it), one made on the server comes to the phone with the songs the phone has, an addition on either side stays and a removal on either side wins. Songs the phone does not have are never lost from a server playlist, and songs the server does not have stay in the phone's. A playlist deleted on one side is deleted on the other if unchanged there. The flag lists stay with the flag sync, which runs as part of the round (new flags up as an inbox playlist, the computer's clearing and its list down). Matching is exact for songs the phone fetched, by artist and title for the rest (at most 150 server lookups a round).
- **Tried on the emulator** (Android 17, against `tools/fake-jellyfin.cjs`, a stand-in server over the demo library): sign-in by Quick Connect, picking artists, albums and a playlist, 24 then 15 songs fetched into the Music folder and shown in the phone's library, an edit on the server fetched again ("1 updated"), a server playlist brought to the phone, a phone playlist sent to the server, and taking an artist off (7 songs deleted, the artist gone from the library, playlists intact on both sides). **Not tried:** a real Jellyfin server (the ETag field of a real server's media source, paging of 14,000 songs), a real phone, a phone over mobile data, Android 11 to 16, and syncing while the app is closed.
- **Not built:** syncing in the background with the app closed (a round runs when the app opens or the phone joins Wi-Fi, or on Sync now); choosing single songs or server folders (artists, albums and playlists are the units); a storage budget; sending the phone's own music to the server (the server's files can only be changed by the program on the computer; the phone sends flags and playlists).

## D178 (2026-11-23): the Android sync recognises music already on the phone

**Owner's request:** instead of deleting the music on the phone and fetching it again, recognise the files already there (names, folders, sizes, perhaps a deeper comparison) and mark them as kept.

- **Recognition (`phone/adopt.ts`, tested):** before a round fetches anything, each wanted server song that is not yet kept is matched to a song in the phone's media index by title and artist (compared like playlist names: case, accents, "feat.", brackets ignored), length (within 1.5 s best, 20 s at most), album or folder name, file name and, strongest, size in bytes. Best pairs first, one phone song to one server song. Songs on the phone are told apart by folder: anything outside `Music/MediaVerse Home/` is the person's own.
- **Exact or differs:** same size = "exact": confirmed by a **fingerprint** (native `HomeSync.fingerprint`): SHA-256 of the first 64 KB and last 8 KB of the phone's file against the same byte ranges fetched from the server (HTTP Range), so a same-size edit is told apart without downloading the song. Any other size = "differs" (another tag, bitrate or rip). Jellyfin has no checksum in its API, so the ETag is kept as the later change signal.
- **What happens to each:** exact songs are marked kept as they are (record: phone id, path, size, server ETag, `adopted`); nothing is downloaded or moved. Differing songs are marked kept but **held**: left alone, listed under "Different from the server" with a button "Use the server's versions". The person's own files are **never deleted** by the program: stopping to keep them only forgets them.
- **Updates in place:** when a song the person already had is edited on the server (or the person chooses the server's version), the new file is written over the phone's copy where it is, keeping its place, heart, play count and playlists. Android needs one permission prompt for that (`createWriteRequest`, one prompt per 200 songs); refusing leaves the old version and reports it. Writing in place does not use the pending flag (Android refuses writes to a pending item the app did not create: found on the emulator, where the first try hid the file as `.pending-…`; no data was lost, and the flag is no longer used there).
- **Also:** Track JSON from the phone carries `file` and `size`; the stand-in server supports byte ranges and realistic lengths.
- **Tried on the emulator** with the demo library: eight songs and one in another folder (named differently) copied onto the phone beforehand: 9 recognised, 15 fetched, the one altered song (2000 bytes longer) held; a second round did nothing; "Use the server's versions" asked permission once and rewrote that file in place; stopping an artist took the fetched songs off and left the person's own copy.
- **Not built:** a full-file checksum compare (the head/tail fingerprint is the practical limit without server support); a checkbox list to review each recognised pair.

## D179 (2026-11-23): a searchable tracker for beta testers, and a stable `main`

**Owner's request:** a bug tracker / feature request board for beta testers, easy to search, where Claude gives a summary and waits for approval before implementing; and test branches so the stable branch is not easily broken after going public.

- **Tracker = GitHub Issues** (already free, searchable by anyone and by `gh issue list --search`, and the place testers expect). Labels created on the repository: type (`bug`, `idea`, `beta-feedback`), area (`area: windows/android/tv/cast/jellyfin/ripping/lyrics/linux/website`), `priority: high`, and one status at a time: `new`, `needs info`, `proposed`, `approved`, `in progress`, `in test`, `released`. The issue templates start every report as `status: new`. An optional board view (Projects, grouped by the status label) needs a token scope the owner has not granted (`gh auth refresh -s project`); the labels carry the same information.
- **Summary, then approval:** nothing is built from an issue until a short summary (meaning, what changes, risks, tests, decisions needed) has been posted on it as a comment and the owner has said yes. A project skill (`.claude/skills/triage`) makes "triage the tracker" do the listing, duplicate search, summaries and (after approval) the branch work.
- **Branches:** `main` stable (changes only by an owner-approved pull request from `develop` or a `hotfix/`), `develop` the next release under test, `feat/` and `fix/` per issue. CI runs on pushes to `develop` and on pull requests into `main` and `develop`. Details and the cycle: `docs/workflow.md`; `AGENTS.md`, `CONTRIBUTING.md` and the roadmap point to it.
- **Branch protection** needs a public repository on the free plan, so it is a go-live step (roadmap, step 3b); until then the rule is kept by this document. The website's Support page gets the issues link at go-live.

## D180 (2026-11-23): volume levelling by the album, gapless playback, crossfade and an equalizer on the PC (Stage 1 of docs/playback-engine-plan.md)

**Owner's requests:** levelling must look at whole albums, not single songs (soft acoustic songs were made too loud and songs with intense passages too quiet by earlier tools), perhaps using the year (older recordings are quieter); build Stage 1 of gapless, levelling and the equalizer, leave WASAPI/native output (Stage 2) for later.

- **Loudness (`apps/sidecar/src/loudness.rs`, no new dependency):** EBU R128 / BS.1770-4 integrated loudness with the K-weighting filter and gating, plus the loudness range and the loud end (95th percentile of 3-second readings) and the peak. Checked against the standard's reference values.
- **Album levelling (`album_level.rs`):** one gain per album, from the album's songs together (energy weighted by length), so songs keep their balance within an album. Sensible limits: songs under 20 s and interludes 15 LU under the median are left out of the album's figure; the boost is held so the album's loud passages stay under -12 LUFS; the boost is capped by the recording's year, and the cap GROWS with age because older recordings are quieter and need more lift (10 dB from 2000, 12 from 1980, 15 from 1960, 18 earlier, 12 unknown; corrected 2026-11-23 after the owner pointed out the first version had it backwards, limiting old albums); "gentle" applies 60 %; a song's own peak never clips. The reasons are kept as plain-words notes. Stored per song (`loudness.sqlite`), gains worked out on request so a changed setting applies at once. Albums are the song's folder; the year is the album's middle tag year. Nothing is written to the music files.
- **Scan:** background job `scan_library_loudness` (low priority threads, resumable, only new or changed songs), `library_loudness_status`, `loudness_gains`, `get/set_loudness_settings`. Settings > Sound starts it and shows progress.
- **Playback (web):** a shared Web Audio graph (`audio-graph.ts`, `sound.ts`): per-element fade and levelling gains, a ten-band equalizer (31 Hz to 16 kHz, +/-12 dB, presets), the analyser the glow follows. The player keeps two audio elements; the spare is loaded ahead from the in-memory cache and takes over about 30 ms before a song ends (gapless, default on) or a chosen 0 to 12 seconds before (crossfade, default off; never longer than half a song). The window no longer throttles timers in the background.
- **Measured** in the real app (muted, isolated data folder, `scripts/check-gapless.cjs`): every join handed over on its own; a 4 s crossfade overlapped by 4.03 s. Honest limits: the join is within about 30 ms, not sample-exact (the MP3 encoder delay and padding are not trimmed yet; exact joins need the sample-scheduled engine, Stage 2); the equalizer and levelling apply to this computer's own playback, not to casts, the phone or TVs.
- **Not done:** applying the levelling on the phone and TVs, writing ReplayGain tags (previewed), the review page listing each album's notes.

## D181 (2026-11-23): mini player, media keys and taskbar buttons on the PC (issue #8)

- **Media keys:** play/pause, next, previous and stop work from the keyboard anywhere (`electron/media-controls.js`, registered as global shortcuts; a key another program already holds is skipped). The system media overlay shows the song and artist (Media Session metadata).
- **Taskbar thumbnail buttons:** previous, play/pause, next, following what plays (icons in `electron/icons/`).
- **Mini player:** a small always-on-top window (cover, song, artist, a progress bar to click, previous/play/next, volume with the mouse wheel, a button back to the main window), opened by the new button in the player bar. It only shows what the main window publishes and sends commands back; the main process checks who sent each message and cleans every value (`cleanState`, `cleanCommand`). Tried in the real app: it shows the song and cover, its buttons drive the main window, media keys register (`scripts/check-media-controls.cjs`).
- **Not done:** jump-list pins (Zune pinned Quickplay items to the taskbar jump list); a remembered position for the mini window; automatically showing the mini player when the main window is minimised.

## D182 (2026-11-23): library organiser, first part: a preview of renaming and a duplicate finder (issue #9)

- **Built (read-only):** Settings > Organise reads the tags of every song and shows (1) how a rule such as `{albumartist}/{album}/{disc}{track} - {title}` would name and place each file, with conflicts (a place already taken, or wanted by two songs) and songs left alone for lack of artist, album or title, and (2) possible duplicates (same artist and title, brackets such as "(Remastered)" ignored, lengths within 3 s; identical sizes flagged as probably the same file) with "Show in folder". `apps/sidecar/src/library_organize.rs` (tested), command `organize_preview`. Names are made safe for Windows.
- **Nothing is moved, renamed or deleted.** Applying a rename is deliberately not built yet: a moved song must take with it the files beside it (lyrics `.lrc`, cover pictures) and every saved reference to its path (favourites, playlists, flags, pins, history, defect and loudness results, the rip/re-rip list), then be undoable. That needs the owner's approval of the approach first (project rule: no moving or overwriting a user's files without a clear, confirmed action).
- **Find moved files:** not built; it depends on the same reference-updating step.

## D183 (2026-11-23): rule-based playlists and an Auto-DJ on the PC (issue #10)

- **Smart playlists** (`smart-playlists.ts`, `smart-store.ts`, `smart-playlists-view.ts`, tested): Library > Playlists has "New smart playlist". Rules over genre, artist, album, title, year, days since added, times played, days since last played, length and "has a heart"; match all or any; order (random, title, artist, newest, most played, oldest); a limit. Worked out each time one is opened, so it is always up to date (hearts from `list_favorites`, play counts from `list_history`). Play, Shuffle, Add to queue, and Save as a playlist (an ordinary, fixed playlist). Kept on this computer (not synced to the phone or Jellyfin yet).
- **Auto-DJ** (`auto-dj.ts`, Settings > Sound, off by default): when the last song in the queue starts, six songs that fit (same genre +3, same artist +2, same decade +1, with some randomness) are added to the end; never a song just played or already queued, never the same band twice in a row; not while repeat is on. Library songs only.
- **Podcasts later:** rules and the Auto-DJ work on library music only, so podcasts (issue #11) will stay out of them.
- Tried in the real app: a rule "year more than 2015" gave 50 songs (the limit); with the Auto-DJ on, reaching the last song kept adding songs.

## D184 (2026-11-23): the organiser makes the changes, and carries everything with the songs (issue #9)

**Owner's decision:** build the apply step. (The "approval of the approach" noted in D182 was my caution about moving a user's files; the owner approved building it, and each use still previews, asks, and can be undone.)

- **Apply** (`organize_apply.rs`, command `organize_apply`): the plan is made again from the files as they are, must match the number the page showed, and every song is moved to the place the rule gave it, only to a free place inside the library with the same extension (nothing is overwritten). The `.lrc` file beside a song follows it; a folder's cover pictures (`cover`, `folder`, `front`, `back`, `artist`, jpg or png) move with the songs when the whole folder moves to one place, otherwise they are copied to where the songs went; folders left empty are removed (only when completely empty). A song that cannot be moved stays exactly where it was and is reported. It refuses to start while a scan, rip, tag write or other job runs.
- **References** (`path_move.rs`): every store that names a song's path is rewritten (case and slash style do not matter): favourites, flags, history, playlists, re-rip and instrumental lists, pins, the library-gaps cache, audio-check results, lyrics-confirmed, and the databases for defect results, loudness, tag repairs (folders, undo journal, confirmed values) and the library index. Each JSON or text file is first copied aside as `<name>.before-organize`. The saved play queue in the page is pointed at the new places.
- **Undo** (`organize_undo`): the last batch (the journal keeps five) is put back in the reverse order: songs, lyrics files, covers; copied covers are removed, folders the batch made are removed if empty, and the references are rewritten back. A song that has since been moved by hand is left alone and reported.
- **Tried in the real app** on a copy of the demo library: a misnamed song in `misc` with a lyrics file, a heart and a playlist entry was moved to its place with its lyrics, the heart and the playlist followed it, the emptied folder went, and Undo restored all of it. Not covered: other programs' references (a Jellyfin server rescans the folder itself; its playlists made by this program match by name), and moving across drives.

## D185 (2026-11-23): organiser choices, compilations, honest duplicates, and a Language tab

**Owner's feedback after trying the organiser on the real library:** nearly every song would move because of the dash between the track number and the title; "cannot be placed" may be the real duplicates; "possible duplicates" were mostly the same song on different albums; wants a drop-down of common naming standards (current one as the default), a default-on "keep compilations together under Various Artists", and a Language tab (American English by default; British, Canadian, New Zealand English; other languages if possible).

- **Naming rules** (`organize-choices.ts`): a drop-down of six common ones (Artist / Album / `01 - Title` (default), `01 Title`, `01. Title`, `Album (Year)`, `Year - Album`, and "keep each file's own name, fix only the folders" using a new `{file}` token) plus "My own rule". Remembered.
- **Compilations:** a checkbox, on by default. An album is a compilation when its tag says so, or when one folder holds one album by three or more different artists and none of its songs has an album artist; such albums go under `Various Artists`. A real album artist tag always wins.
- **Conflicts** now say what is in the way and whether it is the very same file (same size and length); the heading counts those. They are often real duplicate copies.
- **Duplicates** are now chosen by scope: the same song twice in one album (default), exact copies anywhere (same size and length), or the same recording on different albums (information only: a best-of is meant to have it).
- **Language** (`dialect.ts`, `dialect-ui.ts`, Settings > Language): American (default), British, Canadian, New Zealand and Australian spelling of the program's own words, from curated word lists (colour, organise, levelling, centre, catalogue, licence...; Canadians keep -ize). It touches only the settings, the page names at the top and the player's tooltips, never song, album, artist or playlist names. **Other languages** need every piece of the program's text gathered into a translatable catalogue first (hundreds of strings across the pages); that is a separate, larger piece of work, listed in the tracker, and not started.

## D186 (2026-11-23): exclusive (WASAPI) sound output, a switch in Settings > Sound (issue #7)

**Owner's request:** build WASAPI in as an optional output, a switch in Settings, because serious audiophiles will expect it even if it is hard to hear. (The earlier advice, in `docs/playback-engine-plan.md`, was to wait; the owner chose to build it. It is **off by default**.)

- **What it does:** with the switch on, FLAC, MP3 and WAV songs in the music folder are played by the program itself (the sidecar) straight to the sound card in WASAPI exclusive, event-driven mode, with no Windows mixer in between. Samples are held as 32-bit whole numbers, and at full volume the card receives exactly the bits in the file (24-bit and high sample rates stay as they are; 16-bit goes into a 16-bit slot, 24-bit into a 24-bit or 24-in-32 slot). Songs join on the very sample (`Renderer`: gapless is exact, MP3 encoder delay and padding are trimmed by the decoder), and the next song is queued ahead. The settings page says what the last song was played as and whether it is bit-perfect.
- **Choice of card:** Windows' own choice or any active output; the card is let go when the song ends, 20 seconds after a pause, or when the switch is turned off. A song restored paused at start-up does not take the card until it is played.
- **Never fails to play:** a song the program cannot play this way (another file type, a sample rate or depth the card refuses in exclusive mode, the card held by another program, exclusive control disabled in Windows, a library read from Jellyfin only) is played the usual way at once, and the reason is shown in Settings. A card that stops answering during a song hands the song back to the player at the place it had reached.
- **What it gives up while on:** volume levelling, the equalizer, crossfade, play speed and the music glow, because each changes the sound. The volume bar scales the samples (bit-perfect only at the top; the speakers' own volume is the audiophile answer). Other programs cannot use the card while a song plays.
- **No new dependency.** Windows' audio is reached through the `windows` crate already approved for Media Foundation (more of its feature flags: audio, device properties); FLAC is read with `claxon` (already approved for the ripper, now also pinned in the sidecar) and MP3 with `nanomp3` (already used). `third_party/provenance.toml` notes the second use.
- **Built as:** `apps/sidecar/src/native_pcm.rs` (decoding and the card's bytes, platform-independent, 13 tests), `native_wasapi.rs` (Windows device layer), `native_audio.rs` (the playback thread and the commands `native_audio_devices/open/next/control/status`, 138 sidecar commands now); in the page `native-output.ts` (`NativeDeck`, which looks like an audio element to the player; 11 tests), `player.ts` (`usingNative`, `out()`), Settings > Sound > Sound output.
- **Found and fixed on the way:** the screen care (fade to black, Now Playing), the glow and "Play on the TV" read the first `<audio>` element only, which is wrong on every second song once gapless or crossfade swaps elements (Stage 1, D180). They now read one `player.signal` that follows whichever output plays.
- **Checked:** unit tests; a test that opens the real card (Realtek, exclusive, at volume 0) and plays a 24-bit 96 kHz file (taken as 24-in-32), queues a second for a gapless join, pauses, seeks and plays an MP3 at 44.1 kHz; and a run of the real program (`scripts/check-exclusive.cjs`) that confirms the sound is made by the program and not the page, and that pause, seek, next, the join and switching off work. The 22.05 kHz demo-library MP3s are refused by this card in exclusive mode and fall back, as designed.
- **Not done:** converting a rate the card refuses (no resampler: those songs use the usual player), ASIO, DSD, 32-bit float WAV, a live meter for the glow, the phone and TV (they keep their own players), and listening to it on a good DAC (the owner's ears are the missing test).

## D187 (2026-11-23): the organiser's conflicts can be compared and opened, and duplicates are only looked for inside one folder

**Owner's feedback on the previous build:** "songs that cannot be placed" still look like true duplicates but there was no way to open their folders; the "possible duplicates" were overwhelmingly not duplicates (similar songs on other albums, remastered editions of the same album); wants Windows folders of MP3s to show the columns that tell copies apart (bitrate, size, date created, artist, title...) and that does not happen on the network drive M:.

- **Conflicts** now show the two files side by side: tags, size, bitrate, length, date created and changed, with a "Show in folder" button for each (`compareTable` in `organize-settings.ts`; the sidecar adds `from_file` and `other_file` facts read from the files themselves).
- **Duplicates** are now only the same artist and title (brackets ignored) of about the same length **in the same folder**. The three-way choice (`DupMode`, `DUPLICATE_SCOPES`) is gone; a song in another folder is another release, whatever its album tag says. The few groups left use the same comparison table.
- **Explorer columns (not built).** Explorer picks its column layout from a folder "template" (the Music one has artist, album, bit rate...). Windows chooses the template by looking inside local folders but does not look inside network drives, so M: stays "General items", which is why the columns never appear there. The fix is a per-folder setting (right-click the folder > Properties > Customize > Optimize this folder for: Music, with "Also apply this template to all subfolders") and the columns chosen once on the header ("More..."), then View > Options > Apply to Folders. These live in Explorer's own binary "shell bags" in the registry; writing them from the program without being able to look at Explorer would be guessing, so the steps are in `docs/outstanding.md` instead. The comparison table in the organiser is the program's own answer to "which copy is best".

## D188 (2026-11-24): levelling that never lowers, started before the song, heard by every device; the sidecar no longer queues the player behind slow work; progress bars; the mini player in the installed app

**Owner's report after listening:** the first seconds of songs were at a good volume, then the volume dropped on every song; some songs started loud and dropped part way in while the next simply started low; album art rarely updated when skipping through a shuffled queue; no album should be turned down, only quiet ones brought up to the modern standard; wants the levelling heard by every device and Jellyfin, with an easy way back to the originals; long whole-library actions need progress bars; the mini-player button opens an empty black window.

- **Cause of the volume jump and the late art (one cause).** The sidecar answered requests one at a time. A song's gain (`loudness_gains`) and its cover (`track_cover`, read from the network share) waited in the same queue as slow work such as library reads and the measuring run, so both arrived seconds after the song had started; the gain was then applied as a jump (`setLevelDb` set the value at once). Fixes: (1) the sidecar now has a second lane with four workers for what the player waits on (`loudness_gains`, `native_audio_*`, and any request with `"urgent": true`, which the player's cover request uses); everything else still runs one after another in order; checked in the real program: a gain was answered in 5 ms while a library check ran. (2) The page asks for the gains of the current and next songs ahead of time and remembers them for five minutes; a song starts only once its gain is known (waiting at most 0.7 s), the next song's gain is set before it starts, and a gain that still arrives late glides in over 3 s instead of jumping.
- **Never lowered.** `album_level.rs`: the gain is `max(0, -12 LUFS - the album's loudness)`, still held back by the album's loudest passages (now -8 LUFS), its age cap and each song's own peak; a loud album is left exactly as ripped, a clipped song is never lowered. The target moved from -18 (ReplayGain's reference, which lowered most modern albums by 6 to 10 dB) to -12, about where a modern master sits; it is one constant (`TARGET_LUFS`) if it should move.
- **Heard by every device:** Settings > Sound > "Let every device hear the levelling" writes REPLAYGAIN_TRACK_GAIN/PEAK and ALBUM_GAIN/PEAK into the songs of albums that are turned up (`levelling_tags.rs`, through the same safe copy-check-replace write as every tag change, new `TagField`s in `metadata-tags`). Each file's earlier values go into `levelling-tags-journal.json` first; "Put the files back as they were" restores them exactly (tested: the file is the same size and has no tags again). Running it twice writes nothing the second time. Measurements stay valid after the program's own write (the stored size and time are refreshed). Jellyfin and the apps that honour ReplayGain hear it after a library rescan. **The phone and TV apps do not read these tags yet** (not built, untested there).
- **Progress bars** (`progress-bar.ts`, `progress-text.ts`, `runJob(..., onProgress)`): reading the library for the organiser (now read eight files at a time, much quicker on the share), moving files, the library check on Review, measuring the library, and writing the levelling; each shows how far, the time so far, and a guess of the time left. Other jobs already had counters.
- **Mini player:** the packaging script copied only `*.js` from the program's `electron` folder, so `mini.html` and the taskbar button pictures were missing from the installed program (the page worked from source). It now copies them too.

## D189 (2026-11-24): the mini player shrinks the main window; the levelling tags can be written to a few albums or one, and removed without the undo list

**Owner's requests:** the mini player should hide the main window ("shrink" into it) with a way back and a stay-on-top pin; the tag writer should work like Option 1 (press it, stop it, press it again, only what is new is written) with a way to try a few albums or one album first; the tags must follow the ReplayGain standard so they can be deleted or overwritten in foobar2000, Mp3tag and the like even if this program loses its undo list; measuring must ignore the tags and work from the sound.

- **Mini player** (`media-setup.js`, `mini.*`): opening it hides the main window (hidden, not closed; music carries on, throttling is off); the arrow button, or any way of closing the mini player, shows the main window again, so it can never be left hidden. The close button is gone for that reason; a pin button switches stay-on-top (on at each opening).
- **Write choices** (`levelling_tags.rs`, Settings > Sound): all albums (default, resumable), "the next N albums that still need it" (`limit_albums`; albums already right do not count), or one album (`folder`, a picker listing each album with its boost and whether it is written). The result names the albums written.
- **Standard tags, removable without the journal:** the four tags are the ordinary `REPLAYGAIN_TRACK_GAIN/PEAK`, `REPLAYGAIN_ALBUM_GAIN/PEAK` (TXXX in ID3v2, Vorbis comments in FLAC), the same names foobar2000 and Mp3tag write, and the audio frames are never touched. New `levelling_tags_strip` ("Remove the levelling tags") removes the four tags from every measured song, or one album's, without reading the journal (tested on a real MP3 copy with the journal deleted). It removes tags another program wrote to those songs too, and cannot bring back earlier values; "Put the files back" does that when the journal exists. **Deliberate difference from the standard's meaning:** ReplayGain 2 gains aim at -18 LUFS and may lower; ours only lift toward -12 LUFS (D188), so a player that honours the tags turns quiet albums up and leaves loud ones alone. No `REPLAYGAIN_REFERENCE_LOUDNESS` is written.
- **Measuring ignores the tags:** the loudness job decodes the sound only (the one tag it reads is the recording year); the tags never feed the measurement, so "Measure my library" always recalculates from the audio. A file whose tags were changed by another program just looks modified and is measured again (the same sound gives the same result).

## D190 (2026-11-24): the lyric editor fits the window; the skip buttons are gone; right-click the playing song to edit it

- **Lyric editor wider than the screen (owner's report).** The editor under a song's row in Review > Lyrics is inside a table cell, and a cell grows to its widest unbreakable content (the candidate list's long entries); the row then ran past the right edge and could not be scrolled to. `.lyrics-editor { width: 0; min-width: 100% }` makes it take the cell's width instead. Reproduced in a stand-alone page (1279 px wide on a 900 px window before, 900 after); not yet looked at in the installed program.
- **The -5 s / -1 s / +1 s / +5 s buttons are removed** from the editor's transport row (the seek bar, the clock and the speed list stay). The keys Alt+Left and Alt+Right (5 s, with Shift 1 s) still work and the hint still mentions them.
- **Right-click on the playing song** (the player bar's song area, and the cover, title, artist and album on Now Playing): Edit tags, Edit artwork, Edit lyrics (`playingSongMenu` in `main.ts`; the same editors as the library's menu; no menu when the Jellyfin server alone is the library; artwork and lyrics are enabled for MP3 files only, as in the library).

## D191 (2026-11-24): Home page and covers load faster; no stray processes after closing

**Owner's report:** the window opens at once but Home took 4+ seconds to fill and the background 2 to 3 more; the screenshot showed "Your library is empty" next to "13846 tracks in your library"; after closing the program four "MediaVerse Studio" processes and the mini player were still running.

- **Cause of the slow Home (found by reading the code, not yet timed on screen).** Covers were fetched one after another through the sidecar's single ordinary lane (each a read over the network share), and Home waited for every cover on every shelf before showing anything; the background wall asks the same lane. Fixes: (1) covers and artist photos (`track_cover`, `track_artist_photo`) have their own lane of four workers in the sidecar (`is_picture_read`, `lib.rs`), apart from the player's urgent lane, so dozens of covers are read four at a time and a flood of them cannot delay a song's volume or its own cover; (2) Home waits at most 250 ms for covers (`COVER_WAIT_MS`), then shows the shelves with each tile's letter and swaps the cover in when it arrives (covers already known still come at once); (3) Home does not say "Your library is empty" until the first read of the library has finished (`libraryReady`).
- **Stray processes:** the mini player was a second window, so closing the main window left the program running (Electron quits only when every window is gone). The mini player now closes with the main window (`media-setup.js`).
- **Not done:** no startup timer in the program yet; if Home is still slow, add one (window shown, library read, first shelves, covers) to see which step it is.

## D192 (2026-11-24): starting faster (measured), and the mini player remembers where it was

**Owner's report:** Home still filled in slowly after D191; the background arrived before the page's own elements. **Measured this time** (a trace of every call to the sidecar and of the page's long freezes, in `desktop-bridge.ts` and `startup-trace.ts`; the real installed build was launched with a debugging port and read back): the window and page were ready in about 0.1 s and the page never froze for more than 56 ms; the time was in the sidecar.

- **The main cause:** `recent_files` (Home's "New in your library" shelf) walked the whole music folder on the network share, reading 13,846 file times, on **every** Home render (also after each song): 3.2 s. It now reads the times from the library database (`file_records.modified_nanos`, kept current by the scan and the watcher), falling back to the walk only if the database holds nothing for the folder: 3,187 ms became 12 ms; the shelves now appear about 0.4 s after the start instead of about 3.6 s.
- **Covers:** (1) kept on this computer's disk (`cover-cache` in the data folder; the file holds the song's and, for a folder picture, the picture's size and time, and is used only while they match, so re-tagged songs and replaced `cover.jpg` files are read again; pictures over 4 MB and songs with no picture are not kept); (2) a one-minute memory of the library folder's real path, which every cover, play and edit worked out again with a round trip to the share (`real_root`); (3) Home's own covers use the fast lane so they are read ahead of the background wall's (a cover already asked for is not asked twice). About 195 covers: 3.9 s before, 2.9 s the first time, 0.9 s once kept.
- **Home's two quick calls** (`recent_files`, `list_history`) are marked urgent so they do not wait behind the Settings pages' start-up questions (a single ordinary lane).
- **Mini player position:** it opens where it was last left (saved in `mini-player-place.json` while it is moved and when it closes) if all of it lies inside a screen's work area now; otherwise in the bottom right corner of the main screen (`miniPosition`, tested).
- **Still there, not done (small):** the page asks `get_metadata_settings` and `get_archive_settings` four times each at the start; `library_snapshot` (14,000 songs) takes 0.3 s and is the first thing Home needs; the Settings pages' start-up questions could wait until Settings is opened. To look at the trace: developer tools console, `__mvTrace()`, `__mvSteps()`, `__mvFreezes()`.

## D193 (2026-11-24): the TV app remembers its queue

**Owner's request:** the TV applications should remember the queue that was playing when the app is reloaded.

- **What is kept** (`web/app/tv/queue-memory.ts`, wired in `tv/main.ts`): the queue (song ids, as built), its play order, the song it is on, shuffle, repeat and the music source (the Jellyfin server, computer or USB drive the ids belong to); the queue when it changes (a song starts, songs are added or taken out, shuffle or repeat is switched), the second the song had reached every 5 s while playing and when the page is hidden or closed. Stored in the TV app's own storage (`mediaverse.tv.queue.v1`, `mediaverse.tv.queue-position.v1`), as the PC player does; up to 20,000 songs.
- **What happens at the next start:** once the library of the *same* source has loaded, the queue is put back **paused**: the mini bar shows the song, "Your queue is back: N songs. Press Play to carry on." appears, and Play (or the phone's play) opens that song at the saved second; Next/Previous start from there too. Music does not start by itself on a TV that was just switched on. A song that is no longer in the library is left out and the order closes up; if the playing song is gone the next one still there is used, from its start; another source's saved queue is ignored; a USB drive that is still being read is retried as its songs arrive.
- **Tested** with 7 unit tests of the saving and restoring rules (`queue-memory.test.ts`); **not tried on a TV**: it needs the Tizen package (`tools/package-tv.ps1`) installed on the TVs. Not done: the queue of the *phone's* TV remote session and the Android app (the PC player already remembers its own).

## D194 (2026-11-24): measure the library again; the phone saves its place while playing

- **Measure everything again** (Settings > Sound > Volume levelling): `scan_library_loudness` takes `again: true` and reads every song afresh (`loudness_job::library_and_todo`); each old result stays until its song has been re-read and then is replaced (upsert), so stopping half way loses nothing; the player forgets its remembered gains when a measuring run ends. The owner's doubt was whether the stored results were taken while songs were being turned up and down. The measuring never could be: it decodes the file's sound and reads no volume, tag or play setting (the only tag it reads is the year), and the tag writer does not change a measurement. The button is for confidence, and for music changed outside the program. Tested (`measuring_again_reads_every_song_not_only_the_new_ones`); **not run on the real library** (about an hour; the owner's to press).
- **TV app queue memory (D193) tried on the bedroom TV** over the Web Inspector: played an album, moved to 1:00, reloaded the page; after the profile pick the queue was back and paused ("Dijamy", the mini bar), and Play continued at the saved second. TV health at the time: 61 frames a second, 73 MB of 347 MB JavaScript memory.
- **Android:** the app already kept its queue, place, shuffle and repeat (`Resume`, restored paused when the service starts); it was saved only on pause, play, song change and swipe-away. It now also saves every 5 s while playing, so a system kill loses at most five seconds. Unit tests pass; the on-phone check waits for USB debugging to be approved on the phone.

## D195 (2026-11-24): "Feeling lucky" did not spin on a virtual machine

**Owner's report (clean Hyper-V VM, five albums):** the program works, but the lucky jukebox does not spin or do the stopping animation. **Cause:** not the five albums (`luckySpin` repeats albums to fill the strip). A Hyper-V session has Windows' "Animation effects" switched off, so the page sees `prefers-reduced-motion: reduce`; the jukebox skips its animation for that (and `effectiveMotion` makes every other motion "still": no cover flips). Reproduced on the PC by emulating the media feature over the debugging port: 0 running animations with the setting off.
- **New setting** Settings > Display and motion > "Ignore Windows' reduce-motion setting" (`ignoreSystemMotion`, off by default, so a person who really turned animations off is still respected). It lets the jukebox spin (`systemMotionHeldBack`), the cover flips run (`effectiveMotion`) and the stylesheet's reduce-motion rules stand down (`data-ignore-system-motion` on `<html>`). With it on and reduce-motion emulated: the reel animation runs. Unit tests added.
- **Mishap, put right:** the check was run against the owner's real PC data folder and the force-closed test copy left its test queue in the player's saved state; the earlier queue (Hymns Of The Warlock, 13 songs, song 4) was recovered from the storage log and restored; its position within the song (about 1:40) was not kept. Lesson: tests that touch the real profile must use their own `--user-data-dir`.

## D196 (2026-11-24): the version is 0.9.0 (beta)

Owner's decision: the first public build is a beta, 0.9.0 (1.0 will mean "ripped and tested by other people"). Changed by the repository part (A) of `docs/version-bump-checklist.md`: `Cargo.toml` (every crate), `web/app/package.json` and its lock, `ACOUSTID_REGISTERED_VERSION`, the Android `versionName` 0.9.0 and `versionCode` 2 (Play needs it to rise with every upload), the Tizen `config.xml` (package and application ids untouched), `tools/installer/install.ps1`, and the roadmap and workflow notes. Tests that merely use "0.1.0" as sample data were left alone. **Not done here, the owner's to do before a build is shared (checklist part B):** the AcoustID application registration at https://acoustid.org/application/32223 (first), gnudb's registered version, then the GitHub release `v0.9.0`.

## D197 (2026-11-24): the AcoustID application is re-registered under the project account and its key ships in the program

- The AcoustID registration moved from the owner's personal MusicBrainz login to the project's (`MediaVerse.Studio`): application **38031** (replaces 32223 in the checklists and notes), registered at version 0.9.0 with the project Gmail as contact (the form refuses addresses ending `.studio`).
- **The key is built in, but not in the source** (amends D11, "a shipped build starts with no key"): `BUILT_IN_ACOUSTID_KEY` (`crates/disc-metadata/src/settings.rs`) is read from `MEDIAVERSE_ACOUSTID_KEY` when the program is compiled; `tools/make-installer.ps1` sets it from the private file `%USERPROFILE%\.mediaverse\acoustid-key.txt` (outside the repository). Source builds have no key and the Settings page asks. The key is the default only: a saved key (or Remove) in the user's settings wins.
- **AcoustID stays switched off until the person switches it on** (its lookups send a fingerprint of each ripped song to a third party); only the key is pre-filled.
- A MusicBrainz OAuth application (musicbrainz.org/account/applications) is a separate registration and is not needed: nothing in the program signs in to MusicBrainz yet.

## D198 (2026-11-24): MusicBrainz and Cover Art Archive refusals are tried again

**Owner's report:** MusicBrainz was often "busy" or rejected requests: artwork lookups most, but every place that calls it. **Measured:** with the program's User-Agent at one request every 1.2 s, about one reply in six was HTTP 503 "The MusicBrainz web server is currently busy" (1 of 12 in a second run), the rest fine; the replies carry undocumented `X-RateLimit-*` headers whose "remaining" count jumps up and down, so the limit appears to be shared with other users. MusicBrainz's rules pages (2012; no change found in the 2026 account/OAuth announcement) say nothing about a separate limit for signed-in requests, and ws/2 lookups need no key, so registering an application does not address it. The Cover Art Archive itself answered every request. The old musicbrainz.org OAuth registration is deprecated (new ones are created on MetaBrainz; PKCE mandatory); nothing in the program signs in, so none is used.
- **Fix** (`lookup.rs`, `http_get`): a 429 or 503 from `musicbrainz.org`, `coverartarchive.org` or `archive.org` is asked again up to three times, after 1.5, 3 and 5 seconds plus up to a second of random extra (the server's `Retry-After` replaces the pause, between 1 and 10 s); any other answer, and any other site, is not repeated; a refusal that does not go away is returned as before, so each caller reports it and the request scheduler backs off as it did. This covers every MusicBrainz call at once (disc lookup, artwork search, Album IDs, artist names, release comparison, tag repair).
- **Result:** the live check (`live_patience_check`, run on purpose) got 12 of 12 answers through the retries where single tries failed 1 of 12.
- **Not done:** remembering MusicBrainz answers on disk (a repeated lookup would not call out at all) is still on the roadmap. Retrying makes a bulk run that meets many refusals slower, never faster.

## D199 (2026-11-24): a MetaBrainz OAuth application exists for a future "connect my MusicBrainz account"

Registered under the project's MusicBrainz/MetaBrainz account (`MediaVerse.Studio`) at metabrainz.org/profile/applications (the musicbrainz.org form is deprecated, D198). Public (installed) client; **redirect URI `http://localhost:47802/callback`** (accepted by the form; the documented alternatives for desktop programs are `http://localhost:<port>` and `urn:ietf:wg:oauth:2.0:oob`, the fallback if the port is busy). PKCE is mandatory (MetaBrainz announcement of 2026-06-25). The client ID and secret are kept on that account, not in the repository or these notes; MusicBrainz says an installed program's secret "is not treated as a secret", and when the feature is built they are supplied to the build from a private file, as the AcoustID key is (D197). **Nothing in the program signs in yet**, so nothing is built in; the 0.9.0 release does not need it.

## D200 (2026-11-24): going public with a fresh history; Demucs stays optional; the gnudb registration was never sent

- **Fresh history (owner's decision).** The public repository starts from one snapshot of the released tree, with no earlier commits, so nothing from the old history (including what GitHub keeps reachable through its pull-request refs) is published. The existing private repository is kept as a private archive. Last clean-ups before the snapshot: the owner's first name in test sample paths, the PC's host name and a Den TV device id in test data, and the bedroom TV's address in two docs.
- **Demucs.** Not the default (D151), not in the installer (the installer carries no models), optional files the person supplies, with a disclaimer wherever a download is offered: the code is MIT, the weights' licence is not stated and they were trained on a research dataset. The music-lyrics reader and the Whisper rows were as good or better on the mix without it (`docs/lyric-models.md`). The roadmap box is ticked and `THIRD_PARTY_NOTICES.md` says so.
- **gnudb.** There is no registered version to update: the registration email to info@gnudb.org was never sent (`docs/gnudb-registration.md`, now at version 0.9.0 and with the project address). Unregistered programs are accepted while the hello address is real.

## D201 (2026-11-25): the first public release's contents, the contributor line and a documentation clean-up

- **Release `v0.9.0` (draft, in the new repository)** carries: the Windows installer; an Android `.apk` (a release build signed with a project key kept outside the repository, `tools\build-android.ps1 -Release`); the source bundle; and SHA-256 files. **The Samsung TV app is not a download**: a Tizen app installs only on TVs listed in its developer's signing certificate, and that certificate also names its owner, so there is nothing safe or useful to attach; other people get the TV app through Samsung's store beta (`docs/beta-testing.md`) or build and sign it for their own TV (`docs/tv-apps.md`). The Windows installer is unsigned (SignPath needs a public repository first).
- **Contributor line.** The snapshot commit is authored by the owner with the GitHub no-reply address, so GitHub lists the owner's account as a contributor. The early proof-of-concept commits by another author (25 October 2026, the closed pull request #1; their files are no longer in the project) stay in the private archive; credit is the owner's call.
- **Documentation clean-up for the public repository:** the README (platform table with what can be downloaded, status, how to help), the Project Brief, the playback and platform architecture guide (gapless, crossfade, levelling, WASAPI and the visualizer are built; the clean-machine test is done), the Feature Roadmap (a current status and a short "what comes next" in place of the 2026-11-06 list), the third-party licensing guide (AcoustID is built; the release carries its source bundle; the build-time key), `docs/outstanding.md`, `docs/roadmap.md` (going-public boxes), `docs/workflow.md` (`main` only, `develop` created later), `docs/ci.md`, the version checklist. The dead `archive/tauri-desktop` folder (the retired Tauri shell, 63 files) was removed (it stays in the private archive), as was the `spike/**` CI branch pattern and the `.git-blame-ignore-revs` entry for a commit that is not in the new history.
- **Not pruned (deliberately):** `docs/decision-log.md` (the reasons for every choice, including rejected ones, are the point of it), `docs/next-steps.md` and the dated design notes, which are working notes with their dates on them.
