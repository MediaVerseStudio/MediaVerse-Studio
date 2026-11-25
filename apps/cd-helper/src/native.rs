//! The only place that touches libcdio and libcdio-paranoia. Hand-written bindings for the few
//! functions used, checked against the pinned headers
//! (`third_party/build/libcdio-native/prefix/include/cdio`). All `unsafe` is confined to this file.
//! Read-only: nothing here writes to a drive or disc.

use mediaverse_ripper::profile::{Connection, DriveIdentity};
use mediaverse_ripper::rip::ReadQuality;
use mediaverse_ripper::{DriveError, OpticalDrive, SECTOR_BYTES, Toc, TocTrack};
use std::ffi::{CStr, CString, c_char, c_int, c_long, c_void};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::time::{Duration, Instant};

type CdIo = c_void;
type CddaDrive = c_void;
type Paranoia = c_void;

/// `driver_id_t`: DRIVER_DEVICE ("any real drive") is the 12th enumerator in device.h.
const DRIVER_DEVICE: c_int = 11;
const DRIVER_OP_SUCCESS: i32 = 0;
const DRIVER_OP_BAD_PARAMETER: i32 = -5;
const TRACK_FORMAT_AUDIO: c_int = 0;
const CDIO_CDROM_LEADOUT_TRACK: u8 = 0xAA;
const CDIO_INVALID_TRACK: u8 = 0xFF;
/// `CDDA_MESSAGE_FORGETIT`: drop libcdio-paranoia's own messages (stdout carries our protocol).
const CDDA_MESSAGE_FORGETIT: c_int = 0;
/// `PARANOIA_MODE_FULL` (0xff) includes `PARANOIA_MODE_NEVERSKIP`: never silently skip a sector.
const PARANOIA_MODE_FULL: c_int = 0xff;
const SEEK_SET: c_int = 0;

// `paranoia_cb_mode_t` values (paranoia.h).
const CB_FIXUP_EDGE: usize = 2;
const CB_FIXUP_ATOM: usize = 3;
const CB_SKIP: usize = 6;
const CB_FIXUP_DROPPED: usize = 10;
const CB_FIXUP_DUPED: usize = 11;
const CB_READERR: usize = 12;
const CB_CACHEERR: usize = 13;

/// Paranoia's callback has no user-data argument, so events are counted in statics. The helper
/// runs one rip at a time, and the counts are reset before every secure read.
static EVENT_COUNTS: [AtomicU32; 16] = [const { AtomicU32::new(0) }; 16];

/// Where (in sectors from the start of the disc) the reader last gave up or hit a hard error: first and last, -1 for none.
/// Paranoia reports positions in 16-bit samples per channel pairs; 588 of them make one sector.
static FIRST_PROBLEM: AtomicI64 = AtomicI64::new(-1);
static LAST_PROBLEM: AtomicI64 = AtomicI64::new(-1);
const SAMPLES_PER_SECTOR: i64 = 588;

fn note_problem(lsn: i64) {
    if lsn < 0 {
        return;
    }
    let first = FIRST_PROBLEM.load(Ordering::Relaxed);
    if first < 0 || lsn < first {
        FIRST_PROBLEM.store(lsn, Ordering::Relaxed);
    }
    if lsn > LAST_PROBLEM.load(Ordering::Relaxed) {
        LAST_PROBLEM.store(lsn, Ordering::Relaxed);
    }
}

extern "C" fn on_paranoia_event(position: c_long, event: c_int) {
    if matches!(usize::try_from(event), Ok(CB_SKIP | CB_READERR)) {
        note_problem(i64::from(position) / SAMPLES_PER_SECTOR);
    }
    if let Some(slot) = usize::try_from(event)
        .ok()
        .and_then(|index| EVENT_COUNTS.get(index))
    {
        slot.fetch_add(1, Ordering::Relaxed);
    }
}

extern "C" fn on_log(_level: c_int, message: *const c_char) {
    if !message.is_null() {
        // SAFETY: libcdio passes a NUL-terminated string valid for the duration of the call.
        let text = unsafe { CStr::from_ptr(message) }.to_string_lossy();
        eprintln!("libcdio: {}", text.trim_end());
    }
}

