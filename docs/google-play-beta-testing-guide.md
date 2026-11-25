# Guide: friends' beta test and getting listed on Google Play (written 2026-11-20)

Purpose: run the friends' beta test so that it also produces the record Google asks for before a new developer account may publish to everyone, and keep that record as you
go. The Samsung TV beta is at the end. **Google changes these rules; read the two official pages in section 1 on the day you start and trust them over this guide.**

## 1. What Google requires (as of the search on 2026-11-20)

Source: [Google Play Help, "Test your app / App testing requirements for new personal developer accounts"](https://support.google.com/googleplay/android-developer/answer/14151465).
- A **personal** developer account created after 13 November 2023 must run a **closed test with at least 12 testers who stay opted in continuously for 14 days** before it may apply for production access. The 12 must still be opted in on the day you apply.
- **Open testing does not count**; only a closed test does. Completing the 14 days does not unlock anything by itself: you then **apply for production access** (a questionnaire) and Google reviews it.
- Organisation accounts (verified with a D-U-N-S number) are not held to the 12-tester rule. The project account is a personal one today (`MediaVerseStudio2026@...` in the project notes), so the rule applies unless the project becomes an organisation account later. Check which type the account is in Play Console > Settings > Developer account.
- Third-party guides report that if the number of opted-in testers drops below 12 the 14-day clock can stall or restart. This is not in Google's text, so **plan for 15 to 20 testers** and keep the 12 a margin away from the edge.

## 2. Before the test: prepare the app

1. **Developer account:** pay the one-off registration fee, finish identity verification, and add the contact address (the project address, never a personal one) and the public developer name.
2. **App:** `studio.mediaverse.app` (Android). Build a **release** bundle (`.aab`), signed with the upload key Play asks you to create; **keep that key and its password offline and backed up**: losing it makes updates difficult. The bundle's `versionCode` must be higher than any earlier upload (`docs/version-bump-checklist.md`).
3. **Store listing drafts:** name, short and full description, screenshots (phone), icon, and the privacy policy web page (a public URL: put it on the `mediaverse.studio` website; say plainly that music stays on the person's own devices, that lookups go to MusicBrainz, AcoustID, LRCLIB and Cover Art Archive, and that nothing is sold or tracked).
4. **App content forms** (Play Console > Policy > App content): privacy policy, ads (none), app access (explain that the app needs the person's own music files or a MediaVerse library on their network; give the reviewer a way in, such as a short demo-library download), content rating questionnaire, target audience (not for children), data safety (what is collected: none off-device except the lookups; say so exactly), and the declarations that match the permissions in the manifest (media audio access, foreground service for playback and casting, network). Android Auto and Cast declarations are filled separately if listed.
5. **Be honest about what is in the app:** the app is GPL-3.0-or-later; mention the source link in the listing.

## 3. Running the closed test

1. In Play Console create a **closed testing** track, then a **testers list** (an email list or, easier, a **Google Group**: add the group and then add and remove people in the group without touching Play).
2. Upload the bundle to the closed track and **start the release**. Send each friend the **opt-in link** from the track page. A tester must use the Google account that is on the list, **accept the invitation** (opt in) and **install from the Play Store link**; installing is not enough without opting in.
3. Ask every tester to keep the app installed and opted in for the full 14 days and to **open it at least a few times** over that period. Google looks at real engagement, not only the count.
4. **Do not remove testers** during the 14 days; add more if anyone drops out.
5. Push at least one or two **updates** during the test from feedback (each with a higher `versionCode`): it shows the test was used for improving the app.

## 4. The record to keep (this is what Google's questionnaire asks about)

Keep one folder (outside the repository, or in `docs/` without names or emails) with these, written as you go, not afterwards:

| Record | What to put in it |
|---|---|
| **Tester roster** | Count and how they were found (friends, family, a forum), the start date of each, and the date the 12th tester opted in. Keep email addresses out of anything public. |
| **Test plan** | The short list you gave testers: install, scan the music folder, play, lyrics screen, playlists, cast to a TV or speaker, Android Auto if they have one, pair to a MediaVerse library on the computer. The checklist items in `docs/outstanding.md` (phone and casting) are the source. |
| **Feedback log** | Date, who (initials), device and Android version, what happened, severity, and what you did about it (fixed in build N, not reproducible, decided against). A shared form or a GitHub issue label `beta` makes this easy. |
| **Changes made** | One line per update uploaded during the test and which feedback it answers. |
| **Quality evidence** | Play Console > Android vitals (crash and ANR rates for the test), pre-launch report results, and a note that none of them is above the thresholds, or what was done about it. |
| **Readiness statement** | Two or three paragraphs, in your words: who the app is for, what testers said, what was fixed, and why it is ready for everyone. |

When the 14 days are over, **apply for production access** (Play Console > Dashboard, the "Apply for production" step). Answer from the record: how you found testers, how
they used the app, what feedback you got and what you changed. Expect a review of a few days; if it is refused, the reason is given and you may fix and apply again
(a new 14-day test is not always required: read the message).

## 5. After approval

- Promote the tested build to **production** (a staged rollout of 10 to 20% first), keep the closed track for the next beta.
- Add the **Cast receiver** registration as published (`docs/casting-plan.md`), if the receiver page is live.
- Keep `versionCode` ever increasing; update the data-safety form whenever a permission or lookup is added.

## 6. Samsung TV (Tizen) beta, the equivalent

Source: [Samsung Seller Office beta test FAQ](https://developer.samsung.com/tv-seller-office/faq/beta-test.html) and the [launch checklist](https://developer.samsung.com/tv/distribute/launch-checklist).
- Register in the **TV Seller Office**, create the application with the **same Tizen ids as today** (`MVStudioTV`, `MVStudioTV.MediaVerse`), upload the signed `.wgt`, pick the TV model groups.
- **Beta tests** work for Smart TVs from 2021 on: Seller Office makes an **activation code**; testers enter it on their TV and get the build, and newer beta builds update by themselves. Different model groups may run different versions.
- Before certification: the **App Title must match** the `<name>` in `config.xml` or the pre-test fails; follow the launch checklist (UI description, remote-control navigation, exit behaviour, no crashes on the model groups chosen).
- Keep the same kind of record (testers, feedback, changes) for Samsung's reviewers; the form is different but the content is the same. Alpha testing is for Samsung partners only.

## 7. A realistic timeline

Week 0: account, forms, privacy page, signed bundle. Week 1: invite 15 to 20 friends, start the closed test (day 1 of 14). Weeks 1 to 3: updates and feedback log. Day 14: apply for
production access. Then wait for Google's review. Start the Samsung beta in parallel if the TV app is ready.
