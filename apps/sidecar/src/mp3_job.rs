//! The MP3 step of a rip (ADR 0005, decisions D15 and D17): turns the verified WAV files into
//! tagged MP3 copies in the Main Media Library.
//!
//! For each track: encode with LAME from the verified audio, check the encoder's output, add an
//! ID3v2.3 tag, check the tagged file and read the tag back, write it as a new file (never
//! overwriting), then check the file as stored. A failure at any step leaves no file behind and is
//! reported for that track alone.

use crate::cover_art::{self, CoverImage};
use mediaverse_ripper::archive::{
    ArchiveTrack, track_path_with_extension, validate_locations, write_new_file,
};
use mediaverse_ripper::id3::{self, MAX_PICTURE_BYTES, Picture, PictureKind, TagSet};
use mediaverse_ripper::mp3::{self, Quality};
use mediaverse_ripper::{flac, lrc, wav};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LAME_TIMEOUT: Duration = Duration::from_secs(900);

pub struct Mp3Outcome {
    pub entries: Vec<Value>,
    pub warnings: Vec<String>,
}

/// Finds `lame.exe`: an explicit override, next to the sidecar, then the development build.
pub fn find_lame() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("MEDIAVERSE_LAME_PATH") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("lame.exe"));
        // target/<profile>/mediaverse_sidecar.exe -> <repo>/third_party/build/lame-4.0/x64/Release/lame.exe
        if let Some(repo) = dir.parent().and_then(Path::parent) {
            candidates.push(
                repo.join("third_party")
                    .join("build")
                    .join("lame-4.0")
                    .join("x64")
                    .join("Release")
                    .join("lame.exe"),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The picture kind named in the details, e.g. `"back_cover"`.
pub fn picture_kind(name: &str) -> Option<PictureKind> {
    match name {
        "front_cover" => Some(PictureKind::FrontCover),
        "back_cover" => Some(PictureKind::BackCover),
        "artist_photo" => Some(PictureKind::ArtistPhoto),
        _ => None,
    }
}

/// Reads an image file chosen by the user (never trusting its name) as a picture of the given kind.
fn load_picture(kind: &str, path: &str) -> Result<Picture, String> {
    let kind = picture_kind(kind).ok_or_else(|| {
        format!("'{kind}' is not a picture kind (use front_cover, back_cover or artist_photo)")
    })?;
    let data = std::fs::read(path).map_err(|e| format!("could not read the image {path}: {e}"))?;
    cover_art::validate_image(&data)
        .map_err(|e| format!("the image {path} cannot be used: {e}"))?;
    if let Some(problem) = cover_art::song_picture_problem(&data) {
        return Err(format!("the image {path} cannot be used: {problem}"));
    }
    if data.len() > MAX_PICTURE_BYTES {
        return Err(format!(
            "the image {path} is {} KB; the limit for embedding is {} KB",
            data.len() / 1024,
            MAX_PICTURE_BYTES / 1024
        ));
    }
    Ok(Picture { kind, data })
}

/// Runs LAME with a time limit. Returns the encoder's message if it failed.
pub(crate) fn run_lame(
    lame: &Path,
    quality: Quality,
    wav: &Path,
    out: &Path,
) -> Result<(), String> {
    let mut command = Command::new(lame);
    command
        .args(mp3::lame_arguments(quality, wav, out))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start LAME: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut message = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use std::io::Read;
                    let _ = stderr.read_to_string(&mut message);
                }
                return Err(format!("LAME failed ({status}): {}", message.trim()));
            }
            Ok(None) if started.elapsed() > LAME_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("LAME did not finish in time and was stopped".to_owned());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("lost contact with LAME: {e}")),
        }
    }
}

