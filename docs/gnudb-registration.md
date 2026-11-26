# Registering MediaVerse Studio with gnudb

gnudb (the successor to freedb) asks developers of programs that use it to introduce themselves. This
note records what their developer pages say and gives a draft message. It was written from the pages
the owner saved on 2026-10-31 ("How to for application developer" and "CDDB Server protocol, developer
info"); check https://gnudb.org/howto.php for any later change.

## What they ask for

* Email **info@gnudb.org** with the program name, a short description of the program, and a contact
  email address (the address that appears in the program's hello string).
* Every request carries a valid-looking email address in the hello string:
  `hello=emailname+emailhost.com+applicationname+version`. The program lets the user enter their own
  address in Settings (recommended by gnudb). Unregistered programs are accepted as long as the
  address is real, so the program works before registration is complete.
* A clear, descriptive application name (not generic) and a version number. We send
  `MediaVerseStudio` and the program version.
* Use HTTP or HTTPS, not CDDBP. Protocol level 6. Run `cddb query` first and read with the id the
  query returns. Back off on HTTP 429.
* "Fair use": it is a free service run on donations (about one cent per user per month would cover
  the cost, according to their pages).

## Which contact address to use

* **Not your main personal address.** gnudb and MusicBrainz keep it in server logs and use it to reach
  the developer; it is also sent with every lookup.
* **A GitHub repository link works for MusicBrainz only** (it accepts an email address or a web
  address in its User-Agent), and only helps its operators if the page is public. The repository is
  private today, so they could not open it. **gnudb requires an email address**, so a link is not enough
  there.
* **Best: an address on your own domain.** `contact@mediaverse.studio` now exists (the domain's mail records forward it, 2026-11-24) and is the project's contact address for MusicBrainz and the other services, so your personal address stays private. It only receives mail; to *send* the registration from it, use a mail account set up to send as that address, or send it from the project mailbox and say in the message that `contact@mediaverse.studio` is the address to use.

## Draft message (to be sent by the owner, from the address they want gnudb to use)

> Subject: New application registration: MediaVerse Studio
>
> Hello,
>
> I am developing MediaVerse Studio, a free, open-source (GPL-3.0), non-commercial media library and
> CD ripper for Windows (Android planned). When a user rips an audio CD it looks up the disc to fill in
> the album, artist and track names. gnudb is one of several sources it asks, alongside MusicBrainz.
>
> How it uses gnudb: one `cddb query` per disc, then `cddb read` for at most five of the returned
> entries, over HTTPS to gnudb.gnudb.org, protocol level 6, at most one request per second, backing off
> on 429. It never submits data. The hello string is
> `hello=<user's email name>+<user's email host>+MediaVerseStudio+<version>`, using an email address
> the user enters in the program's settings. Server address, port and application name are all
> user-editable.
>
> Application name: MediaVerseStudio, version 0.9.0 (beta).
> Contact: <the address you want gnudb to use>
>
> Thank you for running gnudb.

## Open

* **Granted (2026-11-25): gnudb replied that MediaVerseStudio now has access ("you are all set").** Earlier note, kept for the record: there was no registered version to update. gnudb has no account page for this: registering is one email to info@gnudb.org (the draft above, version 0.9.0). The program already sends its own version in every request, and gnudb accepts unregistered programs whose hello address is real, so nothing is blocked. Send it from the owner's own mail account, giving `contact@mediaverse.studio` as the contact address.
* The code has been tested against local fake servers only. After the contact address is chosen, one
  live query should confirm the parsers against real gnudb replies.
* Submitting corrected entries back to gnudb (`submit.cgi`) is not built and needs the user's own
  email address, per their rules.
