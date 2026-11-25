# ADR 0007: The CD ripper is a standalone module

Status: accepted 2026-11-02 (owner request, decision D19).

## Decision

CD ripping stays a self-contained module that the rest of the program reaches only through a small, typed
interface. Nothing outside it needs to know about libcdio, drives, WAV files or AccurateRip.

## The module today

| Piece | Where | Role |
|---|---|---|
| Native CD reader | `apps/cd-helper` (own process, GNU target) | Drives, TOC, secure reads, WAV output, AccurateRip comparison. The only code that touches the drive. |
| Ripping logic | `crates/ripper`, `crates/accuraterip` | Drive profiles and calibration, FLAC/MP3/ID3/LRC writers and checkers. No platform code. |
| Lookup | `crates/disc-metadata` | Disc ID and MusicBrainz/gnudb lookups. Independent of ripping. |
| Job glue | `apps/sidecar` (`drives.rs`, `rip_job.rs`, `archive_job.rs`, `mp3_job.rs`, `cover_art.rs`) | Folder checks, ordering of steps, progress events, warnings. |

## The interface

The sidecar commands (ADR 0003) are the module boundary: `list_drives`, `calibrate_drive`, `lookup_disc`,
`rip_disc` (with `candidate`, `archive`, `mp3`, `mp3_quality`, `keep_wav`, `pictures`), `cancel_job`, and the
archive settings. Results are plain JSON: per-track verification (`matched`, `no_match`, `unavailable`),
files written, and warnings. The web UI and any future shell use only these.

## Rules that keep it modular

1. The ripper never reads the library database or UI state. The library may read the ripper's outputs (files).
2. The ripper's own writers (`id3.rs`, `lrc.rs`, `flac.rs`, `mp3.rs`) have no dependency on the drive code,
   so the same tag code serves the future library repair page.
3. Anything platform-specific (libcdio, Windows drive paths) lives only in `apps/cd-helper`.
4. Errors are structured codes (`disc_lost`, `disk_full`, `archive_folder_required`, ...), never strings to parse.

## Future: ripping on phones and tablets (Android and iOS) with a USB optical drive

Priority (D21): lowest of the platform ideas. Windows is primary; Android is wanted mainly for playback and casting to a
TV; iOS is a low-priority later path. This section only records what the module split keeps possible.

Goal (owner, 2026-11-02, clarified): a phone or tablet running Android or iOS, with a USB-connected optical drive,
rips CDs by itself, so a Windows PC with an internal or external drive is no longer required. Set aside until the
Windows and mobile apps are complete.

The split above is what keeps this possible: a mobile build would replace only `apps/cd-helper` with a driver that
talks to the USB drive (sending the drive its raw read commands, as libcdio does on Windows), and reuse
`crates/ripper`, the metadata crates and the tag writers unchanged. LAME and the FLAC encoder are portable code.

What a feasibility study must answer first (nothing below is verified yet):
- **Android:** apps can open USB devices through the USB host API, which should allow raw commands to a drive, but
  device support varies and power from the phone may not be enough for a bus-powered drive. A powered hub or
  self-powered drive may be needed.
- **iOS:** Apple restricts which USB devices apps may talk to. Whether an app can send raw read commands to an
  optical drive at all (as opposed to showing a drive as storage) is the main unknown, and may rule it out.
- Secure ripping, drive offset calibration and AccurateRip rely on the same raw reads, so a drive that cannot
  do them cannot be called accurate; the app would have to say so.
- Storage, battery and background-work limits on phones for a long rip.

## Also kept in mind (not built)

- Multi-disc sets: the metadata already carries `disc_number` and `disc_count`; ripping each disc as its own
  job into the same album folder is a UI and bookkeeping feature for later.
The library defect scan (pops, clicks, dropouts) is now built as a separate analysis module
(`crates/ripper/src/defects.rs`, D24) that reads audio files and reports suspect time ranges.
