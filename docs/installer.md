# Installer for testing

`tools\make-installer.ps1` builds **`dist-installer\MediaVerse-Studio-Setup.exe`**, a single file (about 156 MB) that
can be copied to another computer or a virtual machine. `MediaVerse-Studio-Setup.sha256.txt` beside it holds its SHA-256
so a copy can be checked.

## What it does
- Per user: **no administrator rights**. Installs to `%LOCALAPPDATA%\Programs\MediaVerse Studio`.
- Adds a Start menu shortcut, offers a desktop shortcut and to start the program, and lists the program under
  **Settings > Apps** with an uninstaller.
- Needs nothing else on the computer: the Rust program has the C runtime built in, the CD helper and LAME use only
  Windows' own libraries, and Electron carries its own.
- Shortcuts and the Settings > Apps entry use the program icon (`resources\app\electron\icon.ico`, D86); the
  window and taskbar get it from the program itself.
- `MediaVerse-Studio-Setup.exe /Q` installs silently (Start menu shortcut only).
- **Uninstall** from Settings > Apps, or run `uninstall.ps1` in the install folder. It keeps your settings, history,
  flags and pins in `%APPDATA%\MediaVerse Studio` unless you answer yes to deleting them (or pass `-RemoveData`);
  your music files are never touched.
- Updating: run a newer setup over the old install; it replaces the program files and keeps your data.

## How it is built (no extra tools)
The setup program is `apps/installer-stub` (Rust, standard library only). `make-installer.ps1` zips the program plus
`tools\installer\install.ps1` and `uninstall.ps1` with Windows' own `tar.exe`, appends the zip to a copy of the stub
with a 16-byte trailer (zip length and `MVSETUP1`), and records the SHA-256. At run time the stub unpacks the zip to a
temporary folder with `tar.exe` and runs `install.ps1`. IExpress (the tool Windows ships for this) was tried first and
fails on this Windows 11 build even for a one-file test, which is why the stub exists.

## Things to know when testing
- **SmartScreen:** the installer is not code-signed, so Windows shows "Windows protected your PC". Choose **More info**,
  then **Run anyway**. Signing needs a code-signing certificate (an annual cost); decide that before sharing widely.
- **A virtual machine has no CD drive** unless one is passed through, so test installing, starting, Library, playback,
  Review and Settings there; test ripping on a real computer with a drive. A VM may render slowly (no graphics acceleration).
- **Sharing with testers (D88):** the program carries a `licenses` folder (Settings > About opens it), and the script
  also makes `MediaVerse-Studio-Source-<commit>.zip`. Always share both files in the same place (for example one
  shared folder): the GPL/LGPL parts (libcdio, LAME, libiconv) require the source to be available with the
  program, and the repository is private. Only share a build made from a commit (the script makes no source bundle
  for a build with uncommitted changes).
- Windows 10 version 1803 or later (for `tar.exe`) and Windows 11 are supported; older Windows is not.
- Checked on the development PC: silent install in about 2 seconds, the installed program starts and talks to its
  sidecar and the CD helper, silent uninstall removes the folder, shortcut and registry entry and keeps user data.
  **Not yet checked: a clean machine** (no virtual machine was available); that is what this installer is for.
