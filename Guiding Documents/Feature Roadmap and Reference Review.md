# Feature Roadmap and Reference Review

## Where the project stands (2026-11-25)

*Current plan: `docs/roadmap.md`; why each choice was made: `docs/decision-log.md`. This document keeps the reasons and ideas behind the order of work.*

The first public beta, 0.9.0, is out: a Windows installer and an Android app on GitHub, and a Samsung TV app that works on real TVs and reaches other people through Samsung's store beta (`docs/beta-testing.md`). Built since the early order of work below: Fix tags with undo, Discogs, automatic covers and lyrics with review, the Lyric AI, the Windows Media Player-style library, playlists (also rule-based) with XSPF/M3U8 sharing, casting (the MediaVerse TV app, DLNA, Google Cast), Jellyfin as a shared hub and as a library, gapless playback and crossfade, an equalizer, volume levelling that never turns anything down, optional exclusive (WASAPI) output, a mini player, the library organiser, and the Samsung TV and Android apps. Licence: GPL-3.0-or-later (D81).

## Inspirations and references

Each project below is studied for a specific lesson. Nothing is copied: no code, SDKs, binaries, artwork, icons, fonts or names (licence status is in `Third-Party Software and Licensing.md`).

### Look and feel

| Project | What we take from it | Where it shows up |
|---|---|---|
| Microsoft Zune (4.0 desktop software, Zune HD) | Type-led, low-chrome design; Quickplay home (New, History, Pins); Now Playing as a tinted wall of the library's own covers with the queue as plain text | Home (D26, D27), Now Playing wall (D23, D26); notes in `docs/design-inspiration.md` |
| Rune (MPL-2.0, Rust + Flutter) | Evidence that a modern Zune-style player works; responsive layouts, keyboard support, colour themes, rule-based mixes | Ideas list in `docs/design-inspiration.md` |
| Winamp, with its AVS and MilkDrop visualizations | Fun, music-reactive visuals while a song plays; a compact mini player and skinnable feel | The visualizer in Now Playing (see the playback guide) and the mini player (built) |

### Library and playback

| Project | What we take from it | Boundary |
|---|---|---|
| Navidrome | Fast incremental scans, reconciling removed files, then refreshing artist and album totals; the Album Artist and compilation tagging model | AGPL-3.0: behaviour and tagging reference only, no source copied |
| foobar2000 | Responsive large-library browsing, native tag-field mapping, gapless playback, ReplayGain, embedded art | Proprietary: behaviour only |
| Windows Media Player (legacy and Windows 11) | Clear library and indexing state, artist-to-album navigation, explicit rip progress, a ripped disc appearing in the library at once | Behaviour only |
| MusicBee, Plex | A ripped or added album shows up in the library immediately (D20); rich artist pages | Behaviour only |

### Lyrics

| Project | What we take from it | Boundary |
|---|---|---|
| foo_openlyrics (OpenLyrics) | Sources tried in order (tags, `.lrc` file, online); downloaded lyrics never overwrite existing ones; edits always save; skip tracks that already have lyrics; cache searches (D5, D20) | MIT; any source reuse needs attribution and review |
| LRCLIB | The online lyrics source: exact lookup by title, artist, album and length, then search (D29) | Service terms; never publish corrections back without a separate decision |

### Ripping

| Project | What we take from it | Boundary |
|---|---|---|
| Exact Audio Copy (EAC) | Drive offset calibration and cache testing as a guided step | Proprietary: documented behaviour only |
| CUETools / CUERipper and CTDB | Effort levels with bounded retries, Test & Copy, labelling results by the mode that made them, showing AccurateRip and CTDB separately (D6) | GPL-2.0-or-later, C#: design reference |
| fre:ac | Ripping and conversion as cancellable background jobs with narrow component boundaries | Studied only; its CDRip-based CD route was rejected |

## What comes next

The ordered plan is `docs/roadmap.md`. In short:

1. **Learn from the beta** on real libraries, drives, TVs and phones; fix what testers find (`docs/workflow.md` says how issues are tracked and shipped).
2. **Reach the stores**: signed Windows installers (SignPath), the Microsoft Store, Google Play (after its closed test) and Samsung's TV app store (`docs/beta-testing.md`).
3. **More devices**: a Google TV app from the Android app, a Linux AppImage (`docs/linux-plan.md`), and levelling on the phone and TV apps.
4. **Lyric AI downloads**: a model list with checksums so the optional models can be fetched from inside the program (`docs/lyric-models.md`, `docs/distribution-plan.md`).
5. **Ripping and metadata**: remembering lookups so a repeated one never calls out, a rip audit, and more disc sources (`docs/next-steps.md`).
6. **Casting proofs** on more real Google Cast and Samsung/Tizen devices, and the MediaVerse Cast receiver for the TV app's look on Chromecasts.

### Ideas kept for later (owner's choice when to pursue)

- **TV visualizer analysed on the PC** (proposed 2026-11-04, on hold by the owner): the TV's player cannot be listened
  to, so for every song the TV downloads it a second time, decodes all of it (about 50 MB of samples for five
  minutes) and analyses it on its slow processor; that is the visualizer's start-up delay and a likely cause of a
  brief hitch a few seconds into a song. Instead the desktop's sidecar would work out each song's bar heights once
  (with the analysis code it already has), keep them, and serve a small file per song (about 100 to 200 KB) through
  the library share; the TV would only read it, ready the moment a song starts. USB and Jellyfin sources keep the
  TV's own analysis. With it: draw the bars at half resolution and let the TV scale them, measured before and after.
- **Samsung's own player (AVPlay) for the TV's music**: optional now. Since D70 a hidden AVPlay clip holds off the
  OLED screen saver (`docs/tv-screen-saver.md`); moving the music itself to AVPlay would replace that clip (one AVPlay per app).

## Implementation rules

- Keep the UI/shell, then application, then domain dependency direction. The CD ripper is a deliberately standalone module (ADR 0007). Platform and provider details stay behind narrow adapters.
- Run scans, artwork work, network lookups, tag writes, extraction and encoding off the UI thread, with progress, cancellation and structured errors.
- Do not move, overwrite, retag or upload user files without an explicit, confirmed user action.
- Pin exact versions and keep licence and provenance evidence before adding a dependency, copied source, binary, codec or online provider.

## Research sources

- Navidrome tagging: https://www.navidrome.org/docs/usage/library/tagging/
- Navidrome scanning: https://www.navidrome.org/docs/usage/admin/cli/scan/
- OpenLyrics: https://github.com/jacquesh/foo_openlyrics
- LRCLIB API: https://lrclib.net/docs
- foobar2000: https://www.foobar2000.org/
- CUETools: https://github.com/gchudov/cuetools.net
- fre:ac: https://github.com/enzo1982/freac
- Rune: https://github.com/losses/rune
- AccurateRip: http://www.accuraterip.com/

Re-check these sources, licences and service terms before building on them; they change.
