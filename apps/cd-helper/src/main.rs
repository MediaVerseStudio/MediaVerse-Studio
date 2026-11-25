//! MediaVerse CD helper: the native, read-only drive access process (ADR 0004).
//!
//! Speaks the same line-delimited JSON as the sidecar (ADR 0003): one request per line on stdin,
//! one response or event per line on stdout, diagnostics on stderr. Commands:
//!   list_drives                          -> [{device, vendor, model, revision}]
//!   read_toc {device}                    -> {tracks, leadout_lsn}
//!   calibrate {device, disc, date, pressings_hex?, existing?}
//!                                        -> report; emits `calibration-progress` events
//!   cancel                               -> stops a running calibration
//!   shutdown
//! Only builds fully for x86_64-pc-windows-gnu (see tools/build-cd-helper.ps1).

#[cfg(all(windows, target_env = "gnu"))]
mod native;

#[cfg(all(windows, target_env = "gnu"))]
mod service;

#[cfg(all(windows, target_env = "gnu"))]
fn main() {
    service::run();
}

#[cfg(not(all(windows, target_env = "gnu")))]
fn main() {
    eprintln!(
        "mediaverse_cd_helper needs the x86_64-pc-windows-gnu build (tools/build-cd-helper.ps1)."
    );
    std::process::exit(1);
}
