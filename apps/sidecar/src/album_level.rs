//! Volume levelling by the album (owner, 2026-11-23, issue #6). Levelling every song to the same loudness on its own turns a soft acoustic song up as far as
//! a loud one and turns a song with a few intense sections down until the rest of it is too quiet. Instead the whole album gets ONE gain, worked out from
//! the album as a whole (assuming its songs were ripped together), so the songs keep the loudness relationships the artist made: a quiet song stays quieter
//! than the loud one next to it. The single gain is then kept sensible by three things the loudness number alone does not know:
//!
//! 1. **The album's loud end.** However soft the album's average is, its loud passages must not be pushed past `LOUD_CEILING_LUFS` (an acoustic album with one
//!    intense song is not raised until that song is loud).
//! 2. **The recording's age.** Older recordings are quieter by nature, so to play at the same level as a modern album they need more lift, not less: the most
//!    an album may be turned up GROWS with its age (`max_boost_db`). It is only a safety valve for a recording that measures absurdly quiet (a bad transfer);
//!    an ordinary old album is lifted all the way to the common level.
//! 3. **The songs that are not music in the measurement:** a short sound clip, a spoken interlude or a near-silent hidden track would drag the album's
//!    figure around, so they are left out of the album's loudness (they still receive the album's gain).
//!
//! The strength is the person's choice: "gentle" applies 60 % of the correction, "standard" all of it. Pure functions, so it is unit tested.

use crate::loudness::Loudness;

/// The loudness quiet albums are brought up to, in LUFS: about where a modern master sits (owner, 2026-11-24: "bring quiet albums up to the standard of the
/// modern recordings"). Nothing is ever turned DOWN: an album already at or above this is left exactly as it was ripped.
pub const TARGET_LUFS: f64 = -12.0;
/// The loudest the loud passages of an album may become after the gain, in LUFS (3-second readings).
pub const LOUD_CEILING_LUFS: f64 = -8.0;
/// Songs shorter than this (in samples at 44.1 kHz, 20 seconds) are not counted in an album's loudness.
const MIN_SONG_SAMPLES: usize = 20 * 44_100;
/// A song this much quieter than the album's median (LU) is an interlude and is not counted.
const INTERLUDE_BELOW_MEDIAN_LU: f64 = 15.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strength {
    Off,
    Gentle,
    Standard,
}

