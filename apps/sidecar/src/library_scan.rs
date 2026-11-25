//! The library-wide defect scan (ADR 0008): scans every library file that has no current result (new, or
//! changed since its scan) on a few threads, saving each result as soon as it is made. Stopping keeps what is
//! finished; starting again continues with what is left, also after the program was closed.

use crate::defect_results::{DefectResults, fingerprint};
use crate::library_defects::scan_files_until;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What a running library scan has done so far; read by `library_scan_status`.
pub struct ScanProgress {
    pub job_id: String,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
    pub problems: AtomicUsize,
    pub failed: AtomicUsize,
}

impl ScanProgress {
    pub fn new(job_id: &str) -> Arc<Self> {
        Arc::new(Self {
            job_id: job_id.to_owned(),
            done: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            problems: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
        })
    }

    pub fn json(&self) -> Value {
        json!({
            "running": true, "job_id": self.job_id,
            "tracks_done": self.done.load(Ordering::Relaxed), "tracks_total": self.total.load(Ordering::Relaxed),
            "problems": self.problems.load(Ordering::Relaxed), "failed": self.failed.load(Ordering::Relaxed),
        })
    }
}

/// Files the scanner can read (the others are not counted as failures).
pub fn scannable(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp3" | "flac" | "wav"))
}

/// Of `library` (every scannable file), the ones with no current result: never scanned, or changed since.
pub fn still_to_scan(
    library: &[String],
    stored: &std::collections::HashMap<String, (u64, u64)>,
) -> Vec<String> {
    library
        .iter()
        .filter(|path| match stored.get(*path) {
            None => true,
            Some(saved) => fingerprint(Path::new(path.as_str())) != Some(*saved),
        })
        .cloned()
        .collect()
}

/// How many threads to scan with: one less than the computer has, at most four, at least one.
pub fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map_or(1, |n| n.get().saturating_sub(1))
        .clamp(1, 4)
}

/// Scans `todo` with `workers` threads, saving each result in `store`. `emit` is called with the progress at
/// most every few hundred milliseconds. Returns a summary; `stopped` is true when `stop` was raised.
pub fn run(
    todo: &[String],
    library_root: Option<&Path>,
    store: &DefectResults,
    workers: usize,
    stop: &AtomicBool,
    progress: &ScanProgress,
    emit: &(dyn Fn(&ScanProgress) + Sync),
) -> Value {
    progress.total.store(todo.len(), Ordering::Relaxed);
    let next = AtomicUsize::new(0);
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let save_failures = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1) {
            scope.spawn(|| {
                // A scan of every song is background work: it must not slow down playback or a rip.
                crate::os_priority::background_thread();
                let Ok(recorder) = store.recorder() else {
                    save_failures.fetch_add(1, Ordering::Relaxed);
                    return;
                };
                loop {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = todo.get(index) else { return };
                    let reply = scan_files_until(
                        std::slice::from_ref(path),
                        library_root,
                        &mut |_, _, _| {},
                        &|| false,
                    );
                    let entry = &reply["tracks"][0];
                    if entry["ok"] == true {
                        if recorder.record(path, &entry["report"], now).is_err() {
                            save_failures.fetch_add(1, Ordering::Relaxed);
                        }
                        if entry["report"]["verdict"] != "clean" {
                            progress.problems.fetch_add(1, Ordering::Relaxed);
                        }
                    } else {
                        progress.failed.fetch_add(1, Ordering::Relaxed);
                    }
                    progress.done.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut last) = last_emit.try_lock()
                        && last.elapsed() >= Duration::from_millis(300)
                    {
                        *last = Instant::now();
                        emit(progress);
                    }
                }
            });
        }
    });
    let done = progress.done.load(Ordering::Relaxed);
    json!({
        "scanned": done,
        "remaining": todo.len().saturating_sub(done),
        "problems": progress.problems.load(Ordering::Relaxed),
        "failed": progress.failed.load(Ordering::Relaxed),
        "save_failures": save_failures.load(Ordering::Relaxed),
        "stopped": stop.load(Ordering::SeqCst) && done < todo.len(),
        "workers": workers.max(1),
    })
}

