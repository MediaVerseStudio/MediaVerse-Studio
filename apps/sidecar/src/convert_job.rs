//! Convert to MP3 (PC only; owner, 2026-11-04): library songs in other formats (M4A/AAC, FLAC, WAV, WMA, and
//! OGG/Opus where Windows can decode them) become MP3s beside them, with the same tags and pictures. For each file:
//! Windows decodes it to a temporary WAV (`windows_decode`), LAME encodes it with the ripper's own settings, the tags
//! are copied (`copy_tags`) and read back, and the lengths are compared. Only then is the original moved out of the
//! library, into "<library> (converted originals)" with the same folders, so it can be put back by hand. A failure
//! at any step deletes the new MP3 and leaves the original where it was.

use mediaverse_ripper::mp3::Quality;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const CONVERTIBLE: [&str; 7] = ["m4a", "aac", "flac", "wav", "wma", "ogg", "opus"];

fn convertible(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind)
                    if kind.is_file()
                        && path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                            CONVERTIBLE.contains(&e.to_ascii_lowercase().as_str())
                        }) =>
                {
                    found.push(path)
                }
                _ => {}
            }
        }
    }
    found.sort();
    found
}

/// Where originals go: beside the library folder, never inside it (they would be read as songs again).
pub fn originals_folder(root: &Path) -> PathBuf {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Music".to_owned());
    root.with_file_name(format!("{name} (converted originals)"))
}

/// The library's non-MP3 songs by kind, and where the originals would go.
pub fn survey(root: &Path) -> Value {
    let mut kinds = std::collections::BTreeMap::<String, usize>::new();
    let files = convertible(root);
    for file in &files {
        let kind = file
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_uppercase())
            .unwrap_or_default();
        *kinds.entry(kind).or_default() += 1;
    }
    json!({ "files": files.len(), "kinds": kinds, "originals": originals_folder(root).to_string_lossy() })
}

fn length_ms(path: &Path) -> Option<u64> {
    use lofty::file::AudioFile;
    lofty::read_from_path(path)
        .ok()
        .map(|f| f.properties().duration().as_millis() as u64)
        .filter(|ms| *ms > 0)
}

fn convert_one(file: &Path, root: &Path, lame: &Path, work: &Path) -> Result<PathBuf, String> {
    let mp3 = file.with_extension("mp3");
    if mp3.exists() {
        return Err("an MP3 with the same name is already there".to_owned());
    }
    let wav = work.join("converting.wav");
    let result = (|| {
        let decoded_ms = crate::windows_decode::decode_to_wav(file, &wav)?;
        crate::mp3_job::run_lame(lame, Quality::V0, &wav, &mp3)?;
        mediaverse_metadata_tags::copy_tags(file, &mp3).map_err(|e| e.to_string())?;
        let made = length_ms(&mp3).ok_or("the new MP3 could not be read back")?;
        let original = length_ms(file).unwrap_or(decoded_ms);
        if made.abs_diff(original) > 1000 {
            return Err(format!(
                "the new MP3 is {:.1} s long but the original is {:.1} s",
                made as f64 / 1000.0,
                original as f64 / 1000.0
            ));
        }
        let relative = file
            .strip_prefix(root)
            .map_err(|_| "the file is not inside the library folder")?;
        let destination = originals_folder(root).join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not make the originals folder: {e}"))?;
        }
        if destination.exists() {
            return Err("a file of that name is already in the originals folder".to_owned());
        }
        // A rename on the same drive; across drives, a copy that is checked before the original is removed.
        if std::fs::rename(file, &destination).is_err() {
            std::fs::copy(file, &destination)
                .map_err(|e| format!("could not move the original: {e}"))?;
            if std::fs::metadata(&destination).map(|m| m.len()).ok()
                != std::fs::metadata(file).map(|m| m.len()).ok()
            {
                let _ = std::fs::remove_file(&destination);
                return Err("the original could not be copied to the originals folder".to_owned());
            }
            std::fs::remove_file(file)
                .map_err(|e| format!("could not remove the original after copying it: {e}"))?;
        }
        Ok(mp3.clone())
    })();
    let _ = std::fs::remove_file(&wav);
    if result.is_err() && file.exists() {
        let _ = std::fs::remove_file(&mp3);
    }
    result
}