/// `cdio_hwinfo_t`: 8 + 16 + 4 characters plus terminators.
#[repr(C)]
struct HwInfo {
    vendor: [c_char; 9],
    model: [c_char; 17],
    revision: [c_char; 5],
}

unsafe extern "C" {
    fn cdio_log_set_handler(handler: Option<extern "C" fn(c_int, *const c_char)>) -> *const c_void;
    fn cdio_open(source: *const c_char, driver: c_int) -> *mut CdIo;
    fn cdio_destroy(cdio: *mut CdIo);
    fn cdio_get_devices(driver: c_int) -> *mut *mut c_char;
    fn cdio_free_device_list(list: *mut *mut c_char);
    fn cdio_get_hwinfo(cdio: *const CdIo, info: *mut HwInfo) -> bool;
    fn cdio_get_first_track_num(cdio: *const CdIo) -> u8;
    fn cdio_get_num_tracks(cdio: *const CdIo) -> u8;
    fn cdio_get_track_lsn(cdio: *const CdIo, track: u8) -> i32;
    fn cdio_get_track_last_lsn(cdio: *const CdIo, track: u8) -> i32;
    fn cdio_get_track_format(cdio: *const CdIo, track: u8) -> c_int;
    fn cdio_get_cdtext(cdio: *mut CdIo) -> *mut c_void;
    fn cdtext_get_const(cdtext: *const c_void, field: c_int, track: u8) -> *const c_char;
    fn cdio_read_audio_sectors(
        cdio: *const CdIo,
        buffer: *mut c_void,
        lsn: i32,
        blocks: u32,
    ) -> i32;

    fn cdio_cddap_identify(
        device: *const c_char,
        message_dest: c_int,
        messages: *mut *mut c_char,
    ) -> *mut CddaDrive;
    fn cdio_cddap_open(drive: *mut CddaDrive) -> c_int;
    fn cdio_cddap_close(drive: *mut CddaDrive) -> c_int;
    fn cdio_paranoia_init(drive: *mut CddaDrive) -> *mut Paranoia;
    fn cdio_paranoia_free(paranoia: *mut Paranoia);
    fn cdio_paranoia_modeset(paranoia: *mut Paranoia, mode: c_int);
    fn cdio_paranoia_seek(paranoia: *mut Paranoia, seek: i32, mode: c_int) -> i32;
    fn cdio_paranoia_read(
        paranoia: *mut Paranoia,
        callback: Option<extern "C" fn(c_long, c_int)>,
    ) -> *mut i16;
    fn cdio_paranoia_read_limited(
        paranoia: *mut Paranoia,
        callback: Option<extern "C" fn(c_long, c_int)>,
        max_retries: c_int,
    ) -> *mut i16;
    fn cdio_paranoia_cachemodel_size(paranoia: *mut Paranoia, sectors: c_int) -> c_int;
}

/// Sends libcdio's own log output to stderr. Call once at startup.
pub fn route_logs_to_stderr() {
    // SAFETY: `on_log` has the signature libcdio expects and lives for the whole program.
    unsafe { cdio_log_set_handler(Some(on_log)) };
}

fn text(field: &[c_char]) -> String {
    // SAFETY: libcdio NUL-terminates these fixed-size fields; the arrays are zero-initialised.
    unsafe { CStr::from_ptr(field.as_ptr()) }
        .to_string_lossy()
        .trim()
        .to_owned()
}

/// Device paths of every optical drive libcdio finds, for example `\\.\E:`.
pub fn list_devices() -> Vec<String> {
    // SAFETY: the list is NULL-terminated, owned by libcdio, and freed before returning.
    unsafe {
        let list = cdio_get_devices(DRIVER_DEVICE);
        if list.is_null() {
            return Vec::new();
        }
        let mut devices = Vec::new();
        let mut cursor = list;
        while !(*cursor).is_null() {
            devices.push(CStr::from_ptr(*cursor).to_string_lossy().into_owned());
            cursor = cursor.add(1);
        }
        cdio_free_device_list(list);
        devices
    }
}

