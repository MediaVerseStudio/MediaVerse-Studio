# ADR 0004: Drive test and calibration

## Status

Accepted (2026-10-31); build option (b), a separate native helper, chosen by the project owner.
Built from the manual procedures validated on the development PC; see `docs/decision-log.md` D6.

Implemented so far: the pure logic in `crates/ripper` (profile types, transfer-limit search, read
repeatability, cache test, offset determination, the guided `calibrate` run, and a simulated drive,
16 tests) and a fast offset search in `crates/accuraterip`. The native helper (`apps/cd-helper`) is also
built and has run a full calibration on the development drive. The sidecar commands, profile storage
(one JSON file per drive under `<data dir>/drive-profiles`), the AccurateRip lookup with a disk
cache, and Electron's allowlist are done and tested end to end on the development drive. The Drive setup screen
(`web/app/src/drive-setup.ts`, text logic in `drive-format.ts`) is built and was driven end to end in
the real Electron app. Since D30 the Drive setup section lives inside the Rip a CD page and opens by
itself when the drive has not been checked. Not yet implemented: the connection-type lookup and
profile import/export.

## Goal

Let the app test and calibrate any optical drive, on any computer, and remember the result per
drive, so ripping is accurate without the user knowing about offsets or caches. A computer may have
several drives; each is tested and stored separately.

## Drive identity and profiles

- A drive is identified by vendor, model and firmware revision from the drive's identity data
  (`INQUIRY`), plus the connection type (internal or USB) when known. The drive letter (`E:`) is
  not an identity: it changes between machines and ports.
- A **drive profile** records: identity; read offset in samples and the evidence for it (disc,
  tracks matched, date); effective cache size in sectors; largest working transfer size in sectors;
  whether repeat reads agree; whether secure mode is judged viable; app version; free-text notes.
- Profiles are stored in the app's data directory and can be exported and imported as JSON. An
  imported profile is only a starting point and is marked unverified until the quick check passes.
- Profile fields have a state: `measured`, `suggested` (from a database or an import), `manual`,
  or `unknown`. The UI and the rip log show that state; an unverified offset is never described as
  verified.

## Calibration steps (shown to the user as a guided check)

1. **Identify** the drive and read its capabilities.
2. **Read test**: read the table of contents, read a few seconds twice and compare, and find the
   largest transfer size that works (the development drive works up to 55 sectors, about 128 KiB).
3. **Cache test**: the timing method in `tools/cdprobe/cachetest.c`, with the absolute-threshold fix.
   The result sets the cache model used for secure re-reads (default stays 1200 sectors).
4. **Offset check**: needs an audio disc that is in AccurateRip. Look up the disc, rip two or three
   middle tracks, and search offsets within about plus or minus 2,940 samples
   (`mediaverse_accuraterip::find_offsets`). Accept an offset only if at least two tracks match at
   the same offset. A starting suggestion from a published drive-offset list may be shown, but only
   a disc match makes it `measured`. If the disc is not in the database the app says so and asks
   for another disc, or accepts a manual offset marked `manual`.
5. **Save** the profile and show a plain summary and any warnings.

Every step reads only; nothing is written to the drive or disc. Each is cancellable and reports
progress.

## Keeping profiles honest after setup

- A normal rip that verifies against AccurateRip at the stored offset adds to the profile's
  evidence. A rip that repeatedly fails to verify while the disc is clean raises a warning and
  offers to re-run calibration.
- Changed firmware revision, a different connection type, or a user request marks the profile
  stale.

## Architecture

- Pure logic in a Rust library crate (`crates/ripper`): calibration decisions, the cache analysis,
  profile types and rules. It works against an `OpticalDrive` trait and is tested with a simulated
  drive that has chosen offset, cache size and transfer limit.
- The native CD helper (`apps/cd-helper`) implements `OpticalDrive` with libcdio and
  libcdio-paranoia (static MinGW build in `third_party/build`). These libraries only link for the
  `x86_64-pc-windows-gnu` target; the rest of the application builds with MSVC.
- Sidecar commands (see ADR 0003): `list_drives`, `list_drive_profiles`, `calibrate_drive` (a job
  with `job-progress` and `job-finished` events and `cancel_job`).
- UI: the Drive setup section of the Rip a CD page, with a drive picker and the guided check above.
- Android has no raw CD access and does not use any of this.

## Build decision (accepted: helper executable)

Because of the linking constraint, the native code is a separate small helper executable
(`mediaverse_cd_helper`, GNU target) that the sidecar starts per job and talks to with the same
line-delimited JSON. This keeps the rest of the program on the default toolchain, isolates native
crashes and hangs from the library and UI, and lets the helper be restarted per job. (The rejected
alternative was building the whole sidecar for the GNU target.)

## Limits to state in the product

- The offset can only be verified with a disc that is in AccurateRip (or CTDB). Many discs are.
- The cache test is a timing measurement of one access pattern, not a guarantee. USB bridges add
  their own behavior, so a USB drive gets its own profile.
- The same drive model usually has the same offset, but that is not guaranteed.
- AccurateRip and drive-offset-list terms of use must be checked before the app queries them in
  production, and requests must be rate-limited and cached.




