# Outstanding tests and roadmap (kept by Claude; last updated 2026-11-19)

The owner asked for this list to be shown whenever they return to the project. Update it at the end of every session
(`docs/next-steps.md` has the narrative of where each session stopped; `docs/decision-log.md` has the decisions). **The plan (roadmap, testing plan, going public) is `docs/roadmap.md`;
this file is the detailed list of what to try by hand.** Everything below dated up to 2026-11-18 is installed on the PC (build `b4ac54f`) unless a line says otherwise. Page names on Review > Lyrics changed on 2026-11-18 (D138): "Missing", "To review" and "Instrumental" are now **General review** and **Suspected instrumental**.

## State at the 0.9.0 beta (2026-11-25)

The first public beta is out (decision D200). Everything in the lists below dated before 2026-11-24 is in it. **Not yet tried by anyone on real data or devices:** "Measure everything again" and the levelling tag writer (try one album first; both have an undo), exclusive (WASAPI) output on a real DAC, Android Auto in a car, casting to the Den TV and the amp, and the first-run path on a clean machine other than the author's virtual machine. The Samsung TV app is not a download (it must be signed for each TV); the Android app is an `.apk` on the Releases page.

**First things to look at when a tester reports something:** the startup trace in the developer tools (`__mvTrace()`, `__mvSteps()`, `__mvFreezes()`), Settings > About for the version and commit, and `docs/workflow.md` for how issues are handled.

## A. Outstanding tests (nothing to build: someone has to try it)

**Lyric AI (D134 to D142; PC build `b4ac54f`, installed 2026-11-19)**
1. **Look at the owner's whole-list pass** (started the night of 2026-11-18 with "Also redo songs checked before", music-lyrics reader, drafts available): Review > Lyrics should show Step 2's counters, General review with the AI's picks (percentages, "AI-checked against the singing", "Cover of ..." badges, drafts labelled "AI draft from listening"), and Suspected instrumental. Play 10 to 15 (some certain, some below 60%, some drafts, some of the Operation Ivy album) and check the words and where the first line starts.
2. **Batch approve:** in General review tick songs (shift-click for ranges, or "Tick the AI-checked at 90% or more"), then "Approve and save to songs": a batch of 20 to 50 first, check a few in another player (foobar2000 or MusicBee), then the rest. Back up the Music folder first; the batch is journalled and can be undone (ask Claude).
3. **Drafts:** Step 2 > "Songs nothing was found for: write a draft by listening" (needs the music-lyrics reader chosen in Settings > Lyrics > Lyric AI and the Whisper files; both are in place). Correct words with the pencil, confirm. Roughly one draft in two is good (about one word in five wrong).
4. **Instrumental page:** play a few, "Confirm instrumental" (writes language "zxx", genre untouched), check "Show the confirmed" and that "Not instrumental" restores it.
5. **Settings > Lyrics > Lyric AI:** switching the reader between the original and the music-lyrics model; the status line should name the files each needs.
6. **48 kHz albums:** they are listed in `Developer\48khz mp3 files.txt` (65 tracks, 9 albums, mostly digital albums from the artists); the Lyric AI now reads them. Converting them is optional; the owner may rip the CDs instead.
**Casting (phone and PC)**
1. **Den TV** (TCL Google TV, Cast test device): did not accept a connection while off. Try casting from the phone
   (`MediaVerse receiver 0E81A85C` was refused with "app does not have capability tags" before; the owner unticked
   "audio only devices" in the Cast console, needs a TV restart and ~15 min). Also from the PC.
2. **Living Room Amp** (Cast/DLNA speaker at the Deco): play from the phone and the PC, at a time the house is quiet.
3. **A DLNA-only device** (none in the house yet; the S95Fs and the amp also speak Cast, so they are listed as Cast).
4. **The MediaVerse Cast receiver page** (lyrics, colours, drift) on a registered device. The bedroom Samsung only gets
   Google's player, which is plain.
5. **Phone cast with the screen off for several songs** (the foreground service should keep it going; only tested with
   the screen on).
6. **PC casting to the S95Fs and "Play on the TV"** from the desktop (D76 to D80), never tried on real TVs.