/// The secure reader: a libcdio-paranoia session on its own handle to the drive.
struct SecureReader {
    drive: *mut CddaDrive,
    paranoia: *mut Paranoia,
    /// Where the next sequential read would start, so continuing reads skip the seek and keep
    /// paranoia's overlap context.
    next_lsn: Option<u32>,
    /// How many times paranoia re-reads a block before giving up on it (and says so).
    retries: c_int,
}

/// Re-reads before a block is given up on. Paranoia's own default is 20; a retry pass over a damaged track uses more.
pub const DEFAULT_RETRIES: u32 = 20;

impl SecureReader {
    fn open(device: &str, cache_sectors: Option<u32>, retries: u32) -> Result<Self, DriveError> {
        let path = CString::new(device)
            .map_err(|_| DriveError::ReadFailed("invalid device path".to_owned()))?;
        // SAFETY: `path` outlives the calls; every returned pointer is checked before use, and
        // anything already created is released on the failure paths.
        unsafe {
            let drive =
                cdio_cddap_identify(path.as_ptr(), CDDA_MESSAGE_FORGETIT, std::ptr::null_mut());
            if drive.is_null() {
                return Err(DriveError::ReadFailed(format!(
                    "{device} is not an audio-capable drive"
                )));
            }
            if cdio_cddap_open(drive) != 0 {
                cdio_cddap_close(drive);
                return Err(DriveError::ReadFailed(
                    "could not open the drive for secure reading".to_owned(),
                ));
            }
            let paranoia = cdio_paranoia_init(drive);
            if paranoia.is_null() {
                cdio_cddap_close(drive);
                return Err(DriveError::ReadFailed(
                    "could not start the secure reader".to_owned(),
                ));
            }
            cdio_paranoia_modeset(paranoia, PARANOIA_MODE_FULL);
            if let Some(sectors) = cache_sectors {
                cdio_paranoia_cachemodel_size(paranoia, sectors as c_int);
            }
            Ok(Self {
                drive,
                paranoia,
                next_lsn: None,
                retries: retries.clamp(1, 500) as c_int,
            })
        }
    }

    fn read(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
        cancel: Option<&AtomicBool>,
    ) -> Result<ReadQuality, DriveError> {
        for count in &EVENT_COUNTS {
            count.store(0, Ordering::Relaxed);
        }
        FIRST_PROBLEM.store(-1, Ordering::Relaxed);
        LAST_PROBLEM.store(-1, Ordering::Relaxed);
        out.clear();
        out.reserve(sectors as usize * SECTOR_BYTES);
        // Blocks the reader returned nothing for at all (a drive that stopped answering): silence stands in for them
        // and they are counted as skipped, so one bad block never loses the whole rip. A drive that fails over and
        // over is given up on.
        let (mut failed, mut in_a_row) = (0u32, 0u32);
        // SAFETY: `self.paranoia` is valid; each non-null result points to one full sector
        // (SECTOR_BYTES bytes) that stays valid until the next read call, and is copied at once.
        unsafe {
            if self.next_lsn != Some(lsn) {
                cdio_paranoia_seek(self.paranoia, lsn as i32, SEEK_SET);
            }
            for sector in 0..sectors {
                // Cancel is looked at before every sector, not only between the 750-sector segments: a damaged spot can keep one segment going for many minutes (D157).
                if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                    self.next_lsn = None;
                    return Err(DriveError::Cancelled);
                }
                let data = cdio_paranoia_read_limited(
                    self.paranoia,
                    Some(on_paranoia_event),
                    self.retries,
                );
                if data.is_null() {
                    failed += 1;
                    in_a_row += 1;
                    note_problem(i64::from(lsn + sector));
                    if in_a_row >= 25 {
                        self.next_lsn = None;
                        return Err(DriveError::ReadFailed(format!(
                            "the drive stopped answering at sector {}",
                            lsn + sector
                        )));
                    }
                    out.extend(std::iter::repeat_n(0u8, SECTOR_BYTES));
                    cdio_paranoia_seek(self.paranoia, (lsn + sector + 1) as i32, SEEK_SET);
                    continue;
                }
                in_a_row = 0;
                out.extend_from_slice(std::slice::from_raw_parts(data.cast::<u8>(), SECTOR_BYTES));
            }
        }
        self.next_lsn = Some(lsn + sectors);

