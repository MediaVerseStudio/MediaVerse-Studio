# ADR 0005: Ripping pipeline

## Status

Accepted (2026-10-31). All seven steps below are implemented and tested on the development drive
(MP3 and cleanup since D18; the Rip a CD page since D20). The pipeline code is in
`apps/sidecar/src/rip_job.rs`, `archive_job.rs` and `mp3_job.rs`.

## Pipeline

1. **Calibrated drive.** Ripping requires a stored drive profile with a read offset (ADR 0004). A
   drive with no profile is refused (`drive_not_calibrated`). An offset that was never measured
   (suggested or manual) is allowed but flagged in the result and the rip log.
2. **Secure extraction.** For each audio track, `mediaverse_ripper::rip::read_track` reads the
   track's sectors plus whatever the offset requires, through libcdio-paranoia in full mode with
   "never skip" (the helper's `SecureReader`), then cuts out exactly the track's samples. Samples
   that lie outside the readable disc (the start of the first track for a negative offset, the end
   of the last for a positive one) are filled with silence and counted in the log. AccurateRip
   ignores the first 2,939 and last 2,940 samples of the first and last tracks, so this does not
   affect verification there.
3. **Verification.** The track's v1 and v2 checksums are compared with every AccurateRip pressing
   for the disc; the highest-confidence match wins. Reported as one of `matched`, `no_match`,
   `unavailable`.
4. **WAV intermediate** (done): one 16-bit stereo 44.1 kHz WAV per track in the output folder, with
   a `rip-log.json`.
5. **FLAC master** (done): `crates/ripper/src/flac.rs` encodes the verified PCM with `flacenc`,
   adds Vorbis comment tags (TITLE, ARTIST, ALBUM, ALBUMARTIST, TRACKNUMBER, GENRE, DATE), and
   proves with `claxon` that the result decodes to exactly the source samples. The check runs
   three times: on the encoded bytes, on the tagged bytes, and on the file as stored. A track that
   fails any of them leaves no file behind. Files go to the Media Library Archive
   (`apps/sidecar/src/archive_job.rs`, `crates/ripper/src/archive.rs`): `<archive>/<album
   artist>/<album>/NN - Title.flac`, Windows-unsafe characters replaced, an existing file never
   overwritten, the rip log saved beside the masters. Tracks that did not match AccurateRip are
   still archived but flagged as unverified in the result.
6. **MP3** (done): encode with LAME (`-V0` by default, `-b 320` optional) from the same verified
   PCM; tag with metadata, artwork and lyrics (see "MP3 library copies" below).
7. **Cleanup** (done): remove the WAV intermediates and the program's own working folder only after
   every requested output is written and checked (`keep_wav` overrides). Tracks AccurateRip could not
   confirm are scanned for defects before the WAV is removed (D24).

## Honest reporting

The log keeps three things separate and never merges them: extraction completed, read checks (how
the secure reader behaved: repair events, blocks it could not read cleanly, suspected stale cache),
and reference verification (matched, no match, unavailable). A plain, non-secure read is labelled
"single-pass read (not cross-checked)". Reader events that signal trouble (`skipped_sectors > 0`,
`cache_errors > 0`) change the summary text. "Bit-perfect" is never claimed: a match is evidence,
not a guarantee, and MP3 is lossy.

## Interfaces

- `OpticalDrive::read_audio_secure` returns a `ReadQuality`; the default implementation does a plain
  read and reports `secure: false`, so nothing can pass off an unchecked read as secure.
- Helper command `rip_disc {device, output_dir, offset, max_transfer?, secure?, tracks?,
  pressings_hex?}` emits `rip-progress` events and returns the log.
- Sidecar command `rip_disc` is a job (ADR 0003, full argument list in ADR 0007): it loads the
  profile, looks the disc up in AccurateRip, runs the helper, makes the FLAC and MP3 outputs, and
  reports `job-progress` (kinds `rip`, `archive`, ...) and `job-finished`. Cancelling stops the helper;
  a cancelled rip leaves no partial WAV.
- Secure reads run in segments of 750 sectors (about ten seconds) and continue without a seek, so
  paranoia keeps its overlap context while progress and cancellation stay responsive.

## Measured on the development drive (ASUS BW-16D1HT, Operation Ivy "Energy")

Secure rips of tracks 1, 5, 6, 12, 22 and 27 all matched AccurateRip (confidence 11) at offset +6,
including the first track and the last track (6 samples of end padding). The WAV files were
re-checked from disk with separate code. Speed on a clean disc: 45 seconds for 5:20 of audio, about
8 seconds per minute of audio (roughly 7 times real time). A full 57-minute disc should take about
eight minutes in secure mode.

## Archive settings

`get_archive_settings` and `set_archive_dir {path|null}` store the archive folder in
`<data dir>/settings.json`. The folder must be an absolute path, different from and not nested with
the Main Media Library in either direction (checked on save and again before every rip, comparing
real locations where they exist, case-insensitively). The archive is never scanned or watched.

## What goes in the FLAC, and what does not (decided 2026-10-31)

A damaged FLAC master cannot be rebuilt without the disc; a damaged MP3 can be rebuilt from the FLAC in
seconds. So risk is kept off the master:

* **FLAC master: plain text tags only**: title, artist, album, album artist, track number (and total),
  year, genre, disc number, and a compilation flag for "Various Artists" albums. These are the fields the
  Navidrome notes call required or recommended.
* **Cover art** is not embedded in the FLAC. It is saved as an ordinary `cover.jpg` file in the album
  folder (checked: JPEG or PNG, size and dimension limits). The archive is write-only and not part of the
  library, so it does not need library-style embedded art.
* **Lyrics** are not embedded in the FLAC. They are saved as `.lrc` (synced) or `.txt` files beside the
  track; the strict tag check rejects newlines in tag values, which lyrics need.
* **MP3 (the library copy): the full set**: the same text tags, embedded cover art, and lyrics (plain
  and synced), written after the LAME step and tested against a reference decoder and another reader.
* The archive is never edited in place by this program, which removes the largest real-world cause of
  broken FLAC tags (third-party editors rewriting files later).

## Chosen details become tags; cover art (built 2026-10-31)

`rip_disc` accepts `candidate`: one `candidates[].album` object from `lookup_disc`, passed only after
the user has chosen it (nothing is written from a guess). `metadata_from_candidate` turns it into the
tag set: TITLE, ARTIST (the track's own artist if it has one, else the album artist), ALBUM,
ALBUMARTIST, TRACKNUMBER, TRACKTOTAL, DISCNUMBER and DISCTOTAL (only for multi-disc releases), GENRE,
DATE, and COMPILATION=1 only for "Various Artists" albums (MusicBrainz also labels one artist's
best-of albums "Compilation"; those are deliberately not flagged). All text is cleaned first. A
candidate with no album title, no artist or no tracks is refused (`invalid_candidate`); a candidate
listing a different number of tracks than the disc has is refused before anything is ripped
(`metadata_mismatch`); a track with no title is saved as "Track NN" with a warning. A manual `metadata`
object still works.

**Cover art.** If the chosen details carry a MusicBrainz release id and cover art is switched on in
Settings, the front cover is downloaded from the Cover Art Archive (1200 px, else 500 px), checked
(`cover_art.rs`: really a JPEG or PNG, at most 5 MiB, 150 to 6000 px per side, roughly square; the
release id is validated so it cannot alter the request) and saved byte for byte as `cover.jpg` (or
`.png`) beside the FLACs. An existing cover is never replaced. Failure is only ever a warning: the
masters are saved either way. A progressive JPEG is saved with a warning, because some older players
cannot show those; it matters for the MP3 step.

## FLAC tagging safety (2026-10-31)

FLAC tags are a known source of files that players or converters refuse. Everything below is built and
tested (`crates/ripper/src/flac.rs`, 22 tests plus the archive tests):

| Known fault | Defence |
|---|---|
| Tag block added without fixing the "last metadata block" flag (the fault we met with the generic tag library) | We build the metadata chain ourselves; `check_structure` demands the flag only on the final block and a real audio frame right after it |
| ID3 or other data in front of the `fLaC` marker | Marker checked at byte 0; we never write ID3 into FLAC |
| Duplicate tag, seek-table or STREAMINFO blocks; reserved block types; STREAMINFO not first | Rejected. Only block types this program writes are allowed, so a damaged tag header that turns into a cue-sheet or application block (tags vanish silently) is caught too |
| Control characters, NUL, bad UTF-8, a missing `=` or a bad name in a tag | `clean_tag_value` cleans every value from outside; the writer refuses control characters; the validator re-checks every entry |
| Huge tag blocks or pictures | Tag block capped at 256 KiB, values at 1000 characters; embedded pictures (not written yet) must be 8 MiB or less with consistent lengths |
| Missing or wrong audio signature (MD5), wrong sample count or format | STREAMINFO checked against the source: 44.1 kHz, 2 channels, 16 bits, exact sample count, MD5 equal to the MD5 of the audio |
| Corrupt audio frames, truncated files | Full decode with frame-checksum verification, compared sample for sample with the source |
| A final block of a few samples that strict decoders reject | Block size chosen per track (see below) |
| STREAMINFO minimum block size counting the short last block (reference decoder: "file might not be seekable") | Minimum set equal to maximum; the validator rejects a stream declared variable-size whose frames use fixed numbering |
| Tags that went missing or changed in the write | `check_tags` demands exactly the intended tags, in order |

The file is checked at three points (after encoding, after tagging, and re-read from disk after it was
stored), and a file that fails any check is removed. Testing included injecting each fault above, 150
random combinations of track lengths and tag sets, a flip of every single bit of the metadata (no flip
may produce a file that passes with wrong audio, and every flip in a structural field must be caught),
and damage at spots through the audio data.

### Cross-check with the reference decoder (done 2026-10-31)

Xiph's own `flac` 1.5.0 is the strictest reader there is, so our files are tested with
`flac --test --warnings-as-errors` and decoded with `flac -d` (the output must equal our audio byte for
byte). It is a test-only download (`pwsh tools/fetch-flac-reference.ps1` checks it against a pinned
SHA-256, Xiph's published checksums, and GitHub's copy; it is never shipped) and the test
`crates/ripper/tests/reference_decoder.rs` runs automatically when it is present.

**This found a fault that all of our own checks had missed.** The encoder library records the short
final block as the stream's *minimum* block size, but the format says the minimum excludes the last
block. With minimum different from maximum, readers decide the stream has variable block sizes and
expect sample numbers in the frame headers, while the frames carry frame numbers: the reference
decoder warned "sample or frame number does not increase correctly... file might not be seekable" and
failed in strict mode. The audio was always bit-exact, and the in-program decoder did not check this.
Every file made by the library had the fault, at every block size. Fixed by setting the minimum equal
to the maximum in STREAMINFO (outside all frame checksums, so nothing else changes), and the strict
validator now rejects the old form. After the fix 28 test files and 3 real-disc tracks pass the
reference decoder and decode to identical audio.

Embedded cover art in FLAC is deliberately not written (D15); the picture-block validator stays as a guard.

## MP3 library copies (built 2026-10-31)

- LAME (`-V0` default, or `-b 320 --cbr`) encodes from the verified WAV; its output carries no tag.
- `crates/ripper/src/id3.rs` writes ID3v2.3: Latin-1 text when possible, otherwise UTF-16 with BOM;
  APIC pictures (front 3, back 4, artist 8; embedded only if <= 500 KB and not progressive),
  USLT plain lyrics and SYLT synced lyrics (from `.lrc` text via `lrc.rs`).
- `mp3.rs::check_structure` proves the frame chain, Xing/Info count and exact playable length.
- Tests read the finished files with lofty as an independent reader (pictures by kind, lyrics).
- `mp3::decode_check` decodes the stored file with nanomp3 (LAME here is encoder-only) and requires the
  exact sample count and a signal-to-noise ratio of at least 15 dB against the verified source.
- Library WAV files are removed only after every requested output succeeded (`keep_wav` overrides).
## Lessons recorded

* The generic tag library (lofty) corrupts a freshly encoded FLAC: `flacenc` marks STREAMINFO as the
  last metadata block, and lofty inserts a tag block after it without clearing that flag. The
  re-decode check after tagging caught it before any bad file was kept. Tags for new files are now
  written by `with_vorbis_comments`; lofty is used only to read tags back in tests.
* CD tracks are multiples of 588 samples, so about 3 in 1,000 would end in a FLAC block of 4-12
  samples, which valid but strict decoders reject. `block_size_for` picks a block size that avoids a
  final block shorter than 16 samples.

## Open

- What to do when a track does not match: offer a re-rip of that track with stronger error
  correction, keep it flagged, or both (D25 plans the re-rip).
- A lasting "unverified" mark on files whose rip did not match (today it is a warning in the result).
- Free-space check before ripping; multi-disc albums.
- The paranoia cache model stays at its 1,200-sector default; our drive's measured cache is ~30.
