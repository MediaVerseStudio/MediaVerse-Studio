# Where we stopped (2026-11-20, afternoon)

**`lyric-sync` is merged into `main` (pull request #4, D154); history rewritten to the no-reply address and force-pushed; all of today's work is on `main`.** Hashes in older entries are pre-rewrite; the old history is in `Developer\MediaVerse\repo-backup-before-history-rewrite-2026-11-20.git`.
- **Done today (D150 to D154):** doubtful-line flags recalibrated (D150); owner's answers recorded and the **music-lyrics reader is now the default** (D151); the **library-wide wrong-lyrics check** (D152: Review > Lyrics, new card under Step 2, with a tick box for songs marked instrumental; found and fixed a slice panic in the readers on the way); the **phone's "Pair a TV or speaker" step** (D153, APK built, not installed on the phone, not tried with a TV); merge, rewrite and scrub (D154); `docs/version-bump-checklist.md` (0.1.0 to 0.9.0, including Google and Samsung/Tizen) and `docs/google-play-beta-testing-guide.md`; Whisper and Sylla download design in `docs/lyric-models.md`.
- **To try on the PC (installed build):** Review > Lyrics > "Check the lyrics already in your songs" (start with the box for instrumental songs both ways); Step 3 pages and Step 2 tick boxes (still not seen on a screen); Settings > Lyrics > Lyric AI should show the music reader chosen.
- **Open for the owner:** author names in the history (full name; only emails were rewritten); whether to ask GitHub Support to purge `refs/pull/*` or publish a fresh history before going public; removing `lyric-sync` from the remote; whether to put the new phone build on the phone.
- **Not built yet:** the in-app model list and download for Whisper and Sylla (the plan is written); a way to remove lyrics from the wrong-lyrics list in one click (today the person fixes the song in Fix tags).

# Where we stopped (2026-11-20, morning)

- **Pull request #4 (`lyric-sync` into `main`) is open; CI passed (5m48s). Not merged: the roadmap says the merge needs the owner's say-so.**
- **D150:** the doubtful-line flags were measured against people-made time stamps (new ignored test `a_flag_calibration_run`; data `MediaVerse-Lyric-Sync-Lab\judge-lab\flag-calib.jsonl`) and replaced; the old flags were wrong 82% of the time and ran the wrong way per song. The 10% rule is kept. **Owner to decide:** loosen to 15% (100% group would pass 32 of 40, not 27)? Details in the decision log.
- CI flake to watch: host test `a_restart_reads_only_the_files_that_changed_while_the_program_was_closed` failed once on CI ("database is locked"), passed on rerun. CI is green on d78ca96.
- The PC build installed on return is the one with D150; the overnight/morning results on real songs have not been seen on screen.

**The plan (roadmap, testing plan, going public) is `docs/roadmap.md`; the list of outstanding tests and roadmap issues is in `docs/outstanding.md`: read both first when returning.**

# Where we stopped (2026-11-19, evening, after the late-night entry below)

**Everything to D149 is pushed (`lyric-sync`, `ebcac18`) and installed (build of 22:49 on 2026-11-19).** D147 (near-same lyrics settled, Step 3 pages, Step 2 tick boxes) is pushed too and installed (the installer refuses to run while the app is open, so the app must be closed first). The installed program is now the build of 22:49 (D149, `ebcac18`). It has not been opened since: the Step 3 pages and the Step 2 tick boxes are not yet seen on screen.
- **First-line check (private, outside the repo):** playlist "Lyrics check: first line at the start" (139 songs, in MediaVerse Studio's playlists; backup `playlists.json.before-first-line-check`) and `Developer\first-line-check.html`, a page with one-click verdicts that saves `first-line-answers.json`. The answers are the input for the first-line repair.
- **D144:** the Lyric AI panel shows why songs fail and a run stops by itself after 10 identical failures. The first whole-list pass failed all 407 songs ("could not be read"); the cause is still unproven (it worked after an app restart plus Check library). If it happens again the reason is on screen: write it into D144.
- **D145/D147:** approving a suggestion that is already in the song is settled without a write. D145 required exactly the same words; the 27 songs the owner still saw refused hold another LRCLIB record of the same lyrics (a word or two different), so D147 accepts 90% or more shared words and says the share when it refuses.
- **D146/D148/D149:** a first line lit from the start was found harmless (47 songs checked by ear, none badly timed), so the guard of D146 is undone (the shape is only recorded). Three written songs had lyrics that do not belong (Semicolon, Coming Or Going, Teargas); the judge now needs a fit of -2.8 or better before agreeing time stamps make words certain. Pushed (`ebcac18`) and installed (the build of 22:49 on 2026-11-19).
- **Judge diagnostic after D149 (2026-11-19, 22:50, read-only, nothing written):** 40 songs per band, timed afresh. 100%: 38 sure, 2 review (as before). 80 to 89%: 3 sure, 37 review, median 19% of lines doubtful (0 to 3% at 100%). The 80 to 89% songs are not the same ones as in the first diagnostic (the 407 approved songs have left the list), so the two runs are not like for like; the point is that taking the first-line block away does not free them: they stay in review because of the share of doubtful lines. Next: recalibrate the doubtful-line flags for the music reader (roadmap, Step 2, item 2) against the 100% songs and the owner's ear-checked songs, then re-decide the 10% rule. Needs no listening to start.
- **Not done:** the judge still puts songs whose suggestion is already in the song under To review (the approval now clears them); live-version phrases and the vocal-activity hint (roadmap Step 2, items 7 and 8); the whole-list pass has not been run again with D146.

# Where we stopped (2026-11-19, night)

**All pushed (`lyric-sync`, last commit with this entry's docs); PC build `b4ac54f` installed; the owner started the whole-list Lyric AI pass (also redoing songs checked before) and will look at it in the morning, then restart the PC.**
- **Done 2026-11-18/19 (D134 to D142):** the Lyric AI judges the To review list (best-fitting suggestion, checked timing, agreeing time stamps count as proof); the Lyrics page reorganised (step cards with info windows, General review, Suspected instrumental, live-updating list, cover albums recognised, batch approve with shift-click ticks); "Confirm instrumental" (language tag `zxx`); the music-lyrics reader in the engine (Rust audio front end, ONNX, calibrated, opt-in, instrumentals caught by the letters alone); the fixes from the first full pass (48 kHz MP3s now read, failed songs retried, records of one song merged, no-singing songs sent to Suspected instrumental); **Whisper drafts** for songs nobody has lyrics for (checked against the singing; words correctable with a pencil); the phone share-server fix.
- **Plans written:** `docs/roadmap.md`, `docs/lyric-models.md`, `docs/distribution-plan.md`, `docs/linux-plan.md`, and the Microsoft Store/SignPath findings (in the distribution plan).
- **Going-public check run (`tools/check-before-public.ps1`):** the only real findings are personal email addresses in old commit metadata (27 commits) and a few `C:\Users\the owner` paths and first-name mentions in the docs (`docs/roadmap.md`, section 3). CI had not run on `lyric-sync`; a pull request trigger was added to the workflow.
- **48 kHz songs:** 65 tracks on 9 albums listed in `Developer\48khz mp3 files.txt`; the Lyric AI reads them now; converting is optional.
- **First things next session:** look at the pass (Section A of `docs/outstanding.md`), approve a first batch, decide the default reader, then open the pull request `lyric-sync` into `main` so CI runs, then merge.

# Where we stopped (2026-11-16)

**Late evening 2026-11-16 (D117-D119, all pushed; PC build with everything installed):**
- **Lyrics search (D117):** a track number in front of a title is searched again without it; 192 such titles were fixed in the library (Review > Missing lyrics > Track numbers in titles, undo in Fix tags); songs LRCLIB lists as the same instrumental recording leave Missing lyrics (Instrumental list; nothing written to the files).
- **Automatic lyrics was run over the whole library** (finished 23:18: 1,690 songs looked up, lyrics saved into 191, likely lyrics kept for 86 to review, 239 found instrumental; the rest are not on LRCLIB). Songs already asked are remembered for 30 days; Review > Missing lyrics > To review holds the likely ones for the owner.
- **Home page (D119):** New in your library first, Most played removed (PC and phone; the phone change needs the next phone build), the doubled shelves bug fixed, and the "I'm feeling lucky" jukebox (starts full of albums, clickable, casino wiggle, accent box locked to the centre).
- **Rust formatting (D118):** whole repo in standard rustfmt, CI checks it.
- **Code review done (read-only, nothing changed):** `cargo fmt --check` clean; clippy has about 60 style warnings, no errors (new-Rust-version lints such as `chunks_exact`/`is_multiple_of`, 4 "too many arguments", 4 "complex type"); CI does not run clippy. No leftover debug output or TODOs, no trailing whitespace, production `unwrap`/`expect` only on invariants.
- **Finding for the owner to decide (not changed):** the lyrics lookup learns a song's length only by strictly parsing the file as an MP3 this program made (`mp3::inspect` in `drives.rs` `lookup_lyrics`, which also reads the whole file for every lookup). For any other MP3 the length is "unknown", which caps confidence at 72, so such songs are never "sure" and go to To review. The library already knows each song's `length_ms`. Passing it to `lookup_lyrics` would raise confidence for songs of the same length and save lyrics automatically for many more of them, and avoid reading every file; it changes what gets written without review, so it needs the owner's say-so. Songs already asked would have to be asked again (the re-ask revision in `review-panels.ts`).
- Small: the Electron page logs "11 job-finished listeners" at startup (harmless, many jobs at once); the cover cache (`cover-art.ts`) remembers "no cover" for the session, so check that a cover added by the Artwork tab shows without a restart.

**End of day 2026-11-16 (D113-D116, all pushed, CI green on 2a13c54):** AcoustID after the rip (D113, installed), then the second batch
(D114-D116): copy tags from another album and tags from file-name patterns in Fix tags (D114); AcoustID names untitled tracks on a rip and
writes the MusicBrainz recording ID (UFID) and AcoustID (TXXX "Acoustid Id") in the standard places (D115); Review > **Audio check** of
the whole library and **Identify by listening** in Fix tags, titles written with Undo (D116).
- **The second batch is installed** (since the late evening of 2026-11-16; to install a build: close the app, run
  `tools\make-installer.ps1 -SkipSource`, then `dist-installer\MediaVerse-Studio-Setup.exe /Q`, relaunch). The Audio check tab loads (seen
  empty); it has not been run over albums (needs AcoustID), and no real disc has been ripped with naming/ID writing yet.
- **Lyrics handoff for a new Claude project** (private, outside the repo): `C:\Users\<you>\Developer\MediaVerse\MediaVerse-Lyrics-Sync\` (`HANDOFF.md`
  first, then the two lists and the JSON). 3,647 MP3s missing lyrics (1,958 with stored candidates), 2,853 with untimed lyrics. Four open
  questions for the owner are at the end of `HANDOFF.md`. Never commit or upload that folder (library paths).
  **Result: the owner reported that giving it to another session to confirm/synchronise/find lyrics was completely unsuccessful** (cause
  not yet known; the suggested approach in the handoff was never tested). Find out what failed before planning the next try.
- Roadmap: write AcoustID/MusicBrainz IDs into existing library files (Audio check could offer it for albums that agree); a pattern option
  that reads the folder name too; run Compare against real MusicBrainz once it is not busy.

**2026-11-16 (D98-D106, all pushed, last commit 1313336; PC build with everything installed, CI green up to D104):** the ripping and
tagging overhaul before the ~two dozen CDs. Read the decision log entries D100-D106 for the reasons; short version:
- **Disc health is honest (D104):** a clean read that does not match AccurateRip is read once more and, if identical, called
  "unconfirmed"; a shifted match (`pressing_shift`) proves another pressing; "damaged" only for unreadable blocks, disagreeing reads or a
  doubted cache. Drive setup shows a **Drive history** (clearable). The Skints disc (another pressing, -6 shift) and a later disc that
  matched straight away at +6 confirm the drive's offset.
- **Defect scan fixed (D104):** stuck-sound false alarms (18,244) and clipping noise removed; the library rescans itself once; findings
  close together are merged in the lists.
- **Finding the album (D105-D106):** disc ID, then similar-TOC search, then **Search by name** (MusicBrainz, Discogs with the owner's token,
  iTunes, Deezer), or typed album/artist/year/genre/track titles. The Rip page refreshes by itself when the disc changes (5 s probe).
  **Rip safety:** non-exact matches need the "These details match my disc" tick; the sidecar refuses a tagged rip without album+artist.
- **Real finds:** Random Hand (2023) is on MusicBrainz but without this disc's ID (name search finds it). WitchDoktors - Timeless & Dimeless
  (Bomber Music) is only on Discogs.

**Overnight 2026-11-16 (D107, pushed 32eebf3, CI green; PC build installed):** the owner asked for four things and went to bed.
- **CTDB** is a lookup source now (keyless; metadata from MusicBrainz/Discogs/freedb for this and similar layouts; silent when down).
  Next idea there: use CTDB's rip checksums as a second check beside AccurateRip.
- **Share this disc** panel on the Rip page: attach-disc-ID link, pre-filled MusicBrainz Add Release form, gnudb submission (own email,
  confirmation, nothing sent otherwise). **Never run against the live gnudb or a real MusicBrainz login** (no test mode on gnudb): try it
  once on a disc you do not mind sharing (e.g. WitchDoktors) and check it shows up in gnudb ten minutes later. The gnudb registration email
  (`docs/gnudb-registration.md`) is still not sent.
- **Artist photos:** TheAudioDB and Fanart.tv added after Wikimedia (Settings > Artist photos: more sources; needs your own keys; **untested
  with real keys**). Earlier "no photo" answers are asked again once a key is set. Run Review > Artists > photos again after adding keys.
- MusicBrainz was overloaded on 2026-11-16 ("currently busy", global): lookups said "busy or limiting requests right now"; try again later.

**Owner wanted a more complete database (first four items below now done or started).** Ideas, each needs the owner's OK per AGENTS.md:
1. **Contribute back:** a button that opens MusicBrainz's "attach disc ID" page for a chosen release (needs the owner's MusicBrainz
   account), so the next lookup is exact; likewise submit the disc to gnudb (needs the gnudb registration, `docs/gnudb-registration.md`).
2. **Remember choices locally:** store disc ID -> chosen album, so a disc ripped once is recognised at once and a re-rip needs no search.
3. **CUETools Database (CTDB)** (TOC lookups with user-submitted metadata): check its terms and API before using it.
4. ~~**AcoustID** fingerprinting after the rip~~ **Built 2026-11-16 (D113)**: each ripped track is fingerprinted and checked against the chosen details. Still open: use it to name tracks of a disc nothing else knows, and for single library files.
5. **Gracenote** is the big commercial one: needs a paid licence, not free.
6. Label shops (e.g. Bomber Music) have no public API; scraping is out (same reason as Amazon and Bandcamp, D106).
**Still not built:** TheAudioDB/Fanart.tv photos (owner to confirm terms and keys), a MusicBrainz connection in Settings, a rip audit,
the bulk "Write IDs" press on the real library, a real scratched-disc test (only a fake drive so far). Covers for iTunes/Deezer
candidates (use Review > Artwork afterwards). Watch: MusicBrainz answered 503 to the app's identification string for a few minutes after a
burst of testing; several features can add up their requests.

# Where we stopped (2026-11-15)

**2026-11-15 (D97, pushed):** a deep look at Jellyfin against MediaVerse (`docs/jellyfin-review.md`: how Jellyfin does each
thing, who should own it, ordered next steps). Built: **Review > Artists** with *Artist names* (artists spelt two ways, one
button, Undo) and *Artist photos* (Jellyfin's photos written into the songs as the Artist picture, Undo), and the artist's photo
on top of their stack on the wall. **Owner to do:** install the new build, sign in under Settings > Jellyfin, try both tools on
the real library (the Jellyfin calls have not been run against a real server); decide the open questions at the end of the
review document (stand-alone photo source, MusicBrainz IDs in tags).
# Where we stopped (2026-11-11, later)

**2026-11-11 (D94):** casting from the phone (Google Cast + DLNA), phone settings filled out, cover wall removed from
the phone. Tried on the bedroom TV only (see D94 for what is and is not proven). **Next:** (1) owner taps through it on
the phone (TV button on Now Playing: pick "65" OLED" or another device; check the notification and the controls);
(2) the Den TV when it is on; (3) the amp and a DLNA-only device; (4) the MediaVerse receiver on a registered device
(lyrics); (5) "Cast" on the phone leaves the song paused on the TV when "bringing it back" (no stop yet in the UI);
(6) the list below.
# Where we stopped (2026-11-11)

**2026-11-11 (D93, pushed 0619aa4; PC installed, both TVs and the Pixel have it):** colour mask setting on all three
apps, compilations whole under "also appears in". **Not yet seen on a screen:** the mask (PC Settings > Display, TV
and phone Settings) and the whole-album pages. Check the TV's `mix-blend-mode: color` layer on Now Playing, and that
the phone's wall still reads. Everything under "2026-11-10 night" below still stands (visualizer, stale
measure script, copy corrected library to the phone, then `ArtProvider.forgetMissing`).
# Where we stopped (2026-11-10 night)

**2026-11-10 night (D92, pushed; PC installer, living room TV and Pixel all have it):** artist rule, "also appears
in", phone folder pictures, swipe-away stops the music (see D92). Installers\ (next to the repo folder) holds the
Setup and source bundle of the same commit. **Not yet seen by the owner:** the PC's and TV's "also appears in" pages
(code and tests only: 199 web tests, Android unit tests). **To do next:** (1) owner looks at the PC artist page, the
TV artist page and search, the phone; (2) bedroom TV still has the older TV app; (3) the phone's music folder is the
old pre-correction copy: after the owner copies the corrected library, clear the cover cache (reopening the app
after the images permission does it; `ArtProvider.forgetMissing`); (4) visualizer from live audio (Media3
`AudioProcessor`); (5) rebuild `web/app/scripts/measure-large-library.cjs` (stale); (6) the older open list below.
# Where we stopped (2026-11-06) and what comes next

**2026-11-10 (D91), committed locally, not pushed, not yet in a build:** a review for speed. Start-up no longer
reads every song's tags again (file records in the library database); the TV's library list goes out packed
(3.3 MB to 0.7 MB); the TV searches a home network wider than 254 addresses; a folder change during a running
sync is no longer dropped. Measured and left alone because they are already fast on 13,476 songs: sidecar commands
(covers 1 ms, library 140 ms), the desktop page (start 243 ms, Library 62 ms), the TV's list building and search
(under 11 ms on the PC). **To do:** rebuild and restart the PC app (the first start still reads everything once,
to fill the records); reinstall the TV app on the bedroom TV and check the wider search. Found on the way:
`web/app/scripts/measure-large-library.cjs` is out of date (the artist find box and Review buttons it clicks are
gone); the sidecar still answers one command at a time (a cover waits behind a slow command: 0.55 s behind the
ID3 survey), worth a second lane for covers and lyrics if it is ever felt.

**Owner's priorities (D49):** tag fixing, then album art and band photos, then lyrics; then the Pixel phone app
(local storage library, playlists); Google TV later.

**Stopped 2026-11-06 night (D72 to D84, all pushed; website repo `mediaverse.studio` pushed too).** Built today:
desktop playlists with XSPF/M3U8/JSPF export and import, library search, Play all/Shuffle, 20 highlight colours
(desktop, TV, phone), Home boxed like Settings, window place remembered; casting from the desktop (MediaVerse TV
app, DLNA, Google Cast; all in-house, no new components); the Google Cast receiver page (App ID 0E81A85C) live at
https://mediaverse.studio/cast/receiver.html; playlists on the TV (from the PC) and the phone (kept on the
phone); the TV's new top bar (Library with pivots, search beside it, queue under Playlists, a back strip, artist
tiles with one cover); licence GPL-3.0-or-later; guiding documents and the website updated. Both TVs have the
latest TV app (bedroom launched, living room installed). The PC app runs the latest build.

**Open, in order:**
0. **Done the same night (D85):** the desktop library got an albums view (compilations reachable), pinned headings
   and clickable breadcrumbs. The owner sees the PC as the standard; the TV's artist rule (below) likely follows it.
   **Owner's question, 2026-11-06 night: the TV lists 904 artists, the PC 369.** Not a cache: the TV files songs on
   compilations (album artist "Various Artists") under each song's own artist (	v/library.ts listedArtist), the
   PC under the album artist (library-format.ts artistOf). Offer: (1) TV like the PC; (2) PC like the TV; (3) both
   list only artists with an album of their own, with an "Also appears on" row for compilation songs. Owner to choose.
1. **Cast receiver on the Den TV (TCL Google TV, registered test device).** (Owner unticked "audio only devices"
   and saved, 2026-11-06 night; the TV still needs a full restart before the retest.) It refuses the MediaVerse receiver:
   its log (adb logcat, `cast_shell`) says "App 0E81A85C cannot run on virtual device ... because the app does
   not have capability tags". The fallback to Google's player works. Owner is to untick "Supports casting to audio
   only devices" in the Cast console, save, wait about 15 minutes, restart the TV; then retry (scratchpad scripts:
   a launch probe, and a full play test that needs the PC app closed for port 47700). If it still fails, publish
   the app (it needs at least one sender entry; try Chrome with the website address).
2. **The receiver page itself is untested on a real device** (lyrics, colours, drift). Check it as soon as the
   Den TV accepts it.
3. **Real tries of casting from the desktop app's TV button**: DLNA and Google Cast to the WiiM amp and an S95F,
   and "Play on the TV" to a TV with the app; the next song when one ends; Bring the music back.
4. **Website screenshots from a demo library** (owner approved): invented artists and albums, copyright-free
   generated covers, silent or tone MP3s made with LAME; capture with a throwaway data folder.
5. **Phone**: Pixel and Android Auto test still pending; then XSPF import on the phone (needs a WebView file
   chooser in Kotlin); the phone's playlists and colours have not been tried on any device yet.
6. **Tags noticed on the TV**: artists "[Error]", "[no artist]", "1208" (Fix tags).
7. Smaller: the desktop's DLNA/Cast remote has no seek control; the TV's playlists are read-only (making
   playlists from the remote later); the phone's Playlists tab makes eight tabs (check the bar on the Pixel).

**Recurring check (owner's request, 2026-11-10): LAME releases.** We ship LAME 4.0 (pinned in
`third_party/provenance.toml`). The owner noticed LAME 4.1 beta 1 exists. Every so often (at the start of a
session that touches the encoder, or about monthly while active), look at the release lists, home page first:
https://lame.sourceforge.io/index.php and the GitHub mirror https://github.com/enzo1982/lame/releases. Report to
the owner whether a **stable** release newer than 4.0 exists and what it changes (encoder quality, bug fixes,
licence). Do not switch to a beta. Adopting a new version is a dependency change: follow
`Guiding Documents/Third-Party Software and Licensing.md` (verified archive hash, provenance entry, rebuild with
`tools/build-lame-4.0.ps1`, re-run the MP3 tests) and ask the owner first. Last checked: 2026-11-10. Latest stable is
4.0 (the one we ship); 4.1 beta 1 is a pre-release (security hardening on by default, run-time SIMD speedups, fixes
for mono interleaved encoding, ATH masking and float WAV/AIFF loudness). Nothing to adopt yet; wait for a stable 4.1.

**Owner's to-dos:** GitHub Sponsors link (for the README and website); Google Play Console and Samsung Seller
Office when ready (`docs/casting-plan.md` and D79-D81 for the account notes).

**Done 2026-11-04 (D51 to D56):** Fix tags writes on the owner's command, page by page, with undo; suggestions
follow the album's other tracks and can be edited; a missing genre is suggested from the artist's usual genre in the
library, else MusicBrainz's genre for the release's artist (cached), else an empty Genre box on the album card (D56).
At the owner's delegation every suggestion at 99% or more was applied (batches 10 to 36: 554 albums, about 7,130
files, 0 errors). The library is 100% MP3 (13,546; the 245 M4A originals are in `C:\Users\<you>\Music (M4A
originals)`) and all tags are ID3v2.3. Desktop library in Windows Media Player's layout with the Zune look, WMP-style
selection and right-click menus; security and performance pass (D54). TV: Queue tab, tick boxes, repeat, icon
controls, slow 45 s cover wall, quick reopen after silence, keep-awake clip, 20 s idle return, A to Z letter jump;
both TVs have the latest TV build (aa49a8d).

**For the owner to do:** try the new Genre box on the 99% albums whose only gap is genre; keep going through the
90 to 98% group (about 172 albums), then 70 to 89% (40), below 70% (5) and not identified (75); optionally "Tag 24
songs" (untagged MP3s) in Settings › Tags & files; use the TV app for a couple of days and report (screen saver,
stalls). **Next for us:** the owner's feedback on the genre suggestions; AcoustID fingerprints for folders the
lengths and names cannot place; then album art and band photos, then lyrics; playlists and ratings. Ideas on hold:
see "Ideas kept for later" in the roadmap.
**TVs:** install only on a TV the owner says is free (the living room TV is in family use).

**Done 2026-11-04 evening (D57, D58):** Fix tags: a bonus track not on the release takes the album's genre and
year (the two Orbital albums were stuck). The **Android app** began (`docs/android-app.md`): Media3 player with
Android Auto lists, the phone screen in the TV app's look (tabs, album/artist/genre pages, queue, search,
favourites, Now Playing with the visualizer), shuffle/repeat in the notification, sharing the phone's library with
the TV app (Settings > TV), and **Play on the TV** with the phone as the remote. Tried on an Android 17 emulator
only. **For the owner:** turn on USB debugging on the Pixel 11 Pro and run `tools\build-android.ps1 -Install`;
copy some albums into the phone's Music folder; try it in the car (Android Auto > Developer settings > Unknown
sources); approve or not the Media3 and AndroidX libraries (third-party guide). **To install the TV app's remote
support on a TV:** rebuild with `tools\package-tv.ps1` when a TV is free. The Media3/AndroidX libraries are
approved (D57).

**Done 2026-11-04 night (D59):** the Fix tags editor: every tag of every song is a text box (orange suggestion
with the old value struck through, white current value, yellow where the release differs, blue when typed); a
Disc column; album boxes (Album, Album artist, Contributing artists, Genre, Year) set every song of the album at
once; albums with no matching release get suggestions from their folder and file names ("No release found: check
and edit"); titles carrying a track number, the artist's name or a web address get a tidied suggestion. Typed
values and tidied titles may replace a real tag only if it is unchanged since the scan; non-numeric year, track or
disc is refused and reported. All tests pass, but **it has not yet been checked in the running app**: the owner is
using the app to fix tags; on the next restart (Start MediaVerse Studio.cmd rebuilds) look at a few "Not
identified" albums together (1876, AFI Fire Inside, AFI Live Arena Long Beach CA). Pearl Jam "Pulled the Covers"
was checked: disc tags already right (23/17/17/15/18); the matched release is a different 5-CD set, so only the
album artist should be taken. **Next session:** remind the owner to try the Android app on the Pixel 11 Pro.

**Done 2026-11-05 and 06 (D60 to D68):** artwork (Missing / Low resolution / Oversized images, Add artwork dialog,
Fix all with undo, automatic covers taking only 100% matches); library layout on every page; lenient tag reads and
the ID3 status-flag fix (315 files); artists merged by spelling, and feat. guests dropped on the TV and phone; TV low-power pass;
lyrics beyond the exact album; automatic lyrics; Settings › TV firewall check and "Let TVs reach this computer";
the TV app offers Jellyfin and USB when it can't find the PC; the TV holds the screen on with the Tizen Power API
too; lyrics float above the cover and details with an outline. **Lyrics to review (D68):** likely matches kept in
`<data>/lyrics-review/`, each with a confidence score; Review › Lyrics › To review plays the song with a timing
editor (now, Tap or T, All earlier/later); Confirm embeds, Reject tries the next candidate. Missing lyrics is now a
compact song table.

**Open, 2026-11-06 night:**
- **Owner to check:** whether the TV screen saver still starts about a minute into songs with lyrics (bedroom TV has
  build 5fdd785; the cause was never confirmed). Press Start on Automatic lyrics again (the app was restarted); try
  To review on real songs and report on the timing editor.
- **Next for us (owner's ideas):** make plain lyrics time-stamped during ordinary playback (Now Playing); later,
  sync lyrics automatically (would need vocal alignment; no component chosen, ask before adding one). Find a
  cover's original through MusicBrainz works when the title alone is ambiguous; let songs be marked instrumental.
- **Known gaps:** the TV app's search of a /22 home network (192.168.68-71.x) is built (D91) but not yet tried on
  a TV: it relies on Samsung's `webapis.network.getSubnetMask()`; check on the bedroom TV that a PC on another
  192.168.6x part is found. A "low power" TV setting; the Android build not yet on the Pixel; the owner hasn't tried Fix all for oversized pictures
  on his library yet. Jellyfin starts from a scheduled task at sign-in; remove the task when the server moves to the
  home-assistant computer.

Latest test installer: `dist-installer\MediaVerse-Studio-Setup.exe` (built 2026-11-03 from `d0609ec`, SHA-256 0C83341A8D8DAF3DE4865D0825E7BA14CC23DAC113FBD9F391D099D6AA7303E7). It has everything from D32 to D34; running it over the installed copy keeps your settings and data.

Branch `main` (the spike branch became `main` on 2026-11-07; its last commit is tagged `spike-final`). Decisions: `docs/decision-log.md` (D1 to D31,
summary table at the top).

## Tests

- Rust: `cargo test --workspace`. Set `MEDIAVERSE_LAME_PATH` to `third_party/build/lame-4.0/x64/Release/lame.exe`
  to include the LAME tests. The CD helper's own tests need `--target x86_64-pc-windows-gnu` (see
  `tools/build-cd-helper.ps1`).
- Web: `npm test` and `npm run test:electron` in `web/app`.
- CI runs both on every code push (`docs/ci.md`; documentation-only pushes are skipped).

## Try it

- **Installed test build:** `tools\make-installer.ps1` makes `dist-installer\MediaVerse-Studio-Setup.exe`
  (`docs/installer.md`). Per user, no admin rights, Start menu shortcut, uninstaller keeps your data.
- **From the source:** double-click `Start MediaVerse Studio.cmd` (or `tools\start-mediaverse.ps1`, with `-Fresh`
  for a throwaway data folder and `-SkipBuild` to skip rebuilding).
- Pages in the top bar: **Home** (Getting Started, Recently played, Most played, New, Pins), **Rip a CD** (with
  Drive setup inside), **Library** (artists, albums, tracks, tag editor, Pictures & lyrics, Pin to Home),
  **Review** (flagged tracks, missing or uncertain metadata, missing artwork, missing lyrics, audio defects) and
  **Settings**. The player bar opens Now Playing (cover wall, Queue and Lyrics tabs) and has Flag.

## Next, in agreed order

1. **Feedback round 2 (D32)**: Phase A done (see the D32 progress notes). Phase B done as far as measured (D33, D34, ADR 0008): background defect scan, paged Review, native folder watching, incremental resync, stable track IDs, artist paging, suspected albums. Phase C: artwork finding done (D34); fingerprinting waits for the Chromaprint decision below. Still open for large libraries: a change rewrites the whole library database and resends it (4.5 s at 100,000 songs), and after a restart the first change re-reads every tag, then Phase C (fingerprinting, artwork finding). Small: make the `drives_rip` tests use unique temporary folders (one flaky failure seen).
2. **Clean-machine install**: test the installer in Windows Sandbox or a VM (needs Sandbox enabled, see
   below). Add a licence and notices screen before any build is shared.
3. **Code tidy-ups from the review** (in rough order):
   1. Pass a small options struct to the functions with many arguments (`make_mp3s`, `path_suggestions`,
      `Track::with_extended_metadata`).
   2. Share one JPEG/PNG sniffing helper (`cover_art`, `library_cover`, `id3`).
   3. Split `main.ts` (about 600 lines): dialog wiring apart from library rendering.
   4. Add a test for the working-folder tidy-up after a clean MP3+FLAC rip.
   5. Keyed updates on the library page once libraries are large.
4. **Leftovers from the documentation clean-up (D31):** done (Tauri packages and bridge code removed, the
   unused libcdio-sys probe crate removed, the lofty record corrected). Delete `archive/tauri-desktop` once its
   behaviours have Electron tests (D19).
5. **Rip page items:** select all/none for tracks; manual album entry rips all tracks; leftover empty
   `rip-work` folders; free-space check before ripping (needs a reviewed Windows API call or an approved crate);
   a direct link to Settings when the archive folder is missing.
6. **Further features**, in the Feature Roadmap's order: library at scale, bulk lyrics, the Winamp-inspired
   visualizer and a mini player, re-rip of flagged tracks, AcoustID fingerprinting, casting proofs, then the
   Android playback app.

## Known limits

- Covers come from the MP3's embedded front cover or a `cover.jpg` in the album folder. Only ID3v2.3 tags (what
  this program writes) are edited by the Pictures & lyrics editor; files from other taggers (ID3v2.4, FLAC) show
  a cover only if a folder image exists.
- The defect scan is validated on one real track plus synthetic audio (D24); treat it as an aid.
- Flags, history and pins are keyed by file path; mobile sync will need a stable track identity (D25).

## Waiting on the owner

- More Zune screenshots (`docs/design-inspiration.md`) to confirm the design direction (D23).
- gnudb: send the registration email (`docs/gnudb-registration.md`); the contact address is still open.
- Windows Sandbox: run once in an elevated PowerShell:
  `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`, then restart.
- Before going public: scrub personal data (GitHub issue #3, `tools/check-before-public.ps1`).

## Audio fingerprinting: component chosen (D35)

`rusty-chromaprint` 0.3.0 (pure Rust, MIT) is approved after a licence check; `rusqlite` is now recorded too. Next: build fingerprinting as a background job like the defect scan, check first that its fingerprints match AcoustID's, look up AcoustID (at most 3 requests a second, the registered application key), and offer the matches as suggestions in Review, never written without confirmation.

## TV apps (D36, on the roadmap)

See `docs/tv-apps.md`. Done: developer-mode research, fixed TV addresses, Tizen Studio installed (D37), the TV app and library sharing built and tested on the PC (D38). Next: developer mode on a TV (the remote's 123 button for the number pad), read each TV's device ID over `sdb`, make the Samsung certificate profile with the owner signed in, `tools\package-tv.ps1 -Install`, then check on the TV: FLAC playback in the app, synced lyrics, the remote's media keys, how long a developer install lasts. Store releases (Samsung, Google Play) later.

## Standing rules

Ask before every `git push` and before approving third-party components (log in the decision log); never put
the AcoustID key or a personal email in the repository; downloaded files are untrusted; update the AcoustID
registration with every version change (`docs/release-checklist.md`).

**2026-11-06 morning (D69):** TV app on the bedroom TV: lyrics layout redesigned (small corner cover, two-line
details, moving bars under the lyrics: the likely screen saver cause was Samsung's OLED still-picture detector), no
mid-song side swaps, Play next / Add to queue on album, artist, genre and favourites pages, and a choice when OK is
pressed on a song while music plays. **Owner to check:** play an album with lyrics for 5+ minutes on the bedroom TV.

**2026-11-06 afternoon (D69, D70):** the TV screen saver is fixed and confirmed: the OLED still-picture screen saver
only respects Samsung's AVPlay, so the keep-awake clip now plays through it (`docs/tv-screen-saver.md` has the
whole story, rules for future changes and how to debug the TV app from the PC). Also: lyric lines fade at the box
edges, plain lyrics rise like credits a line at a time, Settings › Songs without lyrics (middle visualizer or bottom
glow), truer cover colours (silver for black-and-white covers), Play next / Add to queue everywhere.

## Session end 2026-11-18 (D132)
Pushed to `lyric-sync` (a8c3eb1) and installed (build a8c3eb1; copies in `Developer\MediaVerse\Installers`). Built but **not seen on a screen**: the lyrics page order and left-aligned Start buttons, the Instrumental list's play buttons, the backdrop collage after a tag/lyric save (broken-image fix), and the Match-up cards. Not yet started: running the Lyric AI itself (Step 1 then Step 2 on the missing songs); the open decision on applying songs with 10-25% doubtful lines (D131).

## Session end 2026-11-18 (D133)
Committed on `lyric-sync` (**pushed and installed on 2026-11-18**). Read D133 before changing artwork search, lyrics lookup, or TV sharing.
- Artwork search uses the tagged MusicBrainz release, barcode, and catalogue number before name variants; a pressing with a Cover Art Archive front is kept; the release group is tried when that pressing has none. Below a sure match (95), iTunes and Deezer cover addresses already in their search replies may be fetched (those hosts only). Discogs images are still not fetched. Review's automatic covers use 95, not 100.
- Lyrics within 20 seconds keep their timing and are marked for alignment. A one-song dialog lookup that finds nothing can follow the MusicBrainz work to other artists (`follow_works`). Automatic lyrics does not. Successful LRCLIB replies are cached 30 days. Do not download the LRCLIB dump.
- Outbound redirects are pinned (same host, a dotted subdomain, or Cover Art Archive and archive.org). The TV device key is a header only. Song and cover addresses use a short-lived ticket. Pairing starts only after Settings > TV > Pair a TV. **An already-paired TV will not play until this TV app is installed**; the old `?key=` addresses are refused.
- Checked: targeted Rust tests (redirect pin, artwork front-cover preference, artist queries, near-miss lyrics, work artists, catalogue cover hosts) and `web/app` `library-share.test.js`. Not tried on the real library or a real TV.

## Session 2026-11-18 (later): D133 reviewed, built, installed; folders tidied
- Tests all green (one `drives_mp3` test failed once inside the full-workspace run and passed on 4 reruns: a timing flake, watch for it). Built and installed build `1b450e2`: PC (Setup /Q), phone (`build-android.ps1 -Install`), both S95F TVs (`package-tv.ps1 -SkipBuild -Install <ip>`, one TV per call: the `-Install` list does not accept two addresses at once). **Every TV must be paired again** (Settings > TV > Pair a TV) because the key is no longer in addresses.
- **Folder layout.** All MediaVerse material lives under `C:\Users\<you>\Developer\MediaVerse\`: `MediaVerse-Studio` (this repo), `mediaverse.studio` (website repo), `Installers`, `MediaVerse-Demo-Library`, `MediaVerse-Lyric-Sync-Lab`, `MediaVerse-Lyrics-Sync`, `rip-test`, `Jellyfin-Test-Server` (was `Developer\tools`; the scheduled task "Jellyfin (MediaVerse test server)" was repointed) and `Reference` (Zune, Windows Media Player, Musicolet and Android Auto pictures). Other projects stay directly in `Developer`.
- **Repo moved (2026-11-18):** after `cargo clean` the repo was copied (robocopy, file and byte counts verified equal) to `Developer\MediaVerse\MediaVerse-Studio`, because a program still held the old folder open and a plain move failed. An empty `Developer\MediaVerse-Studio` folder may remain until that program closes or the PC restarts; delete it then.
- **Phone server fix (after the D133 review).** D133 moved the key to a header and added media tickets on the computer's share server, but the phone's own server (`ShareServer.kt`) still read `?key=` and its CORS preflight refused `Authorization`, so a TV could not have used a phone's library. `ShareServer.kt` now accepts the key as `Authorization: Bearer` or `X-MediaVerse-Key`, issues and accepts the same media tickets, and allows and exposes the new headers. It compiles; **not yet built into the APK, installed, or tried with a TV.** The phone server has no "Pair a TV" arming step (the computer has one); that is a separate choice.

