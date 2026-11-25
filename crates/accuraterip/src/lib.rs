//! AccurateRip checksums, database-entry parsing, disc IDs, and read-offset search.
//!
//! Pure computation with no I/O, so it is portable to Android and easy to test. Audio is CD-DA:
//! 16-bit stereo at 44.1 kHz, 588 stereo samples (2352 bytes) per sector.
//!
//! References: the AccurateRip checksum definition as implemented by CUETools
//! (`CUETools.AccurateRip`) and dBpoweramp's published description. Verify against real database
//! entries before relying on it; see `docs/decision-log.md` (D6).

pub const SAMPLES_PER_SECTOR: usize = 588;
pub const BYTES_PER_SAMPLE: usize = 4;
/// The first track skips this many leading samples, the last track this many trailing samples.
pub const FIRST_TRACK_SKIP: usize = 5 * SAMPLES_PER_SECTOR - 1;
pub const LAST_TRACK_SKIP: usize = 5 * SAMPLES_PER_SECTOR;

/// Which part of the disc a track covers; controls which samples the checksum skips.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackPosition {
    First,
    Middle,
    Last,
    /// A disc with only one track (skips both ends).
    Only,
}

/// Both checksum versions for the same audio.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Checksums {
    pub v1: u32,
    pub v2: u32,
}

/// Decodes little-endian 16-bit stereo PCM into packed 32-bit samples (left in the low half).
pub fn pack_samples(pcm: &[u8]) -> Vec<u32> {
    pcm.as_chunks::<BYTES_PER_SAMPLE>()
        .0
        .iter()
        .map(|frame| u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]))
        .collect()
}

/// Computes the v1 and v2 checksums of one track's samples. `samples` must be exactly the
/// track's audio, already corrected for the drive's read offset.
pub fn checksums(samples: &[u32], position: TrackPosition) -> Checksums {
    let skip_start = matches!(position, TrackPosition::First | TrackPosition::Only);
    let skip_end = matches!(position, TrackPosition::Last | TrackPosition::Only);
    let first = if skip_start { FIRST_TRACK_SKIP } else { 0 };
    let last = if skip_end {
        samples.len().saturating_sub(LAST_TRACK_SKIP)
    } else {
        samples.len()
    };

    let (mut v1, mut v2) = (0u32, 0u32);
    for (index, &sample) in samples.iter().enumerate().take(last).skip(first) {
        // Multipliers are 1-based positions counted from the start of the track.
        let product = u64::from(sample) * (index as u64 + 1);
        v1 = v1.wrapping_add(product as u32);
        v2 = v2
            .wrapping_add(product as u32)
            .wrapping_add((product >> 32) as u32);
    }
    Checksums { v1, v2 }
}

/// Checksum of the 588 samples of the sector 450 frames into the track, weighted 1..=588. Verified
/// against the database on a real disc (matches v1 weighting; see docs/decision-log.md).
pub fn frame450_checksum(samples: &[u32]) -> Option<u32> {
    let start = 450 * SAMPLES_PER_SECTOR;
    let window = samples.get(start..start + SAMPLES_PER_SECTOR)?;
    Some(
        window
            .iter()
            .enumerate()
            .fold(0u32, |sum, (index, &sample)| {
                sum.wrapping_add((u64::from(sample) * (index as u64 + 1)) as u32)
            }),
    )
}

/// One pressing's entry for one track in an AccurateRip response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TrackEntry {
    pub confidence: u8,
    pub checksum: u32,
    /// Checksum of the frame at sector 450 of the track (used for drive offset detection).
    pub frame450: u32,
}

/// One pressing: three disc IDs and a per-track entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pressing {
    pub id1: u32,
    pub id2: u32,
    pub cddb_id: u32,
    pub tracks: Vec<TrackEntry>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ParseError(pub String);

