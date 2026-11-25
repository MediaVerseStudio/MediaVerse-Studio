//! Drive test and calibration steps (ADR 0004): transfer limit, read repeatability, cache size,
//! and read offset. Every step is read-only, cancellable, and reports progress.

use crate::profile::{CacheSize, DriveProfile, Field, OffsetEvidence, Provenance};
use crate::{DriveError, OpticalDrive, SECTOR_BYTES, Toc};
use mediaverse_accuraterip::{
    Pressing, SAMPLES_PER_SECTOR, TrackEntry, TrackPosition, find_offsets_fast, pack_samples,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Sectors of audio read on each side of a track so the offset search can shift the window.
const MARGIN_SECTORS: u32 = 5;
const OFFSET_SEARCH_LIMIT: i32 = (MARGIN_SECTORS as usize * SAMPLES_PER_SECTOR) as i32;
/// The cache probe needs this many sectors of disc to keep its test regions apart.
const MIN_CACHE_TEST_SECTORS: u32 = 60_000;
const CACHE_TRIALS: usize = 3;
/// Intervening-sector counts tried by the cache test. A cache hit must survive this many reads.
const CACHE_SIZES: [u32; 20] = [
    0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 96, 128, 256, 512, 1200, 2400, 4800,
];

#[derive(Debug, Eq, PartialEq)]
pub enum CalibrationError {
    Drive(DriveError),
    Cancelled,
}

impl From<DriveError> for CalibrationError {
    fn from(error: DriveError) -> Self {
        Self::Drive(error)
    }
}

impl std::fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Drive(error) => write!(f, "{error}"),
            Self::Cancelled => write!(f, "calibration was cancelled"),
        }
    }
}

impl std::error::Error for CalibrationError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    ReadTest,
    CacheTest,
    OffsetCheck,
}

/// Cancellation and progress shared by every step.
pub struct Control<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a mut dyn FnMut(Step, u32, u32),
}

impl Control<'_> {
    fn check(&self) -> Result<(), CalibrationError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(CalibrationError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn report(&mut self, step: Step, done: u32, total: u32) {
        (self.progress)(step, done, total);
    }
}

/// Reads `sectors` starting at `lsn` in transfers of at most `max_transfer`, appending to `out`.
pub fn read_in_chunks(
    drive: &mut dyn OpticalDrive,
    lsn: u32,
    sectors: u32,
    max_transfer: u32,
    out: &mut Vec<u8>,
) -> Result<(), DriveError> {
    let mut chunk = Vec::new();
    let mut done = 0;
    while done < sectors {
        let count = (sectors - done).min(max_transfer);
        drive.read_audio(lsn + done, count, &mut chunk)?;
        out.extend_from_slice(&chunk);
        done += count;
    }
    Ok(())
}

/// Finds the largest transfer, up to `upper`, that the drive accepts. Assumes that if N sectors
/// work then fewer do too.
pub fn find_max_transfer(
    drive: &mut dyn OpticalDrive,
    lsn: u32,
    upper: u32,
    control: &mut Control,
) -> Result<u32, CalibrationError> {
    let mut buffer = Vec::new();
    drive.read_audio(lsn, 1, &mut buffer)?; // a single sector must work, or the drive is unusable
    let (mut low, mut high) = (1u32, upper.max(1));
    while low < high {
        control.check()?;
        let middle = (low + high).div_ceil(2);
        if drive.read_audio(lsn, middle, &mut buffer).is_ok() {
            low = middle
        } else {
            high = middle - 1
        }
    }
    Ok(low)
}

