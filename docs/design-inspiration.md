# Design inspiration

Layout and behaviour ideas only. We do not copy any project's artwork, fonts, icons, logos, skins or
names, and we check any font licence before use (an open font such as Inter). The full list of
reference projects, with what each one teaches, is in
`Guiding Documents/Feature Roadmap and Reference Review.md`.

## Where the design stands (2026-11-02)

Built from these notes: the Zune-style **Now Playing** view with a tinted wall of the library's own
covers in varied tile sizes (D23, D26), the **Home** page modelled on Quickplay with Recently played,
Most played, New in your library and Pins (D26, D27), and one always-visible top bar (D30). Design
direction D23 is still a proposal for the owner to confirm once more Zune screenshots are compared.

## Microsoft Zune (desktop 4.0, Zune HD, Windows Phone Music+Video hub)

Sources: written reviews (2009) and one Zune 4.0 Now Playing screenshot supplied by the owner.

- The design is the root of Metro: clean typography, little chrome, information shown mainly as text.
- **Quickplay** home: New, History, Pins and Smart DJ; one click to resume. Pins also appear in the
  taskbar jump list.
- **Collection**: songs, albums, artists and genres together; album view with tiled art whose colour
  scheme shifts over time and whose tiles flip.
- **Now Playing** (from the screenshot): the whole window is a collage of the user's own covers in
  several tile sizes, tinted in one warm colour and dimmed so the foreground stays readable. Bottom left:
  the current cover with a white border, the artist in capitals, the album in a light weight, the title
  larger, and a heart button. Right: the queue as a plain text list, the current track in the accent
  colour with a small equalizer icon, "Save as playlist" below. Bottom: a thin progress line with times
  and the transport buttons. No borders or panels.
- Reviewers liked smooth animation, Smart DJ playlists and the Play Count column; they disliked that the
  mini mode could mute but not set a volume level.

### Screenshot review (2026-11-02, 19 screenshots in the owner's `Zune desktop screenshots` folder, kept outside the repo)

**Quickplay / Now Playing (three screenshots).** The full window is the cover wall: hundreds of covers in a
dense grid of mixed sizes (a few 3x3 and 2x2 tiles among many small ones), the whole wall washed in one tint
(magenta-to-amber in one shot, olive green in another) and dimmed far enough that white text reads on it.
Bottom left: current cover with a thin white border, ARTIST (bold capitals), ALBUM (light capitals), title,
heart. Right: the queue as a narrow dark panel, current track in the accent colour with a small bars icon,
"SAVE AS PLAYLIST". Bottom centre: a thin progress line with elapsed and remaining time and, under it, a
**soft red-orange glow** along the bottom edge: the audio visualization, which disappears when the music is
paused (screenshot 003). Bottom right: tiny transport icons and "VOLUME 50". Only a back arrow at top left;
no other chrome.

**Motion that a screenshot cannot show (owner):** covers occasionally **flip** to show a different cover; the
background tint **shifts slowly between colours, like the northern lights**; the bottom glow moves with the
music. It is pleasant to leave running on a PC, tablet, phone or TV.

**Collection, music (two screenshots, light theme).** Lower-case pivot headings across the top (quickplay,
collection, marketplace, social, disc; the current one darker), small capitals sub-pivots (MUSIC, VIDEOS,
PICTURES, PODCASTS, CHANNELS) and a view switch on the right (ARTISTS, GENRES, ALBUMS, SONGS, PLAYLISTS).
Three columns side by side: **artists A-Z, albums (covers with title and artist, by date added), songs A-Z**,
each headed with a count ("383 ARTISTS", "1535 ALBUMS", "13171 SONGS"). Albums with no art show a grey
placeholder. A search box at top right. In the narrow window the columns shrink rather than disappear.

**Welcome / first run (four screenshots, dark).** A black screen with a short gradient bar above a capitals
heading ("WELCOME TO ZUNE"), then two choices: *start playing* (defaults, listed in bullets) or *change the
default settings*. The settings path is a short wizard with BACK / NEXT / CANCEL: **Media locations** (Music,
Videos, Pictures, Podcasts, each with Manage), Media info ("Automatically retrieve and update album art and
metadata" with **Only add missing information** or **Replace all media information**), then **Associate file
types**.

**Settings (ten screenshots, light theme).** A left list of sections (COLLECTION, FILE TYPES, FEEDBACK
PROGRAM, PODCASTS, XBOX 360, PICTURES, DISPLAY, RIP, BURN, METADATA AND RATINGS, GENERAL) with the chosen one
marked, the section's options on the right, OK / CANCEL at the bottom. Notable options: Rip (rip when
inserted, eject after ripping, format, quality slider showing MB per CD); Burn (audio CD or data disc, eject,
speed); Display (named backgrounds, *show Now Playing when idle*, a Basic-to-Premium graphics slider);
Metadata (the same missing-only / replace-all choice); General (startup page, reset warnings, mini player
always on top); Podcasts (episodes to keep, newest or oldest first); Pictures (slideshow speed).

