# ADR 0002: Electron desktop shell

## Status

Accepted (D1, 2026-10-31; Tauri archived in D19, 2026-11-02). Electron 45 is the Windows shell. The
spike branch (`spike/electron-shell-migration`) became `main` on 2026-11-07 (D87; last spike commit tagged
`spike-final`). Packaging works on the development PC and casting is built (D77-D80); a clean-machine test is
still open.

## What the shell does

- Main process (`web/app/electron/main.js`) with secure defaults: context isolation, sandboxed
  renderer, Node integration off.
- A preload bridge with an allowlisted IPC surface; replies are envelopes so structured sidecar errors
  reach the page intact (D11).
- Starts `mediaverse_sidecar` and relays its commands and events (ADR 0003).
- Native dialogs (choose or create a folder) and opening allowed https links in the browser.
- Development: `MEDIAVERSE_DEV_SERVER_URL=http://localhost:5173` with `npm run dev`; otherwise
  `dist/index.html` is loaded.

## Why Electron

Electron bundles its own Chromium, so behaviour does not depend on the system WebView, and its main
process can host a local media server for casting later. The cost is size (about 156 MB installed
build) and no Android version, so Android needs its own shell (see the playback guide).

## Casting boundary

Electron does not include Google's Cast sender. Do not use Chrome-extension APIs,
`navigator.presentation` or other unsupported workarounds. A separate proof must validate a supported
sender route, local delivery, session lifecycle, seeking, metadata and recovery on real receivers before
the app claims Cast support.
