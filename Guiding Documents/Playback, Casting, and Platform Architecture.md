# Playback, Casting, and Platform Architecture

## Product goal

One shared web front end for library browsing and playback, running in Electron on Windows, with a feasible path to Android. The player shows album artwork with readable, scrollable lyrics that follow the music when time-stamped lyrics are available.

"Chromium-based" does not mean every runtime has the same browser APIs, device discovery, DRM, codecs or Cast support. Validate each capability in the packaged runtime.

## Platform priorities (D21)

1. **Windows 11** (primary): library, playback, lyrics, ripping.
2. **Android**: a playback app for music away from home that casts to the TV with artwork and lyrics. Ripping on Android with a USB drive is a far-off wish (ADR 0007).
3. **TV apps** (D36): the player running on Samsung Tizen TVs (a web app, reusing the web front end) and on Google TV (from the Android app), playing from the PC's library over the home network, from a Jellyfin server or from a USB stick. On the owner's own TVs first (developer mode), then a beta, then the official stores (Samsung's TV app store, Google Play for Google TV).
4. **Linux** (roadmap goal, `docs/linux-plan.md`): the Electron shell and the Rust sidecar are portable; an AppImage first.
5. **iOS**: low priority, after Android.

**Distribution goals (owner):** the first public beta (0.9.0, 2026-11-25) is on GitHub with an unsigned Windows installer and an Android `.apk`; next come signed Windows installers (SignPath Foundation), then the Microsoft Store (MSIX), Google Play (after the closed test Google requires: at least 12 testers for 14 days) and Samsung's TV app store. The order and the beta plan are in `docs/beta-testing.md`; each store has its own review, so every platform is proven on real devices before it is listed as supported.

## Windows desktop

- The shell is **Electron** with secure defaults (context isolation, sandboxed renderer, no Node in the renderer, an allowlisted IPC bridge; ADR 0002). The Rust core runs as a sidecar process (ADR 0003).
- Electron bundles its own Chromium, so the UI does not depend on the system WebView. The cost is a larger download (the installer is about 160 MB).
- Packaging: `tools/package-windows.ps1` and `tools/make-installer.ps1` (`docs/installer.md`). Proven on the development PC and on a clean Windows 11 virtual machine (2026-11-24).

## Android

- Electron has no Android version, so Android has its own shell around the same web UI (a native app hosting Android WebView). Pin and test a minimum WebView version.
- **Chosen (D57, `docs/android-app.md`):** a native Kotlin app with AndroidX Media3 for playback, the media session and Android Auto, hosting the web front end (`web/app/phone`) in a WebView. Android Auto draws media apps' screens itself from the browse tree and session; custom car screens are not possible for media apps.
- The Rust core (library, tags, lyrics, metadata) is portable and should be reused; the sidecar's JSON-lines protocol or an in-process binding can carry it.
- The Google Cast Web Sender SDK must not be assumed to work in Android WebView. If Cast is needed, use the official native Android Cast SDK through a platform bridge.
- CD ripping is not part of the Android baseline.
- **Music kept from the home server (D177, owner 2026-11-23):** like a cloud-storage app that syncs chosen folders, the phone can keep the artists, albums and playlists the person chooses from their Jellyfin server in `Music/MediaVerse Home`, fetched when the phone is on the home Wi-Fi (`HomeSync.kt`, `phone/home-sync.ts`). Playback is always from the phone's own files; edits made on the server come down at the next sync, songs no longer chosen go, and playlists and flags are kept in step both ways. Only home-network addresses, nothing through any outside service; a safety stop keeps songs if the server suddenly looks empty. Not built: syncing with the app closed, choosing single songs or server folders, a storage budget.

## Casting is provider-specific

Implement casting through provider adapters, not one generic "Chromium cast" assumption. Built on Windows (2026-11-06, D76-D80; plan and research in `docs/casting-plan.md`), all written in the project with Node's own networking and no outside components:

- **TVs running the MediaVerse app (D76):** the library share answers the TV app's remote; the TV plays the queue with its own Now Playing.
- **DLNA / UPnP renderers (D77):** `electron/dlna.js` (SSDP, device description, AVTransport SOAP).
- **Google Cast (D80):** `electron/googlecast.js` (mDNS discovery, the CastMessage protocol over TLS), playing through Google's Default Media Receiver.
- Media reaches devices through the library share's `/cast/<token>/…` links (a random token per session, home network only, library files only). Searching the network is off until the user turns it on (Settings > Cast). The desktop sends one song at a time and moves on when a song ends; the player bar's TV button is the remote.

### Jellyfin as a library source and a hub (D96, D170, D173)

- The Jellyfin client is written in the project (`web/app/phone/jellyfin-phone.ts` is shared by the phone, the PC and the TV): Quick Connect sign-in, songs, playlists, lyrics and pictures over the server's HTTP API, only at home-network addresses.
- **Server alone as the PC library (D173):** songs are named `jellyfin:<album id>/<song id>` so every list that groups by folder groups by album; the player fetches `/Audio/<id>/stream` through the Electron main process (`electron/jellyfin-stream.js`, byte ranges forwarded, the token kept in main-process memory), and casts hand a device a link to the server (with the token in it, as Jellyfin's own casting does). What needs a file is not offered in this mode.
- **Shared flags and playlists:** see the Project Brief; the PC merges three ways (`playlist-sync.ts`) so an addition or a removal on any device survives.

### Google Cast

- Electron does not include Google's Cast sender, and Chrome-extension APIs or `navigator.presentation` workarounds are not used. **Changed (D80):** on Windows the project speaks the Cast protocol itself (as widely used open-source clients do) rather than through an SDK, because no official sender exists for Electron or Node. On Android, use the official native Cast SDK.
- Custom receiver: "MediaVerse Studio", App ID `0E81A85C`, page at `https://mediaverse.studio/cast/receiver.html` (registered 2026-11-06; unpublished until tested on the registered Den TV).
- Confirm device discovery, session lifecycle, media formats and local-network permission behaviour in the shipped Windows and Android apps.
- A TV cannot read the sender's files directly; the library share serves them (above).
- Test play, pause, seeking, track changes, artwork and metadata, and disconnect and reconnect on real receivers.

### Tizen / Samsung televisions

- Do not assume every Tizen TV supports Google Cast. The owner's 2025 S95Fs answer both Google Cast and DLNA (found 2026-11-06); a Samsung with the MediaVerse TV app is best served by the app itself (D76).
- Treat discovery, control, codecs and media delivery as separate requirements. Check current Samsung documentation, model and firmware coverage, and SDK terms first.
- If a TV cannot receive the chosen protocol, say so instead of listing it as a destination.

## Playback architecture

Built today (D20 to D28, D174): an HTML audio element plays library files, read **whole into memory** before they play and the next two songs ahead, so seeking and skipping never wait on a disk, a share or a server; a play queue with shuffle, repeat and remembered position; the player bar with its own controls (accent-coloured play button, accent progress bar, volume); the full-screen Now Playing view with a cover wall, queue and lyrics tabs. **Gapless playback, crossfade, a ten-band equalizer and album-wise volume levelling** (D180, D188) run through one continuous audio graph in which each song is a scheduled source; **exclusive (WASAPI) output** (D186) is an optional switch that sends FLAC, MP3 and WAV straight to the sound card and bypasses those effects (`docs/playback-engine-plan.md`).

- Keep a common playback model (current track, queue, position, duration, transport state) separate from the local audio engine and future cast sessions.
- Model local and remote playback as explicit output targets; never leave two playing by accident.
- The lyrics view consumes time-stamped lines and the playback position through a stable interface, not a particular player API.
- Validate file access before playback or transfer. Handle unsupported codecs, missing files, network loss and device disconnects explicitly.
- Do not send local file paths or audio to a remote service without user action and clear disclosure.

### Visualization (built, inspired by Winamp)

An optional visualizer in Now Playing, using the Web Audio API's `AnalyserNode` on the local audio element (frequency and waveform data, no audio leaves the computer). It is decoration: it must not hide the lyrics, must respect a reduced-motion setting, and must be switchable off. When casting, it can only run locally, because the TV receives the audio stream, not the analysis. Any open-source visualization engine (for example a MilkDrop-style renderer) goes through the third-party review first.

## Proof gates before promising casting

1. Cast a locally stored track from the packaged Windows app to a Google Cast receiver, with metadata and seeking. *Partly proven 2026-11-06:* a library song played on a TCL Google TV (Android TV 14) with pause and stop; seeking, track changes and the packaged app still to try.
2. Repeat from the chosen Android runtime; if WebView cannot use the sender API, test a native Cast bridge.
3. Test the intended Samsung/Tizen models and find out whether they receive through Cast, a vendor API or another protocol.
4. Document supported device, OS and firmware combinations and the failure behaviour.

A test in desktop Chrome is not proof that the packaged app can cast.

## References

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Web Audio API AnalyserNode: https://developer.mozilla.org/docs/Web/API/AnalyserNode
- Google Cast developer documentation: https://developers.google.com/cast/docs/overview
- Android WebView overview: https://developer.chrome.com/docs/webview/
- Samsung TV/Tizen developer portal: https://developer.samsung.com/smarttv

Review current platform documentation before implementing; behaviour and TV firmware coverage change.
