# Casting plan: TVs and speakers (2026-11-06)

The owner asked whether to add Cast to TV or Speaker alongside playlists, and whether casting to a TV could reuse
the TV app's interface while it is active. This note is the answer and a proposed order. It follows the guiding
document *Playback, Casting, and Platform Architecture* (casting through separate adapters for each provider; no
casting is promised until it has been proven on real hardware).

## 1. Done: "Play on the TV" for TVs with the MediaVerse Studio app (D76)

**This is the "reuse the TV app's interface" route, and it needed no new component.**

- The TV app already obeyed a remote when it was playing a phone's library (D58: `GET /api/remote` long poll,
  `POST /api/remote/state`). It asked the computer the same thing, got a 404, and stopped listening.
- The computer's library share (`electron/library-share.js`) now answers those two requests, only for paired TVs,
  and only on the home network as before.
- The desktop player bar has a TV button. It lists TVs with the app open on this computer's library and offers
  "Play on <TV>". That sends the queue, the song and the position, and pauses the computer.
- While the TV plays, the same button is its remote: pause or play, next, previous, "Bring the music back here"
  (continues on the computer from where the TV is) and "Stop on the TV". Pressing play on the computer also
  takes the music back.
- The TV shows its own Now Playing: the album wall, cover, lyrics, visualizer, cover colours, and the AVPlay
  keep-awake that stops the OLED screen saver. The music streams from the computer as it does when the TV
  browses the library itself.
- Tests: the share's remote is unit tested (`library-share.test.js`). **Not yet tried with a real TV.** It needs
  the PC app restarted. The TV app needs no update for it to work (only a toast now names the computer).

Limits: the app must be open on the TV and connected to this computer, so this is "play there" rather than
casting to any device. Seeking from the computer is not offered yet (the protocol has it; the desktop needs a seek
control for a remote song).

## 2. Done (D77): DLNA / UPnP for TVs and speakers without the app

Built in-house as recommended (`electron/dlna.js`); research on the libraries is in D77. The plan as written:

- **Covers:** Samsung TVs without the app (they are DLNA renderers) and many network speakers and amplifiers
  (Sonos, Denon/Marantz HEOS, Yamaha MusicCast, WiiM, Bluesound, most smart TVs).
- **How:**
  - Find renderers with SSDP (a UDP multicast on the home network).
  - Give the renderer a link to the song on the computer's share.
  - Control it with the standard AVTransport and RenderingControl actions: `SetAVTransportURI` (with DIDL-Lite
    title, artist, album and cover link), `Play`, `Pause`, `Seek`, `GetPositionInfo` (asked every second or two),
    and volume.
  - The next song is sent by the computer when one ends; `SetNextAVTransportURI` gives gapless play where the
    device supports it.
- **Components:** none. It is plain UDP and HTTP/SOAP, written in the Electron main process like the library
  share.
- **Security:**
  - A renderer cannot pair with a code. The song links would carry a random token that is valid only for that
    session's queue, and only on the home network.
  - Turning device discovery on must be a Settings choice: the Cast settings page already says nothing is
    searched for yet.
- **What the screen shows:** a TV renderer shows its own basic player (cover, title, progress), not our wall or
  lyrics. Speakers show what their app shows.
- **Effort:** medium. The proof gate (guiding document) is the S95F in DLNA mode plus one speaker.

## 3. Proposed after: Google Cast (Chromecast, Google TV, Nest speakers)

- Electron has no Cast sender (guiding document). The route is the Cast protocol from Node with a maintained
  open-source library (for example `castv2-client`, MIT licence). **That is a new dependency and needs the
  owner's approval** (licence and provenance check per the third-party guide).
- **With Google's Default Media Receiver:** song, cover, title, progress and controls work with no Google account
  setup.
- **The TV-app look on a Chromecast:** this would need a custom Cast receiver, a web page in the TV app's style
  hosted on the internet. It also needs a one-time Google Cast developer registration, which costs a small fee and
  is tied to a Google account. That is the owner's decision; the TV app's code could largely be reused for it.
- Android: the native Cast SDK through a bridge, later (guiding document).

## 4. Not planned

AirPlay (Apple's own protocol, no open sender from Windows that we could vet), Bluetooth speakers (Windows already
does that as a sound output), and Miracast or screen mirroring (it is not music casting and loses quality).

## Decisions for the owner

1. **Order:** this note suggests DLNA next (no new components; it covers speakers and TVs without the app), then
   Google Cast. Or Google Cast first, if Chromecasts or Nest speakers matter more in the house.
2. **Google Cast:** approve a Cast protocol library when we get there (checked against the third-party guide
   first).
3. **Later, optional:** a Google Cast developer registration for a custom receiver with the TV app's look.
4. **Discovery switch:** confirm that searching the network for devices is something the owner turns on in
   Settings > Cast, and is off until then.

## Google Cast registration (2026-11-06)

- Developer account: the project's own Google account (not the owner's personal one).
- Custom Receiver application **"MediaVerse Studio", Application ID `0E81A85C`** (not secret: every sender
  includes it). Receiver URL `https://mediaverse.studio/cast/receiver.html`, to be published from the website
  repository (GitHub Pages; the domain already serves it over HTTPS). Status: Unpublished, so only registered
  test devices can load it. Guest mode off; Google Cast for audio on (speakers play the music without the
  picture). No Android TV package (Cast Connect) until there is a Google TV app.
- Test device: the owner's basement Google TV (TCL, Android TV 14, Cast firmware 3.72), registered by serial
  number (kept in the owner's private notes, not here). Wireless debugging is paired with the development PC,
  for screenshots and for remote debugging of the receiver page.
