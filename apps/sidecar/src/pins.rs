//! Pinned albums for the Home page (Zune's "Pins"). Kept in `<data dir>/pins.json`, on this computer only.
//! An album is identified by its folder in the music library.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_PINS: usize = 200;

pub struct Pins {
    path: PathBuf,
}

impl Pins {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("pins.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn save(&self, pins: &[Value]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(pins).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, &self.path)
    }

    pub fn list(&self) -> Value {
        json!({ "pins": self.load() })
    }

    /// Pins (or, with `pinned: false`, unpins) the album folder `folder` (already checked to be inside the library).
    pub fn set(&self, folder: &str, args: &Value, now_secs: u64) -> Result<Value, String> {
        let mut pins = self.load();
        pins.retain(|p| p["folder"] != folder);
        if args["pinned"] != false {
            if pins.len() >= MAX_PINS {
                return Err("too many pinned albums; unpin one first".to_owned());
            }
            let text = |key: &str| {
                args[key].as_str().map(|s| {
                    s.chars()
                        .filter(|c| !c.is_control())
                        .take(200)
                        .collect::<String>()
                })
            };
            pins.push(json!({ "folder": folder, "album": text("album"), "artist": text("artist"), "pinned_at": now_secs }));
        }
        self.save(&pins)
            .map_err(|e| format!("could not save the pins: {e}"))?;
        Ok(json!({ "pins": pins }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn albums_are_pinned_once_unpinned_and_remembered() {
        let dir = std::env::temp_dir().join(format!("mv-pins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pins = Pins::new(&dir);
        assert_eq!(pins.list()["pins"], json!([]));
        pins.set("C:\\m\\A", &json!({ "album": "LP", "artist": "Band" }), 10)
            .unwrap();
        pins.set("C:\\m\\B", &json!({}), 20).unwrap();
        let again = pins
            .set("C:\\m\\A", &json!({ "album": "LP2" }), 30)
            .unwrap();
        assert_eq!(
            again["pins"].as_array().unwrap().len(),
            2,
            "pinning twice does not duplicate"
        );
        assert_eq!(Pins::new(&dir).list()["pins"][1]["album"], "LP2");
        let gone = pins
            .set("C:\\m\\B", &json!({ "pinned": false }), 40)
            .unwrap();
        assert_eq!(gone["pins"].as_array().unwrap().len(), 1);
        std::fs::write(dir.join("pins.json"), b"junk").unwrap();
        assert_eq!(Pins::new(&dir).list()["pins"], json!([]));
    }
}