        let count = |index: usize| EVENT_COUNTS[index].load(Ordering::Relaxed);
        let (first, last) = (
            FIRST_PROBLEM.load(Ordering::Relaxed),
            LAST_PROBLEM.load(Ordering::Relaxed),
        );
        Ok(ReadQuality {
            secure: true,
            repair_events: count(CB_FIXUP_EDGE)
                + count(CB_FIXUP_ATOM)
                + count(CB_FIXUP_DROPPED)
                + count(CB_FIXUP_DUPED),
            skipped_sectors: count(CB_SKIP) + count(CB_READERR) + failed,
            cache_errors: count(CB_CACHEERR),
            first_problem_lsn: u32::try_from(first).ok(),
            last_problem_lsn: u32::try_from(last).ok(),
        })
    }
}

impl Drop for SecureReader {
    fn drop(&mut self) {
        // SAFETY: both pointers came from the matching init calls and are released exactly once,
        // paranoia first because it refers to the drive.
        unsafe {
            cdio_paranoia_free(self.paranoia);
            cdio_cddap_close(self.drive);
        }
    }
}

pub struct LibcdioDrive {
    cdio: *mut CdIo,
    device: String,
    identity: DriveIdentity,
    secure: Option<SecureReader>,
    /// Cache model for the secure reader, in sectors (libcdio-paranoia's default is 1200).
    pub cache_sectors: Option<u32>,
    /// Re-reads before a block is given up on (None: [`DEFAULT_RETRIES`]).
    pub retries: Option<u32>,
    /// Raised when the person cancels; the secure reader looks at it before every sector.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl LibcdioDrive {
    pub fn open(device: &str) -> Result<Self, DriveError> {
        let path = CString::new(device)
            .map_err(|_| DriveError::ReadFailed("invalid device path".to_owned()))?;
        // SAFETY: `path` outlives the call; a NULL result is handled.
        let cdio = unsafe { cdio_open(path.as_ptr(), DRIVER_DEVICE) };
        if cdio.is_null() {
            return Err(DriveError::ReadFailed(format!("could not open {device}")));
        }

        let mut info = HwInfo {
            vendor: [0; 9],
            model: [0; 17],
            revision: [0; 5],
        };
        // SAFETY: `cdio` is valid and `info` matches the C struct layout.
        let known = unsafe { cdio_get_hwinfo(cdio, &mut info) };
        let identity = DriveIdentity {
            vendor: if known {
                text(&info.vendor)
            } else {
                String::new()
            },
            model: if known {
                text(&info.model)
            } else {
                String::new()
            },
            revision: if known {
                text(&info.revision)
            } else {
                String::new()
            },
            // libcdio does not say how the drive is attached; see ADR 0004.
            connection: Connection::Unknown,
        };
        Ok(Self {
            cdio,
            device: device.to_owned(),
            identity,
            secure: None,
            cache_sectors: None,
            retries: None,
            cancel: None,
        })
    }
}

/// What the disc itself says about its contents (CD-Text, stored in the lead-in by many newer pressings): the album and
/// artist (track 0) and a title and artist for each track. Empty strings are left out as `None`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CdText {
    pub album: Option<String>,
    pub artist: Option<String>,
    /// `(title, artist)` for each track, first track first.
    pub tracks: Vec<(Option<String>, Option<String>)>,
}

/// `cdtext_field_t` values in libcdio's cdtext.h.
const CDTEXT_FIELD_TITLE: c_int = 0;
const CDTEXT_FIELD_PERFORMER: c_int = 1;

