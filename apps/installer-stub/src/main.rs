//! The MediaVerse Studio setup program (Windows). `tools/make-installer.ps1` appends a zip file to a copy of this
//! program, followed by a 16-byte trailer: the zip's length (8 bytes, little endian) and the magic text `MVSETUP1`.
//! At run time the program finds that zip inside itself, unpacks it into a temporary folder with the `tar.exe` that
//! ships with Windows 10 and 11, and runs the `install.ps1` found there. Standard library only.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const MAGIC: &[u8; 8] = b"MVSETUP1";
const TRAILER_LEN: u64 = 16;

/// Where the zip starts and how long it is, given the total file length and the 16 trailer bytes.
pub fn payload_range(file_len: u64, trailer: &[u8; 16]) -> Option<(u64, u64)> {
    if &trailer[8..] != MAGIC {
        return None;
    }
    let zip_len = u64::from_le_bytes(trailer[..8].try_into().ok()?);
    let start = file_len.checked_sub(TRAILER_LEN)?.checked_sub(zip_len)?;
    (zip_len > 0).then_some((start, zip_len))
}

fn copy_range(from: &mut File, start: u64, len: u64, to: &Path) -> io::Result<()> {
    from.seek(SeekFrom::Start(start))?;
    let mut out = File::create(to)?;
    io::copy(&mut from.take(len), &mut out)?;
    out.flush()
}

#[cfg(windows)]
fn hidden(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no console flashes up
}

#[cfg(not(windows))]
fn hidden(command: &mut Command) -> &mut Command {
    command
}

fn show_problem(message: &str) {
    let _ = hidden(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:MV_SETUP_MESSAGE, 'MediaVerse Studio setup', 'OK', 'Error')"])
            .env("MV_SETUP_MESSAGE", message),
    )
    .status();
}

fn run() -> Result<i32, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not find the setup program itself: {e}"))?;
    let mut file =
        File::open(&exe).map_err(|e| format!("Could not open the setup program: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len < TRAILER_LEN {
        return Err("This setup program has no program files attached.".to_owned());
    }
    let mut trailer = [0u8; 16];
    file.seek(SeekFrom::Start(len - TRAILER_LEN))
        .and_then(|_| file.read_exact(&mut trailer))
        .map_err(|e| e.to_string())?;
    let (start, zip_len) = payload_range(len, &trailer).ok_or("This setup program is incomplete: its program files are missing. Download or copy it again.")?;

    let work: PathBuf =
        std::env::temp_dir().join(format!("mediaverse-setup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    let files = work.join("files");
    std::fs::create_dir_all(&files)
        .map_err(|e| format!("Could not make a temporary folder: {e}"))?;
    let zip = work.join("payload.zip");
    copy_range(&mut file, start, zip_len, &zip)
        .map_err(|e| format!("Could not unpack the setup files: {e}"))?;

    let tar = Path::new(&std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join("tar.exe");
    let unpacked = hidden(
        Command::new(&tar)
            .arg("-xf")
            .arg(&zip)
            .arg("-C")
            .arg(&files),
    )
    .status()
    .map_err(|e| format!("Could not run Windows' tar tool ({}): {e}", tar.display()))?;
    if !unpacked.success() {
        let _ = std::fs::remove_dir_all(&work);
        return Err("The setup files could not be unpacked (is the disk full?).".to_owned());
    }
    let _ = std::fs::remove_file(&zip);

    let quiet = std::env::args().skip(1).any(|a| {
        matches!(
            a.to_ascii_lowercase().as_str(),
            "/q" | "/quiet" | "-q" | "-quiet" | "--quiet"
        )
    });
    let mut install = Command::new("powershell.exe");
    install
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(files.join("install.ps1"));
    if quiet {
        install.arg("-Quiet");
    }
    let status = hidden(&mut install)
        .status()
        .map_err(|e| format!("Could not start the installation: {e}"))?;
    let _ = std::fs::remove_dir_all(&work);
    Ok(status.code().unwrap_or(1))
}

fn main() -> ExitCode {
    match run() {
        Ok(0) => ExitCode::SUCCESS,
        Ok(code) => ExitCode::from(code.clamp(1, 255) as u8),
        Err(message) => {
            show_problem(&message);
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trailer(zip_len: u64, magic: &[u8; 8]) -> [u8; 16] {
        let mut t = [0u8; 16];
        t[..8].copy_from_slice(&zip_len.to_le_bytes());
        t[8..].copy_from_slice(magic);
        t
    }

    #[test]
    fn the_zip_is_found_from_the_trailer() {
        assert_eq!(
            payload_range(1_000_116, &trailer(1_000_000, MAGIC)),
            Some((100, 1_000_000))
        );
    }

    #[test]
    fn a_missing_wrong_or_impossible_trailer_is_refused() {
        assert_eq!(payload_range(1_000, &trailer(10, b"NOTMAGIC")), None);
        assert_eq!(
            payload_range(1_000, &trailer(5_000, MAGIC)),
            None,
            "longer than the file"
        );
        assert_eq!(payload_range(1_000, &trailer(0, MAGIC)), None, "empty");
        assert_eq!(
            payload_range(10, &trailer(1, MAGIC)),
            None,
            "file shorter than a trailer"
        );
    }
}
