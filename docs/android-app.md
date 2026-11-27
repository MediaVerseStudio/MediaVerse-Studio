# The Android app (phone and Android Auto)

Status: started 2026-11-04 (D57). Runs on an Android 17 emulator (Pixel 9 Pro profile); not yet on the owner's
Pixel 11 Pro or in a car.

## Goals (owner, 2026-11-04)

- A media player for the owner's Pixel 11 Pro, playing music **stored on the phone**, held upright.
- **Android Auto**: the full app when it is the main screen, and just Now Playing in Android Auto's split view.
- **Cast to the TV**, looking and working like the TV app.

## What platforms decide (checked against Google's and Samsung's documentation before building)

- **Android Auto draws media apps itself.** A media app offers its library (a browse tree) and the playing song
  through a media session; Android Auto shows them in Google's own car layouts (lists and grids, its own Now
  Playing). Apps cannot draw their own media screens in the car, so the car cannot look like the TV app. The small
  Now Playing card in Android Auto's split view comes from the same session automatically. What we control: the
  lists (Artists, Albums, Genres, Songs), grid or list style, covers, titles, search and voice ("play AFI on
  MediaVerse"), and later custom buttons (shuffle, repeat, favourite).
- **Samsung's 2025 TVs (Tizen) do not receive Google Cast.** "Cast to the TV" will therefore use our own TV app:
  the phone offers its library over the home network the same way the PC does (the share API on port 47700,
  `web/app/tv/api.ts`), and the TV app plays it, with the phone as the remote. Not built yet.
- **Sideloaded apps in the car:** Android Auto lists only apps from Google Play unless *Unknown sources* is turned on
  in Android Auto's developer settings (Android Auto settings > tap the version ten times > menu > Developer
  settings > Unknown sources). Needed for the owner's car until the app is on Google Play.

## How it is built

- `apps/android`: a Kotlin app (Gradle, Android Gradle Plugin 9.5, compile and target SDK 37, minimum Android 11).
  - `PlaybackService`: AndroidX Media3 `MediaLibraryService` with ExoPlayer. Plays with the screen off, shows the
    notification and lock screen controls, and offers the library to Android Auto (`Browse`): root tabs Artists,
    Albums (grid), Genres, Songs (with Shuffle all). A song chosen in a list plays with the rest of that list. The
    queue, place, shuffle and repeat are remembered (`Resume`) and restored, paused, when the service starts.
  - `Library` (`LocalLibrary.kt`): reads Android's media index (MediaStore) and groups it with the TV app's rules
    (`web/app/tv/library.ts`): an album per folder, artists by each song's artist, genres split on `;` `/` `,`.
  - `ArtProvider`: album covers by song (`content://studio.mediaverse.app.art/track/<id>/<size>`), made from the
    songs' embedded pictures and cached; exported read-only because the notification and Android Auto read covers
    from their own processes. It only ever returns a JPEG.
  - `MainActivity`: a WebView showing the phone's web front end from the app's own files
    (`https://appassets.androidplatform.net/assets/web/`, via AndroidX `WebViewAssetLoader`), with covers and song
    data for the visualizer at `/media/cover/<id>` and `/media/audio/<id>`. One message channel
    (`WebViewCompat.addWebMessageListener`, this origin only) carries the library and player commands; the player
    is a Media3 `MediaController`, so the screen, the notification and the car always agree.
- `web/app/phone`: the phone's screen, sharing the TV app's library grouping, search, visualizer and look.
  Tabs in the TV app's order (Artists, Genres, Albums, Songs, Queue) and a search icon; long lists draw only the
  rows on screen and have an A to Z strip; the same bar at the bottom on every page opens Now Playing (cover,
  visualizer, cover wall behind, shuffle, previous, play, next, repeat, "Next: ..."). In a desktop browser
  (`npm run phone:dev`) a stand-in plays a made-up library silently, for trying the layout.

Why not the Rust core yet: on the phone, Android's media index already reads the tags of every song and keeps them
up to date, quickly and without storage permissions beyond music. The Rust core comes in when the phone needs what
only it does (lyrics lookup, tag repair, the share server for the TV).

## Sharing with the TV app (first step of casting)

Settings > TV > "Share my library with the TV app" (off by default) starts `ShareServer`: the computer's share API
(`web/app/electron/library-share.js`) on the same port, 47700, with the same pairing (a 6-digit code shown on the
phone over any page, 5 minutes, 5 wrong codes lock that address out for 10 minutes, keys kept only as SHA-256
hashes), home network addresses only, read only except favorites (flags answer "not available"; lyrics are empty
for now). The TV app needs no change: it finds the phone when it searches the home network, or by "Type an
address" with the address the phone's Settings shows, and lists it under the phone's model name.

