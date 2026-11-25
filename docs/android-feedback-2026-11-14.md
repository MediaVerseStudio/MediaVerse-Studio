# Android feedback from the rental-house trip (2026-11-14) and the Musicolet baseline

## 1. What the owner saw, what we found, what changed

| # | Observation | Finding | Status |
|---|---|---|---|
| 1 | Google TV at the rental: no sound (TV's own apps fine; may route to a soundbar) | Cause unknown. The code tries our unpublished receiver `0E81A85C`, which only registered devices can open, then falls back to Google's Default Media Receiver. A muted receiver, a soundbar on HDMI-ARC/eARC, or a codec the TV refused would all look like this. The phone never told the device its volume or un-muted it. | **Diagnose on a real device.** The volume slider (below) also un-mutes. Next time: `adb logcat -s MediaVerseCast` shows the receiver used, the player state and the volume. |
| 2 | Bose speaker: phone volume keys did nothing | Expected with the current design: we speak the Cast protocol ourselves, so Android does not know the phone is a remote volume control. | **Slider added** on Now Playing while casting (SET_VOLUME, also un-mutes, shows the device's reported level). **Still to do:** make the phone's hardware volume keys drive the device (Media3 session with remote device volume), and DLNA volume (RenderingControl). |
| 3 | One device: tapping Cast started playing at once, no choice | `np-tv` sent straight to the only device. | **Fixed:** the list always shows, with a Cancel line, even for one device. |
| 4 | Android Auto split view: tapping the app opens it on the phone, not full screen | The session has a `sessionActivity` (so the notification opens the app). Android Auto treats that as "this app has its own phone screen" and says "opened on phone". | **Not changed yet** (needs testing in the car or Desktop Head Unit, since the notification tap depends on the same setting). Plan: test a session without it for the car controller. |
| 5 | App missing from Android Auto's launcher customisation list | Most likely the sideloaded-app rule (Unknown sources in Android Auto developer settings; the apps list is cached and needs Android Auto restarted). The manifest declares the media app correctly, which is why it shows in the split view. | **Test:** toggle Unknown sources, force-stop Android Auto, reconnect. Google Play internal testing removes the problem. |
| 6 | "Dots" at top right of the small player | Android Auto's overflow for the custom buttons (our shuffle and repeat). They sit in the secondary slots, so the car folds them into a menu. | Part of the redesign below: put shuffle/repeat in the Now Playing screen's own secondary row, keep the main row to previous / play / next. |
| 7 | Small player: prioritise previous / play-pause / next, show song, artist, album, and a smaller "next up" | The car draws the card; apps do not lay it out. What we control: the metadata fields we publish, the three main buttons, and the secondary buttons. | Publish `title`, `artist`, `albumTitle` always; put next-up in the `subtitle`/`description` extras; keep only 3 main buttons. See 3. |

## 2. Competitor feature scan (what each does that we can learn from)

**Musicolet** (offline, no internet permission, ad-free; promo shots in `Developer\MediaVerse\Reference\Musicolet promo shots`)
- Multiple named queues (one per folder, album, artist, playlist), each resumable from its last position; queue drawer with drag handles, search in queue, save queue as playlist.
- Equalizer **per output device** (built-in speaker, wired, headset, car Bluetooth, earbuds, USB); 3 to 31 bands; bass and treble.
- Synchronised lyrics: embedded or `.lrc` file, **create and edit LRC on the phone**, A-B repeat on synced lines.
- Advanced multi-select that combines songs from different lists; many actions on the selection (play next, add to queue, playlist, favourites, tags, move, copy, share, delete).
- Multi-song tag editor (blank = leave unchanged), album art change, written into the files.
- Small extras: audio cutter, pause when muted, bookmarks/notes per song, A-B repeat, sleep timers, backup and restore, gapless, folder.jpg, Most Played / Not Played, advanced shuffle, audio-focus levels, lock screen controls.
- Player layout: art, title/artist/album, a row of favourite / info / add-to-queue / more / sort-order / repeat, a seek bar, then volume / previous / play / next / equalizer; bottom tab bar (Queue, Now Playing, Folders, Albums, Artists, Genres, Playlists, overflow).

**Poweramp**
- Layouts (default, alternative, full-cover), blended skin (art fades into a background taken from the art), Material You colours, home widgets (4 sizes), Milkdrop visualisations.
- Android Auto: up to four browse tabs (Library, Playlists, Albums, Folders), search and voice, grids or lists with art, **configurable action buttons** (repeat, shuffle, like, rating).
- **Chromecast: audio decoded on the phone, EQ still applies, volume synced with the device**, art and info on screens.
- Parametric EQ, per-output and per-device presets, AutoEq headphone presets, limiter indicator, ReplayGain, crossfade, gapless; automatic playlists (Most Played, Recently Added, Top Rated); 20 browse categories; CUE sheets; m3u import/export.

**MediaMonkey for Android** (companion to the PC app, like ours)
- **Sync with the PC library:** tracks, playlists, metadata, ratings, lyrics and play history, plus Wi-Fi sync (Pro). Ratings and edits on the phone flow back.
- 5-band EQ, ReplayGain, bookmarks, a sleep timer that fades out, widgets, scrobbling.
- Pro: Cast and UPnP/DLNA **sending**, UPnP library browsing, missing art and lyrics lookup.

**Pulsar**
- Light (2.6 MB), 15+ themes, 5-band EQ with bass boost and reverb, sleep timer, smart playlists, Chromecast, automatic cover and artist image download, tag editing, Last.fm scrobbling.

## 3. Where MediaVerse already beats them, and what to take

**Already ahead:** the same app on PC, TV and phone; the phone as a TV remote; Cast, DLNA and "play on the TV" from the phone; the playing screen with covers, lyrics, visualizer and the colour mask; Android Auto browse tree; FLAC-first library tooling on the PC (rip, AccurateRip, tag fixing).

**Take next, in this order (owner to reorder):**
1. **Casting you can trust:** hardware volume keys, volume on DLNA, a "Test sound" and a visible reason when a device refuses or is muted (the rental-house failure), and a Cast diagnostics line in Settings.
2. **Android Auto polish:** full-screen Now Playing from the car, three-button main row, title/artist/album and next-up, shuffle/repeat as secondary actions, Favourite as a car button, Playlists tab. Test on the Desktop Head Unit and in the car.
3. **Phone Now Playing like Musicolet's** (a row of icons under the title: favourite, queue, more, shuffle, repeat; volume/EQ row) with our look. Mini bar keeps previous / play / next first.
4. **Multiple resumable queues** (Musicolet's best idea), saved queue as a playlist.
5. **Per-output equalizer** (Musicolet and Poweramp both do it; Media3 has an `Equalizer` effect, no new dependency).
6. **Sleep timer with fade, bookmarks, A-B repeat, Most Played / Not Played.**
7. **Synced-lyrics editing on the phone** (we already read LRCLIB and `.lrc` on the PC).
8. **PC library sync** (MediaMonkey): ratings, play counts and playlists flowing both ways over our share API.

## 4. Questions for the owner
1. Which of the order above do you want built first? (My suggestion: 1 and 2, because they are the failures you hit.)
2. For the car, do you want shuffle/repeat kept at all? They are what Android Auto folds into the "dots" menu.
3. Next time you are in front of the Google TV or the Bose again: run with the phone on USB (or wireless debugging) and I can read the log.
