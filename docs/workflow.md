# How changes are tracked and shipped

Two small systems keep the project calm once people are using it: **one place where every bug and request lives** (GitHub Issues, searchable), and **a stable `main` that only changes after testing** (a `develop` branch in front of it).

## 1. The tracker: GitHub Issues

Everything a beta tester or the owner wants changed is an issue (bug report, beta feedback or idea; templates in `.github/ISSUE_TEMPLATE/`). Searching is the point: `https://github.com/MediaVerseStudio/MediaVerse-Studio/issues`, or from a terminal `gh issue list --search "lyrics sync in:title,body"`.

**Labels**
- **Type:** `bug`, `idea`, `beta-feedback` (set by the templates).
- **Area:** `area: windows`, `android`, `tv`, `cast`, `jellyfin`, `ripping`, `lyrics`, `linux`, `website`.
- **Priority:** `priority: high` is only for lost data, crashes and anything that stops people using the app. Everything else is ordered by the owner.
- **Status** (exactly one at a time, this is the board's column):

| Status | Meaning | Who moves it |
|---|---|---|
| `status: new` | Reported, not looked at | the template |
| `status: needs info` | A question is waiting for the reporter | whoever asked |
| `status: proposed` | A summary and plan are written in a comment, waiting for the owner | Claude or a maintainer |
| `status: approved` | The owner said yes | the owner |
| `status: in progress` | Being built on a branch | the builder |
| `status: in test` | Merged to `develop`; being tried on real devices | the builder |
| `status: released` | In a release on `main`; the issue is closed | the builder |

**The summary-then-approval rule.** Nothing is built from an issue until the owner has read a short summary and said yes. The summary (a comment on the issue, so it stays with it) has: what the report means in one or two sentences, what would change and where, what could go wrong, how it will be tested, and any decision the owner must make (a new dependency, a change of behaviour). Then the issue becomes `status: proposed`. The owner approving (a reply, or the label) is what makes it `approved`.

**Working through it with Claude.** Say "triage the tracker" (the `triage` skill in `.claude/skills/triage`): Claude lists open issues by status, priority and area, searches for duplicates, writes the summaries, and waits. After approval it builds on a branch, labels the issue, and keeps the owner in the loop at each step.

A **board view** (columns by status) is an optional extra: in the repository, Projects > New project > Board, group by the Status label. The labels carry the same information without it.

## 2. Branches: `main` stays stable

*The public repository started on 2026-11-25 with a single snapshot commit on `main` (D200). `develop` does not exist yet: create it from `main` when development resumes (`git switch -c develop`), and follow the table below from then on.*

| Branch | Holds | Rules |
|---|---|---|
| `main` | What has been tested and could be released. | Never worked on directly. Changes arrive only by a pull request from `develop` (or a `hotfix/` branch), after CI is green and the owner has said yes. Releases are tagged here (`v0.x.y`). |
| `develop` | The next release, being tested. | Features and fixes are merged here first. Installed on the owner's own devices for real-world testing. CI runs on every push. |
| `feat/<issue>-short-name`, `fix/<issue>-short-name` | One issue each. | Started from `develop`; merged back into `develop` by a pull request (or by the owner after review). Deleted after the merge. |
| `hotfix/<issue>-short-name` | An urgent fix to a released version. | Started from `main`; merged into `main` and then into `develop`. |

The cycle for one issue:
1. The issue is `approved`. Branch from `develop`: `git switch develop && git pull && git switch -c fix/123-short-name`.
2. Build it with tests (`npm test`, `cargo test --workspace`, `cargo fmt --all`). Reference the issue in the commits and the pull request (`Refs #123`). Label it `status: in progress`.
3. Open a pull request into `develop`; CI runs. Merge it. Label the issue `status: in test`. (Do not use "Closes #123" here: GitHub only closes an issue when the commit reaches the default branch, `main`.)
4. Try it on real devices (the build from `develop`: PC, phone, TVs). Anything that is wrong becomes a new commit on `develop`.
5. When `develop` is good, open a pull request `develop` into `main` that lists the issues it contains with "Closes #123" for each, wait for green CI and the owner's yes, merge, tag the release, and label the issues `status: released`.

Rules that keep `main` safe: no direct pushes to `main` (turned on in the repository settings when the repository goes public, see below); no force-push to `main` or `develop`; formatting-only changes go in their own commit (`AGENTS.md`); a change that touches tags, files in a user's library, or the installer is tested on a copy of real data before it reaches `main`.

**Branch protection.** GitHub's free plan only offers branch protection on public repositories, so it is switched on at go-live (`docs/roadmap.md`, go-live day): Settings > Branches > add a rule for `main`: require a pull request, require the CI check "test" to pass, no force pushes, no deletions. Until then the rule is kept by habit and by this document.

## 3. Hot topics for the owner
- Installing: PC, phone and both TVs are updated from `develop` for testing. A build from `main` is what a beta tester or a store listing gets.
- The version number is `0.9.0` (beta) since 2026-11-24 (D196); `docs/version-bump-checklist.md` lists every place it lives. Builds are also told apart by the commit in Settings > About.
