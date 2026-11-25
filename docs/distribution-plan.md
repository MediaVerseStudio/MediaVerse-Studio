# Distribution plan: two downloads, and Linux (plan, 2026-11-18)

Owner's decisions (2026-11-18): when the program goes public, offer **two PC downloads**: one **without any model** and one **with the best licence-compatible model
included**. A **Linux build** is a future roadmap goal (the owner's friends mostly use Linux; the owner has no Linux computer set up yet). **Not built:** the two installers and the Linux build; the models and engine they would carry exist (`docs/lyric-models.md`).

## Two downloads for Windows

| | **MediaVerse Studio** | **MediaVerse Studio + Lyric AI** |
|---|---|---|
| Contents | Today's installer (about 160 MB). Lyric AI is switched off until a model is added in Settings > Lyric AI > Models (download from the list, or add your own). | The same, plus the default reader model and ONNX Runtime (CPU). About +0.6 to 1.3 GB depending on precision (see below). |
| Why | Small; no question about any model's origin; for people who do not want the AI, or want to choose their own. | Works the first time; for people who just want lyrics found and timed. |

- **Same program in both.** The second installer differs only by the model files and their licence texts, so there is one build, one source bundle, one set of tests.
- **Which model is bundled:** the best-ranked model whose licence is compatible with the program (GPL-3.0-or-later, free, non-commercial stance), whose weights may be
  redistributed, and whose origin is acceptable. Today that is `mrfakename/w2v-bert-2.0-music-lyrics-ctc` (MIT; the owner accepted its undocumented training data, D136). Whisper (about 1.6 GB) is a separate download in both
  versions (D137). A GPL-3.0 model (Sylla) is a separate download only (D137): its weights are a GPL-3.0-*only* grant next to a "GPL-3.0-or-later" program, to be checked before it is ever bundled. A non-commercial model (MMS,
  CC-BY-NC) is never bundled or listed by default.
- **Size:** the released weights are 2.3 GB (fp32). Half precision is about 1.2 GB and 8-bit about 0.6 GB; the accuracy of each is **to be measured** before one is chosen
  (the benchmark in `docs/lyric-models.md` does it). A GitHub release file is limited to 2 GB, so fp16 or int8 fits as one file; fp32 would not.
- **GPU:** the installer carries only the CPU runtime. NVIDIA acceleration (CUDA libraries, about 1 GB) stays an optional download in Settings, as planned in
  `docs/lyric-ai-plan.md`; without it the AI runs on the CPU, slower (a CPU speed for the new reader is **not measured yet**).
- **Licences and source:** every bundled model's licence text and origin go in the `licenses` folder (Settings > About) and in `third_party/README.md`; the GPL source
  bundle already shipped beside the installer stays. Dropping the Demucs separator from the default pipeline also removes a weights licence that is "not stated".
- **Hosting and checks:** the installers and source go on the project's releases with SHA-256 files; models in the in-app list are fetched from their own pages with
  checksums. SmartScreen warnings remain until the installer is code-signed (a cost to decide before going public; `docs/installer.md`).

## Linux (roadmap goal, not scheduled)

See `docs/linux-plan.md` for the inventory of what is Windows-only and the steps. In short: the program is Electron plus a Rust sidecar plus a native CD helper, so most
of it is portable; the work is the Windows-specific pieces (audio decoding for conversions, the installer, the firewall check, CD access), packaging (AppImage first,
then `.deb`/`.rpm`/Flatpak), and testing without a Linux computer (continuous integration on Linux, a virtual machine, and the owner's friends as testers).


## Signing and the Microsoft Store (researched 2026-11-18, from Microsoft's "Code signing options" page, updated 2026-11-10)

Owner's decision: apply to the **SignPath Foundation** (free signing for open-source projects) when the repository goes public, and look into the **Microsoft Store**.

| Route | Cost | Effect for users | Fit for this program |
|---|---|---|---|
| **Microsoft Store, MSIX package** | Free; Microsoft re-signs the package, no certificate to buy | No SmartScreen warning; updates through the Store | Needs the program packaged as MSIX (Electron apps can be; the sidecar and CD helper go in the package as full-trust desktop parts). **To verify before committing:** raw CD-drive access from a packaged app, writing to the user's music folders, the 2 GB-plus model download (kept outside the package), and the Store's content policy and terms against a GPL-3.0 program (source offer, trademark rules). Developer account at storedeveloper.microsoft.com (Microsoft says free for an individual; check the page when applying). |
| Microsoft Store, EXE/MSI installer | Needs a certificate from a trusted CA anyway | No SmartScreen prompts during Store install | Does not remove the signing problem. |
| **SignPath Foundation** | Free for qualifying open-source projects | Signed installer; SmartScreen reputation still builds over releases | Needs a public repository and an application; fits the GPL licence. Sign the existing `Setup.exe` in CI. |
| Azure Artifact Signing (was Trusted Signing) | about $9.99 a month | Same as above | Individuals in the USA and Canada, organisations in USA, Canada, EU, UK. A fallback if SignPath declines. |
| OV or EV certificate | $150 to 300 or $400+ a year | EV no longer skips SmartScreen since 2024 | Not worth it. |
| Unsigned (today) | Free | Strong SmartScreen warning | Fine for testers only. |

Plan: sign with SignPath for the direct download, and later try the Store (MSIX) as a second channel (free updates and no warnings), once the repository is public and a first release has had testing. The Store route is real work (a packaging pipeline and a certification pass), not a switch. Linux needs no signing.