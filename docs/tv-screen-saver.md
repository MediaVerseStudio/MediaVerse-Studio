# The TV screen saver on Samsung OLED TVs: what we learned (2026-11-03 to 2026-11-06)

**Status: fixed (D70, commit `be178e3`), confirmed by the owner on the bedroom 65" S95F on 2026-11-06.**
Read this before changing anything in `web/app/tv/main.ts` around `keepAwake`, `playMusic`, `startNativeClip`,
`checkNativeClip`, `holdScreenSaver`, or the lyrics/visualizer motion. Decisions: D43, D46, D47, D55, D69, D70 in
`docs/decision-log.md`.

## The short version

- Samsung OLED TVs have **two different screen savers**:
  1. The ordinary TV screen saver (idle timer). Apps control it with `webapis.appcommon.setScreenSaver(OFF/ON)`.
  2. **OLED panel protection**: after about **2 minutes of a still picture** the TV shows its screen saver (and dims
     gradually before that). Samsung: it "cannot be disabled" and "may not activate when viewing Live TV or
     full-screen videos". `setScreenSaver` does **not** affect it, and neither does the Tizen Power API.
- What holds panel protection off is **media playing in Samsung's own player, AVPlay** (`webapis.avplay`).
  Media in the page's own `<audio>`/`<video>` elements does not reliably count: our music plays in `<audio>`, and
  the screen saver came during music whenever the picture was still enough.
- Fix: while music plays, AVPlay loops a silent, black, 4-second clip (`web/app/tv/public/keep-awake.mp4`) under
  the page, where it is never seen. It runs alongside the `<audio>` music and across song changes.

## Symptoms, in order (so the history is not repeated)

| Date | What the owner saw | What we tried | Result |
|---|---|---|---|
| 11-03 | Screen saver 20-30 s into music | AppCommon `setScreenSaver(OFF)`, repeated every 10 s | Accepted by the TV, no effect |
| 11-03 | Owner: YouTube only keeps it away during full-screen video | Silent HTML `<video>` clip looping behind the page (D47) | Seemed to help; really it was the visualizer moving (see below) |
| 11-04 | Clip `loop` ignored; clip never loaded if started while music played | Manual looping; clip started before the music; kept loaded across songs | Still never actually advanced during music (found 11-06) |
| 11-05 | Screen saver ~1 min into songs **with lyrics** | Tizen Power API `request("SCREEN","SCREEN_NORMAL")` (+ `power` privilege) | No effect |
| 11-06 | Same | Moving bars under the lyrics (D69) | Held off (bright, constant motion), but owner wanted the calmer glow |
| 11-06 | Glow instead of bars; synced lyrics | Brighter swaying glow | Held off on synced lyrics (line jumps every few seconds) |
| 11-06 | Screen saver ~2 min into **plain** (unsynced) lyrics | Plain lyrics step a line at a time instead of a 1 px crawl | **Still came** |
| 11-06 | Owner: YouTube with comments/description beside a partial video also gets the screen saver | Research + measuring on the TV (below) | Root cause found; AVPlay clip (D70) **fixed it** |

Lesson: on these TVs, "enough movement on screen" is a fragile, unknowable threshold (frame-to-frame motion
over enough of the screen). Don't rely on picture motion to hold the screen saver off; rely on AVPlay playback.
The app's own OLED care (drift, glow, wall turning, sides changing per song) is for burn-in, not for this.

## What was measured on the TV (2026-11-06, bedroom S95F, Tizen 9, AVPlay 7.0)

Through the Web Inspector (how-to below), with an album playing:

- The HTML keep-awake `<video>`: `paused=false`, `readyState=4`, but `currentTime` **stuck at 0.1 s** for as long
  as the music played. The TV saw no video. The 10-second "stuck clip" restart did not help.
- An AVPlay clip opened from the installed package played and looped next to the `<audio>` music, and kept
  playing across song changes (new `<audio>` `src`).
