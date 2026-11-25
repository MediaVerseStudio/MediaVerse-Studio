//! Drive-independent CD ripping logic: the optical-drive abstraction, drive profiles, and the
//! drive test and calibration steps (ADR 0004). No platform code lives here; a native adapter
//! implements [`OpticalDrive`], and [`sim::SimulatedDrive`] stands in for hardware in tests.

pub mod archive;
pub mod calibrate;
pub mod defects;
pub mod flac;
pub mod id3;
pub mod lrc;
pub mod mp3;
pub mod profile;
pub mod rip;
pub mod sim;
pub mod wav;

use profile::DriveIdentity;
use serde::Serialize;
use std::fmt;
use std::time::Duration;

/// Bytes in one raw CD-DA sector (588 stereo 16-bit samples).
pub const SECTOR_BYTES: usize = 2352;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DriveError {
    NoDisc,
    /// The drive or its driver refused a read this large.
    TransferTooLarge {
        requested: u32,
        max: u32,
    },
    ReadFailed(String),
    Unsupported(String),
    /// The caller asked to stop.
    Cancelled,
}

impl fmt::Display for DriveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDisc => write!(f, "there is no readable disc in the drive"),
            Self::TransferTooLarge { requested, max } => {
                write!(f, "cannot read {requested} sectors at once (limit {max})")
            }
            Self::ReadFailed(message) => write!(f, "read failed: {message}"),
            Self::Unsupported(message) => write!(f, "not supported: {message}"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::error::Error for DriveError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TocTrack {
    pub number: u8,
    pub start_lsn: u32,
    pub end_lsn: u32,
    pub audio: bool,
}

impl TocTrack {
    pub fn sectors(&self) -> u32 {
        self.end_lsn - self.start_lsn + 1
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Toc {
    pub tracks: Vec<TocTrack>,
    pub leadout_lsn: u32,
}

impl Toc {
    pub fn audio_starts(&self) -> Vec<u32> {
        self.tracks
            .iter()
            .filter(|track| track.audio)
            .map(|track| track.start_lsn)
            .collect()
    }
}

/// What the ripper needs from an optical drive. Read-only by design.
pub trait OpticalDrive {
    fn identity(&self) -> DriveIdentity;

    /// Reads the table of contents. Decide whether a disc is audio from the track formats, not
    /// from the drive's disc-mode label (libcdio reports audio discs as "DVD-ROM" on some drives).
    fn read_toc(&mut self) -> Result<Toc, DriveError>;

    /// Reads `sectors` raw audio sectors from `lsn`, replacing the contents of `out`. Returns how
    /// long the read took, measured by the adapter, so callers can detect drive-cache hits.
    fn read_audio(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
    ) -> Result<Duration, DriveError>;

    /// Like `read_audio`, but with re-reading and cross-checking where the adapter supports it,
    /// reporting how clean the read was. The default does a single plain read and says so
    /// (`secure: false`), so a caller can never mistake it for a verified read.
    fn read_audio_secure(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
    ) -> Result<rip::ReadQuality, DriveError> {
        self.read_audio(lsn, sectors, out)?;
        Ok(rip::ReadQuality::default())
    }
}
