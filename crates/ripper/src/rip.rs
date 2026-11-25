//! Track extraction with read-offset correction, AccurateRip verification, and the rip log
//! (ADR 0005). Pure logic over [`OpticalDrive`]; the native adapter supplies the secure reads.
//!
//! Terms used in the log, kept separate on purpose (see the CD ripping policy):
//! * extraction completed: we obtained audio for every sector of the track;
//! * read checks: how the drive/secure reader behaved (retries, skipped sectors);
//! * reference verification: whether the audio matched an AccurateRip entry.
//!
//! None of them is described as "bit-perfect" unless the reference matched, and even then it is
//! evidence, not a guarantee.

use crate::{DriveError, OpticalDrive, SECTOR_BYTES, Toc, TocTrack};
use mediaverse_accuraterip::{
    Pressing, SAMPLES_PER_SECTOR, TrackPosition, checksums, pack_samples,
};
use serde::Serialize;

const SAMPLES: i64 = SAMPLES_PER_SECTOR as i64;
/// Sectors per secure-read call (about ten seconds of audio).
const SECURE_SEGMENT_SECTORS: u32 = 750;

/// How trustworthy a block of audio is according to the reader that produced it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub struct ReadQuality {
    /// True when the secure (re-reading, cross-checking) reader was used.
    pub secure: bool,
    /// Repair events the reader reported (jitter fix-ups, dropped or duplicated samples). Counts
    /// events, not sectors; one sector can cause several.
    pub repair_events: u32,
    /// Times the reader gave up on a block or hit a hard read error. Above zero means the audio is
    /// suspect and must not be presented as verified.
    pub skipped_sectors: u32,
    /// Times the reader suspected the drive cache returned stale data.
    pub cache_errors: u32,
    /// The first and last sector (disc position) where the reader gave up or hit a hard read error, so a damaged
    /// stretch can be told to the person ("near 1:12 into track 5"). None when nothing was skipped.
    pub first_problem_lsn: Option<u32>,
    pub last_problem_lsn: Option<u32>,
}

impl ReadQuality {
    pub fn merge(&mut self, other: ReadQuality) {
        self.secure &= other.secure;
        self.repair_events += other.repair_events;
        self.skipped_sectors += other.skipped_sectors;
        self.cache_errors += other.cache_errors;
        self.first_problem_lsn = match (self.first_problem_lsn, other.first_problem_lsn) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.last_problem_lsn = match (self.last_problem_lsn, other.last_problem_lsn) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
}

/// One track's audio after offset correction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrackAudio {
    /// Exactly the track's samples (stereo pairs packed into `u32`).
    pub samples: Vec<u32>,
    pub quality: ReadQuality,
    /// Samples at the start / end that lie outside the readable disc and were filled with silence.
    pub padded_start: u32,
    pub padded_end: u32,
}

/// Position of a track within the disc, for AccurateRip's edge rules.
pub fn position_of(toc: &Toc, track: &TocTrack) -> TrackPosition {
    let audio: Vec<&TocTrack> = toc.tracks.iter().filter(|t| t.audio).collect();
    let first = audio.first().is_some_and(|t| t.number == track.number);
    let last = audio.last().is_some_and(|t| t.number == track.number);
    match (first, last) {
        (true, true) => TrackPosition::Only,
        (true, false) => TrackPosition::First,
        (false, true) => TrackPosition::Last,
        _ => TrackPosition::Middle,
    }
}