impl LibcdioDrive {
    /// The disc's CD-Text, or `None` when the disc has none (most older discs) or the drive cannot read it.
    pub fn read_cdtext(&mut self) -> Option<CdText> {
        // SAFETY: `self.cdio` is valid; the returned cdtext object is owned by libcdio and lives as long as `cdio`. Every
        // string pointer is NULL or a NUL-terminated string valid until the next call, and is copied at once.
        unsafe {
            let cdtext = cdio_get_cdtext(self.cdio);
            if cdtext.is_null() {
                return None;
            }
            let get = |field: c_int, track: u8| -> Option<String> {
                let pointer = cdtext_get_const(cdtext, field, track);
                if pointer.is_null() {
                    return None;
                }
                let value = CStr::from_ptr(pointer).to_string_lossy().trim().to_owned();
                (!value.is_empty()).then_some(value)
            };
            let first = cdio_get_first_track_num(self.cdio);
            let count = cdio_get_num_tracks(self.cdio);
            if first == CDIO_INVALID_TRACK || count == 0 {
                return None;
            }
            let found = CdText {
                album: get(CDTEXT_FIELD_TITLE, 0),
                artist: get(CDTEXT_FIELD_PERFORMER, 0),
                tracks: (first..first + count)
                    .map(|number| {
                        (
                            get(CDTEXT_FIELD_TITLE, number),
                            get(CDTEXT_FIELD_PERFORMER, number),
                        )
                    })
                    .collect(),
            };
            let any_title = found.tracks.iter().any(|(title, _)| title.is_some());
            (any_title || found.album.is_some()).then_some(found)
        }
    }
}

impl Drop for LibcdioDrive {
    fn drop(&mut self) {
        self.secure = None; // release the secure session before the plain handle
        // SAFETY: `cdio` came from `cdio_open` and is destroyed exactly once.
        unsafe { cdio_destroy(self.cdio) };
    }
}

impl OpticalDrive for LibcdioDrive {
    fn identity(&self) -> DriveIdentity {
        self.identity.clone()
    }

    fn read_toc(&mut self) -> Result<Toc, DriveError> {
        // SAFETY: `self.cdio` is valid for the lifetime of `self`.
        unsafe {
            let first = cdio_get_first_track_num(self.cdio);
            let count = cdio_get_num_tracks(self.cdio);
            if first == CDIO_INVALID_TRACK || count == 0 {
                return Err(DriveError::NoDisc);
            }
            let tracks = (first..first + count)
                .map(|number| TocTrack {
                    number,
                    start_lsn: cdio_get_track_lsn(self.cdio, number).max(0) as u32,
                    end_lsn: cdio_get_track_last_lsn(self.cdio, number).max(0) as u32,
                    audio: cdio_get_track_format(self.cdio, number) == TRACK_FORMAT_AUDIO,
                })
                .collect();
            let leadout = cdio_get_track_lsn(self.cdio, CDIO_CDROM_LEADOUT_TRACK);
            Ok(Toc {
                tracks,
                leadout_lsn: leadout.max(0) as u32,
            })
        }
    }

    fn read_audio(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
    ) -> Result<Duration, DriveError> {
        out.clear();
        out.resize(sectors as usize * SECTOR_BYTES, 0);
        let started = Instant::now();
        // SAFETY: `out` has room for `sectors` raw sectors and `self.cdio` is valid.
        let code = unsafe {
            cdio_read_audio_sectors(self.cdio, out.as_mut_ptr().cast(), lsn as i32, sectors)
        };
        let elapsed = started.elapsed();
        match code {
            DRIVER_OP_SUCCESS => Ok(elapsed),
            // Windows error 87 (invalid parameter) is how an oversized transfer is rejected.
            DRIVER_OP_BAD_PARAMETER => Err(DriveError::TransferTooLarge {
                requested: sectors,
                max: 0,
            }),
            other => Err(DriveError::ReadFailed(format!(
                "libcdio error {other} at sector {lsn}"
            ))),
        }
    }

    fn read_audio_secure(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
    ) -> Result<ReadQuality, DriveError> {
        if self.secure.is_none() {
            self.secure = Some(SecureReader::open(
                &self.device,
                self.cache_sectors,
                self.retries.unwrap_or(DEFAULT_RETRIES),
            )?);
        }
        let reader = self
            .secure
            .as_mut()
            .expect("secure reader was just created");
        reader.read(lsn, sectors, out, self.cancel.as_deref())
    }
}
