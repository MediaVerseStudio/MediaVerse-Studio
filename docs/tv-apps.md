# TV apps: MediaVerse Studio on the TV itself (idea, 2026-11-03)

Status: on the roadmap (owner decision 2026-11-03, D36): first the player on the owner's own two S95F TVs in developer mode, then the Samsung (Tizen) store and Google Play. Nothing built or researched yet. Everything below marked *to check* must
be confirmed against current Samsung and Google developer documentation and tested on the real TVs before it
is planned in detail (AGENTS.md: no capability claimed from guesswork).

## The goal (owner)

Play the music library through the TVs to the hi-fi system. Casting from the PC or the family's Android
phones and tablets stays the main route (playback guide). New: **an app on the TV itself** that plays from a
**network location** (the PC's library) or a **USB stick**, ideally downloadable from the **official stores**
(Google TV / Google Play, and Samsung's Tizen store). At the very least, the owner wants to load it onto his
own TVs and does not mind changing TV settings to do so.

## The TVs

Two Samsung S95F OLEDs (2025 models), Tizen, software version T-RSMFAKUC-0090-1301.0 on both:
- 65-inch, model QN65S95FAFXZA
- 77-inch "Living room tv", model QN77S95FAFXZA

(Serial numbers, MAC addresses and device IDs from the About TV screens are deliberately not recorded here.)

## Why it fits the project

The player is already a web front end. Samsung TV apps are web apps (HTML, CSS, JavaScript, packaged as a
`.wgt`), so much of the page could be reused; an Android TV / Google TV app would come from the planned Android
playback app (D21). The Rust core does not run on the TV; the TV app would be a player and browser only.

## Routes, roughly in order of effort (*to check*)

1. **What the TVs already do:** Samsung TVs can usually play music from a USB stick and from a DLNA/UPnP
   media server on the home network. If MediaVerse Studio on the PC offered its library as a DLNA server (or a
   simple local web address), the TVs might play it with no TV app at all. Cheapest test.
2. **Our app on our own TVs (developer mode):** retail Samsung TVs have a developer mode (Apps panel, a code
   on the remote, then the PC's address) that lets Tizen Studio or the Tizen command-line tools install a
   signed `.wgt` built from our web page. Needs a Samsung developer certificate (free). *To check:* that the
   2025 S95F still allows it, how long a developer install lasts, and what the TV's web runtime supports
   (audio formats, USB file access through the Tizen filesystem API, local-network requests).
3. **The stores:** Samsung's Seller Office (Tizen store) and Google Play (Google TV) each have their own
   developer accounts, review, content and privacy rules, and TV design rules (remote-control navigation, no
   mouse). *To check:* costs, whether a free non-commercial GPL app is accepted, and whether the app may reach
   a PC on the home network.

## Developer mode research (2026-11-03)

Checked against Samsung's developer documentation; community reports marked as such. Not yet tried on the TVs.

**Platform (official):** 2025 Samsung TVs run Tizen 9.0 with a Chromium M120 web engine
([web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
Our page targets current Chromium, so M120 should be close; anything newer than M120 must be avoided or polyfilled.

**Audio (official):** Samsung's [media specifications](https://developer.samsung.com/smarttv/develop/specifications/media-specifications.html)
list MP3 and FLAC music files with no limitations; WMA is dropped from 2025 models. Sample rate and bit depth
limits are not stated, and whether the app's HTML `<audio>` element plays FLAC (not just the TV's own media
player) must be tested on the TV.

**Enabling developer mode (official,
[TV Device guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)):**
1. Update the TV's firmware first; PC and TV on the same network.
2. Smart Hub → Apps → App Settings; type `12345` on the remote (or the on-screen keypad: remotes without
   number keys use the `123` button). A Developer mode popup appears.
3. Developer mode **On**, enter the PC's local IPv4 address, OK.
4. Restart the TV (community advice: unplug for 10-15 seconds if the PC still cannot connect). "Develop Mode"
   then shows at the top of the Apps panel.

Community-reported quirks: some TVs store the host address reversed (enter `192.168.1.2` as `2.1.168.192` if
the connection fails); one 2025 owner could not connect until a Samsung firmware update for 2025 models fixed it;
developer mode may switch off after a firmware update. The developer-mode setting holds a single PC address, so
the PC needs a fixed address (DHCP reservation) as well as the TVs.

**Signing (official,
[creating certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html)):**
an app installed on a retail TV must be signed with a **Samsung** certificate profile: an author certificate
(made with a free Samsung Developers account) plus a Samsung distributor certificate listing each TV's DUID
(Menu → Support → Contact Samsung → Unique Device ID, or added automatically when the TV is connected in Device
Manager). A Tizen (non-Samsung) distributor certificate in the same profile can make installs fail. Updates must
be signed with the **same author certificate**, so its `author.p12` and password must be backed up; losing it
means uninstalling and reinstalling. Certificates expire (renewal needed; exact periods not documented on the
page). Install over USB is no longer supported; installs go over the network.

**Tools (official, to approve before installing):** Samsung's Tizen Studio (Device Manager, Certificate Manager,
the `sdb` and `tizen` command-line tools) or Samsung's
[Tizen TV extension for VS Code](https://github.com/Samsung/vscode-extension-tizentv) (`tizensdk.tizentv`),
which packages, signs and launches `.wgt` apps. Build-time tools only; nothing from them ships in our app, but
their licences must still be recorded (provenance) before use. Command-line flow once set up:
`tizen package -t wgt -s <profile>` then `sdb connect <tv-ip>` and `tizen install -n <app>.wgt -t <tv>`.

**App manifest (community, to confirm in Samsung docs):** reaching the PC's library over the network needs the
`http://tizen.org/privilege/internet` privilege and an `<access origin=...>` rule in `config.xml`; the PC's
server must also send CORS headers for the app's origin.

**Still open:** how long a developer install lasts (community reports differ), whether the app survives TV
restarts and firmware updates, `<audio>` FLAC and high-resolution playback, USB file access from a web app on
Tizen 9, and Samsung Developers account terms for a free GPL app.

## The TV app (D38, built 2026-11-03, not yet on a TV)

> **Screen saver on Samsung OLED TVs:** see [tv-screen-saver.md](tv-screen-saver.md) before touching the keep-awake
> code. Short version: only playback in Samsung's AVPlay holds off the OLED panel's 2-minute still-picture screen
> saver; the TV app loops a hidden black clip through AVPlay while music plays (D70). With lyrics, the layout is
> a small corner cover, two-line details and the lyrics across the screen (D69).


- **On the computer:** Settings > TV > "Share my library with the TV app". Off by default; home network only;
  read only. Lists paired TVs (each can be removed).
- **Finding and pairing (D39):** the TV asks every address on its own /24 home network (its address comes from
  Samsung's `webapis.network.getIp()`, privilege `network.public`) for MediaVerse Studio on port 47700, about 9
  seconds in all, and lists the computers that answer. Choosing one makes the computer show a one-time 6-digit
  code (5 minutes) over whatever page is open; typing it on the TV earns a 64-hex-digit key, of which the computer
  keeps only a hash. 5 wrong codes lock that address out for 10 minutes. "Type an address" remains as a fallback.
  Since D91 the TV also asks its network mask (`webapis.network.getSubnetMask()`, same privilege): on a wider
  network (mesh systems: 255.255.252.0) it searches its own 254 addresses first, then the rest, four blocks at
  most (about half a minute in all). Not yet tried on a TV.
  Next sources to look at: USB drives (Tizen filesystem API) and DLNA servers on a NAS, both to be tried on the TV.
- **Tried on the 65" S95F (2026-11-03, Tizen 9.0, Chromium 120):** installs and runs from `tools\package-tv.ps1`
  (the package file name must not contain a space). `webapis.network.getIp()` gives the TV's address. `canPlayType`
  says "probably" for MP3, FLAC, Opus and AAC. A Web Audio analyser on the `<audio>` element hears only silence
  (the TV plays it through its own media pipeline), but `decodeAudioData` works (a 2.5-minute MP3 in 1.3 s), so
  the visualizer analyses each song when it starts (`tv/spectrum.ts`) and draws in step with playback, at 60 frames
  a second on the TV. `tizen.filesystem.listStorages()` works with the `filesystem.read` and `externalstorage`
  privileges (internal storages only listed; no USB drive was plugged in yet). With a test build that could also write, a song saved in the app's own folder could be listed (`listDirectory`, `isDirectory`), read (`openFile(...).readData`, a 6 MB file in 0.7 s), fetched from its `file://` address (so the visualizer works) and played by `<audio>`; a USB drive should work the same way once it shows as an EXTERNAL storage, still to be tried. `sdb push` cannot write to the TV's Music folder, and sdb fails on file names with spaces. Debugging: `sdb shell 0 debug
  MVStudioTV.MediaVerse` prints an inspector port to forward with `sdb forward`.
- **Now Playing (owner's design, D40):** the visualizer in the middle; the cover (460 px) and the song details
  (title, artist, album, year) either side, changing sides with each new song (never mid-song since D69); behind them a
  dark wall of album covers (small copies the computer shrinks with Electron's own image code), one tile slowly
  turning over to another album every few seconds. Lyrics, when a song has them, show over the dimmed visualizer.
- **Build:** `npm run tv:build` in `web/app` (output `web/app/dist-tv`). Try it on the PC in a 1920 x 1080
  window: `npx electron scripts/capture-tv.cjs <library> <output-dir>` (arrows, Enter, Escape stand in for the
  remote).
- **Package and install:** `tools\package-tv.ps1 -CertificateProfile <name> -Install <tv-address>` (Samsung
  certificate profile from Certificate Manager; TV in developer mode).
- **Remote:** arrows move, OK selects, Return goes back (twice at the top to leave), play/pause and skip keys
  work anywhere, the channel rocker pages through long lists, number buttons type the address and code.

## Changing the TV's own software (bloatware, autoplay, tracking)

Replacing or rooting Tizen on a 2025 Samsung TV is not a realistic route: the TVs use secure boot and signed
firmware, there is no supported way to change the system, and an attempt risks the TV and its security
updates. It is not something this project would build or recommend. What does work, while keeping updates:
- **Settings:** switch off Viewing Information Services (automatic content recognition), interest-based ads,
  voice and marketing agreements in the privacy / Terms and Policies settings; switch off Smart Hub autorun and
  "autorun last app", and Samsung TV Plus autoplay. Remove pre-installed apps where the TV allows it.
- **Network:** block Samsung's advertising and tracking addresses at the router or with a network-wide blocker
  (for example Pi-hole), while leaving the firmware update addresses open; or keep the TVs off the internet
  and install firmware updates by USB from samsung.com.
*To check:* the exact menu names on these models and current, published lists of addresses to block without
breaking updates. A short how-to can be written once checked.
