# Windows CD Ripping and MP3 Policy

## The meaning of "near-lossless"

For this project, "near-lossless" means preserving the CD's decoded PCM samples accurately during extraction, before any lossy encoding. The application should aim for a bit-perfect PCM rip when the disc and drive permit it, and should report what it could and could not verify.

An MP3 is a lossy encode. Even when encoded from a verified, bit-perfect rip using the highest-quality LAME VBR setting, it is not bit-perfect and cannot reconstruct the original PCM samples. Do not label MP3 files or the MP3 encoding step "lossless" or "bit-perfect."

Offer a lossless WAV or FLAC extraction/archive path if the product supports it. A useful workflow is to extract/verify PCM first, optionally preserve a lossless master, then encode the MP3 from that same PCM source.

## Extraction and verification behavior

- Read audio sectors digitally; do not use analog line-in recording.
- Read the CD table of contents and retain track boundaries, offsets, and relevant disc metadata.
- Use secure extraction techniques appropriate to the selected drive/library: retry suspicious reads and detect/report read errors. Where supported, account for drive read offsets and C2/error information without treating a drive's C2 reporting as infallible.
- Verify extracted tracks against AccurateRip or another suitable reference when available. Clearly distinguish:
  - extraction completed;
  - local read checks/retries completed;
  - reference verification matched;
  - reference unavailable or no match found.
- A verification match is evidence, not a guarantee that every source sample is correct. A missing database match is not itself proof of a bad rip.
- Never silently claim a rip is verified when the service was unavailable, the disc was not found, or a check failed.
- Keep extraction output in lossless PCM until verification is complete; do not send a lossy stream directly from the drive as the only retained output.
- Make jobs cancellable and report track-level progress, retries, errors, and final verification status.
- Test with real drives and discs, including damaged media and different drive offsets. Hardware access and drive behavior cannot be validated by unit tests alone.

## LAME defaults and options

The MP3 encoder is LAME 4.0, built from a pinned, verified source archive (`tools/build-lame-4.0.ps1`, approved in `third_party/provenance.toml`) and run as a separate program. Every MP3 is decoded again with nanomp3 and compared with the verified source (D18).

- Default: **Variable Bit Rate, LAME `-V0`**.
- Optional: **Constant Bit Rate, 320 kbps, LAME `-b 320`** (also known as `--preset insane`).
- Show these as user-understandable options and pass explicit, validated arguments to the encoder. Do not allow arbitrary UI text to become shell arguments.
- Record the selected mode and encoder version in the rip job result. Do not imply that V0 produces a fixed bitrate; VBR bitrate varies with the content.
- Preserve the lossless extraction if the user requests it, independent of which MP3 setting is selected.

## Separation of responsibilities

Keep CD access, TOC/metadata lookup, PCM extraction, verification, encoding, and tagging separate. A failed metadata request should not prevent a user from extracting the disc; a failed encode should not erase a verified PCM source.

Represent ripping as an explicit job with state, progress, cancellation, and structured errors. Never hold up the UI while the drive is working. Do not allow two application jobs to control the same drive simultaneously.

## Accepted workflow: verified PCM first, then FLAC master and MP3 (D2, D3, D4)

1. Read the TOC and compute the disc ID; look up metadata and artwork.
2. Extract PCM with libcdio-paranoia in secure mode, applying the drive read offset.
3. Verify against AccurateRip (or CTDB) and write the per-rip log. Report each verification state separately.
4. Write the verified PCM to a WAV working file. (Corrected 2026-11-02: earlier text said "write FLAC first"; the implementation keeps a WAV, avoiding an encode/decode round trip.)
5. Optional, controlled by the "Keep a lossless FLAC archive" setting: encode a FLAC master from that WAV, tag it with plain text tags, and decode it back to prove it is identical.
6. Encode the MP3 from the same WAV (LAME `-V0` by default, or `-b 320`), then tag it (ID3v2.3) with metadata, embedded artwork and lyrics, and decode it to check it matches the source.
7. Delete the WAV only after every requested output has succeeded.

Before any of this starts, the rip is refused unless the folders are safe: an archive folder must be chosen when archiving is on, it must be separate from the Main Media Library, and the temporary WAV folder must not be inside the library (no duplicate songs in the library).

A missing AccurateRip entry is a warning, not a failure. The tracks are marked "not confirmed" and the user is told a defect scan (planned library feature) can check them later.

Keeping FLAC masters is a user option. When enabled, they go to the **Media Library Archive**, a location configured separately from the **Main Media Library** that holds the MP3s. The two locations must differ and must not be nested. The archive is write-only storage and is never scanned into or shown in the playback library. A rip that fails verification may still be encoded, but must be labelled unverified.

## Integration boundary

The CD backend is libcdio and libcdio-paranoia, built from pinned source and used only inside the separate CD helper program (`apps/cd-helper`, D4, D6). It sits behind a Windows-only interface so the ripper stays a self-contained module (ADR 0007). The rest of the application depends only on operations such as:

- enumerate drives and inspect media state;
- read TOC and CD-Text where available;
- extract a selected track/range to PCM;
- report drive/read capabilities and extraction errors;
- stop or cancel an active job;
- return verification information separately from extraction output.

These are the sidecar commands listed in ADR 0003 and ADR 0007. The libcdio bindings are hand-written for the pinned headers and kept in one file (`apps/cd-helper/src/native.rs`).

**Not used:** CDex's CDRip.dll and fre:ac's BoCA CD components were studied early on and rejected (licensing conflicts and an unverifiable DLL; see `Third-Party Software and Licensing.md`). The `libcdio-sys` crate was also rejected because its secure-read build fails on Windows (D6).

## References

- libcdio: https://github.com/libcdio/libcdio
- libcdio-paranoia: https://github.com/libcdio/libcdio-paranoia
- LAME project: https://lame.sourceforge.io/
- AccurateRip: http://www.accuraterip.com/
- CUETools / CUERipper and the CTDB (design reference, D6): https://github.com/gchudov/cuetools.net

Service policies can change. Check pinned releases and primary documentation before changing an integration.