/// Parses a `dBAR-*.bin` response (a sequence of pressings).
pub fn parse_response(bytes: &[u8]) -> Result<Vec<Pressing>, ParseError> {
    let mut pressings = Vec::new();
    let mut position = 0;
    while position < bytes.len() {
        let header = bytes
            .get(position..position + 13)
            .ok_or_else(|| ParseError("truncated pressing header".to_owned()))?;
        let track_count = usize::from(header[0]);
        let word = |at: usize| {
            u32::from_le_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]])
        };
        let (id1, id2, cddb_id) = (word(1), word(5), word(9));
        position += 13;

        let mut tracks = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            let entry = bytes
                .get(position..position + 9)
                .ok_or_else(|| ParseError("truncated track entry".to_owned()))?;
            tracks.push(TrackEntry {
                confidence: entry[0],
                checksum: u32::from_le_bytes([entry[1], entry[2], entry[3], entry[4]]),
                frame450: u32::from_le_bytes([entry[5], entry[6], entry[7], entry[8]]),
            });
            position += 9;
        }
        pressings.push(Pressing {
            id1,
            id2,
            cddb_id,
            tracks,
        });
    }
    Ok(pressings)
}

/// AccurateRip disc IDs from track start sectors (LBA, first track normally 0) and the lead-out.
pub fn disc_ids(track_starts: &[u32], leadout: u32) -> (u32, u32, u32) {
    let (mut id1, mut id2) = (0u32, 0u32);
    let positions = track_starts.iter().copied().chain(std::iter::once(leadout));
    for (index, start) in positions.enumerate() {
        id1 = id1.wrapping_add(start);
        id2 = id2.wrapping_add(start.max(1).wrapping_mul(index as u32 + 1));
    }

    let digit_sum = |mut value: u32| {
        let mut sum = 0;
        while value > 0 {
            sum += value % 10;
            value /= 10;
        }
        sum
    };
    let seconds = |lba: u32| (lba + 150) / 75;
    let checksum: u32 = track_starts
        .iter()
        .map(|&start| digit_sum(seconds(start)))
        .sum();
    let first = track_starts.first().copied().unwrap_or(0);
    let total_seconds = seconds(leadout) - seconds(first);
    let cddb = ((checksum % 255) << 24) | (total_seconds << 8) | track_starts.len() as u32;
    (id1, id2, cddb)
}

/// URL of the database file for a disc.
pub fn database_url(track_count: usize, id1: u32, id2: u32, cddb_id: u32) -> String {
    let hex = format!("{id1:08x}");
    let digits: Vec<char> = hex.chars().collect();
    format!(
        "http://www.accuraterip.com/accuraterip/{}/{}/{}/dBAR-{track_count:03}-{id1:08x}-{id2:08x}-{cddb_id:08x}.bin",
        digits[7], digits[6], digits[5]
    )
}

/// A candidate read offset whose corrected audio matched a database checksum.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OffsetMatch {
    /// Conventional read offset in samples: positive when the track appears later in the drive's
    /// output than it should (so the first `offset` samples are discarded to correct it).
    pub offset: i32,
    pub version: u8,
    pub confidence: u8,
    pub pressing: usize,
}

/// Searches `offsets` for ones where the track's checksum matches any pressing.
///
/// `samples` holds the track plus `margin` extra samples before it and after it, exactly as read
/// by the drive (no offset correction). For candidate offset `x`, the corrected track is the
/// window starting at `margin + x`. Windows that would leave `samples` are skipped.
pub fn find_offsets(
    samples: &[u32],
    margin: usize,
    track_len: usize,
    position: TrackPosition,
    expected: &[(usize, TrackEntry)],
    offsets: std::ops::RangeInclusive<i32>,
) -> Vec<OffsetMatch> {
    let mut matches = Vec::new();
    for offset in offsets {
        let Some(start) = (margin as i64).checked_add(i64::from(offset)) else {
            continue;
        };
        if start < 0 || start as usize + track_len > samples.len() {
            continue;
        }
        let window = &samples[start as usize..start as usize + track_len];
        let sums = checksums(window, position);
        for &(pressing, entry) in expected {
            for (version, value) in [(1u8, sums.v1), (2u8, sums.v2)] {
                if value == entry.checksum {
                    matches.push(OffsetMatch {
                        offset,
                        version,
                        confidence: entry.confidence,
                        pressing,
                    });
                }
            }
        }
    }
    matches
}