/// Builds the tag for one track from the chosen details.
fn tag_set(
    metadata: &Value,
    number: u8,
    title: &str,
    cover: Option<&Picture>,
    extra: &[Picture],
    warnings: &mut Vec<String>,
) -> TagSet {
    let album_artist = flac::clean_tag_value(
        text(metadata, "album_artist")
            .or_else(|| text(metadata, "artist"))
            .unwrap_or("Unknown Artist"),
    );
    let per_track = &metadata["tracks"][number.to_string()];
    let artist = flac::clean_tag_value(
        text(per_track, "artist")
            .or_else(|| text(metadata, "artist"))
            .unwrap_or(&album_artist),
    );
    let mut pictures: Vec<Picture> = cover.cloned().into_iter().collect();
    pictures.extend(extra.iter().cloned());

    let (mut lyrics, mut synced) = (None, Vec::new());
    if let Some(source) = text(per_track, "lyrics") {
        let parsed = lrc::parse(source);
        if parsed.plain.trim().is_empty() {
            warnings.push(format!(
                "The lyrics given for track {number} contain no words, so none were embedded."
            ));
        } else {
            lyrics = Some(parsed.plain);
            synced = parsed.synced;
        }
    }
    TagSet {
        title: flac::clean_tag_value(title),
        artist,
        album: flac::clean_tag_value(text(metadata, "album").unwrap_or("Unknown Album")),
        album_artist,
        track: Some((
            u32::from(number),
            metadata["track_total"].as_u64().map(|n| n as u32),
        )),
        disc: metadata["disc_number"]
            .as_u64()
            .map(|d| (d as u32, metadata["disc_count"].as_u64().map(|n| n as u32))),
        year: metadata["release_year"].as_u64().map(|y| y as u32),
        genre: text(metadata, "genre")
            .map(flac::clean_tag_value)
            .filter(|g| !g.is_empty()),
        compilation: metadata["compilation"] == true,
        pictures,
        lyrics,
        synced_lyrics: synced,
        recording_id: crate::audio_check::tag_id(per_track, "recording_id"),
        acoustid_id: crate::audio_check::tag_id(per_track, "acoustid_id"),
    }
}

/// Makes the MP3 copies of every ripped track in `rip` (the helper's result) in `library_dir`.
pub fn make_mp3s(
    rip: &Value,
    library_dir: &Path,
    archive_dir: Option<&Path>,
    lame: &Path,
    quality: Quality,
    metadata: &Value,
    cover: Option<&CoverImage>,
    small_cover: &mut dyn FnMut() -> Option<CoverImage>,
    progress: &mut dyn FnMut(u8, usize, usize),
) -> Mp3Outcome {
    let mut outcome = Mp3Outcome {
        entries: Vec::new(),
        warnings: Vec::new(),
    };
    if let Some(archive) = archive_dir
        && let Err(problem) = validate_locations(library_dir, archive)
    {
        outcome
            .warnings
            .push(format!("No MP3 copies were made: {problem}"));
        return outcome;
    }

    // Pictures that go on every track: the downloaded front cover (if it may be embedded) and any
    // the user chose by hand (back cover, artist photo, a replacement front cover).
    let mut extra = Vec::new();
    for item in metadata["pictures"].as_array().cloned().unwrap_or_default() {
        match (text(&item, "kind"), text(&item, "path")) {
            (Some(kind), Some(path)) => match load_picture(kind, path) {
                Ok(picture) => extra.push(picture),
                Err(problem) => outcome
                    .warnings
                    .push(format!("A picture was not embedded: {problem}.")),
            },
            _ => outcome
                .warnings
                .push("A picture was skipped because it needs both a kind and a file.".to_owned()),
        }
    }
    let manual_front = extra.iter().any(|p| p.kind == PictureKind::FrontCover);
    let mut embedded_cover: Option<Picture> = None;
    if !manual_front {
        let usable = match cover.map(|c| (c, cover_art::embedding_problem(c))) {
            Some((c, None)) => Some(c.bytes.clone()),
            Some((_, Some(why))) => match small_cover() {
                Some(small) if cover_art::embedding_problem(&small).is_none() => Some(small.bytes),
                _ => {
                    outcome.warnings.push(format!("The cover was not embedded in the MP3 files because {why} (it was still saved as a file)."));
                    None
                }
            },
            None => None,
        };
        embedded_cover = usable.map(|data| Picture {
            kind: PictureKind::FrontCover,
            data,
        });
    }

    let reports = rip["tracks"].as_array().cloned().unwrap_or_default();
    let files = rip["files"].as_array().cloned().unwrap_or_default();
    let album_artist = flac::clean_tag_value(
        text(metadata, "album_artist")
            .or_else(|| text(metadata, "artist"))
            .unwrap_or("Unknown Artist"),
    );
    let album = flac::clean_tag_value(text(metadata, "album").unwrap_or("Unknown Album"));

    for (index, report) in reports.iter().enumerate() {
        let number = report["number"].as_u64().unwrap_or(0) as u8;
        progress(number, index, reports.len());
        let wav_path = files.get(index).and_then(Value::as_str).unwrap_or_default();
        let per_track = &metadata["tracks"][number.to_string()];
        let title = match text(per_track, "title") {
            Some(title) => flac::clean_tag_value(title),
            None => format!("Track {number:02}"),
        };
        let tags = tag_set(
            metadata,
            number,
            &title,
            embedded_cover.as_ref(),
            &extra,
            &mut outcome.warnings,
        );
        let destination = track_path_with_extension(
            library_dir,
            &ArchiveTrack {
                album_artist: &album_artist,
                album: &album,
                track_number: u32::from(number),
                title: &title,
            },
            "mp3",
        );
        match make_one(lame, quality, Path::new(wav_path), &destination, &tags) {
            Ok(done) => {
                outcome.entries.push(json!({
                    "track": number, "ok": true, "path": destination.to_string_lossy(), "bytes": done.bytes,
                    "quality": if quality == Quality::V0 { "v0" } else { "cbr320" },
                    "variable_bitrate": done.variable_bitrate, "frames": done.frames,
                    "checked": "valid MP3 frames of exactly the source length, tag read back identical, file re-checked after writing",
                    "note": "MP3 is lossy: it is a high-quality copy, not bit-perfect",
                }));
            }
            Err(message) => {
                outcome
                    .entries
                    .push(json!({ "track": number, "ok": false, "error": message }));
                outcome.warnings.push(format!(
                    "Track {number} was not made into an MP3: {message}"
                ));
            }
        }
    }
    progress(0, reports.len(), reports.len());
    outcome
}

