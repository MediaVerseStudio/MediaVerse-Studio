//! Tracks flagged for review: while listening the user notices something wrong (a pop, missing tags)
//! and flags the track, noting where in the song; later the track can be checked, repaired or re-ripped.
//! Kept in `<data dir>/flags.json`, written atomically. The file is the user's own list: nothing here
//! is ever sent anywhere. Later this list will follow the library to other devices.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_FLAGS: usize = 20_000;
const MAX_NOTE_CHARS: usize = 500;
/// What can be wrong. A flag may carry several.
pub const REASONS: [&str; 5] = ["audio", "tags", "cover_or_lyrics", "wrong_track", "other"];

pub struct Flags {
    path: PathBuf,
}

impl Flags {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("flags.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn save(&self, flags: &[Value]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(flags).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, &self.path)
    }

    pub fn list(&self) -> Value {
        json!({ "flags": self.load() })
    }

    /// `{path, flagged, reasons?, note?, position_ms?, title?, artist?, album?}`. Flagging an already
    /// flagged track updates its reasons, note and position; `flagged: false` removes the flag.
    /// `path` must already have been checked to be a library file by the caller.
    pub fn set(&self, path: &str, args: &Value, now_secs: u64) -> Result<Value, String> {
        let mut flags = self.load();
        flags.retain(|f| f["path"] != path);
        if args["flagged"] == false {
            self.save(&flags)
                .map_err(|e| format!("could not save the review list: {e}"))?;
            return Ok(json!({ "flags": flags }));
        }
        if flags.len() >= MAX_FLAGS {
            return Err("the review list is full".to_owned());
        }
        let reasons: Vec<&str> = args["reasons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|r| REASONS.contains(r))
            .collect();
        let note: String = args["note"]
            .as_str()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(MAX_NOTE_CHARS)
            .collect();
        let text = |key: &str| {
            args[key].as_str().map(|s| {
                s.chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect::<String>()
            })
        };
        flags.push(json!({
            "path": path,
            "reasons": if reasons.is_empty() { vec!["other"] } else { reasons },
            "note": note.trim(),
            "position_ms": args["position_ms"].as_u64().filter(|ms| *ms < 24 * 3600 * 1000),
            "title": text("title"),
            "artist": text("artist"),
            "album": text("album"),
            "flagged_at": now_secs,
        }));
        self.save(&flags)
            .map_err(|e| format!("could not save the review list: {e}"))?;
        Ok(json!({ "flags": flags }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-flags-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn flags_are_saved_updated_and_removed() {
        let dir = temp("basic");
        let flags = Flags::new(&dir);
        assert_eq!(flags.list()["flags"], json!([]));
        let one = json!({ "flagged": true, "reasons": ["audio", "bogus"], "note": " pop at the chorus ", "position_ms": 72_500, "title": "Song", "artist": "Band" });
        let reply = flags.set("C:\\Music\\a.mp3", &one, 1000).unwrap();
        assert_eq!(
            reply["flags"][0]["reasons"],
            json!(["audio"]),
            "unknown reasons are dropped"
        );
        assert_eq!(reply["flags"][0]["note"], "pop at the chorus");
        assert_eq!(reply["flags"][0]["position_ms"], 72_500);
        // Survives a restart.
        assert_eq!(
            Flags::new(&dir).list()["flags"].as_array().unwrap().len(),
            1
        );
        // Flagging again updates rather than duplicates.
        let again = json!({ "flagged": true, "reasons": ["tags"], "note": "no album" });
        let reply = flags.set("C:\\Music\\a.mp3", &again, 2000).unwrap();
        assert_eq!(reply["flags"].as_array().unwrap().len(), 1);
        assert_eq!(reply["flags"][0]["reasons"], json!(["tags"]));
        assert_eq!(reply["flags"][0]["flagged_at"], 2000);
        flags
            .set("C:\\Music\\b.mp3", &json!({ "flagged": true }), 3000)
            .unwrap();
        assert_eq!(
            flags.list()["flags"][1]["reasons"],
            json!(["other"]),
            "a flag with no reason is just \"other\""
        );
        let reply = flags
            .set("C:\\Music\\a.mp3", &json!({ "flagged": false }), 4000)
            .unwrap();
        assert_eq!(reply["flags"].as_array().unwrap().len(), 1);
        assert_eq!(reply["flags"][0]["path"], "C:\\Music\\b.mp3");
    }

    #[test]
    fn odd_input_is_cleaned_and_a_damaged_file_is_ignored() {
        let dir = temp("odd");
        let flags = Flags::new(&dir);
        let long = "x".repeat(2000);
        let reply = flags.set("p", &json!({ "flagged": true, "note": long, "title": "A\u{0}B", "position_ms": 99_999_999_999u64 }), 1).unwrap();
        assert_eq!(
            reply["flags"][0]["note"].as_str().unwrap().len(),
            MAX_NOTE_CHARS
        );
        assert_eq!(reply["flags"][0]["title"], "AB");
        assert_eq!(reply["flags"][0]["position_ms"], Value::Null);
        std::fs::write(dir.join("flags.json"), b"not json").unwrap();
        assert_eq!(Flags::new(&dir).list()["flags"], json!([]));
    }
}
