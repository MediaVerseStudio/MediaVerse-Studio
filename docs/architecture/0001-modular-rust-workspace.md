# ADR 0001: Modular Rust Workspace and UI Boundary

## Status

Accepted. Updated 2026-11-02 to match the Electron shell and sidecar (D1, D19); the original version
assumed a Tauri desktop crate, which is archived.

## Context

MediaVerse Studio needs portable library, metadata, lyrics and playback logic while keeping
Windows-only CD access and provider-specific casting replaceable. The web UI runs in Electron's
Chromium, but must not assume it has full Chrome device or Cast APIs, and the same logic must later
serve an Android app.

Long-running work must stay off the UI thread, be observable and support cancellation. CD and encoder
integrations need separate provenance, licence and hardware validation before they ship.

## Decision

A Cargo workspace with this dependency direction:

```text
web/app (UI + Electron main) --JSON lines--> apps/sidecar -> crates/host -> application -> domain
                                                  |                ^            ^
                                                  |                |            |
                                                  |          adapter crates -----
                                                  |
                                                  +-- ripper, accuraterip, disc-metadata
                                                  +--JSON lines--> apps/cd-helper (libcdio, GNU target)
```

| Crate or app | Role |
|---|---|
| `crates/domain` | Stable IDs, entities, value types, errors. No SQLite, HTTP, paths, native code or SDKs. |
| `crates/application` | Use cases, port traits, commands and events. Depends only on `domain`. |
| `crates/adapters/library-filesystem` | File discovery and monitoring |
| `crates/adapters/metadata-tags` | Tag reading and editing (lofty; ID3v2.3 kept for this program's MP3s) |
| `crates/adapters/persistence-sqlite` | Library database |
| `crates/host` | Library state and `Host::dispatch`, used by the sidecar |
| `crates/ripper`, `crates/accuraterip`, `crates/disc-metadata` | The ripping module and disc lookup (ADR 0005 to 0007); pure logic, no platform code |
| `apps/sidecar` | The process Electron talks to: jobs, settings, history, flags, pins, lyrics lookup, defect scans |
| `apps/cd-helper` | The only code that touches the drive |
| `apps/installer-stub` | Self-extracting setup program for test builds |

Create an adapter crate only when its capability is needed and its technical, device and licensing
constraints are validated (future candidates: casting adapters, an Android CD reader). Avoid a generic
plugin framework or empty crates.

The shell exposes only stable commands, events and serializable view data to the web UI. It does not
leak database records, native handles or provider SDK types.

Every long-running operation is a job with an ID, state, progress, cancellation, result and structured
error. Cancellation is cooperative and leaves files and stored state recoverable.

## Consequences

- `domain` and `application` are tested without a UI, database, network, drive, encoder or cast device.
- SQLite, playback, CD access and cast providers can change without changing the UI contract.
- Windows-only code (the CD helper) cannot become a prerequisite for Android library, lyrics or
  playback work.
- Some sidecar modules (history, flags, pins, lyrics lookup) currently hold logic that belongs in
  `application` and adapters; move it there when Android needs it.

## References

- `Guiding Documents/MediaVerse Studio - Project Brief.md`
- `Guiding Documents/Playback, Casting, and Platform Architecture.md`
- ADR 0003 (sidecar protocol), ADR 0007 (ripper as a module)