/// Like [`find_offsets`], but first narrows the candidate offsets with the small sector-450
/// checksum, then confirms each candidate with the whole-track checksum. Orders of magnitude
/// faster over a wide offset range. Falls back to the full search when the track is too short for
/// a sector-450 checksum or no database entry carries one.
pub fn find_offsets_fast(
    samples: &[u32],
    margin: usize,
    track_len: usize,
    position: TrackPosition,
    expected: &[(usize, TrackEntry)],
    offsets: std::ops::RangeInclusive<i32>,
) -> Vec<OffsetMatch> {
    let usable = track_len > 451 * SAMPLES_PER_SECTOR
        && expected.iter().any(|(_, entry)| entry.frame450 != 0);
    if !usable {
        return find_offsets(samples, margin, track_len, position, expected, offsets);
    }

    let mut candidates = Vec::new();
    for offset in offsets {
        let start = margin as i64 + i64::from(offset);
        if start < 0 || start as usize + track_len > samples.len() {
            continue;
        }
        let Some(frame) = frame450_checksum(&samples[start as usize..]) else {
            continue;
        };
        if expected
            .iter()
            .any(|(_, entry)| entry.frame450 != 0 && entry.frame450 == frame)
        {
            candidates.push(offset);
        }
    }

    let mut matches = Vec::new();
    for offset in candidates {
        matches.extend(find_offsets(
            samples,
            margin,
            track_len,
            position,
            expected,
            offset..=offset,
        ));
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_search_agrees_with_the_full_search() {
        let margin = 200;
        let track_len = 452 * SAMPLES_PER_SECTOR;
        let disc: Vec<u32> = (0..track_len + 2 * margin)
            .map(|i| (i as u32).wrapping_mul(2_654_435_761).rotate_left(11))
            .collect();
        let shift = 13usize;
        let mut drive = vec![0u32; shift];
        drive.extend_from_slice(&disc);

        let truth = &disc[margin..margin + track_len];
        let sums = checksums(truth, TrackPosition::Middle);
        let entry = TrackEntry {
            confidence: 9,
            checksum: sums.v2,
            frame450: frame450_checksum(truth).unwrap(),
        };
        let expected = [(0usize, entry)];
        let fast = find_offsets_fast(
            &drive,
            margin,
            track_len,
            TrackPosition::Middle,
            &expected,
            -100..=100,
        );
        let full = find_offsets(
            &drive,
            margin,
            track_len,
            TrackPosition::Middle,
            &expected,
            -100..=100,
        );
        assert_eq!(fast, full);
        assert_eq!(fast.len(), 1);
        assert_eq!((fast[0].offset, fast[0].version), (13, 2));
    }

    #[test]
    fn v1_weights_each_sample_by_its_one_based_position() {
        // 1*10 + 2*20 + 3*30 = 140
        assert_eq!(checksums(&[10, 20, 30], TrackPosition::Middle).v1, 140);
    }

    #[test]
    fn v2_adds_the_high_half_of_each_product() {
        let samples = [0xFFFF_FFFF, 0xFFFF_FFFF];
        let sums = checksums(&samples, TrackPosition::Middle);
        // sample*1 = 0x0_FFFF_FFFF -> low 0xFFFF_FFFF, high 0
        // sample*2 = 0x1_FFFF_FFFE -> low 0xFFFF_FFFE, high 1
        assert_eq!(sums.v1, 0xFFFF_FFFFu32.wrapping_add(0xFFFF_FFFE));
        assert_eq!(sums.v2, sums.v1.wrapping_add(1));
    }

    #[test]
    fn first_and_last_tracks_skip_their_ends() {
        let samples = vec![1u32; 10_000];
        let first = checksums(&samples, TrackPosition::First).v1;
        let skipped: u64 = (FIRST_TRACK_SKIP as u64 + 1..=10_000).sum();
        assert_eq!(first, skipped as u32);

        let last = checksums(&samples, TrackPosition::Last).v1;
        let kept = 10_000 - LAST_TRACK_SKIP;
        assert_eq!(last, (kept as u64 * (kept as u64 + 1) / 2) as u32);
    }

    #[test]
    fn frame450_needs_a_long_enough_track_and_weights_from_one() {
        assert_eq!(frame450_checksum(&[0; 100]), None);
        let mut samples = vec![0u32; 451 * SAMPLES_PER_SECTOR];
        samples[450 * SAMPLES_PER_SECTOR] = 3;
        samples[450 * SAMPLES_PER_SECTOR + 1] = 5;
        assert_eq!(frame450_checksum(&samples), Some(3 + 2 * 5));
    }

    #[test]
    fn parses_pressings_and_rejects_truncated_data() {
        let mut bytes = vec![2u8];
        for word in [1u32, 2, 3] {
            bytes.extend(word.to_le_bytes());
        }
        for (confidence, checksum) in [(7u8, 0xAABBCCDDu32), (9, 5)] {
            bytes.push(confidence);
            bytes.extend(checksum.to_le_bytes());
            bytes.extend(0u32.to_le_bytes());
        }
        let parsed = parse_response(&bytes).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!((parsed[0].id1, parsed[0].id2, parsed[0].cddb_id), (1, 2, 3));
        assert_eq!(parsed[0].tracks[0].checksum, 0xAABBCCDD);
        assert_eq!(parsed[0].tracks[1].confidence, 9);
        assert!(parse_response(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn computes_the_ids_and_url_verified_against_a_real_disc() {
        // The Watchmen, "Brand New Day"; the database returned a valid entry for these IDs.
        let starts = [
            0, 15770, 32932, 48082, 64527, 79350, 93247, 109050, 125150, 143145, 162400, 182457,
        ];
        let (id1, id2, cddb) = disc_ids(&starts, 198_077);
        assert_eq!((id1, id2, cddb), (0x0013232b, 0x00b35ece, 0x860a510c));
        assert_eq!(
            database_url(12, id1, id2, cddb),
            "http://www.accuraterip.com/accuraterip/b/2/3/dBAR-012-0013232b-00b35ece-860a510c.bin"
        );
    }

    #[test]
    fn finds_a_known_offset_in_shifted_audio() {
        // Build "disc" audio, then simulate a drive with a +7 read offset: its output carries the
        // track 7 samples later than it should, so correcting means dropping 7 leading samples.
        let margin = 100;
        let track_len = 3_000;
        let disc: Vec<u32> = (0..track_len + 2 * margin)
            .map(|i| (i as u32).wrapping_mul(2_654_435_761).rotate_left(7))
            .collect();
        let drive_offset = 7usize;
        let mut drive = vec![0xDEAD_BEEFu32; drive_offset];
        drive.extend_from_slice(&disc);

        // Truth: the track is disc[margin..margin+track_len].
        let truth = checksums(&disc[margin..margin + track_len], TrackPosition::Middle);
        let entry = TrackEntry {
            confidence: 12,
            checksum: truth.v1,
            frame450: 0,
        };

        let found = find_offsets(
            &drive,
            margin,
            track_len,
            TrackPosition::Middle,
            &[(0, entry)],
            -50..=50,
        );
        assert_eq!(
            found,
            vec![OffsetMatch {
                offset: drive_offset as i32,
                version: 1,
                confidence: 12,
                pressing: 0
            }]
        );
    }
}