/// Converts every convertible song in the library. Stops between files when `stop` is raised.
pub fn run(
    root: &Path,
    work: &Path,
    stop: &AtomicBool,
    progress: &dyn Fn(usize, usize, &str),
) -> Result<Value, String> {
    let lame = crate::mp3_job::find_lame().ok_or("The MP3 encoder (LAME) was not found.")?;
    std::fs::create_dir_all(work).map_err(|e| format!("could not make a work folder: {e}"))?;
    let files = convertible(root);
    let total = files.len();
    let mut converted = 0;
    let mut problems = Vec::new();
    for (done, file) in files.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            return Ok(
                json!({ "stopped": true, "converted": converted, "total": total, "problems": problems, "originals": originals_folder(root).to_string_lossy() }),
            );
        }
        let name = file
            .strip_prefix(root)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned();
        progress(done, total, &name);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| convert_one(file, root, &lame, work))) {
            Ok(Ok(_)) => converted += 1,
            Ok(Err(message)) => problems.push(json!({ "path": file.to_string_lossy(), "message": message })),
            Err(_) => problems.push(json!({ "path": file.to_string_lossy(), "message": "converting this file stopped unexpectedly" })),
        }
    }
    progress(total, total, "");
    Ok(
        json!({ "stopped": false, "converted": converted, "total": total, "problems": problems, "originals": originals_folder(root).to_string_lossy() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn originals_go_beside_the_library_not_inside_it() {
        assert_eq!(
            originals_folder(Path::new("C:/Users/K/Music")),
            PathBuf::from("C:/Users/K/Music (converted originals)")
        );
    }

    /// Run by hand with a COPY of a real song: `MV_CONVERT_SAMPLE=<file> cargo test ... -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn a_real_song_converts() {
        let (Ok(sample), Some(lame)) = (
            std::env::var("MV_CONVERT_SAMPLE"),
            crate::mp3_job::find_lame(),
        ) else {
            return;
        };
        let base = std::env::temp_dir().join(format!("mv-convert-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("Music");
        std::fs::create_dir_all(root.join("A")).unwrap();
        let file = root.join("A").join(Path::new(&sample).file_name().unwrap());
        std::fs::copy(&sample, &file).unwrap();
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let mp3 = convert_one(&file, &root, &lame, &work).unwrap_or_else(|e| panic!("{e}"));
        let tags = mediaverse_metadata_tags::read_track_metadata(&mp3).unwrap();
        println!(
            "converted: {tags:?}, {} bytes",
            std::fs::metadata(&mp3).unwrap().len()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A real conversion through Windows' decoder and LAME: a WAV with a tag becomes an MP3 with the same tag, and
    /// the WAV moves to the originals folder.
    #[cfg(windows)]
    #[test]
    fn a_wav_becomes_a_tagged_mp3_and_the_original_moves_out() {
        let Some(lame) = crate::mp3_job::find_lame() else {
            eprintln!("LAME not built; skipped");
            return;
        };
        let base = std::env::temp_dir().join(format!("mv-convert-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("Music");
        let album = root.join("Band").join("Record");
        std::fs::create_dir_all(&album).unwrap();
        let wav = album.join("01 Tone.wav");
        let samples: Vec<u32> = (0..44_100 * 3)
            .map(|i| {
                let v = (8000.0 * (i as f64 / 44_100.0 * 440.0 * std::f64::consts::TAU).sin())
                    as i16 as u16;
                u32::from(v) | (u32::from(v) << 16)
            })
            .collect();
        let mut bytes = Vec::new();
        mediaverse_ripper::wav::write_wav(&mut bytes, &samples).unwrap();
        std::fs::write(&wav, bytes).unwrap();
        mediaverse_metadata_tags::patch_track_metadata(
            &wav,
            &[
                (
                    mediaverse_metadata_tags::TagField::Title,
                    Some("Tone".into()),
                ),
                (
                    mediaverse_metadata_tags::TagField::Artist,
                    Some("Band".into()),
                ),
            ],
        )
        .unwrap();

        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let mp3 = convert_one(&wav, &root, &lame, &work).unwrap_or_else(|e| panic!("{e}"));
        let tags = mediaverse_metadata_tags::read_track_metadata(&mp3).unwrap();
        assert_eq!(
            (tags.title.as_deref(), tags.artist.as_deref()),
            (Some("Tone"), Some("Band"))
        );
        assert!(!wav.exists(), "the original left the library");
        assert!(
            originals_folder(&root)
                .join("Band")
                .join("Record")
                .join("01 Tone.wav")
                .exists()
        );
        assert_eq!(survey(&root)["files"], 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
