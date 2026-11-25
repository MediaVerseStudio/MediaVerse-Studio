# Playback engine plan: gapless, crossfade, volume levelling, EQ, audiophile output

Owner's list of 2026-11-23: gapless and crossfade (issue #5), volume levelling (#6), the playback engine with WASAPI, EQ and DSP (#7); then the mini player and media keys (#8). This is the plan, with the one decision that needs the owner (see the end).

## What I found

- The PC plays one song at a time through an `<audio>` element fed from memory (`web/app/src/player.ts`, `audio-cache.ts`: the whole song is read first, the next songs are read ahead). So the next song is already in memory when the current one ends.
- Chromium's Web Audio can schedule sound to the exact sample. So **gapless, crossfade, ReplayGain and a 10-band EQ do not need a new native engine or any new dependency**; only **exclusive-mode output (WASAPI exclusive) and ASIO** need native code, because a browser engine cannot open the sound card exclusively.
- This changes the recommendation in `docs/competitor-and-style-review-2026-11-23.md`, which said one native engine would deliver all of it: the cheaper route is to do items 1 and 2 in two stages and decide about the native engine afterwards.
- Decoders already in the program: `nanomp3` (MP3) and `claxon` (FLAC) (see `third_party/provenance.toml`), used by the defect scan through `library_defects::decode_file`.

## Stage 1: no new dependencies (Web Audio in the renderer, loudness in the sidecar)

1. **Loudness analysis (done 2026-11-23, `apps/sidecar/src/loudness.rs`, 7 tests).** EBU R128 / ITU-R BS.1770-4 integrated loudness with the K-weighting filter, gating, ReplayGain 2.0 reference of -18 LUFS, a no-clipping limit, and an album gain. It reads a full-scale 997 Hz tone as 0.0 LUFS and one channel as -3.01 LUFS, as the standard says. Written from the published standard.
2. **A scan job and storage (next).** A sidecar job analyses library songs in the background (resumable, low priority like the defect scan) and stores loudness and peak per song in the library database; optionally writes the standard ReplayGain tags after a preview (project rule: no silent file changes). The Jellyfin-only mode reads the tags if present.
3. **Gain on playback.** A Web Audio graph (`audio` element -> gain node -> existing analyser -> output) applies the song's or the album's gain, with a Settings choice: off, per song, per album. This also gives the phone and TV a path (they read the stored gain).
4. **Gapless and crossfade.** Two decks (two `audio` elements, or decoded buffers) so the next song starts on the sample the current one ends. MP3 encoder delay and padding are trimmed from the LAME/Xing header (parsed in the sidecar, passed with the song) so albums such as live recordings and mixes have no gap. Crossfade is a gain ramp across the join with a length from Settings (off by default); never applied between two songs of the same album marked as a continuous mix. Seeking, pause, the visualizer, lyrics timing and casting keep working on the deck that is playing.
5. **EQ.** A 10-band equalizer from Web Audio biquad filters with presets (the phone's presets already exist in `eq-presets.ts`).

Risk: the player is used every day and during rips; each step lands behind a Settings switch and is tested on `develop` before it reaches `main`.

## Stage 2: native output (only if wanted afterwards)

WASAPI exclusive mode and ASIO need a native output in the Rust sidecar: a decoder crate (candidate: Symphonia, MPL-2.0) and a device layer (candidates: the `wasapi` crate for exclusive mode, or `cpal`, which I have not confirmed supports exclusive mode). I did not verify these licences and capabilities beyond the project pages; each needs a provenance and licence record and the owner's approval before it is added (`Guiding Documents/Third-Party Software and Licensing.md`). Stage 2 would replace the `<audio>` decks with the native engine behind the same player interface.

## Decision for the owner

Approve Stage 1 now (it adds nothing to the dependency list) and decide on Stage 2 after trying Stage 1 on real music? Recommended: yes.

## What a native engine would and would not add (answering the owner, 2026-11-23)

The earlier finding stands: gapless, crossfade, volume levelling and the equalizer did **not** need a native engine, and are built with Web Audio (D180). A native engine (decoder plus WASAPI/ASIO output in the Rust sidecar) would add only:

| Gain | Audible? | Without a native engine |
|---|---|---|
| Bit-perfect / exclusive output, switching the sound card to the file's sample rate, ASIO | Only on a good DAC with 88.2 kHz and up files; for CD-quality MP3 and FLAC it is not audible | Windows' mixer resamples to the card's rate; fine for normal listening |
| Sample-exact gapless | Only on gapless albums (live recordings, mixes); today's join is within about 30 ms | Web Audio can schedule decoded buffers to the exact sample and trim the MP3 encoder delay: a smaller job than a new engine, still to do |
| More formats (APE, WavPack, DSD, WMA) | Only if the library has them (it is MP3 and FLAC) | Convert, or leave out |
| More DSP (crossfeed, upmixing, resampling quality) | Marginal | Not needed |

Cross-platform: a native engine is one more audio stack to keep alive per platform (WASAPI here; ALSA or PipeWire on Linux; Android already uses Media3 and the TVs use the platform player). The browser engine gives Windows and Linux the same player for free. Recommendation: do not build a native engine now. Do the sample-exact Web Audio scheduling if gapless albums matter, and revisit WASAPI exclusive only if beta testers with hi-res libraries ask for it.

## Update 2026-11-23 (D186): exclusive output is built, as a switch

The owner chose to build it (off by default) after the recommendation above. It needed no new dependency: Windows' audio through the windows crate already in the program, FLAC through claxon and MP3 through 
anomp3. Details, limits and checks are in D186 in the decision log. Still open from the table: ASIO, a resampler for rates a card refuses, and more formats.