/// Reads one track and corrects it for the drive's read offset (conventional sign: positive means
/// the track appears later in the drive's output). Samples that would fall before the first or
/// after the last readable sector are filled with silence and counted in `padded_*`.
pub fn read_track(
    drive: &mut dyn OpticalDrive,
    toc: &Toc,
    track: &TocTrack,
    offset: i32,
    max_transfer: u32,
    secure: bool,
    progress: &mut dyn FnMut(u32, u32) -> bool,
) -> Result<TrackAudio, DriveError> {
    let wanted_start = i64::from(track.start_lsn) * SAMPLES;
    let wanted_end = (i64::from(track.end_lsn) + 1) * SAMPLES;
    // In the drive's output the wanted audio sits `offset` samples later.
    let (from, to) = (
        wanted_start + i64::from(offset),
        wanted_end + i64::from(offset),
    );

    let first_sector = from.div_euclid(SAMPLES).max(0);
    let last_sector = ((to - 1).div_euclid(SAMPLES)).min(i64::from(toc.leadout_lsn) - 1);
    let mut quality = ReadQuality {
        secure,
        ..ReadQuality::default()
    };
    let mut raw: Vec<u8> = Vec::new();
    if last_sector >= first_sector {
        let total = (last_sector - first_sector + 1) as u32;
        let mut chunk = Vec::new();
        let mut done = 0;
        // Plain reads are limited by the drive's transfer size; secure reads run in longer
        // segments so the reader keeps its overlap context between calls.
        let segment = if secure {
            SECURE_SEGMENT_SECTORS
        } else {
            max_transfer
        };
        while done < total {
            if !progress(done, total) {
                return Err(DriveError::Cancelled);
            }
            let count = (total - done).min(segment);
            let lsn = first_sector as u32 + done;
            let result = if secure {
                drive.read_audio_secure(lsn, count, &mut chunk)?
            } else {
                drive.read_audio(lsn, count, &mut chunk)?;
                ReadQuality::default()
            };
            quality.merge(ReadQuality {
                secure: secure && result.secure,
                ..result
            });
            raw.extend_from_slice(&chunk);
            done += count;
        }
    }

    // Place what we read on a timeline of drive positions, then cut out the wanted window.
    let readable = pack_samples(&raw);
    let readable_start = first_sector * SAMPLES;
    let mut samples = Vec::with_capacity((wanted_end - wanted_start) as usize);
    let (mut padded_start, mut padded_end) = (0u32, 0u32);
    for position in from..to {
        let index = position - readable_start;
        if index >= 0 && (index as usize) < readable.len() {
            samples.push(readable[index as usize]);
        } else {
            samples.push(0);
            if position < readable_start {
                padded_start += 1
            } else {
                padded_end += 1
            }
        }
    }
    debug_assert_eq!(raw.len() % SECTOR_BYTES, 0);
    Ok(TrackAudio {
        samples,
        quality,
        padded_start,
        padded_end,
    })
}

/// Outcome of comparing a track with the AccurateRip database. Distinct states, never merged.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verification {
    /// The checksum matched an entry. This is evidence of an accurate rip, not a guarantee.
    Matched {
        pressing: usize,
        version: u8,
        confidence: u8,
    },
    /// The disc has database entries but none matched this track.
    NoMatch,
    /// No database entry was available (disc not listed, lookup failed, or not attempted).
    Unavailable,
}

/// Compares a track's audio with every pressing's entry for it; the highest confidence wins.
pub fn verify_track(
    audio: &TrackAudio,
    position: TrackPosition,
    track_number: u8,
    pressings: &[Pressing],
) -> Verification {
    let entries: Vec<_> = pressings
        .iter()
        .enumerate()
        .filter_map(|(index, p)| {
            p.tracks
                .get(usize::from(track_number) - 1)
                .map(|e| (index, *e))
        })
        .collect();
    if entries.is_empty() {
        return Verification::Unavailable;
    }
    let sums = checksums(&audio.samples, position);
    let mut best: Option<Verification> = None;
    for (pressing, entry) in entries {
        for (version, value) in [(1u8, sums.v1), (2u8, sums.v2)] {
            if value == entry.checksum {
                let better = match &best {
                    Some(Verification::Matched { confidence, .. }) => {
                        entry.confidence > *confidence
                    }
                    _ => true,
                };
                if better {
                    best = Some(Verification::Matched {
                        pressing,
                        version,
                        confidence: entry.confidence,
                    });
                }
            }
        }
    }
    best.unwrap_or(Verification::NoMatch)
}

/// One line of the rip log.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TrackReport {
    pub number: u8,
    pub sectors: u32,
    pub quality: ReadQuality,
    pub padded_start_samples: u32,
    pub padded_end_samples: u32,
    pub checksum_v1: u32,
    pub checksum_v2: u32,
    pub verification: Verification,
    /// Where in the track (milliseconds from its start) the reader could not read cleanly: from, to. None when it could.
    pub problem_span_ms: Option<(u64, u64)>,
}

impl TrackReport {
    /// A short, honest summary for the log and the UI.
    pub fn summary(&self) -> String {
        let read = if self.quality.skipped_sectors > 0 {
            format!(
                "{} block(s) could not be read cleanly",
                self.quality.skipped_sectors
            )
        } else if self.quality.cache_errors > 0 {
            format!(
                "the reader suspected a stale drive cache {} time(s)",
                self.quality.cache_errors
            )
        } else if self.quality.secure {
            "secure read, no unreadable sectors".to_owned()
        } else {
            "single-pass read (not cross-checked)".to_owned()
        };
        let reference = match &self.verification {
            Verification::Matched { confidence, .. } => {
                format!("matched AccurateRip (confidence {confidence})")
            }
            Verification::NoMatch => "did not match AccurateRip".to_owned(),
            Verification::Unavailable => "AccurateRip reference unavailable".to_owned(),
        };
        format!("Track {}: {read}; {reference}", self.number)
    }
}