Android 17 asks the person for **local network access** ("nearby devices") before an app may accept connections
from the home network (`ACCESS_LOCAL_NETWORK`, required when targeting SDK 37; see
https://developer.android.com/privacy-and-security/local-network-permission); the app asks when sharing is switched
on. The server runs while the app or the player is running.

Tried on the emulator through `adb forward tcp:47700 tcp:47700`: hello, pairing (wrong code refused, right code
gives a key), library, audio with byte ranges, covers, and the TV app's own client (`web/app/tv/api.ts`) building
the albums. Not yet tried from the real TVs. Next: the phone as the TV's remote ("play this on the TV").

## Build and try it

- One-time tools (installed on the development PC 2026-11-04): Android command-line tools 23.0
  (`%LOCALAPPDATA%\Android\Sdk`, checksum checked against Google's repository), platform-tools, SDK platform 37.0,
  build tools 37.0.0, the emulator, an Android 17 Google Play system image, and the Android Auto Desktop Head Unit
  (`extras\google\auto`). Gradle comes through the wrapper (9.8.2). Java 17 or newer (Java 25 is installed).
- `tools\build-android.ps1` builds the web front end and the app; `-Install` installs it on the connected phone or
  emulator and starts it.
- Emulator: `emulator -avd MediaVerse_Pixel` (Pixel 9 Pro profile, Android 17). Music goes on with
  `adb push <folder> /sdcard/Music/`.
- **On the Pixel 11 Pro:** Settings > About phone > tap Build number seven times; then Settings > System >
  Developer options > USB debugging on. Connect by USB, accept the PC's key on the phone, run
  `tools\build-android.ps1 -Install`. Music: copy album folders into the phone's `Music` folder (File transfer
  over USB); Android indexes them by itself.

## Next

1. Try it on the Pixel 11 Pro and in the car (Desktop Head Unit first).
2. Shuffle and repeat buttons in the notification and in Android Auto (Media3 media button preferences).
3. Favourites and flags on the phone; lyrics (LRCLIB, as on the PC).
4. Casting to the TV app: the share server is built (above); next, the phone as the remote ("play this on the TV").
5. Releases: a signing key kept by the owner (never in the repository), then Google Play (internal testing first).

## Playing on the TV (D58)

With sharing on and the TV app showing the phone's library, Now Playing on the phone shows a TV button. It sends
the queue, from the playing song and place, to the TV and pauses the phone; the phone's screen then shows the
TV's song and controls it (play/pause, next, previous, seek). The TV button again brings the music back: the TV
pauses and the phone carries on from the same song and place. If the TV stops listening (switched off, or back to
the computer's library) the phone says so and takes over. Shuffle and repeat stay with the TV's own remote for now.
Protocol: `GET /api/remote?after=<seq>` (long poll, phone only) and `POST /api/remote/state` (see D58).

## Music from the home server (D177, D178, D207)

Chosen artists, albums or playlists are fetched into the phone's own Music folder (`Music/Artist/Album/`). The app takes
off only songs it created itself (Android records the creating app); songs that were already on the phone are recognised
and never deleted. A phone coming from an earlier version has its songs moved up from `Music/MediaVerse Home` at the
first sync, keeping their identity (hearts, flags, playlists). **Replace phone copies with the library's versions**
(off by default) writes the server's version over copies that differ, after Android's own permission question. A sync
can be run for five minutes' worth or everything; one started by hand keeps the screen on.

## Release build (the `.apk` on the Releases page)

`tools\build-android.ps1 -Release` builds a signed, non-debuggable `app-release.apk` (`apps/android/app/build/outputs/apk/release/`). The signing key is **not** in the repository: the script reads where it is from `%USERPROFILE%\.mediaverse\android-release.properties` (a keystore file, its passwords and the key alias) and passes them to Gradle in environment variables (`MEDIAVERSE_KEYSTORE`, `MEDIAVERSE_KEYSTORE_PASSWORD`, `MEDIAVERSE_KEY_ALIAS`, `MEDIAVERSE_KEY_PASSWORD`); without them the release build is simply unsigned. **Keep that keystore and its passwords backed up**: an app can only be updated in place by a build signed with the same key. The certificate names only the project ("MediaVerse Studio"). This key is for the downloadable `.apk`; Google Play's own upload key (`docs/google-play-beta-testing-guide.md`) is a separate thing, and a phone that has the sideloaded `.apk` must uninstall it before installing the Play version (the signatures differ). A debug build (the default) is signed with Android's generic debug key and cannot be installed over a release one, or the other way round.
