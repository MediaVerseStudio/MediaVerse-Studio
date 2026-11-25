# ADR 0003: Rust sidecar protocol

## Status

Accepted (2026-10-31), protocol version 1. Implemented in `crates/host` and `apps/sidecar`.

## Context

The Electron shell (ADR 0002) needs the Rust library, tag, persistence, ripping and lookup code.
Rewriting it in Node was rejected (D1): Node cannot read audio CDs without a native helper anyway, the
tested Rust code would be discarded, and Android could not share the logic. The sidecar keeps one Rust
implementation and keeps heavy native work in a separate process that can crash or be cancelled
without taking down the UI.

## Decision

- `crates/host` (`mediaverse_host`) owns library state and exposes `Host::dispatch(command, args)`.
  Shells provide an `EventSink` for background events.
- `apps/sidecar` (`mediaverse_sidecar`) speaks this protocol over stdin/stdout and adds the drive,
  rip, lookup, lyrics, review and settings commands. Start it as `mediaverse_sidecar --data-dir <dir>`;
  the data directory holds `library.sqlite` and the JSON settings files.
- The sidecar starts the CD helper (`mediaverse_cd_helper`) per job and talks to it with the same
  line-delimited JSON.

## Wire format (protocol version 1)

UTF-8, one JSON object per line, in both directions. stdout carries protocol messages only; stderr is
for diagnostics and must never contain credentials or private library data.

Sidecar to client:

```json
{"type":"ready","protocol":1,"sidecar":"0.1.0","commands":["collection_status", "..."]}
{"type":"response","id":1,"ok":true,"result":{}}
{"type":"response","id":1,"ok":false,"error":{"code":"collection_not_selected","message":"..."}}
{"type":"event","event":"library-updated","payload":{}}
```

Client to sidecar:

```json
{"id":1,"command":"import_collection","args":{"root":"C:\\Music"}}
{"id":2,"command":"shutdown"}
```

Rules:

- `ready` is the first line and lists every command. The client must check `protocol` and refuse an
  unsupported version.
- `id` is chosen by the client and echoed in the response. A malformed request gets `invalid_request`
  with `id: null`.
- Always correlate responses by `id`.
- `shutdown` replies, then the sidecar exits. Closing stdin also ends it.
- Error `code` values are stable snake_case strings; `message` is user-presentable.
- Adding commands, events or fields is backward compatible. Removing or changing the meaning of
  anything bumps `protocol`. Electron's allowlist (`web/app/electron`) must be updated with each new
  command or event.

## Jobs

Long work returns `{job_id}` at once and reports through events: `job-progress` (`{job_id, kind, ...}`,
kinds such as `calibration`, `rip`, `archive`, `lookup`, `gaps`, `defects`) and `job-finished`
(`{job_id, ok, result | error}`). `cancel_job {job_id}` stops a job, which then finishes with `cancelled`.

## Commands (grouped)

| Area | Commands |
|---|---|
| Library | `collection_status`, `import_collection`, `library_snapshot`, `rescan_collection`, `tag_editor_choices_command`, `write_track_tags`; events `library-updated`, `collection-sync-failed` |
| Drives and ripping (ADR 0004, 0005, 0007) | `list_drives`, `list_drive_profiles`, `calibrate_drive`, `rip_disc`, `cancel_job` |
| Disc lookup (ADR 0006) | `get_metadata_settings`, `set_metadata_settings`, `lookup_disc` |
| Archive | `get_archive_settings`, `set_archive_dir`, `set_archive_enabled` |
| Pictures and lyrics | `track_cover`, `track_lyrics`, `update_track_media`, `find_album_art` and `fetch_album_art` (jobs: MusicBrainz release search and Cover Art Archive covers, on request), `get_lyrics_settings`, `set_lyrics_settings`, `lookup_lyrics` |
| Review | `list_flags`, `set_flag`, `library_gaps`, `scan_defects` (up to 1,000 chosen files), `scan_library_defects` (the whole library, in the background, ADR 0008), `library_scan_status`, `list_defect_problems` (a page of results), `list_defect_results`, `set_defect_reviewed`, `get_listen_settings`, `set_listen_settings` |
| Home | `list_history`, `record_play`, `set_history_enabled`, `clear_history`, `list_pins`, `set_pin`, `recent_files` |
| Other | `create_folder` |

Argument details live with each command in `apps/sidecar/src/drives.rs` and the ADR for its area.
Common error codes include `helper_unavailable`, `helper_failed`, `drive_not_found`,
`drive_not_calibrated`, `no_tracks`, `output_unavailable`, `invalid_archive_location`,
`archive_folder_required`, `output_in_library`, `disc_lost`, `disk_full`, `unknown_job`.

## Consequences

- Requests are handled one at a time; jobs run in the background so long work never blocks the queue.
- Packaging ships `mediaverse_sidecar.exe` and `mediaverse_cd_helper.exe` beside the Electron app
  (`process.resourcesPath`). `MEDIAVERSE_SIDECAR_PATH` overrides the lookup for development. Code
  signing is not decided yet (`docs/installer.md`).

## Verification

- `cargo test -p mediaverse_host -p mediaverse_sidecar` (unit tests plus end-to-end tests that spawn the
  real binary with a fake CD helper and fake servers).
- `npm run sidecar:build` then `npm run test:electron` (Node client against the real binary).