**Phone (Pixel 11 Pro)**
7. **Android Auto in the car** (needs Unknown sources in Android Auto's developer settings) and Bluetooth/USB controls.
8. **Folder album pictures** after the corrected library is copied across (then "Look for new music"; cover cache
   `ArtProvider.forgetMissing` clears the saved "no cover" answers).
9. **Playlists and the eight-tab bar** on the phone (never used on a device), **XSPF import** on the phone (needs a
   WebView file chooser, not built).

**PC and TV (installed 2026-11-11, build 0619aa4; nothing seen on a screen by the owner yet)**
10. **Artist page "also appears in:"** on the PC (whole compilations), TV and phone; search finding compilation-only bands.
11. **Colour mask** (PC Settings > Display, TV and phone Settings; phone has none now): on/off, colours, the TV's
    `mix-blend-mode: color` layer on Now Playing, and the PC's look with the mask off.
12. **TV network search** wider than 254 addresses (`getSubnetMask` on a TV, the owner's mesh is /22).
13. **First start after the speed update** (D91: file records), and a timing on the 13,476-song library.
14. **Fix all artwork** (Review > Artwork) has never been run on the real library; the Fix tags editor changes of
    2026-11-04 were never seen live by the owner.
15. **Clean-PC install test** of the Setup program (a PC or VM that has never had the app).

**Added 2026-11-15 (D97), to try on the PC (installed since):** (a) Settings > Jellyfin > sign in, then **Review > Artists >
Look on Jellyfin** and "Write photos into the songs" (never run against the real server: the two Jellyfin calls are untested
live); then the artist wall should show the photo on top of each stack. (b) **Review > Artists > Artist names**: "AFI" /
"A.F.I." should be offered; press "Use AFI", check the wall, and try Undo. After either, run "Scan library" on the Jellyfin
server so it follows the new spelling.

**Added 2026-11-15 (D98/D99):** phone (installed 2026-11-15): car browse lists now have Play all / Shuffle all / Add all to queue; check the grey covers are gone. PC (installed since): **Review > Album IDs** > Check the library (about an hour for ~1000 albums, can be stopped), look at the counts and the set-aside list, then Write IDs and try Undo. First real run (2026-11-15, 1083 albums): 442 ready, 432 album-only, 147 set aside, 62 single-song folders left out; write + undo tried on one album (187 Lockdown, 12 songs) and worked; the bulk write has not been pressed.

**Added 2026-11-14 (D95), to try on the phone:** cast volume slider (Cast and DLNA), device chooser with Cancel, bar with previous/play/next and artist/album/next, landscape Now Playing, sleep timer, Most played / Not played lists, save queue as playlist, equalizer per output (Settings, or Equalizer on Now Playing). Android Auto: test whether tapping the split-view card can open full screen (Desktop Head Unit, or the car).

## B. Roadmap and known issues

**Lyric AI, models, distribution, Linux:** see `docs/roadmap.md` (steps 1, 2 and 5), `docs/lyric-models.md`, `docs/distribution-plan.md` and `docs/linux-plan.md`.
**Owner's priorities (D49):** tag fixing, album art and band photos, lyrics; then the phone app; Google TV later.

**Phone and casting**
- Live **visualizer from a Media3 `AudioProcessor`** (no recording permission; today it analyses each song ahead).
- Casting gaps: no volume control, the TV's progress is polled every 1.5 s, the queue lives on the phone (the app must\n  stay installed and running).
- **Google Cast receiver:** publish the MediaVerse receiver (needs at least one sender entry) so any Cast device, not
  only registered test devices, gets the lyrics/colour page; the owner's decision (small fee, Google account).
- Phone music folder is the **old pre-correction copy** until the owner copies the corrected library.

**PC, TV and library**
- **Tags noticed on the TV:** artists "[Error]", "[no artist]", "1208" (Fix tags).
- Desktop DLNA/Cast remote has **no seek control**; TV playlists are read-only (making them from the remote later).
- `web/app/scripts/measure-large-library.cjs` is **stale** (buttons it clicks are gone); rebuild it, then re-measure.
- The sidecar answers **one command at a time** (a cover waits behind a slow command); a second lane if it is ever felt.
- An album with no album-artist tag is not treated as a compilation by the artist rule (its artists are listed one
  by one).
- Setup.exe has a blank FileDescription (cosmetic).
- **POSSIBLE BUG, TV freezes after the Home key (2026-11-22, not reproduced):** on the living room TV (S95F), pressing Home while music
  played took it home and stopped the music, then the whole TV stopped answering until it was rebooted. It had been on for many hours and
  had been streaming video apps (YouTube, Crunchyroll) before MediaVerse; the app was on the Favorites page, source Jellyfin. Tried
  afterwards on both TVs with the app freshly started and a tracer attached: Home worked normally on both. The one difference seen:
  the app's `visibilitychange` handler (`web/app/tv/main.ts` `stopNativeClip`) stops and closes the AVPlay keep-awake clip, which took
  0.16 s + 0.02 s on the bedroom TV but 1.16 s + 0.34 s on the living room TV. Suspect: that teardown hanging when the TV's player
  is under load after hours of use. Not proven. Ideas if it comes back: do not touch AVPlay when the app hides (let the TV close it),
  or check `config.xml` `background-support="disable"`. To test: Home after the TV has been on all day with video apps used first,
  and on a page other than Now playing (Favorites).

**Project and release**
- **LAME:** check for a stable release newer than 4.0 now and then (4.1 beta 1 seen 2026-11-10; do not adopt a beta).
- **Owner's to-dos:** GitHub Sponsors link (README and website); Google Play Console and Samsung Seller Office when
  ready; repo is still private; builds are unsigned; share the Setup and its source bundle together (GPL).
- The folder `Developer\_old` may be deleted by the owner (planned); the repo folder is `Developer\MediaVerse\MediaVerse-Studio`,
  installers in `Developer\MediaVerse\Installers`.

**Jellyfin and artists (D97, `docs/jellyfin-review.md` section 5), in order:** MusicBrainz IDs in the tags; a stand-alone artist
photo source (owner to choose: Wikimedia, TheAudioDB, Fanart.tv); artist information on the artist page; favourites and play
counts through Jellyfin user data; "more like this"; MediaVerse as a Jellyfin remote-control target; SyncPlay (last); an option
to also write `.lrc` files for Jellyfin. (The `drives_rip` nested-archive test was fixed in D99.)

## C. Easy next jobs (an hour or less each)
- Rebuild the **measure script** and take a timing.
- Cast volume control (the Cast and DLNA protocols both have it).
- A "Stop casting" line in the phone's Now Playing menu (the notification and the TV button already stop it).

Done 2026-11-11 (after the first try on the bedroom TV): Stop button on the cast notification, "On <name>" in the mini
bar, the phone's shuffle and repeat applying to the cast queue, TV names, the next song after one ends.
The app now asks once for notification permission (without it Android hid the cast notification; allow it).

**Added 2026-11-16 night (D107), to try on the PC:** Rip page > "Share this disc" (attach link, MusicBrainz Add Release form, gnudb send; the gnudb send and the MusicBrainz form were never run for real); CTDB results in the disc lookup (shows as "CUETools Database"); Settings > "Artist photos: more sources" with a TheAudioDB or Fanart.tv key, then Review > Artists > photos again.

**Added 2026-11-16 (D105-D106), to try on the PC:** Rip page: put in a disc and watch the album choices refresh by themselves; "Search by name" (MusicBrainz, Discogs, iTunes, Deezer); the "These details match my disc" tick; typed track titles/year/genre in the hand-entry form. **Wanted by the owner:** a more complete database (ideas in `docs/next-steps.md`: attach disc IDs to MusicBrainz, remember chosen albums locally, CUETools DB, AcoustID after the rip).

**Added 2026-11-16 (D100-D104):** built and installed on the PC, to look over in daily use: Wikimedia artist photos (Review > Artists, credits kept in the program's data folder only); artist names checked against MusicBrainz spelling; Album IDs checked against disc IDs (Review > Album IDs); Match-up for orphan songs (Review); lyrics finder shows your song's length; Rip page shows all tracks and each release's cover and edition; damaged-disc re-reads and plain disc health; **another-pressing detection** and **Drive history** (Drive setup); defect scan false alarms fixed (the library rescans itself the first time). **Not built yet:** refuse to start a rip without accepted or typed tags (a rate-limited lookup once produced "Unknown Artist" files); TheAudioDB / Fanart.tv photo sources (need your approval of their terms and keys); a MusicBrainz account/connection in Settings; a "rip audit"; the bulk "Write IDs" press on the real library; trying a real scratched disc once the drive behaves (the damaged-disc retry path is only tested with a fake drive); the AccurateRip -6 shift on the Skints disc matching the drive's +6 offset is worth confirming with another listed disc.
**Added 2026-11-16 (D108-D109), to try on the PC (installed since):** Review > Fix tags: "Leave as it is" (and "Left alone" chip), "Also replace values that differ from the release" switch; Review > "Missing & copies" (hole list, copies, same song on other albums; Show in folder); Rip page: put in a disc and look at the track-length line under each choice, and that a strong fit starts the "matches my disc" tick ticked. **Roadmap from the owner:** a not-identified file is captured where it is and tagged by many routes (never moved); re-sync from MusicBrainz is a low-priority idea; the request scheduler continues with stages 2 to 4 (priorities, retries, a status line per source).

**Added 2026-11-16 (D110-D111), to try on the PC (installed):** Review > Album IDs: "Compare with my files" on a card (cycle the releases with the dropdown; tick differences; "Use the release's values"; "Flag this disc for a re-rip…"; the flagged discs are under Review > Missing & copies > To re-rip); the "Online sources" status line under the Rip lookup and the Review tabs (shows after the first request to a service); a lookup that finds MusicBrainz busy says so and asks again by itself.

**Added 2026-11-16 (D112-D113), to try on the PC:** Review > Fix tags: on an album nothing identified, "Search other sources by name…", pick a result, "Use these details", check and Apply (nothing is moved). Rip page: rip a disc with AcoustID switched on (Settings > AcoustID, key already saved) and look at the "Audio (AcoustID)" column in the results and the "AcoustID:" line; a track that sounds like a different song than its title is a warning and says which track's title it carries. **Still to build on this theme:** copy tags from another album in the library; AcoustID for single library files (the fingerprinting already reads MP3 and FLAC); writing the AcoustID/MusicBrainz recording ids into the new MP3s.

**Added 2026-11-16 (D114-D116), to try on the PC (installed since):** Review > Fix tags, on an album nothing identified: "Copy tags from another album…", "Tags from file names…" (choose the pattern when asked), "Identify by listening…" (needs AcoustID on in Settings). Review > "Audio check": "Check the albums not checked yet" (a first run on the whole library takes a while; Stop works), then the "Different songs" list; tick songs to take AcoustID's titles, "It is fine" to dismiss. Rip page: a disc ripped with no track titles typed gets them from AcoustID when sure; MP3s and FLACs get the MusicBrainz recording id and AcoustID in the standard places (check one in Mp3tag or Picard if you like). **Still open:** AcoustID/MusicBrainz ids for existing library files (the Audio check could offer to write them for albums that agree); a pattern option that also reads the folder name for artist/album.

**Added 2026-11-17 (D120-D123); installed the same day (see "Update 2026-11-17 (later)" below):**
- **Lyrics (PC):** Review > Missing lyrics > Automatic lyrics: songs asked before today are asked again (likely ones first). Watch how many now become sure (D120: library lengths, first-artist and free-text searches) and that songs leave To review when filled in. The lyrics finder (media dialog) now shows "your song's length".
- **Phone heat (D121):** visualizer capped at 30 drawings/s, 38 bars, paused when hidden; position messages every 2 s. Check the Pixel's temperature after 30+ minutes of Now Playing with the screen on (before: unmeasured).
- **Casting (D122):** phone casts now send lyrics to a TV running the MediaVerse receiver (needs a registered test device: the Den TV "no capability tags" problem is still open); receiver page made lighter (website repo, pushed; GitHub Pages serves it); next song starts sooner on phone and PC.
- **TV (D123):** song analysis uses less memory; 38 bars. Try on the bedroom TV; a Tizen Web Inspector timing is still wanted.
- **PC (D123):** background priority for library scans (try a library scan or Audio check while playing music and ripping), glow visualizer capped.
- **Roadmap added:** automatic lyric syncing (docs/lyrics-plan.md: check/fine-tune existing timing first, then align plain lyrics, then draft transcriptions; needs your OK on models); gapless casting (Cast QUEUE_LOAD / DLNA SetNext); PC cast volume, seek, shuffle, repeat; optional TV "low power" setting; sidecar second lane.

**Update 2026-11-17 (later): installed and built.** PC (D120-D124) installed and running; phone APK installed; TV app (D121/D123) installed on both Samsung S95Fs (bedroom 65" and living room 77"). Still to look at by a person: the lyrics re-ask results; Now Playing on both TVs (visualizer at 38 bars, 30/s); the phone's temperature; casting from the phone and the PC to the bedroom TV with a real ear (gapless: the device moves from song to song by itself, verified by status only); the TV button's new menu items (Shuffle, Repeat, Louder, Quieter, Back/Forward 15 s) on the PC. **Den TV was off** (TCP 8009 refused): turn it on and the "no capability tags" test can continue.
**Lyric AI history:** the Python prototype (`tools/lyric-sync/README.md`) became the Lyric AI in the program (D127 to D142): identity by fit, timing, review pages, the music-lyrics reader, Whisper drafts. Its current state and tests are in Section A and `docs/roadmap.md`; the decisions are D130 to D142.

**Added 2026-11-18 (D133), pushed and installed 2026-11-18 (build 1b450e2) on the PC, the phone and both Samsung S95Fs after all tests passed:** easier artwork and lyrics for discs already owned, and the TV key is no longer in the address. To try after a PC and TV build: Review > Artwork on an album whose tag has a barcode or MusicBrainz id; a one-song lyric lookup that LRCLIB does not have (the dialog may ask MusicBrainz for other artists of the work); Settings > TV > Pair a TV, then pair. An old TV app will fail to play until it is updated. Do not scrape Genius, AZLyrics, Musixmatch, Amazon, Bandcamp, or Discogs images, and do not download the LRCLIB dump.

**Added 2026-11-22 (D169), installed on the PC (build eefa687):** Review > Lyrics now has Step 3 (match), **Step 4 (time)** and Step 5 (review). Try: (a) Step 4 on the playlist "Lyrics: band's own, untimed (not written by the app)" (323 songs) with "Write" unticked first, then look at General review; (b) tick "Write", run on 20 songs, play them in another player, try Undo last run; (c) the new timing editor in General review: select lines, copy, paste between others, Enter, Backspace, Ctrl+Z, Ctrl+Enter, right-click a red-underlined word (the right-click menu was not tried outside the real app); (d) "Re-time songs that already have timing" on a song you fixed by hand.
**Added 2026-11-22 (D170), installed on the PC and both TVs (build 0a0e72e):** flags and playlists through Jellyfin. Already checked by the assistant on the real server from the TV app: a flag made on the TV lands in a "Problem Playlist … (TV)" list, removing it empties it, the TV's Playlists tab shows the Jellyfin playlists without the flag lists, and last night's three living-room flags uploaded at the first load (they now sit in one "Problem Playlist 2026-11-22 21:32 (TV)" list waiting for the PC to merge them). **Not tried on the real PC app** (it was closed; only unit tests): the PC must be signed in (Settings > Jellyfin > Shared problem tracks), then Sync now. Try: (a) on a TV with Jellyfin as the source, flag a song; within a minute it should be on the PC's Review page (the PC must be signed in: Settings > Jellyfin > Shared problem tracks) and in Jellyfin as "Problem tracks" or a "Problem Playlist ... (TV)"; mark it Done on the PC and reload the TV library: the flag clears. Last night's flags on the living room TV should upload the first time the library loads. (b) On the TV, Playlists lists the Jellyfin playlists. (c) On the PC, Settings > Jellyfin > Sync now: the PC playlists (including the two untimed-lyrics ones) appear in Jellyfin and on the TV; check the status line for "not on the server" counts (songs the path match missed). (d) Remove a song from a PC playlist: it leaves the Jellyfin one at the next sync.

**Added 2026-11-22 late (D171), not installed yet (the PC app was busy with a Step 4 run):** Try: (a) Settings > Jellyfin: "Use this server" on the home server and "Hide" on the test server; sign in under the server (Sync now); tick/untick the rescan option and save a lyric, check Jellyfin rescans (needs an admin account). (b) Settings > Library: read "Using a Jellyfin server" and press its button. (c) Flagged tracks: Lyrics… opens the editor: play, press now on a line, edit a line, Search online, Save; then check the song in another player. Also Library > right-click > Lyrics… and Artwork…. (d) Review > Lyrics (renamed): a song with no lyrics opens the same editor. (e) Review > Artwork: the dialog is pictures only. (f) Review > Lyrics, the first "Checking your library…" after install (about a minute and a quarter on the share), then again (about 10 seconds).

**2026-11-22 night, installed on the PC (build 3f53527; the TVs were not changed):** D171 and the fixes below are all in the installed program. **The stored paths were rebased** with `tools\rebase-stored-paths.ps1 -Apply` (program closed): favorites 2, play history 410, instrumental list 575, playlists 275 paths, review entries 938, Lyric AI results 1,050 and judgements 1,983 now point at `M:\`; the originals are in `%APPDATA%\MediaVerse Studio\path-rebase-backup-20261122-222334` (about 14.5 MB, delete when satisfied). 17 entries name songs the library does not have and were left alone. Journals were not touched. To try: (a) Review > Lyrics: open MxPx "Nervous Energy"; it should play and its booklet-photo version should show the times carried from the timed candidate (with a note saying how many lines). (b) Favorites hearts and play counts should show again for songs that were on the old path. (c) Everything listed under "Added 2026-11-22 late (D171)" above. Not tried in the real program by the assistant (it was not launched after installing): the new Settings > Jellyfin page, the Lyrics… window and the Library tab text.

**Added 2026-11-23 (D172, D173), committed, not installed yet:** (1) **Lyrics editor:** it has its own play/pause, back/forward 5 s and 1 s, seek bar and speed (¾, ½). Try it on a song such as AFI "Morningstar" (28 untimed lines): press now on the first line or two as they start (the times turn the accent colour: they are yours), then **Lyric AI: time the lines**; the first run on a song takes about a minute (listening), then check the lines, fix a few with now, and press it again: your lines must not move. Shift-click times everything again; "Undo the AI's timing" takes it back. Not tried on the real engine; if the Lyric AI is not set up it says what is missing. (2) **Jellyfin server alone as the library:** Settings > Library > Use the Jellyfin server as my library (needs the sign-in under Settings > Jellyfin; the page restarts). Try: how long the list takes (13,849 songs, read 1,000 at a time; the status line counts), playing a song and seeking, covers, lyrics in Now Playing, casting to the living room TV and the bedroom TV (Google Cast), a favorite, a playlist, a flag, and "Use my music folder" to go back. In this mode Rip a CD, most of Review, tag/artwork/lyrics editing and "Play on the TV" (the TV app) are not offered. Not tried against the real server or in the running program.

**Added 2026-11-23 (D174), committed:** the player bar has its own controls (accent-coloured play button, accent progress bar, times, volume) and songs are read whole into memory, the next two ahead. Try: play a song and drag the bar or click it (no wait); press next (it should start at once; the first song after a jump shows Loading… for a moment); keyboard: Tab to the bar, arrow keys seek; the volume bar and mute button; open the lyrics editor and check its bar looks the same. Check the memory the program uses after an hour of playing (limit 600 MB of songs).

**Added 2026-11-23 (D175), to try:** (a) Review > Audio defects: because the scanner changed, press the scan button to scan the library again (it runs in the background; it can be stopped and continued). The eight silent songs should appear under a card "No sound at all: 8 songs on 2 discs" (Boards of Canada "Magic Window" too: Mark as good); press "Put them in the playlist Needs re-ripping" and "Flag their discs for a re-rip" and look at the playlist and at Review > Missing & copies > To re-rip. (b) Home: press I'm feeling lucky several times; the ending should differ (wiggle, creep, bounce, quick snap).

**Added 2026-11-23 (D177), to try on the real phone (it was tried only on the emulator with a stand-in server):** Settings > Keep music from the server on this phone. Sign in under Jellyfin server first (home Wi-Fi). Choose one small album, press Sync now: it should appear in the library and play with the phone offline. Edit that album's tags on the PC (or replace a song's file), let Jellyfin rescan, Sync now: the song should come down again and keep its heart. Stop keeping it: the songs go. Make a playlist on the phone and on the PC: both appear on the other side (and on the TV). Check the real server's behaviour with a big library (artists list, the first 'whole library' read) and that nothing is taken off when the server is switched off in the middle of a sync.

**Found 2026-11-23: eight songs that are digital silence (nothing to play).** Checked every MP3 in the library (13,849) by decoding three short stretches of each, then every candidate in full. Silent from the first sample to the last, so the audio itself is empty, not a playing fault: **The Unseen, "The Anger And The Truth", tracks 07 to 12** (What Happened-, No Master Race, Never Forget, Where Have You Gone-, Fight For A Better Life, No Evacuation) and **Various Artists, "Punk-O-Rama, Vol. 2", tracks 15 "Don't Have The Cow" and 16 "Give You Nothing"** (the one flagged from the TV). The Punk-O-Rama files are silent in the original 2020 rip too (`D:\Temp-MVS-Library`, 2/16/2020), so the program did not damage them; the Unseen album has no older copy. The fix is to rip those songs again from the discs (tracks 08 and 14 of Punk-O-Rama are not in the library at all, so the disc may have been scratched); Bad Religion's "Give You Nothing" from "Suffer" (`M:\Bad Religion\Suffer\05`) plays fine and is the same song, 2:02 against 2:00. Two other silent finds are meant to be: Boards of Canada "Magic Window" (the silent last track of Geogaddi) and The Misfits "Hidden 2" (5 s of nothing). Four long files (AFI "High School Football Hero", Machines of Loving Grace "Trigger For Happiness", Pennywise "Clear Your Mind", The Hippos "Forget The World") are mostly silence with a hidden song after it, as made. The program has no silent-file check yet: an "audio check" that finds a song with no sound (decode three stretches of each file, as above, about 75 s for the whole library) would be a cheap addition.

**Added 2026-11-23 (D178), to try on the real phone:** with music already on the phone (copied by cable, say), Settings > Keep music from the server on this phone > choose the same artists > Sync now. It should say how many songs "already on the phone" were recognised and kept as they are, and fetch only what is missing; check nothing is downloaded twice (Music/MediaVerse Home should only hold what was new). Songs that differ from the server's copy are listed under "Different from the server": press "Use the server's versions" and allow Android's prompt. Stopping to keep an artist must leave your own files in place.

**Added 2026-11-23 (D180 to D185), to try on the real PC build (installed 17:43):** (1) Settings > Sound > Measure my library (it was interrupted by the reinstall and carries on where it stopped), then listen to a few albums of different ages with levelling on, gentle and off; older, quieter albums should now be lifted more. (2) Gapless and crossfade on a live or mixed album; Auto-DJ. (3) The mini player (button in the player bar) and the media keys. (4) Settings > Organise: pick a naming rule, leave "keep compilations" on, press Preview; the numbers should look sensible before any change is made. Try "Make these changes" on a small copy of a folder first; Undo it once to see it all come back. (5) Library > Playlists > New smart playlist. (6) Settings > Language: British, Canadian, New Zealand, Australian spelling.

**Added 2026-11-23 (D186), to try on the PC (built, not installed):** Settings > Sound > Sound output: tick "Exclusive output (WASAPI)", choose the sound card (or leave Windows' own choice), play a FLAC or MP3 at 44.1 kHz and look at the line under the switch ("Playing exclusively at 44.1 kHz, 16-bit through ... Bit-perfect"). Turn the volume to the top for bit-perfect; with a 24-bit or 88.2/96 kHz file it should say so. Check: pause, seek, next, a live or mixed album joining with no gap, switching the option off in the middle of a song (it should carry on through the normal player), another program playing sound while it is on (the song should play the usual way, with the reason shown), unplugging a USB DAC mid-song. Not tried on a real DAC.

**Added 2026-11-23 (D187), to try on the PC (installed):** Settings > Organise > Preview on the real library: "Songs that cannot be placed" should now list each pair with tags, size, bitrate, length and dates and a Show in folder button for each file (open both, keep the better one, delete or retag the other by hand, preview again). "The same song twice in one folder" should be short now (only true strays).

**Setting up Explorer's columns for M: (by hand, once; D187):** (1) In Explorer right-click your top music folder on M: > Properties > Customize > "Optimize this folder for: Music items" and tick "Also apply this template to all subfolders" > OK. (2) Open an album folder, View > Details, right-click a column header > More..., tick Title, Contributing artists, Album, Year, Track number, Bit rate, Size, Length, Date created, Date modified. (3) Folder Options > View > Apply to Folders > Yes. If M: stays plain after a restart of Explorer, tell Claude: the next step would be to write the view into the registry, which needs a look at the real screen to get right.

**End of day 2026-11-23, what is not done and what to test:**
- *Not done:* ASIO and a resampler for exclusive output; levelling/EQ in exclusive mode; the glow in exclusive mode; podcasts (issue #11 awaits your OK of the design); scrobbling (#12); translations (#22); jump-list pins and a remembered mini-player position; levelling on the phone and TVs; Explorer columns by program (see above).
- *Test (PC):* Settings > Sound > Sound output (exclusive) with the volume at the top, on a FLAC/MP3 and on a hi-res file if you have one; unplug a USB DAC mid-song if you have one. Measure my library (it carries on) and listen to levelling on a few albums. Organise: preview, then "Make these changes" on a small copy first, and Undo once. Gapless on a live album. The mini player and media keys.
- *Test (elsewhere):* the phone's "keep music from the server" (D177/D178) and the TVs with the latest builds (not changed today).
