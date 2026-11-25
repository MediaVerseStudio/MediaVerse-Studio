# MediaVerse Studio brand files

The name and logo are covered by [`TRADEMARKS.md`](../TRADEMARKS.md).

## Sources (edit these)

| File | What it is |
|---|---|
| `mediaverse-logo.jpg` | The full logo artwork (record, waveform, teal band, "MediaVerse Studio" lettering) on black, 1408x768. |
| `icon.svg` | Program icon for 48 px and up: a simplified, redrawn version of the record (no small text, fewer lines). |
| `icon-small.svg` | The same icon for 24-40 px: one bold waveform, no grooves. |
| `icon-tiny.svg` | The same icon for 16-20 px: the record, its label and the teal band only. |

## Made from them

Run `tools\make-brand-assets.ps1` after changing a source. It uses the Electron already in `web\app\node_modules`,
so no image tools need installing.

| Output | Used for |
|---|---|
| `web/app/public/mediaverse-emblem.png` | Desktop top bar: the record artwork, black made transparent. |
| `web/app/public/mediaverse-wordmark.png` | Desktop top bar: the logo's own "MediaVerse Studio" lettering, beside the emblem. |
| `web/app/electron/icon.ico` (+ `icon.png`) | Windows: title bar, taskbar, Start menu and desktop shortcuts, Settings > Apps. 16-256 px. |
| `web/app/public/favicon.png` | Spare 64 px copy for pages. |
| `web/app/tv/public/icon.png` | Samsung TV launcher icon (512x423, Tizen's size). |
| `apps/android/.../mipmap-*/ic_launcher.png` | Android launcher icon, 48-192 px. |
| `brand/png/icon-*.png` | Previews and spares, 16-1024 px. |

## The program file

The installed program is Electron's own `electron.exe` renamed. `tools\package-windows.ps1` writes `icon.ico` and the
program's name into it with rcedit (D89, build-time only, fetched and hash-checked by `tools\fetch-rcedit.ps1`);
`tools\make-installer.ps1` does the same for the setup program.
