# Beta testing plan (written 2026-11-23)

The goal: a public release of MediaVerse Studio on **Windows, Android and Samsung TVs**, then **Google TV and Linux**, listed in the **Microsoft Store, Google Play and Samsung's TV app store** as well as
downloadable here. Testers are how the project gets there: Google Play will not publish a new developer's app to everyone until a closed test has run, and every store has a review that is easier to
pass with an app that other people have already used. The website (`mediaverse.studio`, its own repository) carries the public invitation; this file is the plan behind it.

## What a tester does

Installs a build, uses it the way they normally listen, and says what happened, good or bad. No scripts, no tick lists, nothing collected from their computer. A few minutes a week is plenty.

## The three beta tracks

| Track | Who | How they get it | What it proves |
|---|---|---|---|
| **Windows 11** | Friends, family, then volunteers from the website | The Setup program (`MediaVerse-Studio-Setup.exe`) with its SHA-256 file; unsigned until SignPath accepts the project, so Windows shows "More info, then Run anyway" and the tester is told so first | A clean install, a library that is not the owner's, ripping on other drives (the drive check), the review pages, the Lyric AI on other computers |
| **Android** | At least **15 to 20** people (Google needs 12 who stay opted in for 14 days; keep a margin) | A **closed test** on Google Play with a Google Group as the tester list; each tester opts in with the link and installs from the Play Store | The record Google asks for before production access (`docs/google-play-beta-testing-guide.md`), Android Auto, casting |
| **Samsung TV** | A handful of people who own a Samsung Tizen TV | The `.wgt` installed in Developer Mode with a Samsung certificate, by the owner's script (`tools/package-tv.ps1`), with a helper; later Samsung's own beta channel in the Seller Office | That the app runs on other models and firmware before it is submitted for review |

Google TV / Chromecast owners are asked to try Google Cast from the PC and the phone (the MediaVerse receiver page), and later the Google TV app. Linux friends are asked to say hello now and test the AppImage when it exists.

## Order of work to open the beta

1. **Make the repository public** (`docs/roadmap.md` section 3, "go-live day"), so the website can link to the source and an issue tracker exists.
2. **Apply to the SignPath Foundation** (free signing for open source; needs the public repository). Until it is accepted the Windows installer is unsigned.
3. **Cut a first beta version number** (`0.9.0`, owner's decision, `docs/release-checklist.md` item 1) and the two Windows downloads (with and without the Lyric AI model), each with a SHA-256 file, on the repository's Releases page.
4. **Open the Windows beta** to the first ten people from the website's list and the owner's friends.
5. **Google Play closed test** (the guide above): developer account, signed `.aab`, store listing, privacy page (already on the website), app content forms, tester Google Group, the 14-day clock.
6. **Microsoft Store** as a second Windows channel: an MSIX package (to be proven to carry the sidecar and the CD helper, and raw CD access), free re-signing by Microsoft, no SmartScreen warning (`docs/distribution-plan.md`).
7. **Samsung TV store**: Seller Office account, certification of the `.wgt` (screenshots, privacy page, test accounts, the Jellyfin and PC-library sources explained), then the store listing.
8. **Google TV app** from the Android app (a leanback layout and remote focus), then its own Play listing.
9. **Linux AppImage**, with CI on Linux first (`docs/linux-plan.md`).

## Feedback and records

- One feedback route for testers: e-mail `contact@mediaverse.studio` at first, then GitHub issues with the **Beta feedback** template once the repository is public. Never publish a tester's address or name without asking.
- A private log (outside the repository) with: date, tester initials, device and version, what happened, severity, and what was done (fixed in build N, not reproducible, decided against). It doubles as the evidence Google asks for.
- Each beta build is announced to testers with a plain list of what changed and what to look at.
- **Crash and privacy:** the program sends nothing home. Testers are asked to describe problems; the Settings > About page shows the version and commit to quote.

## Honest labels

The website and store listings call a feature **Working** only when it has been used on a real device, **New** or **In testing** until the owner has tried it, and **Planned** when nothing is built. Screenshots show the invented demo library, never a tester's or the owner's music.
