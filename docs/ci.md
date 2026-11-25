# Continuous integration (GitHub Actions)

`.github/workflows/ci.yml` runs every automated test on a clean Windows machine when code is pushed to `main` or `develop`, **or when a pull request into `main` is opened or updated** (added 2026-11-19, so a long-lived branch is tested once, when it is about to be merged, without spending
Windows minutes on every push to it), for documentation-only changes too (since the repository went public on 2026-11-25 the runners are free, and the required "test" check must always report), or when started by hand from the Actions tab.

## What it runs
Rust: `cargo fmt --all --check` first (standard rustfmt, no config file; fails in seconds if anything is unformatted, fix it with
`cargo fmt --all`), then `cargo test --workspace`. Web: `npm ci`, `npm test`, `npm run build`, `npm run test:electron`.
Not run there: the native CD helper (needs MSYS2/libcdio and a real drive) and the LAME tests (LAME is built
locally); those tests skip themselves when the tools are missing. Only official GitHub actions are used, pinned to
exact commits (checkout, setup-node, cache). No secrets are used or needed; the workflow can only read the code.

## Your free allowance, in plain terms
The repository belongs to the organisation `MediaVerseStudio` on GitHub's **Free** plan, private repository.
- Allowance: **2,000 "minutes" per month**, shared by every private repository in the organisation.
- **Windows minutes count double**, so the allowance is about **1,000 real Windows minutes** (about 16 hours of
  machine time) a month. The counter resets monthly.
- Storage: 500 MB for build artifacts (this workflow stores none) and a separate 10 GB cache.
- If the allowance runs out, workflows stop running until the month resets (or spending is allowed); nothing is
  charged by default.

## Measured, first run (2026-11-02)
The first run, with nothing cached, took **5 minutes 28 seconds** of real time: building and testing the Rust code
284 seconds, everything else about 40 seconds. A Windows job is billed in whole minutes and counts double, so
this run cost about **12 of the 2,000 minutes (0.6 per cent)**. That is far below the 30 to 40 I first guessed.
The Rust tests all passed on the clean machine. The web checks failed because Node 24 on the runner does not accept
a folder name for `node --test`; the test scripts now name the test files explicitly (same 66 and 9 tests).
No cache was saved because the run failed (caches are saved only after a successful run).

## Measured, second run: the first fully green one (2026-11-02)
All Rust and web tests passed on the clean machine. It took **10 minutes 45 seconds** (the Rust step 570 seconds, twice the first run's 284 for the same
work: GitHub's machines vary in speed), so it cost about **22 minutes**. It saved a build cache of 240 MB, so the next run should be shorter (to be measured).
**Total used by CI so far: about 34 of the 2,000 minutes (1.7 per cent).**

| Case | Real time | Counts against the allowance |
|---|---|---|
| Nothing cached (measured twice: 5.5 and 10.75 minutes; machine speed varies) | 5.5 to 11 minutes | about 12 to 22 |
| Later run with a build cache (estimate) | about 2 to 4 minutes | about 6 to 10 |
| Documentation-only push | runs like any other (free on a public repository) | 0 |

At about 4 code pushes a day on 20 working days, expect roughly **500 to 1,000** of the 2,000 minutes a month
(25 to 50 per cent). The GitHub API does not report billable minutes for this private repository, so keep using
the measured run times (times two) rather than the billing page's figure until they can be compared.
## How to keep it cheap
- Push in batches (the workflow cancels an older run when a newer push arrives, so quick back-to-back pushes cost little).
- Documentation and notes never trigger a run.
- Add checks (clippy, a Linux job for the portable crates at half the price) only when a measured run shows room.

## Checking real usage
Settings of the organisation, Billing and plans, shows monthly Actions minutes (needs organisation owner access;
the command-line token used here does not have that permission). Each run's duration is also listed in the Actions
tab, and `gh run list --json` reports it; multiply Windows minutes by two.