- **Starting the HTML clip while AVPlay plays pauses/freezes AVPlay.** After that, AVPlay reported `PLAYING` but
  `getCurrentTime()` no longer moved, and `seekTo(0)` did not revive it; only `stop()` + `close()` + `open()` +
  `prepareAsync()` + `play()` did. So the HTML clip must never be started while AVPlay is the keep-awake.
- Paths AVPlay was offered (from `tizen.filesystem.resolve("wgt-package")`):
  - `dir.toURI() + "/keep-awake.mp4"` = `file:///home/owner/apps_rw/MVStudioTV/res/wgt/keep-awake.mp4`: **works**.
  - Relative `keep-awake.mp4`, `file:///keep-awake.mp4` (the page's own `location.href` base): not usable by
    AVPlay (the page's `file:///index.html` is a virtual address). Another app saw `PLAYER_ERROR_INVALID_URI` for
    plain paths.
- Looping: `setListener({ onstreamcompleted })` with `seekTo(0)` then `play()` loops the 4 s clip cleanly.

## How it works now (`web/app/tv/main.ts`, `index.html`, `style.css`)

- `index.html`: `<object id="av-keep-awake" type="application/avplayer">` (AVPlay draws in it) next to the old
  `<video id="keep-awake">` (fallback). Both are `position: fixed`, full screen, `z-index: -1`, under the opaque
  page, so neither is ever visible.
- At start: `tizen.filesystem.resolve("wgt-package", …)` gives the clip's real address (`nativeClipPath`). Needs
  the `filesystem.read` privilege (already in `config.xml`). No extra privilege is needed for AVPlay.
- `keepAwake()` (called on `playing`, on a pause that lasts 3 s, on screen changes, and every 10 s while music
  plays): if AVPlay is usable, `startNativeClip()` while music plays, `stopNativeClip()` when it has stopped.
  `holdScreenSaver()` still calls AppCommon and the Power API too (harmless; AppCommon matters on LCD TVs and for
  store review).
- `startNativeClip()`: `close()` (anything left over), `open(path)`, `setListener` (loop on stream end),
  `setDisplayRect(0, 0, 1920, 1080)`, `prepareAsync()`, then `play()`. States: `off`, `starting`, `on`, `failed`.
  If preparing fails, the state becomes `failed` and the HTML clip is used from then on.
- `checkNativeClip()` (every 10 s while music plays): if the state is not `PLAYING`, or `getCurrentTime()` has
  not changed since the last check, the clip is stopped and started afresh.
- `playMusic()`: with AVPlay usable the music starts at once (the old "start the clip first, then the music" dance
  was only for the HTML clip).
- `visibilitychange`: hidden, the AVPlay clip is stopped (Samsung's players must let go in the background);
  visible again, `keepAwake()` restarts it if music plays.
- Pause: after 3 s of pause the clip is released, so the TV's own screen saver works normally when nothing plays
  (the owner wants that: only music playing holds it off). Short pauses between songs do not release it.

Verified on the TV: plays across song changes (state `PLAYING`, time looping 0-4000 ms, music unaffected), state
`NONE` 5 s after a pause, `PLAYING` again 3 s after pressing play. Owner confirmed the screen saver stays away.

## Rules for future changes

1. **Never start the HTML `<video>` clip while the AVPlay clip runs.** It freezes AVPlay.
2. AVPlay is a single player per app. If music ever moves to AVPlay (an idea in the roadmap: "Samsung's own
   player for the TV's music"), the keep-awake clip must go: the music itself then holds the screen saver off.
   Then also drop `<audio>` features that AVPlay does not have (check seeking, `timeupdate`-style progress, gapless
   changes, the visualizer reading the position, error events).
3. Any new full-screen view that should keep the TV awake (a slideshow, a lyrics-only view, a party mode) must
   go through `keepAwake()`; don't rely on animation.
4. If the screen saver comes back: first measure, don't guess. In the Web Inspector check
   `webapis.avplay.getState()` and `getCurrentTime()` twice a few seconds apart while music plays, and that
   `#keep-awake` has no `src`. A clip stuck in `PLAYING` with a fixed time means something paused it.
5. Other Samsung models and older Tizen: AppCommon can throw on Tizen 5.0 when reading
   `AppCommonScreenSaverState` (seen by another app); the calls are wrapped in try/catch. AVPlay exists on all
   Samsung Tizen TVs; if `webapis.avplay` is missing (an emulator, another platform) the HTML clip is the fallback.
6. The Android TV / Google TV app (later) solves this differently (`FLAG_KEEP_SCREEN_ON` / Media3 with a
   playing session); this note is Samsung-only.

## Testing it

On the TV, with an album whose songs have **plain (unsynced) lyrics** (the stillest picture the app shows):
play for at least 5 minutes without touching the remote. Then pause for more than 2 minutes: the TV's screen
saver should come (proving the hold is released). Also try a synced-lyrics song and a song change.

## Debugging the TV app from this PC (Web Inspector over sdb)

The bedroom TV is in developer mode with this PC's address; the app is signed with the `MediaVerseTV` profile.

```powershell
$sdb = "C:\tizen-studio\tools\sdb.exe"
& $sdb connect <tv-address>
& $sdb -s <tv-address>:26101 shell 0 kill MVStudioTV            # the debug launch needs the app closed
# The debug launch prints "... port: NNNNN" and then does not exit: run it in the background and read its output.
$p = Start-Process $sdb "-s <tv-address>:26101 shell 0 debug MVStudioTV.MediaVerse" -RedirectStandardOutput "$env:TEMP\mv-debug.txt" -NoNewWindow -PassThru
Start-Sleep 20; Get-Content "$env:TEMP\mv-debug.txt"; $p.Kill()
& $sdb -s <tv-address>:26101 forward tcp:9333 tcp:NNNNN
Invoke-WebRequest http://127.0.0.1:9333/json                       # the page's webSocketDebuggerUrl
```

Then either open `chrome://inspect` (add `localhost:9333`) or send Chrome DevTools Protocol
`Runtime.evaluate` messages over the WebSocket from Node (Node 22 has `WebSocket` built in), with
`awaitPromise: true` and `returnByValue: true`, to run code in the running app (click buttons, sample
`webapis.avplay.getState()`, read `#audio.currentTime`). A debug launch restarts the app on the TV.

## Sources

- Samsung: [How Samsung OLED TV displays are protected with Logo Detection and Screen Saver](https://www.samsung.com/uk/support/tv-audio-video/how-samsung-oled-tv-displays-are-protected-with-logo-detection-and-screen-saver/)
  (2 minutes of a still image; cannot be disabled; may not activate during full-screen video).
- Samsung Developers: [Setting Screensaver](https://developer.samsung.com/smarttv/develop/guides/fundamentals/setting-screensaver.html),
  [AppCommon API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/appcommon-api.html).
- tessel-tizen-tv (another open-source Tizen app, same problem during slideshows):
  [issue #126](https://github.com/PatrickSt1991/tessel-tizen-tv/issues/126) (screen saver at exactly 2 minutes despite
  `setScreenSaver(OFF)`), [issue #132](https://github.com/PatrickSt1991/tessel-tizen-tv/issues/132) (tester confirms a
  hidden AVPlay clip fixed it), [PR #129](https://github.com/PatrickSt1991/tessel-tizen-tv/pull/129),
  [PR #133](https://github.com/PatrickSt1991/tessel-tizen-tv/pull/133) (clip path fallbacks).
- immich-tv-for-samsung [PR #16](https://github.com/rfsmason/immich-tv-for-samsung/pull/16) (HTML `<video>` keep-awake,
  unverified on OLED).
- Spotify Community: [Samsung app not keeping the TV awake while playing](https://community.spotify.com/t5/Other-Podcasts-Partners-etc/Samsung-app-not-keeping-the-TV-awake-while-playing/td-p/6360915)
  (Spotify on Samsung OLEDs gets the screen saver after about 2 minutes, even with lyrics showing).
