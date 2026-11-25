//! The library-wide loudness scan (issue #6): measures every library song that has no current result, on a few low-priority threads, saving each result as
//! soon as it is made. Stopping keeps what is finished; starting again continues with what is left. Nothing is written to the music files.

use crate::library_scan::{ScanProgress, scannable, worker_count};
use crate::loudness::analyze;
use crate::loudness_store::LoudnessStore;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// The recording year in a song's tags, when it has one.
fn year_of(path: &Path) -> Option<i32> {
    use lofty::prelude::*;
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.year()
        .and_then(|y| i32::try_from(y).ok())
        .filter(|y| (1850..=2100).contains(y))
}

/// Every scannable library file, and the part of it that has no current result (all of it when `again`: the owner can ask for every song to be measured
/// afresh; each old result stays until its song has been read again, so stopping half way loses nothing).
pub fn library_and_todo(
    root: &Path,
    store: &LoudnessStore,
    again: bool,
) -> Result<(Vec<String>, Vec<String>), String> {
    let found =
        mediaverse_library_filesystem::scan_music_collection(root).map_err(|e| e.to_string())?;
    let files: Vec<String> = found
        .into_iter()
        .map(|t| t.source_uri)
        .filter(|p| scannable(p))
        .collect();
    let keep = files.iter().cloned().collect();
    let _ = store.forget_except(&keep);
    let stored = store.fingerprints().map_err(|e| e.to_string())?;
    let todo = if again {
        files.clone()
    } else {
        crate::library_scan::still_to_scan(&files, &stored)
    };
    Ok((files, todo))
}

pub fn run(
    todo: &[String],
    store: &LoudnessStore,
    workers: usize,
    stop: &AtomicBool,
    progress: &ScanProgress,
    emit: &(dyn Fn(&ScanProgress) + Sync),
) -> Value {
    progress.total.store(todo.len(), Ordering::Relaxed);
    let next = AtomicUsize::new(0);
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1) {
            scope.spawn(|| {
                crate::os_priority::background_thread();
                let Ok(connection) = store.open() else { return };
                loop {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let Some(path) = todo.get(next.fetch_add(1, Ordering::Relaxed)) else {
                        return;
                    };
                    let measured = crate::library_defects::decode_file(Path::new(path))
                        .ok()
                        .and_then(|samples| analyze(&samples));
                    match measured {
                        Some(loudness) => {
                            let _ = store.record(
                                &connection,
                                path,
                                &loudness,
                                year_of(Path::new(path)),
                            );
                        }
                        None => {
                            progress.failed.fetch_add(1, Ordering::Relaxed);
                        }
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
    json!({ "scanned": progress.done.load(Ordering::Relaxed), "failed": progress.failed.load(Ordering::Relaxed), "stopped": stop.load(Ordering::SeqCst), "measured_total": store.count(), "workers": worker_count() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loudness::Loudness;

    #[test]
    fn measuring_again_reads_every_song_not_only_the_new_ones() {
        let base = std::env::temp_dir().join(format!("mv-loud-again-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let library = base.join("lib").join("Band").join("Album");
        std::fs::create_dir_all(&library).unwrap();
        let (a, b) = (library.join("01.mp3"), library.join("02.mp3"));
        std::fs::write(&a, [0xFF, 0xFB, 0x90, 0x00]).unwrap();
        std::fs::write(&b, [0xFF, 0xFB, 0x90, 0x00]).unwrap();
        let store = LoudnessStore::new(&base);
        let connection = store.open().unwrap();
        let loud = Loudness {
            lufs: -20.0,
            peak: 0.5,
            gain_db: 0.0,
            range_lu: 6.0,
            loud_end_lufs: -17.0,
            samples: 100 * 44_100,
        };
        // the first song has a current result; the second has none
        store
            .record(&connection, &a.to_string_lossy(), &loud, None)
            .unwrap();
        let root = base.join("lib");
        let (files, todo) = library_and_todo(&root, &store, false).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(todo.len(), 1, "only the song without a result");
        let (files, todo) = library_and_todo(&root, &store, true).unwrap();
        assert_eq!(todo.len(), files.len(), "every song, measured or not");
        assert_eq!(
            store.count(),
            1,
            "the old result stays until its song is read again"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