/// Reads the same region twice and reports whether both reads were identical.
pub fn reads_agree(
    drive: &mut dyn OpticalDrive,
    lsn: u32,
    sectors: u32,
    max_transfer: u32,
) -> Result<bool, DriveError> {
    let (mut first, mut second) = (Vec::new(), Vec::new());
    read_in_chunks(drive, lsn, sectors, max_transfer, &mut first)?;
    read_in_chunks(drive, lsn, sectors, max_transfer, &mut second)?;
    Ok(first == second)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct CacheMeasurement {
    pub size: CacheSize,
    pub cold_median_ms: f64,
    pub threshold_ms: f64,
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Estimates the drive's audio cache by timing re-reads (see `tools/cdprobe/cachetest.c`).
/// Returns `None` if the disc is too short to keep the test regions apart.
pub fn measure_cache(
    drive: &mut dyn OpticalDrive,
    toc: &Toc,
    max_transfer: u32,
    control: &mut Control,
) -> Result<Option<CacheMeasurement>, CalibrationError> {
    let leadout = toc.leadout_lsn;
    if leadout < MIN_CACHE_TEST_SECTORS {
        return Ok(None);
    }
    let base = leadout * 40 / 100;
    let (far_a, far_b) = (leadout / 10, leadout * 9 / 10);
    let mut sink = Vec::new();
    let mut timed = |drive: &mut dyn OpticalDrive, lsn: u32| -> Result<f64, DriveError> {
        drive.read_audio(lsn, 1, &mut sink).map(millis)
    };

    // Cold reads: never-touched sectors after a long seek away.
    let mut cold = Vec::new();
    for i in 0..8u32 {
        control.check()?;
        timed(drive, if i % 2 == 1 { far_a } else { far_b })?;
        cold.push(timed(drive, base + 30_000 + i * 97)?);
    }
    cold.sort_by(f64::total_cmp);
    let cold_median = cold[4];
    // A cache hit takes well under a millisecond; even a short seek takes several.
    let threshold = (cold_median * 0.25).min(2.0);

    let total = CACHE_SIZES.len() as u32;
    let mut cached_through = None;
    let mut uncached_at = None;
    for (step, &between) in CACHE_SIZES.iter().enumerate() {
        control.check()?;
        control.report(Step::CacheTest, step as u32, total);
        let mut hits = 0;
        for trial in 0..CACHE_TRIALS {
            let target = base + trial as u32 * 7919;
            timed(drive, if trial % 2 == 1 { far_a } else { far_b })?;
            timed(drive, target)?;
            if between > 0 {
                let mut scratch = Vec::new();
                read_in_chunks(drive, target + 1, between, max_transfer, &mut scratch)?;
            }
            if timed(drive, target)? < threshold {
                hits += 1;
            }
        }
        if hits * 2 > CACHE_TRIALS {
            cached_through = Some(between);
        } else {
            uncached_at = Some(between);
            break;
        }
    }
    control.report(Step::CacheTest, total, total);

    let size = match (cached_through, uncached_at) {
        (None, _) => CacheSize::None,
        (Some(through), Some(at)) => CacheSize::Between {
            cached_through: through,
            uncached_at: at,
        },
        (Some(through), None) => CacheSize::AtLeast { sectors: through },
    };
    Ok(Some(CacheMeasurement {
        size,
        cold_median_ms: cold_median,
        threshold_ms: threshold,
    }))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OffsetOutcome {
    /// At least two tracks matched the database at the same offset.
    Measured {
        offset: i32,
        tracks: Vec<u8>,
        versions: Vec<u8>,
    },
    /// Not enough usable database entries or tracks; ask for a disc that is in AccurateRip.
    NeedsDisc { reason: String },
    /// Tracks matched, but at different offsets, so nothing can be concluded.
    Inconclusive { reason: String },
}

/// Determines the read offset by ripping a few middle tracks and matching them against the
/// AccurateRip entries for the disc. `pressings` must belong to the disc in the drive.
pub fn determine_offset(
    drive: &mut dyn OpticalDrive,
    toc: &Toc,
    pressings: &[Pressing],
    max_transfer: u32,
    control: &mut Control,
) -> Result<OffsetOutcome, CalibrationError> {
    let audio_count = toc.tracks.iter().filter(|track| track.audio).count();
    // Middle tracks only (the first and last skip samples), with room for the margin on both sides.
    let candidates: Vec<_> = toc
        .tracks
        .iter()
        .filter(|track| track.audio && track.number > 1 && usize::from(track.number) < audio_count)
        .filter(|track| track.start_lsn >= MARGIN_SECTORS && track.sectors() > 460)
        .filter(|track| {
            pressings
                .iter()
                .any(|p| p.tracks.get(usize::from(track.number) - 1).is_some())
        })
        .collect();
    if candidates.len() < 2 {
        return Ok(OffsetOutcome::NeedsDisc {
            reason: "the disc has fewer than two usable middle tracks in the AccurateRip database"
                .to_owned(),
        });
    }

    // Spread the choice across the disc: first, middle and last candidate.
    let mut chosen = vec![
        candidates[0],
        candidates[candidates.len() / 2],
        candidates[candidates.len() - 1],
    ];
    chosen.dedup_by_key(|track| track.number);

    let mut by_offset: BTreeMap<i32, (Vec<u8>, Vec<u8>)> = BTreeMap::new();
    for (index, track) in chosen.iter().enumerate() {
        control.check()?;
        control.report(Step::OffsetCheck, index as u32, chosen.len() as u32);
        let mut pcm =
            Vec::with_capacity((track.sectors() + 2 * MARGIN_SECTORS) as usize * SECTOR_BYTES);
        read_in_chunks(
            drive,
            track.start_lsn - MARGIN_SECTORS,
            track.sectors() + 2 * MARGIN_SECTORS,
            max_transfer,
            &mut pcm,
        )?;
        let samples = pack_samples(&pcm);
        let expected: Vec<(usize, TrackEntry)> = pressings
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.tracks.get(usize::from(track.number) - 1).map(|e| (i, *e)))
            .collect();
        let found = find_offsets_fast(
            &samples,
            MARGIN_SECTORS as usize * SAMPLES_PER_SECTOR,
            track.sectors() as usize * SAMPLES_PER_SECTOR,
            TrackPosition::Middle,
            &expected,
            -OFFSET_SEARCH_LIMIT..=OFFSET_SEARCH_LIMIT,
        );
        for hit in found {
            let entry = by_offset.entry(hit.offset).or_default();
            if !entry.0.contains(&track.number) {
                entry.0.push(track.number);
            }
            if !entry.1.contains(&hit.version) {
                entry.1.push(hit.version);
            }
        }
    }
    control.report(Step::OffsetCheck, chosen.len() as u32, chosen.len() as u32);

    let agreed: Vec<_> = by_offset
        .iter()
        .filter(|(_, (tracks, _))| tracks.len() >= 2)
        .collect();
    match agreed.as_slice() {
        [] if by_offset.is_empty() => Ok(OffsetOutcome::NeedsDisc {
            reason:
                "no track matched the database; the disc may be a different pressing or damaged"
                    .to_owned(),
        }),
        [] => Ok(OffsetOutcome::Inconclusive {
            reason: "tracks matched at different offsets, or only one track matched".to_owned(),
        }),
        [(offset, (tracks, versions))] => Ok(OffsetOutcome::Measured {
            offset: **offset,
            tracks: tracks.clone(),
            versions: versions.clone(),
        }),
        _ => Ok(OffsetOutcome::Inconclusive {
            reason: "several different offsets each matched two tracks".to_owned(),
        }),
    }
}

pub struct CalibrationInput<'a> {
    /// AccurateRip pressings for the disc in the drive; empty if the disc is not in the database.
    pub pressings: &'a [Pressing],
    /// Human-readable disc label recorded as evidence, for example the AccurateRip ids.
    pub disc: String,
    pub date: String,
    pub app_version: String,
    /// The drive's existing profile, if any; values this run cannot improve are kept.
    pub existing: Option<DriveProfile>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CalibrationReport {
    pub profile: DriveProfile,
    pub offset: OffsetOutcome,
    pub cache: Option<CacheMeasurement>,
    pub warnings: Vec<String>,
}

/// Runs the full guided check and returns the updated profile.
pub fn calibrate(
    drive: &mut dyn OpticalDrive,
    input: &CalibrationInput,
    control: &mut Control,
) -> Result<CalibrationReport, CalibrationError> {
    let identity = drive.identity();
    let mut warnings = Vec::new();
    let mut profile = match input.existing.clone() {
        Some(existing) if !existing.is_stale_for(&identity) => existing,
        Some(_) => {
            warnings.push("The drive's firmware or connection changed, so earlier measurements were discarded.".to_owned());
            DriveProfile::new(identity.clone(), &input.app_version)
        }
        None => DriveProfile::new(identity.clone(), &input.app_version),
    };
    profile.identity = identity;
    profile.app_version = input.app_version.clone();

    let toc = drive.read_toc()?;
    let audio_start = toc
        .tracks
        .iter()
        .find(|track| track.audio)
        .map(|track| track.start_lsn);
    let Some(probe_lsn) = audio_start else {
        return Err(CalibrationError::Drive(DriveError::Unsupported(
            "the disc has no audio tracks".to_owned(),
        )));
    };

    // 1. Read test.
    control.report(Step::ReadTest, 0, 2);
    let max_transfer = find_max_transfer(drive, probe_lsn, 128, control)?;
    profile.max_transfer_sectors = Some(Field::measured(max_transfer));
    control.report(Step::ReadTest, 1, 2);
    let agree = reads_agree(drive, probe_lsn, 75, max_transfer)?;
    profile.repeat_reads_agree = Some(agree);
    if !agree {
        warnings.push("Repeated reads of the same sectors returned different data. Clean the disc or try another disc before trusting any result.".to_owned());
    }
    control.report(Step::ReadTest, 2, 2);

    // 2. Cache test.
    let cache = measure_cache(drive, &toc, max_transfer, control)?;
    match &cache {
        Some(measurement) => {
            profile.cache = Some(Field::measured(measurement.size));
            if matches!(measurement.size, CacheSize::AtLeast { .. }) {
                warnings.push("The drive's cache is larger than the largest size tested. Secure re-reads may be served from the cache; use a larger cache model.".to_owned());
            }
        }
        None => {
            warnings.push("The disc is too short for the cache test; use a longer disc.".to_owned())
        }
    }

    // 3. Offset check.
    let offset = if input.pressings.is_empty() {
        OffsetOutcome::NeedsDisc {
            reason: "this disc is not in the AccurateRip database".to_owned(),
        }
    } else {
        determine_offset(drive, &toc, input.pressings, max_transfer, control)?
    };
    match &offset {
        OffsetOutcome::Measured {
            offset,
            tracks,
            versions,
        } => {
            profile.read_offset = Some(Field::measured(*offset));
            profile.offset_evidence = Some(OffsetEvidence {
                disc: input.disc.clone(),
                tracks_matched: tracks.clone(),
                checksum_versions: versions.clone(),
                date: input.date.clone(),
            });
        }
        OffsetOutcome::NeedsDisc { reason } | OffsetOutcome::Inconclusive { reason } => {
            let kept = profile
                .read_offset
                .is_some_and(|f| f.provenance == Provenance::Measured);
            warnings.push(format!(
                "The read offset was not verified: {reason}.{}",
                if kept {
                    " The earlier measured offset was kept."
                } else {
                    ""
                }
            ));
        }
    }

    Ok(CalibrationReport {
        profile,
        offset,
        cache,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Connection, DriveIdentity};
    use crate::sim::SimulatedDrive;
    use mediaverse_accuraterip::{checksums, frame450_checksum};

    /// Ten 6,500-sector tracks: a 65,000-sector disc, long enough for the cache test.
    fn sim(offset: i32, cache: usize, max_transfer: u32) -> SimulatedDrive {
        SimulatedDrive::with_disc(&[6500; 10], offset, cache, max_transfer)
    }

    /// The AccurateRip entry a database would hold for the simulated disc (v2 checksums).
    fn pressing_for(drive: &mut SimulatedDrive) -> Pressing {
        let toc = drive.read_toc().unwrap();
        let count = toc.tracks.len();
        let tracks = toc
            .tracks
            .iter()
            .map(|track| {
                let truth = drive.disc_samples(track.start_lsn, track.sectors());
                let position = match track.number as usize {
                    1 => TrackPosition::First,
                    n if n == count => TrackPosition::Last,
                    _ => TrackPosition::Middle,
                };
                TrackEntry {
                    confidence: 20,
                    checksum: checksums(&truth, position).v2,
                    frame450: frame450_checksum(&truth).unwrap(),
                }
            })
            .collect();
        Pressing {
            id1: 1,
            id2: 2,
            cddb_id: 3,
            tracks,
        }
    }

    fn run<T>(f: impl FnOnce(&mut Control) -> T) -> T {
        let cancel = AtomicBool::new(false);
        let mut progress = |_: Step, _: u32, _: u32| {};
        f(&mut Control {
            cancel: &cancel,
            progress: &mut progress,
        })
    }

    #[test]
    fn finds_the_largest_working_transfer() {
        let mut drive = sim(0, 30, 27);
        assert_eq!(run(|c| find_max_transfer(&mut drive, 100, 128, c)), Ok(27));
        let mut generous = sim(0, 30, 200);
        assert_eq!(
            run(|c| find_max_transfer(&mut generous, 100, 128, c)),
            Ok(128)
        );
    }

    #[test]
    fn measures_a_small_cache_like_the_development_drive() {
        let mut drive = sim(0, 30, 27);
        let toc = drive.read_toc().unwrap();
        let measured = run(|c| measure_cache(&mut drive, &toc, 27, c))
            .unwrap()
            .unwrap();
        assert_eq!(
            measured.size,
            CacheSize::Between {
                cached_through: 28,
                uncached_at: 32
            }
        );
        assert!(measured.threshold_ms <= 2.0);
    }

    #[test]
    fn reports_no_cache_and_a_very_large_cache() {
        let mut none = sim(0, 0, 27);
        let toc = none.read_toc().unwrap();
        let measured = run(|c| measure_cache(&mut none, &toc, 27, c))
            .unwrap()
            .unwrap();
        assert_eq!(measured.size, CacheSize::None);

        let mut huge = sim(0, 100_000, 27);
        let measured = run(|c| measure_cache(&mut huge, &toc, 27, c))
            .unwrap()
            .unwrap();
        assert_eq!(measured.size, CacheSize::AtLeast { sectors: 4800 });
    }

    #[test]
    fn skips_the_cache_test_on_a_short_disc() {
        let mut drive = SimulatedDrive::with_disc(&[6500; 3], 0, 30, 27);
        let toc = drive.read_toc().unwrap();
        assert_eq!(run(|c| measure_cache(&mut drive, &toc, 27, c)), Ok(None));
    }

    #[test]
    fn measures_positive_and_negative_read_offsets() {
        for offset in [6, -20, 0, 667] {
            let mut drive = sim(offset, 30, 27);
            let pressing = pressing_for(&mut drive);
            let toc = drive.read_toc().unwrap();
            let outcome = run(|c| determine_offset(&mut drive, &toc, &[pressing], 27, c)).unwrap();
            match outcome {
                OffsetOutcome::Measured {
                    offset: found,
                    tracks,
                    versions,
                } => {
                    assert_eq!(found, offset);
                    assert!(tracks.len() >= 2);
                    assert_eq!(versions, vec![2]);
                }
                other => panic!("offset {offset}: {other:?}"),
            }
        }
    }

    #[test]
    fn asks_for_another_disc_when_the_database_has_no_entry() {
        let mut drive = sim(6, 30, 27);
        let toc = drive.read_toc().unwrap();
        let outcome = run(|c| determine_offset(&mut drive, &toc, &[], 27, c)).unwrap();
        assert!(matches!(outcome, OffsetOutcome::NeedsDisc { .. }));
    }

    #[test]
    fn a_wrong_pressing_is_not_reported_as_a_measured_offset() {
        let mut drive = sim(6, 30, 27);
        let mut pressing = pressing_for(&mut drive);
        for entry in &mut pressing.tracks {
            entry.checksum ^= 0xDEAD_BEEF;
            entry.frame450 ^= 0x1234_5678;
        }
        let toc = drive.read_toc().unwrap();
        let outcome = run(|c| determine_offset(&mut drive, &toc, &[pressing], 27, c)).unwrap();
        assert!(
            matches!(outcome, OffsetOutcome::NeedsDisc { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn full_calibration_builds_a_verified_profile() {
        let mut drive = sim(6, 30, 27);
        let pressing = pressing_for(&mut drive);
        let input = CalibrationInput {
            pressings: &[pressing],
            disc: "test-disc".to_owned(),
            date: "2026-10-31".to_owned(),
            app_version: "0.1.0".to_owned(),
            existing: None,
        };
        let mut steps = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut progress = |step: Step, _: u32, _: u32| {
            if steps.last() != Some(&step) {
                steps.push(step);
            }
        };
        let report = calibrate(
            &mut drive,
            &input,
            &mut Control {
                cancel: &cancel,
                progress: &mut progress,
            },
        )
        .unwrap();

        assert_eq!(
            steps,
            vec![Step::ReadTest, Step::CacheTest, Step::OffsetCheck]
        );
        assert!(report.profile.offset_is_verified());
        assert_eq!(report.profile.read_offset, Some(Field::measured(6)));
        assert_eq!(
            report.profile.max_transfer_sectors,
            Some(Field::measured(27))
        );
        assert_eq!(report.profile.repeat_reads_agree, Some(true));
        assert_eq!(
            report.profile.cache,
            Some(Field::measured(CacheSize::Between {
                cached_through: 28,
                uncached_at: 32
            }))
        );
        assert_eq!(
            report.profile.offset_evidence.as_ref().unwrap().disc,
            "test-disc"
        );
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    }

    #[test]
    fn calibration_without_a_database_entry_keeps_an_earlier_measured_offset() {
        let mut drive = sim(6, 30, 27);
        let mut existing = DriveProfile::new(drive.identity(), "0.1.0");
        existing.read_offset = Some(Field::measured(6));
        let input = CalibrationInput {
            pressings: &[],
            disc: String::new(),
            date: String::new(),
            app_version: "0.1.0".to_owned(),
            existing: Some(existing),
        };
        let report = run(|c| calibrate(&mut drive, &input, c)).unwrap();
        assert_eq!(report.profile.read_offset, Some(Field::measured(6)));
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("earlier measured offset was kept"))
        );
    }

    #[test]
    fn a_changed_firmware_revision_discards_earlier_measurements() {
        let mut drive = sim(6, 30, 27);
        let mut old_identity: DriveIdentity = drive.identity();
        old_identity.revision = "0.99".to_owned();
        old_identity.connection = Connection::Internal;
        let mut existing = DriveProfile::new(old_identity, "0.1.0");
        existing.read_offset = Some(Field::measured(99));
        let input = CalibrationInput {
            pressings: &[],
            disc: String::new(),
            date: String::new(),
            app_version: "0.1.0".to_owned(),
            existing: Some(existing),
        };
        let report = run(|c| calibrate(&mut drive, &input, c)).unwrap();
        assert_eq!(report.profile.read_offset, None);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("firmware or connection changed"))
        );
    }

    #[test]
    fn can_be_cancelled() {
        let mut drive = sim(6, 30, 27);
        let cancel = AtomicBool::new(true);
        let mut progress = |_: Step, _: u32, _: u32| {};
        let input = CalibrationInput {
            pressings: &[],
            disc: String::new(),
            date: String::new(),
            app_version: "0.1.0".to_owned(),
            existing: None,
        };
        let result = calibrate(
            &mut drive,
            &input,
            &mut Control {
                cancel: &cancel,
                progress: &mut progress,
            },
        );
        assert_eq!(result, Err(CalibrationError::Cancelled));
    }

    #[test]
    fn a_unreadable_disc_is_an_error_not_a_profile() {
        let mut drive = sim(6, 30, 27);
        drive.bad_sector = Some(0);
        let input = CalibrationInput {
            pressings: &[],
            disc: String::new(),
            date: String::new(),
            app_version: "0.1.0".to_owned(),
            existing: None,
        };
        assert!(matches!(
            run(|c| calibrate(&mut drive, &input, c)),
            Err(CalibrationError::Drive(_))
        ));
    }
}