/// The stretch of the track the reader could not read cleanly, in milliseconds from the track's start (75 sectors a second).
pub fn problem_span(track: &TocTrack, quality: &ReadQuality) -> Option<(u64, u64)> {
    let (first, last) = (quality.first_problem_lsn?, quality.last_problem_lsn?);
    let ms = |lsn: u32| u64::from(lsn.saturating_sub(track.start_lsn)) * 1000 / 75;
    Some((ms(first), ms(last + 1)))
}

pub fn report_for(
    track: &TocTrack,
    audio: &TrackAudio,
    position: TrackPosition,
    pressings: &[Pressing],
) -> TrackReport {
    let sums = checksums(&audio.samples, position);
    TrackReport {
        number: track.number,
        sectors: track.sectors(),
        quality: audio.quality,
        padded_start_samples: audio.padded_start,
        padded_end_samples: audio.padded_end,
        checksum_v1: sums.v1,
        checksum_v2: sums.v2,
        verification: verify_track(audio, position, track.number, pressings),
        problem_span_ms: problem_span(track, &audio.quality),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::SimulatedDrive;
    use mediaverse_accuraterip::{TrackEntry, frame450_checksum};

    fn disc(offset: i32) -> SimulatedDrive {
        SimulatedDrive::with_disc(&[3000, 4000, 3500, 3000], offset, 30, 27)
    }

    /// What the database would hold for the simulated disc: v2 checksums of the true audio.
    fn database(drive: &mut SimulatedDrive) -> Vec<Pressing> {
        let toc = drive.read_toc().unwrap();
        let tracks = toc
            .tracks
            .iter()
            .map(|track| {
                let truth = drive.disc_samples(track.start_lsn, track.sectors());
                TrackEntry {
                    confidence: 7,
                    checksum: checksums(&truth, position_of(&toc, track)).v2,
                    frame450: frame450_checksum(&truth).unwrap(),
                }
            })
            .collect();
        vec![Pressing {
            id1: 1,
            id2: 2,
            cddb_id: 3,
            tracks,
        }]
    }

    #[test]
    fn corrects_the_offset_so_audio_equals_the_true_disc_audio() {
        for offset in [0, 6, -20, 667, -1200] {
            let mut drive = disc(offset);
            let toc = drive.read_toc().unwrap();
            let track = toc.tracks[1].clone();
            let audio = read_track(&mut drive, &toc, &track, offset, 27, false, &mut |_, _| {
                true
            })
            .unwrap();
            assert_eq!(
                audio.samples,
                drive.disc_samples(track.start_lsn, track.sectors()),
                "offset {offset}"
            );
            assert_eq!((audio.padded_start, audio.padded_end), (0, 0));
        }
    }

    #[test]
    fn every_track_verifies_including_the_first_and_last_at_the_disc_edges() {
        for offset in [6, -20, 667, -1200] {
            let mut drive = disc(offset);
            let toc = drive.read_toc().unwrap();
            let pressings = database(&mut drive);
            for track in &toc.tracks {
                let audio =
                    read_track(&mut drive, &toc, track, offset, 27, false, &mut |_, _| true)
                        .unwrap();
                let position = position_of(&toc, track);
                let verification = verify_track(&audio, position, track.number, &pressings);
                assert_eq!(
                    verification,
                    Verification::Matched {
                        pressing: 0,
                        version: 2,
                        confidence: 7
                    },
                    "track {} offset {offset}",
                    track.number
                );
            }
        }
    }

    #[test]
    fn audio_beyond_the_readable_disc_is_padded_and_counted() {
        let mut drive = disc(-20);
        let toc = drive.read_toc().unwrap();
        let first = read_track(
            &mut drive,
            &toc,
            &toc.tracks[0],
            -20,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        assert_eq!((first.padded_start, first.padded_end), (20, 0));
        assert!(first.samples[..20].iter().all(|&s| s == 0));

        let mut drive = disc(667);
        let last = read_track(
            &mut drive,
            &toc,
            &toc.tracks[3],
            667,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        assert_eq!((last.padded_start, last.padded_end), (0, 667));
    }

    #[test]
    fn a_wrong_offset_does_not_verify() {
        let mut drive = disc(6);
        let toc = drive.read_toc().unwrap();
        let pressings = database(&mut drive);
        let audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            0,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        assert_eq!(
            verify_track(&audio, TrackPosition::Middle, 2, &pressings),
            Verification::NoMatch
        );
    }

    #[test]
    fn an_absent_database_entry_is_unavailable_not_a_failure() {
        let mut drive = disc(6);
        let toc = drive.read_toc().unwrap();
        let audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        assert_eq!(
            verify_track(&audio, TrackPosition::Middle, 2, &[]),
            Verification::Unavailable
        );
    }

    #[test]
    fn corrupted_audio_is_a_no_match_and_the_report_says_so() {
        let mut drive = disc(6);
        let toc = drive.read_toc().unwrap();
        let pressings = database(&mut drive);
        let mut audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        audio.samples[1000] ^= 1; // one flipped bit
        let report = report_for(&toc.tracks[1], &audio, TrackPosition::Middle, &pressings);
        assert_eq!(report.verification, Verification::NoMatch);
        assert!(report.summary().contains("did not match AccurateRip"));
    }

    #[test]
    fn secure_reads_are_reported_and_skips_are_never_hidden() {
        struct Skippy(SimulatedDrive);
        impl OpticalDrive for Skippy {
            fn identity(&self) -> crate::profile::DriveIdentity {
                self.0.identity()
            }
            fn read_toc(&mut self) -> Result<Toc, DriveError> {
                self.0.read_toc()
            }
            fn read_audio(
                &mut self,
                l: u32,
                s: u32,
                o: &mut Vec<u8>,
            ) -> Result<std::time::Duration, DriveError> {
                self.0.read_audio(l, s, o)
            }
            fn read_audio_secure(
                &mut self,
                l: u32,
                s: u32,
                o: &mut Vec<u8>,
            ) -> Result<ReadQuality, DriveError> {
                // A real secure reader splits large requests itself.
                let (mut all, mut chunk, mut done) = (Vec::new(), Vec::new(), 0);
                while done < s {
                    let n = (s - done).min(27);
                    self.0.read_audio(l + done, n, &mut chunk)?;
                    all.extend_from_slice(&chunk);
                    done += n;
                }
                *o = all;
                Ok(ReadQuality {
                    secure: true,
                    repair_events: 1,
                    skipped_sectors: 1,
                    cache_errors: 0,
                    first_problem_lsn: Some(l + 3),
                    last_problem_lsn: Some(l + 4),
                })
            }
        }
        let mut drive = Skippy(disc(6));
        let toc = drive.read_toc().unwrap();
        let audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            true,
            &mut |_, _| true,
        )
        .unwrap();
        assert!(audio.quality.secure);
        assert!(audio.quality.skipped_sectors > 0);
        let report = report_for(&toc.tracks[1], &audio, TrackPosition::Middle, &[]);
        assert!(report.summary().contains("could not be read cleanly"));
        // The stretch is told in milliseconds from the track start (75 sectors a second): the first segment of the
        // track starts at its offset-corrected first sector, so the problem lies within the first second or so.
        let (from, to) = report.problem_span_ms.expect("a skipped block has a place");
        assert!(from <= to && to < 120_000, "{from}..{to}");
    }

    #[test]
    fn a_stale_cache_warning_is_surfaced_and_cancellation_stops_a_rip() {
        let mut drive = disc(6);
        let toc = drive.read_toc().unwrap();
        let audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        let mut stale = report_for(&toc.tracks[1], &audio, TrackPosition::Middle, &[]);
        stale.quality = ReadQuality {
            secure: true,
            cache_errors: 2,
            ..ReadQuality::default()
        };
        assert!(stale.summary().contains("stale drive cache 2 time(s)"));

        let result = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            false,
            &mut |done, _| done == 0,
        );
        assert_eq!(result, Err(DriveError::Cancelled));
    }

    #[test]
    fn a_plain_read_is_not_described_as_cross_checked() {
        let mut drive = disc(6);
        let toc = drive.read_toc().unwrap();
        let audio = read_track(
            &mut drive,
            &toc,
            &toc.tracks[1],
            6,
            27,
            false,
            &mut |_, _| true,
        )
        .unwrap();
        let report = report_for(&toc.tracks[1], &audio, TrackPosition::Middle, &[]);
        assert!(
            report
                .summary()
                .contains("single-pass read (not cross-checked)")
        );
        assert!(report.summary().contains("reference unavailable"));
    }
}
