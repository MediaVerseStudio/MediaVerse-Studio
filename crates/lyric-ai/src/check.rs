//! Judging timed lyrics a song already has, and writing timed lyrics out as LRC text.

use crate::align::LineTime;
use serde::Serialize;

/// The aligner's line starts come out about 0.2 s after the singing starts (CTC letter spikes sit late in a sound) and timed lyrics are made to light a
/// line as it begins, so a line is written 0.2 s earlier than the aligner says.
pub const BIAS_SECONDS: f64 = 0.2;
/// The usual difference between this aligner and existing timings, in ms (the median over 100 songs).
pub const USUAL_OFFSET_MS: f64 = 180.0;

/// `[mm:ss.xx]` for a time in seconds.
pub fn lrc_stamp(seconds: f64) -> String {
    let s = seconds.max(0.0);
    let hundredths = (s * 100.0).round() as u64;
    format!(
        "[{:02}:{:02}.{:02}]",
        hundredths / 6000,
        hundredths / 100 % 60,
        hundredths % 100
    )
}

/// The lines as LRC text: each at its start less the bias; a line that could not be placed shares the time of the line before it.
pub fn to_lrc(lines: &[LineTime]) -> String {
    let mut out = String::new();
    let mut previous = 0.0f64;
    for line in lines {
        if let Some(start) = line.start {
            previous = previous.max(start - BIAS_SECONDS);
        }
        out.push_str(&lrc_stamp(previous));
        out.push_str(&line.text);
        out.push('\n');
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fit {
    /// The lines are where the singing is.
    Fits,
    /// All lines early or late by about the same amount: a correction of that size is proposed.
    Shifted,
    /// The offset grows through the song (timing made for another master): a re-timing is proposed.
    Drifts,
    /// Most lines are nowhere near the singing: probably the wrong words or another song.
    DoesNotFit,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Verdict {
    pub fit: Fit,
    pub offset_ms: f64,
    pub drift_ms_per_minute: f64,
    pub lines: usize,
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Least-squares line through (x, y), ignoring points far from the trend after a first fit: (slope, intercept).
fn trend(points: &[(f64, f64)]) -> (f64, f64) {
    let mut keep: Vec<bool> = vec![true; points.len()];
    let (mut slope, mut intercept) = (0.0, 0.0);
    for _ in 0..4 {
        let used: Vec<&(f64, f64)> = points
            .iter()
            .zip(&keep)
            .filter(|(_, k)| **k)
            .map(|(p, _)| p)
            .collect();
        if used.len() < 5 {
            break;
        }
        let n = used.len() as f64;
        let (sx, sy) = (
            used.iter().map(|p| p.0).sum::<f64>(),
            used.iter().map(|p| p.1).sum::<f64>(),
        );
        let (sxx, sxy) = (
            used.iter().map(|p| p.0 * p.0).sum::<f64>(),
            used.iter().map(|p| p.0 * p.1).sum::<f64>(),
        );
        let denominator = n * sxx - sx * sx;
        if denominator.abs() < 1e-9 {
            break;
        }
        slope = (n * sxy - sx * sy) / denominator;
        intercept = (sy - slope * sx) / n;
        keep = points
            .iter()
            .map(|p| (p.1 - (slope * p.0 + intercept)).abs() < 1500.0)
            .collect();
    }
    (slope, intercept)
}

/// `errors`: for each line that was placed, (its existing time in seconds, the aligner's start minus the existing one in milliseconds); at least 8.
pub fn verdict(errors: &[(f64, f64)]) -> Option<Verdict> {
    if errors.len() < 8 {
        return None;
    }
    let mut values: Vec<f64> = errors.iter().map(|e| e.1).collect();
    let offset = median(&mut values);
    let (slope_per_second, start) = trend(errors);
    let slope = slope_per_second * 60.0;
    let middle = (errors[0].0 + errors[errors.len() - 1].0) / 2.0;
    let trend_middle = start + slope_per_second * middle;
    let near = |shift: f64| {
        errors
            .iter()
            .filter(|e| (e.1 - shift).abs() <= 700.0)
            .count() as f64
            / errors.len() as f64
    };
    let off_usual = offset - USUAL_OFFSET_MS;
    let fit = if near(USUAL_OFFSET_MS) < 0.4 && near(offset) < 0.5 {
        Fit::DoesNotFit
    } else if slope.abs() > 250.0 && (trend_middle - USUAL_OFFSET_MS).abs() > 400.0 {
        Fit::Drifts
    } else if off_usual.abs() > 600.0 {
        Fit::Shifted
    } else {
        Fit::Fits
    };
    Some(Verdict {
        fit,
        offset_ms: offset.round(),
        drift_ms_per_minute: slope.round(),
        lines: errors.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(starts: &[Option<f64>]) -> Vec<LineTime> {
        starts
            .iter()
            .enumerate()
            .map(|(i, s)| LineTime {
                text: format!("line {i}"),
                start: *s,
                end: *s,
                score: None,
                words: vec![],
                flags: vec![],
            })
            .collect()
    }

    #[test]
    fn stamps_and_lrc_text() {
        assert_eq!(lrc_stamp(0.0), "[00:00.00]");
        assert_eq!(lrc_stamp(83.456), "[01:23.46]");
        assert_eq!(lrc_stamp(-1.0), "[00:00.00]");
        let text = to_lrc(&lines(&[Some(10.0), None, Some(12.0)]));
        assert_eq!(
            text,
            "[00:09.80]line 0\n[00:09.80]line 1\n[00:11.80]line 2\n"
        );
    }

    fn series(offset: f64, slope_per_minute: f64) -> Vec<(f64, f64)> {
        (0..20)
            .map(|i| {
                (
                    10.0 + i as f64 * 8.0,
                    offset
                        + slope_per_minute * (10.0 + i as f64 * 8.0) / 60.0
                        + ((i * 37) % 11) as f64 * 10.0
                        - 50.0,
                )
            })
            .collect()
    }

    #[test]
    fn timing_that_fits_is_told_from_shifted_and_drifting_timing() {
        assert_eq!(verdict(&series(180.0, 0.0)).unwrap().fit, Fit::Fits);
        let shifted = verdict(&series(1500.0, 0.0)).unwrap();
        assert_eq!(shifted.fit, Fit::Shifted);
        assert!((shifted.offset_ms - 1500.0).abs() < 100.0);
        assert_eq!(verdict(&series(180.0, 900.0)).unwrap().fit, Fit::Drifts);
        assert!(
            verdict(&series(180.0, 0.0)[..5]).is_none(),
            "too few lines to tell"
        );
        // lines scattered all over: wrong words
        let mess: Vec<(f64, f64)> = (0..20)
            .map(|i| (i as f64 * 8.0, ((i * 7919) % 9000) as f64 - 4500.0))
            .collect();
        assert_eq!(verdict(&mess).unwrap().fit, Fit::DoesNotFit);
    }
}