**What we take for MediaVerse Studio:**
1. **Dark mode only** (owner, D32), with the tinted cover collage behind every main page, not only Home and
   Now Playing.
2. A first-run welcome in the same dark style, replacing the Getting Started box: defaults or a short
   wizard (library folder, FLAC archive, contact email, "only add missing information" vs "replace").
3. Settings as a left list of sections: Library, Rip, Cast (placeholder), Lookups and metadata, Lyrics,
   Display and motion, General. **Cast replaces Xbox 360** (owner, D32).
4. Library: the three-column artists / albums / songs view with counts, and a grey placeholder for albums
   without art.
5. Display options worth copying: Now Playing when idle, a graphics level (still, gentle, full motion).
6. **Future** (owner, D32): a Burn page (mix CD, or a playlist to give a friend) and podcast management.

## Rune (github.com/losses/rune)

MPL-2.0 code, Rust core with a Flutter interface, on Windows, macOS, Linux, Android and iOS. A fan's
"what if Zune had kept evolving". Worth noting: responsive layouts, keyboard support, colour themes,
rule-based dynamic Mix playlists (similar to this album, most played, chosen artists) and library-wide
audio analysis for recommendations. Its official builds are paid; we do not copy its code or art.

## Winamp (added 2026-11-02)

The owner asked to include Winamp for its audio visualizations, which are fun to watch while music plays.

- Winamp (Nullsoft, from 1997) made music-reactive visuals a feature people loved: the small built-in
  spectrum and oscilloscope, and the full-screen plugins **AVS** (Advanced Visualization Studio) and
  **MilkDrop**, which drew presets that morph with the beat.
- Also remembered: the compact, always-on-top main window and mini mode, and skins.
- **Idea for MediaVerse Studio:** a visualizer that can replace or overlay the cover wall in Now Playing,
  driven by the Web Audio API's `AnalyserNode` on the local audio element. Start simple (spectrum bars or
  a waveform tinted with the cover's accent colour), then consider a MilkDrop-style preset renderer.
- **Rules:** it is optional and off-switchable, respects reduced motion, never covers the lyrics, and
  never flashes fast enough to be a risk for people with photosensitive epilepsy (no more than three
  flashes a second). When casting, it runs only on the computer.
- **Licences:** Winamp itself is closed (its 2024 source release used a restrictive licence that is not
  open source), so nothing is taken from it. Open MilkDrop-compatible engines exist; check the exact
  project and licence under the third-party rules before using one.

## Ambient motion and OLED burn-in (D32)

The wall, flips, tint drift and glow make the program pleasant to leave on, but a picture left still on an
OLED screen (many TVs, phones and tablets) can burn in. Rules:
- Nothing bright stays in the same place for long. The foreground block (cover, titles, queue) drifts by a
  few pixels every few minutes; the progress line and controls dim after a short idle time.
- The wall keeps changing: occasional tile flips, a slow tint cycle (minutes per colour), and a gradual
  reshuffle so no cover sits in one spot all evening.
- Stay dark: the tint is dim, no large white areas, the glow is soft and follows the music, and it fades
  out when the music pauses (as in the Zune screenshot).
- After a long idle time (setting, default about 30 minutes with nothing playing), fade to black.
- A graphics level in Settings (still, gentle, full motion) and the system's reduced-motion setting are
  respected; "still" keeps the tint and drift protection but no flips or glow.

## Ideas list (not built unless noted)

1. Quickplay-style home: New, History, Pins (built, D26, D27); Smart DJ-style mixes later.
2. Large type and album art as the main visual, few borders (in progress).
3. Artist photo and cover art as the Now Playing backdrop (artist photos can be added, D17).
4. One accent colour taken from the current cover, used for tint and highlights.
5. A mini player window with real volume control.
6. A rip view that feels like part of the library (Rip a CD sits in the top bar, D30).
7. Wall tiles that slowly flip and a colour scheme that shifts over time.
8. Winamp-inspired visualizer in Now Playing.
9. Play Count shown in the library (history already counts plays, D26).
10. Keep everything keyboard-reachable and readable; decoration never carries information alone.
