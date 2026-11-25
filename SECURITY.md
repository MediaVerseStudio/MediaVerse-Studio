# Security policy

MediaVerse Studio is a desktop, phone and TV application that runs on your own devices and talks to your own network. It has no accounts and no servers of its own.

## Reporting a vulnerability

Please report it privately through GitHub: on the repository's **Security** tab choose **Report a vulnerability**, and describe what you found and how to reproduce it. If you cannot use GitHub, write to **contact@mediaverse.studio** with "Security" in the subject. Please do not open a public issue for a vulnerability.
You will get an answer, and a fix or a plain explanation, as quickly as a one-person spare-time project can manage. Reports are credited if you wish.

## What matters most here

- The Electron shell exposes an allowlisted bridge to the page; anything that lets web content reach files, commands or the network beyond that is in scope.
- The library share, the pairing code and the cast links are meant to work only on the home network; anything that lets another network, or an unpaired device, read the library is in scope.
- The Jellyfin sign-in token is kept on your device; anything that leaks it beyond the cast links described in the privacy page is in scope.
- Files outside the music library must never be read, played or changed through the program.

Supported versions: the latest release and the current beta.