impl Strength {
    pub fn parse(text: &str) -> Strength {
        match text {
            "off" => Strength::Off,
            "gentle" => Strength::Gentle,
            _ => Strength::Standard,
        }
    }
    fn share(self) -> f64 {
        match self {
            Strength::Off => 0.0,
            Strength::Gentle => 0.6,
            Strength::Standard => 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AlbumPlan {
    /// The album's integrated loudness (the songs that count), in LUFS.
    pub album_lufs: f64,
    /// The one gain the album would get, in dB, after the limits below.
    pub album_gain_db: f64,
    /// Each song's gain in dB, in the order given: the album's gain, lowered for a song only where its own peak would clip.
    pub gains_db: Vec<f64>,
    /// Why the gain is what it is, in plain words, for the Review page.
    pub reasons: Vec<String>,
}

/// The most an album of that year may be turned up, in dB. It grows with age: older recordings are quieter and need more lift to match a modern album.
/// Unknown years get a middle value.
pub fn max_boost_db(year: Option<i32>) -> f64 {
    match year {
        Some(y) if y >= 2000 => 10.0,
        Some(y) if y >= 1980 => 12.0,
        Some(y) if y >= 1960 => 15.0,
        Some(_) => 18.0,
        None => 12.0,
    }
}
fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// The album's loudness from the songs that count: energy weighted by length.
fn album_lufs(songs: &[&Loudness]) -> f64 {
    let total: usize = songs.iter().map(|s| s.samples).sum::<usize>().max(1);
    let energy: f64 = songs
        .iter()
        .map(|s| 10f64.powf((s.lufs + 0.691) / 10.0) * s.samples as f64)
        .sum::<f64>()
        / total as f64;
    -0.691 + 10.0 * energy.log10()
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Works out the gains for one album. `songs` are the album's songs as measured (at least one).
pub fn plan_album(songs: &[Loudness], year: Option<i32>, strength: Strength) -> AlbumPlan {
    let mut reasons = Vec::new();
    let mut counted: Vec<&Loudness> = songs
        .iter()
        .filter(|s| s.samples >= MIN_SONG_SAMPLES)
        .collect();
    if !counted.is_empty() {
        let mid = median(&mut counted.iter().map(|s| s.lufs).collect::<Vec<_>>());
        counted.retain(|s| s.lufs > mid - INTERLUDE_BELOW_MEDIAN_LU);
    }
    if counted.len() < songs.len() && !counted.is_empty() {
        reasons.push(format!(
            "{} short or very quiet song(s) were left out of the album's measurement",
            songs.len() - counted.len()
        ));
    }
    if counted.is_empty() {
        counted = songs.iter().collect();
    }
    let lufs = album_lufs(&counted);
    // Only ever up: a loud album is left alone (owner, 2026-11-24).
    let mut gain = (TARGET_LUFS - lufs).max(0.0);
    reasons.push(if gain > 0.0 {
        format!("the album measures {lufs:.1} LUFS, so {gain:+.1} dB brings it to {TARGET_LUFS:.0}")
    } else {
        format!("the album measures {lufs:.1} LUFS, which is already as loud as {TARGET_LUFS:.0}, so it is left as it is")
    });

    // 1. The loud end of the album.
    let loud_end = counted
        .iter()
        .map(|s| s.loud_end_lufs)
        .fold(f64::NEG_INFINITY, f64::max);
    if gain > 0.0 && loud_end + gain > LOUD_CEILING_LUFS {
        let limited = (LOUD_CEILING_LUFS - loud_end).max(0.0);
        reasons.push(format!(
            "its loud passages reach {loud_end:.1} LUFS, so the boost is held to {limited:+.1} dB"
        ));
        gain = limited;
    }
    // 2. The recording's age.
    let cap = max_boost_db(year);
    if gain > cap {
        reasons.push(match year {
            Some(y) => format!("a recording from {y} may be turned up by at most {cap:.0} dB (older recordings are quieter, so they are allowed more)"),
            None => format!("the year is unknown, so the boost is held to {cap:.0} dB"),
        });
        gain = cap;
    }
    // 3. The person's strength.
    gain *= strength.share();
    if strength == Strength::Gentle {
        reasons.push("gentle levelling: 60 % of the correction".to_owned());
    }
    let album_gain_db = round_tenth(gain);
    // A song's own peak may never clip.
    let gains_db = songs
        .iter()
        .map(|s| {
            if s.peak > 0.0 {
                round_tenth(album_gain_db.min(-20.0 * s.peak.log10()).max(0.0))
            } else {
                album_gain_db
            }
        })
        .collect();
    AlbumPlan {
        album_lufs: round_tenth(lufs),
        album_gain_db,
        gains_db,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(lufs: f64, loud_end: f64, peak: f64, seconds: usize) -> Loudness {
        Loudness {
            lufs,
            peak,
            gain_db: TARGET_LUFS - lufs,
            range_lu: 8.0,
            loud_end_lufs: loud_end,
            samples: seconds * 44_100,
        }
    }

    #[test]
    fn every_song_of_an_album_gets_the_same_gain_so_soft_songs_stay_soft() {
        let album = [
            song(-26.0, -22.0, 0.3, 200),
            song(-25.0, -21.0, 0.3, 210),
            song(-15.0, -11.0, 0.5, 240),
        ];
        let plan = plan_album(&album, Some(2005), Strength::Standard);
        assert!(
            plan.gains_db.windows(2).all(|w| (w[0] - w[1]).abs() < 1e-9),
            "{:?}",
            plan.gains_db
        );
        // The loud song does not set the gain alone and the soft songs are not raised to match it.
        let soft_after = -26.0 + plan.gains_db[0];
        let loud_after = -15.0 + plan.gains_db[2];
        assert!(
            loud_after - soft_after > 9.0,
            "the albums's own balance is kept ({soft_after} vs {loud_after})"
        );
    }

    #[test]
    fn an_acoustic_album_with_one_intense_song_is_not_raised_until_that_song_is_loud() {
        let album = [
            song(-27.0, -23.0, 0.3, 200),
            song(-26.0, -22.0, 0.3, 200),
            song(-24.0, -13.0, 0.6, 200),
        ];
        let plan = plan_album(&album, Some(2010), Strength::Standard);
        // The loud end after the gain stays at the ceiling at most.
        assert!(
            -13.0 + plan.album_gain_db <= LOUD_CEILING_LUFS + 0.05,
            "{}",
            plan.album_gain_db
        );
        assert!(plan.reasons.iter().any(|r| r.contains("loud passages")));
    }

    #[test]
    fn an_old_quiet_recording_is_turned_up_more_than_a_modern_one() {
        // The same quiet measurement from two eras: the older one is allowed the bigger lift.
        let album = [song(-34.0, -32.0, 0.2, 200), song(-33.0, -31.0, 0.2, 200)];
        let old = plan_album(&album, Some(1958), Strength::Standard);
        let newer = plan_album(&album, Some(2012), Strength::Standard);
        assert_eq!(
            newer.album_gain_db, 10.0,
            "a modern album is held to its smaller cap"
        );
        assert!(
            old.album_gain_db > newer.album_gain_db,
            "{} vs {}",
            old.album_gain_db,
            newer.album_gain_db
        );
        assert!(
            old.album_gain_db > 14.0,
            "an old album is lifted nearly all the way to the common level"
        );
        assert!(newer.reasons.iter().any(|r| r.contains("2012")));
        assert!(
            max_boost_db(Some(1955)) > max_boost_db(Some(1975))
                && max_boost_db(Some(1975)) > max_boost_db(Some(1990))
                && max_boost_db(Some(1990)) > max_boost_db(Some(2010))
        );
        assert_eq!(max_boost_db(None), 12.0);
    }

    #[test]
    fn an_ordinary_old_album_is_lifted_all_the_way_to_the_common_level() {
        let album = [song(-27.0, -24.0, 0.3, 200), song(-26.0, -23.0, 0.3, 200)];
        let plan = plan_album(&album, Some(1966), Strength::Standard);
        assert!(
            (plan.album_gain_db - (TARGET_LUFS - plan.album_lufs)).abs() < 0.11,
            "{plan:?}"
        );
    }

    #[test]
    fn a_loud_album_is_never_turned_down() {
        let album = [song(-8.0, -6.0, 1.0, 200), song(-7.5, -5.5, 1.0, 200)];
        let plan = plan_album(&album, Some(2008), Strength::Standard);
        assert_eq!(plan.album_gain_db, 0.0);
        assert!(plan.gains_db.iter().all(|&g| g == 0.0));
        // Not even a song whose peak is at full scale or beyond (a clipped master) is lowered.
        let clipped = [song(-9.0, -7.0, 1.2, 200)];
        assert_eq!(
            plan_album(&clipped, Some(2008), Strength::Standard).gains_db,
            vec![0.0]
        );
        assert!(plan.reasons.iter().any(|r| r.contains("left as it is")));
    }

    #[test]
    fn interludes_and_short_clips_do_not_drag_the_album_figure() {
        let with = [
            song(-12.0, -9.0, 0.8, 220),
            song(-12.5, -9.5, 0.8, 220),
            song(-45.0, -40.0, 0.01, 90),
            song(-14.0, -10.0, 0.8, 8),
        ];
        let without = [song(-12.0, -9.0, 0.8, 220), song(-12.5, -9.5, 0.8, 220)];
        let a = plan_album(&with, Some(2000), Strength::Standard);
        let b = plan_album(&without, Some(2000), Strength::Standard);
        assert_eq!(a.album_lufs, b.album_lufs);
        assert!(a.reasons.iter().any(|r| r.contains("left out")));
        assert_eq!(a.gains_db.len(), 4, "every song still receives the gain");
    }

    #[test]
    fn gentle_applies_part_of_the_correction_and_off_none() {
        let album = [song(-20.0, -17.0, 0.5, 200)];
        let full = plan_album(&album, Some(2005), Strength::Standard).album_gain_db;
        let gentle = plan_album(&album, Some(2005), Strength::Gentle).album_gain_db;
        assert!((gentle - full * 0.6).abs() < 0.11);
        assert_eq!(
            plan_album(&album, Some(2005), Strength::Off).album_gain_db,
            0.0
        );
        assert_eq!(Strength::parse("gentle"), Strength::Gentle);
        assert_eq!(Strength::parse("whatever"), Strength::Standard);
    }

    #[test]
    fn a_song_that_would_clip_gets_less_gain_than_the_album() {
        let album = [song(-24.0, -20.0, 0.2, 200), song(-24.5, -21.0, 0.97, 200)];
        let plan = plan_album(&album, Some(2005), Strength::Standard);
        assert!(plan.gains_db[1] < plan.gains_db[0]);
        assert!(plan.gains_db[1] <= -20.0 * 0.97f64.log10() + 0.05);
    }
}