struct Made {
    bytes: u64,
    frames: u64,
    variable_bitrate: bool,
}

fn make_one(
    lame: &Path,
    quality: Quality,
    wav_path: &Path,
    destination: &Path,
    tags: &TagSet,
) -> Result<Made, String> {
    let wav_bytes =
        std::fs::read(wav_path).map_err(|e| format!("could not read the ripped audio: {e}"))?;
    let samples =
        wav::read_wav(&wav_bytes).map_err(|e| format!("the ripped audio is not usable: {e}"))?;
    let temp = wav_path.with_extension("encoding.mp3");
    let _ = std::fs::remove_file(&temp);
    let result = (|| -> Result<Made, String> {
        run_lame(lame, quality, wav_path, &temp)?;
        let encoded = std::fs::read(&temp).map_err(|e| format!("LAME produced no file: {e}"))?;
        mp3::check_structure(&encoded, samples.len())
            .map_err(|e| format!("the encoder's output failed its check: {e}"))?;

        let tag = id3::write_tag(tags).map_err(|e| e.to_string())?;
        let tagged = mp3::with_tag(&encoded, &tag).map_err(|e| e.to_string())?;
        mp3::check_structure(&tagged, samples.len()).map_err(|e| format!("after tagging, {e}"))?;
        id3::check_tag(&tagged, tags).map_err(|e| format!("after tagging, {e}"))?;

        write_new_file(destination, &tagged).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!(
                "{} already exists and was left untouched",
                destination.display()
            ),
            _ => format!("could not write {}: {e}", destination.display()),
        })?;
        let finish = || -> Result<Made, String> {
            let stored = std::fs::read(destination)
                .map_err(|e| format!("could not re-read the file: {e}"))?;
            let info = mp3::check_structure(&stored, samples.len())
                .map_err(|e| format!("the stored file is damaged: {e}"))?;
            id3::check_tag(&stored, tags)
                .map_err(|e| format!("the stored file's tag is damaged: {e}"))?;
            mp3::decode_check(&stored, &samples)
                .map_err(|e| format!("the stored file does not sound like the source: {e}"))?;
            Ok(Made {
                bytes: stored.len() as u64,
                frames: info.audio_frames,
                variable_bitrate: info.variable_bitrate,
            })
        };
        finish().inspect_err(|_| {
            let _ = std::fs::remove_file(destination);
        })
    })();
    let _ = std::fs::remove_file(&temp);
    result
}
