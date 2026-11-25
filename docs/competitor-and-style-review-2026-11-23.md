# Competitor and style review (2026-11-23)

Owner's request: compare MediaVerse Studio with MediaMonkey and MusicBee (features, and how their sites look), and bring more of the Zune era into the website. Sources read on 2026-11-23: mediamonkey.com (home and the Windows page), getmusicbee.com (home), and Internet Archive captures of zune.net (October 2009 Zune HD page, October 2010 home page; the 2006-2007 captures were saved without their style sheets and do not show the look). The feature scan of our own code was by keyword (web/app, crates, apps/android), so treat "missing" as "not found, check before building".

## 1. Features they advertise that MediaVerse does not have yet

Ranked by how much a serious collector would notice.

| # | Feature | MediaMonkey | MusicBee | MediaVerse today | Note |
|---|---|---|---|---|---|
| 1 | Gapless playback, crossfade | yes | gapless | planned (docs/roadmap.md, Winamp study) | The one most people test first. |
| 2 | Volume levelling (ReplayGain, MP3Gain, analyse and apply) | yes (Gold: automatic) | logarithmic volume, normalise | not found | Pairs with 1. |
| 3 | Organise files by rules (rename and move by artist/album/title/year), find duplicates, find moved files | yes (Gold: automatic, in the background) | yes | not found for the library (only the rip's own naming) | Their core promise. Our rule applies: preview and confirm, recoverable. |
| 4 | Rule-based playlists (auto playlists) and Auto-DJ | yes | yes | not found on the PC (Zune had Smart DJ) | Also "more like this". |
| 5 | Ratings (stars) and custom or multi-value fields, collections | yes (collections are Gold) | ratings, tags | hearts, flags and play counts; no stars or custom fields | Collectors use stars. |
| 6 | Scrobbling (Last.fm; ListenBrainz is the open one) | yes | yes | not found | Table stakes. |
| 7 | Convert formats (and convert when syncing to a device) | yes | yes, on the fly for devices | LAME at rip time only | Needed for phone/TV sync of FLAC. |
| 8 | Podcasts and internet radio | yes | yes | not found | Lower priority; Jellyfin may cover some. |
| 9 | Audiophile output: WASAPI, ASIO, 10/15-band EQ, DSP, upmixing | WASAPI, 10-band EQ, DSP add-ons | WASAPI and ASIO, 10/15-band EQ, DSP | PC plays through the browser engine (no exclusive output); EQ exists on the phone | See the strategic option below. |
| 10 | Skins and add-ons (plugins, a developer API, Winamp plugins) | skins, add-ons, some Winamp plugins | skins, plugins, visualizers, theatre mode, developer API | 20 accent colours; no skins or plugins | Shareable theme files are the cheap first step. |
| 11 | Mini player, media keys, taskbar controls | yes | mini player | not found | Quick wins on Windows 11. |
| 12 | Jukebox/party mode, sleep timer | yes | yes | sleep timer exists on the phone | Small. |
| 13 | Video, audiobooks, classical-music fields | yes | audiobook sync | out of scope for now | Say so on the site rather than leave it unmentioned. |

**Strategic option (a decision for the owner, not a recommendation to start):** gapless, crossfade, ReplayGain, EQ/DSP and WASAPI are all the same missing piece: the PC plays through the browser engine, which cannot do them well. A playback engine in the Rust sidecar (decoder and WASAPI output, controlled by the existing UI) would deliver items 1, 2 and 9 together. It needs a dependency and licence review first (`Guiding Documents/Third-Party Software and Licensing.md`).

## 2. Where MediaVerse is ahead (what the site can say that they cannot)

- Secure CD ripping with AccurateRip, the audio defect scan (including silence) and a re-rip list. MediaMonkey rips (Gold adds AccurateRip); MusicBee rips; neither has a defect scan.
- Time-stamped lyrics with an AI timing tool and an editor. Neither site mentions lyric timing.
- Real apps on Samsung TVs (Google TV next) and casting, where MediaMonkey shares through DLNA and MusicBee has no TV app.
- The Jellyfin home server as the shared hub: flags, playlists, and the Android app keeping chosen music on the phone and recognising music already there.
- Free and open source (GPL), no paid "Gold" tier (MediaMonkey: free, $39.95, or $99.95 for lifetime Gold); MusicBee is free but closed source and Windows only.
- A distinct, Zune-descended look instead of a classic grey desktop player.

## 3. How their sites look, and what to take

**MusicBee (getmusicbee.com).** A full-width photograph hero (a silhouette against an orange-and-blue sunset) with a screenshot in a device frame on the right and two outlined buttons (amber "Download", blue "Check out features"). Then **bands that alternate in colour and texture as you scroll**: light grey (#eee) with a big screenshot; a dark photographic band (a turntable) with six translucent icon cards; mid grey with a monitor-and-phone picture; a solid **Windows blue** band for the Groove partnership; each band one idea, one picture, short text. Font Roboto; a dark bar on top that stays put. This variation is exactly what our page lacks: ours is one dark colour from top to bottom.

**MediaMonkey (mediamonkey.com).** The opposite: white, airy, light-weight type, orange accent only. A device montage (laptop, monitor, phone) with the app's own orange. A **row of verbs**: Manage, Organize, Share, Play, Convert, Customize, Enjoy, each a small icon, a heading and two lines; tabs for Overview, Windows and Android; a press quote; and a clear price block (Free, Gold, Lifetime) at the end. Take the verb structure and the price block.

**Zune (zune.net, 2009-2010).** A black strip across the top only (logo, then lowercase "products music video podcasts my social"), then a **black hero** with the devices lit from below and a huge, light, **lowercase headline** ("welcome to zune", with a gradient on the word), then a **white page** for everything else. Section titles are small lowercase headings with a thin rule under them ("what's new", "tip of the week", "zune pass"); a two-by-two grid of picture tiles with black caption bars (bold capitals line, light line below); a single hot-pink accent for links and the one button ("Free software download"); the Zune HD page puts four short lowercase feature headings in a row ("touchscreen", "HD radio", "HD video out", "wi-fi"). Type is Segoe-family, thin and large. The 2009 software added Quickplay (New, History, Pins). Colour was used in blocks and the accent shifted with the content.

## 4. Proposal for mediaverse.studio (nothing built yet)

1. **Bands, as on MusicBee.** Alternate five backgrounds down the page: (a) dark hero with the cover-wall collage behind the headline; (b) warm off-white "paper" for the features, with copper headings; (c) a copper-to-plum gradient band for "Carry it with you" (phone, TVs, cast); (d) a teal band for the Jellyfin home server (our second brand colour); (e) a photo-style dark band with translucent cards for the beta call; then light for the roadmap. Each band gets one accent colour, as Zune's content did.
2. **Zune typography.** Large, light, lowercase headlines, small lowercase section titles with a thin rule, light body text; Segoe UI where installed (it is already in our font stack), no new font files.
3. **Zune layout pieces.** Two-by-two picture tiles with black caption bars for the headline features; a "what's new in this build" block and a "tip of the week" (one feature a week, from our own list); four short lowercase feature headings under the hero.
4. **MediaMonkey pieces.** A verb row (Rip, Fix, Play, Carry, Cast, Lyrics) and a price block that says Free, free, free (donations only); a "switching from MediaMonkey or MusicBee?" section with the honest comparison from sections 1 and 2.
5. **MusicBee pieces.** A photographic hero image (a warm-lit headphones-and-record-shelf shot or our own cover wall) and a screenshot inside a device frame with the PC, phone and TV together.
6. Keep: the sticky bar (just added), the accessibility basics, no tracking, no scripts needed.
Effort: one to two sessions for the stylesheet and page restructure, plus new screenshots in device frames.
