//! Small persistent settings for the sidecar, kept in `<data dir>/settings.json`. Currently the
//! Media Library Archive folder (decision D3).

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct Settings {
    path: PathBuf,
}

impl Settings {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("settings.json"),
        }
    }

    fn load(&self) -> Value {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| json!({}))
    }

    pub fn archive_dir(&self) -> Option<PathBuf> {
        self.load()["archive_dir"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(PathBuf::from)
    }

    /// Whether FLAC masters are kept (the "Keep a lossless FLAC archive" switch). On unless turned off;
    /// turning it off keeps the chosen folder so the switch can be turned back on.
    pub fn archive_enabled(&self) -> bool {
        self.load()["archive_enabled"].as_bool().unwrap_or(true)
    }

    /// Whether the person has made the archive decision (chose a folder, or switched archiving off), as opposed
    /// to the default of "on" with no folder. Used by the Getting Started box.
    pub fn archive_decided(&self) -> bool {
        let settings = self.load();
        settings["archive_enabled"].is_boolean()
            || settings["archive_dir"]
                .as_str()
                .is_some_and(|d| !d.is_empty())
    }

    pub fn set_archive_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let mut settings = self.load();
        settings["archive_enabled"] = json!(enabled);
        self.save(&settings)
    }

    /// Length in seconds of the sample played by "Listen" buttons for an audio defect (the defect sits at its middle).
    pub const LISTEN_DEFAULT: u32 = 8;
    pub const LISTEN_MIN: u32 = 3;
    pub const LISTEN_MAX: u32 = 30;

    pub fn listen_seconds(&self) -> u32 {
        self.load()["listen_seconds"]
            .as_u64()
            .map_or(Self::LISTEN_DEFAULT, |s| {
                (s as u32).clamp(Self::LISTEN_MIN, Self::LISTEN_MAX)
            })
    }

    pub fn set_listen_seconds(&self, seconds: u32) -> std::io::Result<()> {
        let mut settings = self.load();
        settings["listen_seconds"] = json!(seconds.clamp(Self::LISTEN_MIN, Self::LISTEN_MAX));
        self.save(&settings)
    }

    /// Whether the user may ask for lyrics from LRCLIB (decision D29). On unless turned off; a lookup still happens
    /// only when the user asks for one.
    pub fn lyrics_lookup_enabled(&self) -> bool {
        self.load()["lyrics_lookup_enabled"]
            .as_bool()
            .unwrap_or(true)
    }

    pub fn lyrics_base_url(&self) -> String {
        self.load()["lyrics_base_url"]
            .as_str()
            .filter(|u| crate::lyrics_lookup::allowed_base_url(u))
            .unwrap_or(crate::lyrics_lookup::DEFAULT_BASE_URL)
            .to_owned()
    }

    pub fn set_lyrics(&self, enabled: Option<bool>, base_url: Option<&str>) -> std::io::Result<()> {
        let mut settings = self.load();
        if let Some(enabled) = enabled {
            settings["lyrics_lookup_enabled"] = json!(enabled);
        }
        if let Some(url) = base_url {
            settings["lyrics_base_url"] = json!(url.trim().trim_end_matches('/'));
        }
        self.save(&settings)
    }

    /// Whether listening history is recorded (decision D26). On unless turned off.
    pub fn history_enabled(&self) -> bool {
        self.load()["history_enabled"].as_bool().unwrap_or(true)
    }

    pub fn set_history_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let mut settings = self.load();
        settings["history_enabled"] = json!(enabled);
        self.save(&settings)
    }

    /// Whether MP3 tags are written as ID3v2.4 (an advanced setting; off: ID3v2.3, which older players such as the
    /// iPod Classic read best; owner, 2026-11-04).
    pub fn id3v24(&self) -> bool {
        self.load()["id3v24"].as_bool().unwrap_or(false)
    }

    pub fn set_id3v24(&self, on: bool) -> std::io::Result<()> {
        let mut settings = self.load();
        settings["id3v24"] = json!(on);
        self.save(&settings)
    }

    pub fn set_archive_dir(&self, dir: Option<&Path>) -> std::io::Result<()> {
        let mut settings = self.load();
        settings["archive_dir"] = dir.map_or(Value::Null, |path| json!(path.to_string_lossy()));
        self.save(&settings)
    }

    fn save(&self, settings: &Value) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_archive_switch_defaults_on_and_keeps_the_folder() {
        let dir = std::env::temp_dir().join(format!("mv-settings-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let settings = Settings::new(&dir);
        assert!(settings.archive_enabled());
        settings
            .set_archive_dir(Some(Path::new(r"D:\Archive")))
            .unwrap();
        settings.set_archive_enabled(false).unwrap();
        assert!(!settings.archive_enabled());
        assert_eq!(
            settings.archive_dir(),
            Some(PathBuf::from(r"D:\Archive")),
            "the folder is kept"
        );
        settings.set_archive_enabled(true).unwrap();
        assert!(Settings::new(&dir).archive_enabled());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remembers_and_clears_the_archive_folder() {
        let dir = std::env::temp_dir().join(format!("mv-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let settings = Settings::new(&dir);
        assert_eq!(settings.archive_dir(), None);
        settings
            .set_archive_dir(Some(Path::new(r"D:\Archive")))
            .unwrap();
        assert_eq!(settings.archive_dir(), Some(PathBuf::from(r"D:\Archive")));
        settings.set_archive_dir(None).unwrap();
        assert_eq!(settings.archive_dir(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_settings_file_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("mv-settings-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), b"{ nope").unwrap();
        assert_eq!(Settings::new(&dir).archive_dir(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
