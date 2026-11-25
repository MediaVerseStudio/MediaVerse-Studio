//! A simulated optical drive for tests: a synthetic audio disc read through a drive with a chosen
//! read offset, cache size and transfer limit, and plausible timing. It lets the calibration logic
//! be verified without hardware. Timing numbers are modelled on the development drive (cache hit
//! about 0.3 ms, short seek about 8-20 ms, long seek about 100 ms).

use crate::profile::{Connection, DriveIdentity};
use crate::{DriveError, OpticalDrive, SECTOR_BYTES, Toc, TocTrack};
use std::collections::{HashSet, VecDeque};
use std::time::Duration;

const SAMPLES_PER_SECTOR: i64 = 588;

pub struct SimulatedDrive {
    identity: DriveIdentity,
    toc: Toc,
    seed: u32,
    /// Conventional read offset: positive means the track appears this many samples later.
    pub offset: i32,
    pub cache_sectors: usize,
    pub max_transfer: u32,
    /// When set, reads of this sector fail, to model damage.
    pub bad_sector: Option<u32>,
    cache_order: VecDeque<u32>,
    cache_members: HashSet<u32>,
    head: u32,
    pub reads: u32,
}

impl SimulatedDrive {
    /// Builds a disc whose audio tracks have the given lengths in sectors.
    pub fn with_disc(
        track_sectors: &[u32],
        offset: i32,
        cache_sectors: usize,
        max_transfer: u32,
    ) -> Self {
        let mut tracks = Vec::new();
        let mut start = 0u32;
        for (index, &sectors) in track_sectors.iter().enumerate() {
            tracks.push(TocTrack {
                number: index as u8 + 1,
                start_lsn: start,
                end_lsn: start + sectors - 1,
                audio: true,
            });
            start += sectors;
        }
        Self {
            identity: DriveIdentity {
                vendor: "SIMDRIVE".to_owned(),
                model: "Test Drive".to_owned(),
                revision: "1.00".to_owned(),
                connection: Connection::Internal,
            },
            toc: Toc {
                tracks,
                leadout_lsn: start,
            },
            seed: 0x9E37_79B9,
            offset,
            cache_sectors,
            max_transfer,
            bad_sector: None,
            cache_order: VecDeque::new(),
            cache_members: HashSet::new(),
            head: 0,
            reads: 0,
        }
    }

    /// The disc's true audio at absolute sample index `index` (zero outside the disc).
    fn disc_sample(&self, index: i64) -> u32 {
        let end = i64::from(self.toc.leadout_lsn) * SAMPLES_PER_SECTOR;
        if index < 0 || index >= end {
            return 0;
        }
        (index as u32)
            .wrapping_add(self.seed)
            .wrapping_mul(2_654_435_761)
            .rotate_left(13)
    }

    /// The true audio of a sector range, as an ideal drive with no offset would deliver it.
    pub fn disc_samples(&self, start_lsn: u32, sectors: u32) -> Vec<u32> {
        let first = i64::from(start_lsn) * SAMPLES_PER_SECTOR;
        (0..i64::from(sectors) * SAMPLES_PER_SECTOR)
            .map(|i| self.disc_sample(first + i))
            .collect()
    }

    fn remember(&mut self, lsn: u32) {
        if self.cache_sectors == 0 || !self.cache_members.insert(lsn) {
            return;
        }
        self.cache_order.push_back(lsn);
        while self.cache_order.len() > self.cache_sectors {
            if let Some(old) = self.cache_order.pop_front() {
                self.cache_members.remove(&old);
            }
        }
    }
}

impl OpticalDrive for SimulatedDrive {
    fn identity(&self) -> DriveIdentity {
        self.identity.clone()
    }

    fn read_toc(&mut self) -> Result<Toc, DriveError> {
        Ok(self.toc.clone())
    }

    fn read_audio(
        &mut self,
        lsn: u32,
        sectors: u32,
        out: &mut Vec<u8>,
    ) -> Result<Duration, DriveError> {
        if sectors == 0 || sectors > self.max_transfer {
            return Err(DriveError::TransferTooLarge {
                requested: sectors,
                max: self.max_transfer,
            });
        }
        if lsn + sectors > self.toc.leadout_lsn {
            return Err(DriveError::ReadFailed(
                "read past the end of the disc".to_owned(),
            ));
        }
        if let Some(bad) = self.bad_sector {
            if (lsn..lsn + sectors).contains(&bad) {
                return Err(DriveError::ReadFailed(format!("unreadable sector {bad}")));
            }
        }
        self.reads += 1;

        let milliseconds = if self.cache_members.contains(&lsn) {
            0.3
        } else {
            let distance = f64::from(lsn.abs_diff(self.head));
            8.0 + (distance / 1000.0).min(100.0)
        };

        out.clear();
        out.reserve(sectors as usize * SECTOR_BYTES);
        let first = i64::from(lsn) * SAMPLES_PER_SECTOR - i64::from(self.offset);
        for i in 0..i64::from(sectors) * SAMPLES_PER_SECTOR {
            out.extend_from_slice(&self.disc_sample(first + i).to_le_bytes());
        }
        for sector in lsn..lsn + sectors {
            self.remember(sector);
        }
        self.head = lsn + sectors;
        Ok(Duration::from_secs_f64(milliseconds / 1000.0))
    }
}
