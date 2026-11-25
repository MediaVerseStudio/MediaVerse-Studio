# MediaVerse Studio - Project Brief

## Purpose

MediaVerse Studio is a free, open-source music library and player (GPL-3.0-or-later, D79/D81). It stays free: no paid features, adverts, accounts or tracking, and every copy or changed version must stay free with its source. The project is supported only by voluntary donations; the name and logo are protected separately (`TRADEMARKS.md`). It rips CDs accurately, helps people correct incomplete or inaccurate metadata, finds and manages lyrics, and plays music with album artwork and lyrics shown together.

Windows desktop is the first and primary platform (D21). A Samsung TV app (Tizen) and an Android playback app (with Android Auto) are built (D36-D58) and are being tried on real devices. **Where it is (2026-11-25):** the first public beta, 0.9.0, is on GitHub (a Windows installer and an Android app; the TV app is built, but reaches other people through Samsung's store beta). **Goals (owner):** learn from the beta and then release the apps in the stores people look in: the **Microsoft Store**, **Google Play** and **Samsung's TV app store**; add a **Google TV** app (from the Android app) and **Linux** builds; and keep the project free, open source and respectful of people's privacy by design. The roadmap, the beta plan and the go-public checklist are `docs/roadmap.md` and `docs/beta-testing.md`; the website (`mediaverse.studio`, its own repository) carries the public invitation and must stay honest about what is working, new, in testing and planned. iOS is a low-priority later path. The platforms share product concepts, the Rust core and as much web UI as is practical, without assuming desktop hardware or APIs exist on mobile.

## Product capabilities

### Music library

- Import existing supported audio files without moving them unless the user chooses to.
- Scan and display the library by artist, album and song.
- Read and edit tags and artwork; apply album-level edits to selected tracks with a preview (batch editing, D30).
- Find likely metadata matches using existing tags, track names, folder context, DiscIDs for CDs, and audio fingerprints for files.
- Present ambiguous matches for user confirmation. Do not silently replace a plausible existing identity.
- Support playlists (D74: kept by the program, made and arranged on the PC, shared as XSPF/M3U8 files and imported by artist and title so they work in any library, D78), a reorderable play queue with Play next / Add to queue, and remembered queue and current-track state.
- Keep an optional listening history (D26): on until switched off in Settings, kept only on the user's own device, never sent anywhere, and clearable.
- Help the user review the library: flagged tracks, missing or uncertain metadata, missing artwork, missing lyrics, and audio defects (D24, D25, D30).

### Lyrics and playback

- Look for embedded lyrics first, then a `.lrc` file beside the song, then offer online lookup (D5, D28).
- LRCLIB is the online lyrics source (D29). Other sources are optional, and websites are never scraped without a separate product, policy and legal review.
- Show artwork and lyrics during playback. Support plain and time-stamped lyrics, manual edits, and timing adjustments where the format permits them.
- Save lyric and tag changes only after user confirmation.
- Optional audio visualization while music plays, inspired by Winamp (see the Feature Roadmap). It is decoration and never replaces the artwork and lyrics view.

### CD ripping

- CD ripping is a Windows desktop feature (D21). Keep doors open for ripping on Android later, as long as that never harms the Windows version.
- Extract verified, accurate PCM before any encoding. See `Windows CD Ripping and MP3 Policy.md`.
- Retrieve CD metadata through supported online services (MusicBrainz, gnudb), but keep ripping usable when lookup fails.

### Jellyfin (D90, D96, D170, D173)

- A Jellyfin media server the person runs is a first-class partner, never a requirement. Every device (PC, phone, TV) signs in with Quick Connect and talks only to a home-network address; the client is written in the project (no Jellyfin code or binary is bundled).
- **The server as the shared hub:** flagged songs (the "Problem tracks" playlist and per-device "Problem Playlist" inboxes) and playlists are kept in step between devices through the server, so a flag made on a TV or phone shows on the PC's Review page. The PC's own lists are the fallback when there is no server.
- **Two ways to use a server on the PC:** the music folder can be the server's shared folder (ripping and every edit work; the program can ask Jellyfin to rescan), or the **server alone** is the library (play and cast only: Jellyfin does not let other programs change its files, so ripping and editing are not offered). The TV app can also play from the server.
- **On the phone** the person can choose artists, albums or playlists to keep from the server (D177): they are fetched into the phone's Music folder on the home Wi-Fi and played from there; edits made on the server come down, songs no longer chosen are taken off, and playlists and flags are kept in step both ways.
- Never send the sign-in anywhere but the server, and to a cast device on the home network (as Jellyfin's own casting does); say so in the privacy page.

### Casting

- Provide a shared playback and casting experience where supported, with each kind of device its own integration. Built (D76-D80, written in-house, no outside components): "Play on the TV" for TVs running the MediaVerse app (the TV shows its own Now Playing); DLNA renderers; and Google Cast through Google's Default Media Receiver. Next: the MediaVerse custom Cast receiver (App ID 0E81A85C) for the TV app's look on Chromecasts and Google TVs.
- Searching the home network for devices happens only after the user turns it on (Settings > Cast); devices are reached only at home-network addresses.
- See `Playback, Casting, and Platform Architecture.md`. Device discovery and playback must be proven on real target devices before being shown as supported.

## Application boundaries

Keep the application organized around replaceable interfaces:

- **Library service:** file discovery, indexing, user-approved organization and search.
- **Metadata service:** tag read/write, artwork handling, fingerprinting and provider matching.
- **Lyrics service:** embedded and local lookup, LRCLIB requests, editing, timing and tag persistence.
- **Playback service:** supported formats, queue, playback position and media state.
- **CD service:** drive enumeration, TOC reading, secure extraction, verification and rip jobs. This is a standalone module (ADR 0007).
- **Encoding service:** explicit encoder settings, including the LAME presets defined in the ripping policy.
- **Casting service:** provider-specific discovery, session setup, media loading, state and errors.
- **Persistence service:** SQLite library data and small JSON files for settings, history, flags and pins, all kept apart from the user's audio files.

Keep platform-dependent implementations behind typed Rust traits or equally narrow interfaces. The UI uses stable application commands and events; it never calls C libraries, DLL functions or platform SDKs directly.

### Shell, sidecar and workspace

- The desktop shell is **Electron** (D1). The web UI talks to the Rust core through a versioned JSON-lines **sidecar** process (ADR 0003). The shell is a thin bridge and does not expose native handles, database records or provider types to the UI.
- Native CD code runs in its own **CD helper** process (ADR 0004, ADR 0007), so a drive problem cannot take down the UI or the library.
- `domain` holds stable IDs, entities, value types and errors, with no dependency on SQLite, HTTP clients, file paths, native libraries or provider SDKs. `application` holds use cases and port traits. Adapters implement the ports. Layout and rules: `docs/architecture/0001-modular-rust-workspace.md`.

### Background jobs

Scans, fingerprinting, metadata lookup, tag writes, ripping, encoding, defect scans and network operations are jobs with a stable ID, lifecycle state, progress, cancellation, result and structured error. Adapters do the work; the sidecar coordinates it and emits progress events. Keep all of it off the UI thread, and make cancellation cooperative so an interrupted operation leaves files and stored state recoverable.

## Data and file-safety principles

- Treat the user's existing audio files as authoritative until they approve a change.
- Do not make a database row the only copy of user-authored metadata, artwork or lyrics. When writing to a file, report failures and keep enough context to recover.
- Keep an online provider's match result separate from a confirmed library edit.
- Use stable internal IDs for library entities; paths and tag values can change.
- Do not upload audio or send file paths to providers unless a clearly described feature requires it and the user acts. Online lookups send only what is needed (a disc's table of contents; a song's title, artist, album and length for lyrics). Listening history stays on the user's device.

## Status and order of work

Built so far (details in `docs/decision-log.md` and `docs/next-steps.md`): the Electron shell and Rust sidecar; drive calibration; secure ripping verified with AccurateRip; optional FLAC archive; LAME MP3 copies with ID3v2.3 tags, cover art and lyrics; MusicBrainz, gnudb and Discogs lookup; Fix tags with undo; automatic covers and lyrics with review of likely matches; the library in the Windows Media Player layout with search across artists, albums and songs, playlists and queue building; Now Playing with a cover wall, cover colours and time-stamped lyrics; the Review page with a defect scan; Home with history and pins; the Samsung TV app; the Android app (emulator-tested); casting (TV app, DLNA, Google Cast); a single-file test installer; CI on GitHub Actions.

Since 2026-11-06 also built (to 2026-11-23): the Jellyfin integration above, a lyrics editor with playback and AI-assisted timing (D172), the player bar's own controls with songs held whole in memory (D174), silent-song detection and a re-rip list in the defect scan (D175), AcoustID fingerprints and ids, Review pages for artwork, lyrics, album ids, artists and the audio check, TV sharing with pairing, and the **Lyric AI** (D127 to D142): it finds, checks and times lyrics by listening with ONNX models (a music-lyrics reader, Whisper for drafts) that are separate, optional downloads, and a person confirms what is not certain.

Since 2026-11-23 also built (to the 0.9.0 beta, 2026-11-25): gapless playback, crossfade and a ten-band equalizer (D180); album-wise volume levelling that never turns anything down (D188), which can be written into the files as ReplayGain tags with an undo; optional exclusive (WASAPI) output (D186); a mini player, media keys and taskbar buttons (D181, D190); rule-based playlists and an Auto-DJ (D183); the library organiser with naming standards, compilations and conflict comparison (D182 to D187); a much quicker start (D192); queue memory on the TV and phone apps (D193, D194); retries when MusicBrainz or the Cover Art Archive is busy (D198); and the version number 0.9.0 (D196). Going public with a fresh history is D200.

The ripper was built before the library because it was the riskiest unknown. The current order of work, the testing plan and the plan for going public are in `docs/roadmap.md` (2026-11-19).

## Background documents

The original Word documents in this folder are background on the product vision, database ideas, metadata matching, lyrics, DiscID, ripping and UI references. Specific libraries, service policies and technical suggestions in them are unverified until checked against current primary documentation; several (CDRip.dll, fre:ac components, Tauri) have since been rejected. Never copy API credentials from those documents into source control.