/// Every scannable file in the library, and drops stored results of files that are gone.
pub fn library_files(root: &Path, store: &DefectResults) -> Result<Vec<String>, String> {
    let found =
        mediaverse_library_filesystem::scan_music_collection(root).map_err(|e| e.to_string())?;
    let files: Vec<String> = found
        .into_iter()
        .map(|t| t.source_uri)
        .filter(|p| scannable(p))
        .collect();
    let keep: HashSet<String> = files.iter().cloned().collect();
    let _ = store.forget_except(&keep);
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_ripper::wav;

    fn tone(pop: bool) -> Vec<u32> {
        let mut state = 5u32;
        let mut samples: Vec<u32> = (0..88_200usize)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let v = (6000.0 * (i as f64 / 44_100.0 * 330.0 * std::f64::consts::TAU).sin()
                    + f64::from((state >> 22) as i32 - 512)) as i32;
                u32::from(v as i16 as u16) | (u32::from(v as i16 as u16) << 16)
            })
            .collect();
        if pop {
            for place in [20_000usize, 50_000, 70_000] {
                samples[place] = 0x4E20_4E20;
            }
        }
        samples
    }

    #[test]
    fn a_library_scan_saves_as_it_goes_and_a_second_run_does_only_what_is_left() {
        let base = std::env::temp_dir().join(format!("mv-library-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("music").join("Band").join("Album");
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..6 {
            wav::write_wav(
                std::fs::File::create(root.join(format!("{i}.wav"))).unwrap(),
                &tone(i == 2),
            )
            .unwrap();
        }
        std::fs::write(root.join("cover.jpg"), b"not audio").unwrap();
        std::fs::write(root.join("notes.m4a"), b"not scannable here").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = DefectResults::new(&data);
        let library_root = base.join("music");
        let files = library_files(&library_root, &store).unwrap();
        assert_eq!(
            files.len(),
            6,
            "only MP3, FLAC and WAV files are scanned: {files:?}"
        );

        // First run, stopped after the first file is taken.
        let stop = AtomicBool::new(false);
        let progress = ScanProgress::new("job-1");
        let todo = still_to_scan(&files, &store.fingerprints().unwrap());
        assert_eq!(todo.len(), 6);
        let first = run(
            &todo[..1],
            Some(&library_root),
            &store,
            1,
            &stop,
            &progress,
            &|_| {},
        );
        assert_eq!(first["scanned"], 1);
        stop.store(true, Ordering::SeqCst);
        let stopped = run(
            &todo[1..],
            Some(&library_root),
            &store,
            2,
            &stop,
            &ScanProgress::new("job-2"),
            &|_| {},
        );
        assert_eq!(stopped["scanned"], 0);
        assert_eq!(stopped["stopped"], true);

        // Second run picks up the five that are left, on several threads, and finds the clicks in file 2.
        let todo = still_to_scan(&files, &store.fingerprints().unwrap());
        assert_eq!(todo.len(), 5);
        let progress = ScanProgress::new("job-3");
        let emitted = AtomicUsize::new(0);
        let summary = run(
            &todo,
            Some(&library_root),
            &store,
            3,
            &AtomicBool::new(false),
            &progress,
            &|_| {
                emitted.fetch_add(1, Ordering::Relaxed);
            },
        );
        assert_eq!(summary["scanned"], 5);
        assert_eq!(summary["stopped"], false);
        assert_eq!(summary["problems"], 1, "{summary}");
        assert!(emitted.load(Ordering::Relaxed) >= 1);
        assert!(
            still_to_scan(&files, &store.fingerprints().unwrap()).is_empty(),
            "nothing left"
        );
        assert_eq!(store.problems(0, 10).unwrap()["total"], 1);

        // A changed file is scanned again; a removed one is forgotten.
        std::thread::sleep(Duration::from_millis(1100)); // modification times are kept in whole seconds
        wav::write_wav(
            std::fs::File::create(root.join("4.wav")).unwrap(),
            &tone(true),
        )
        .unwrap();
        std::fs::remove_file(root.join("5.wav")).unwrap();
        let files = library_files(&library_root, &store).unwrap();
        assert_eq!(
            still_to_scan(&files, &store.fingerprints().unwrap()).len(),
            1
        );
        assert_eq!(store.problems(0, 10).unwrap()["scanned"], 5);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worker_count_stays_between_one_and_four() {
        let n = worker_count();
        assert!((1..=4).contains(&n));
    }
}
