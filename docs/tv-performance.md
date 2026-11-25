# TV app: keeping it light

Owner, 2026-11-05: the TV app should stay smooth on older Samsung TVs and a future Google TV port with weaker
processors, and should not heat the TV when it is left running all day.

## Done

- **First pass (earlier):** visualizer smoothing measured in time, colours blended only while they change, nothing
  set on the whole Now Playing screen each frame, the song analysis in a worker in 10-second slices with rests.
- **Low-power pass (2026-11-05, D66):**
  - The blurred cover behind everything was `filter: blur(60px)` over a 2080 × 1240 image: the costliest thing on
    the screen, and redrawn whenever something above it changed. Now the cover is drawn once into a 32 × 18 canvas
    (`#backdrop-soft`) that the screen stretches: the stretching blurs it, for almost nothing.
  - Visualizer: at most 30 drawings a second (`VIS_FRAME_MS`, was 60). Watch the first-frame case: the first frame
    must count as due (a bug in this pass kept it waiting forever; fixed).
  - Progress bars move by `transform: scaleX()` (graphics chip) instead of `width` (page layout), and the elapsed
    and total times are written only when the shown second changes.
  - Plain lyrics measure their scroll distance once per song, not on every `timeupdate`.

## Ideas not done yet (in order of likely gain)

1. **A "low power" setting** (Settings on the TV): visualizer off or at 15 fps, the cover wall static, no
   animations. Worth it for old TVs and all-day play; let the person choose.
2. **Done (D66):** while the controls are faded (no button pressed for 10 s) the visualizer draws 20 times a
   second (`VIS_IDLE_FRAME_MS`). Could go lower after longer idle.
3. **The cover wall (`#np-wall`, 17 × 10 tiles):** each tile is its own image and fades with an opacity transition;
   the flips use 3D transforms. Smaller tiles (128 px covers are asked for at 256), fewer flips at once, and no
   `perspective` on tiles that are not moving (already so) keep it cheap. Measure on the TV before changing.
4. **Song analysis:** decoding the whole song with `OfflineAudioContext` at 22 050 Hz is a spike at the start of
   each song (in a worker). 11 025 Hz would halve it, but the top bands reach 10 kHz: the analyser would need
   fewer, lower bands. Not worth it unless a weak TV stutters at song changes.
5. **Measure, don't guess:** on the TV, `tizen` debug launch with Web Inspector (Performance tab) while Now
   Playing runs for a minute; compare before and after any change. The capture window (`npx electron
   scripts/capture-tv.cjs <library> <out>`) prints the TV page's errors.

## How to test on the bedroom TV

`C:\tizen-studio\tools\sdb.exe connect <tv-address>`, then
`tools\package-tv.ps1 -CertificateProfile MediaVerseTV -Install <tv-address>`, then
`C:\tizen-studio\tools\ide\bin\tizen.bat run -p MVStudioTV.MediaVerse -t QN65S95FAFXZA`.
Use the bedroom TV, not the living room one (family use).

## Low-memory pass (2026-11-17, D123; not measured on a TV)

- **Song analysis memory:** the analysis kept the decoded song (all channels) and a copy of every channel for the worker, and the worker mixed them into a third array: about 20 to 28 bytes per sample. It now makes one mono copy straight from the decoded buffer and the worker uses it as it is: about 12 bytes per sample (a 3.5-minute song: roughly 93 MB down to 55 MB at the peak). Recordings over 12 minutes are not analysed (a live set decoded would be 250 MB or more).
- **Fewer bars (D121):** 38 instead of 48 for every style; the cap of 30 drawings a second now also applies to the phone.
- **Looked at and left alone:** the cover wall (about 60 tiles of varied size, one 256 px picture each, at most one turn per 5 s, 3D only while turning), the timers (1 s stuck-song check, 2 s remote report, 10 s keep-awake check, 60 s drift), the lyric text shadows (rasterised once per layer; changing them needs a measurement).
- **Still to do, needs a real measurement on the bedroom TV:** the Tizen Web Inspector Performance tab for a minute of Now Playing before and after (`tools\package-tv.ps1`); the optional "low power" setting.
