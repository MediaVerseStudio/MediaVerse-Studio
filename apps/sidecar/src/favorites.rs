//! Favorite songs (D44): marked with a heart in the desktop app or from a paired TV, played together as
//! "Favorites" (the first playlist; user playlists may follow). Kept in `<data dir>/favorites.json`, written
//! atomically, on this computer only. A song is identified by its file in the music library, like flags.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_FAVORITES: usize = 50_000;

pub struct Favorites {
    path: PathBuf,
}

impl Favorites {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("favorites.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn save(&self, favorites: &[Value]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(favorites).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, &self.path)
    }

    pub fn list(&self) -> Value {
        json!({ "favorites": self.load() })
    }

    /// `{path, favorite}`: `favorite: false` removes it; marking twice keeps one entry (and its first date).
    /// `path` must already have been checked to be a library file by the caller.
    pub fn set(&self, path: &str, args: &Value, now_secs: u64) -> Result<Value, String> {
        let mut favorites = self.load();
        let existing = favorites.iter().position(|f| f["path"] == path);
        if args["favorite"] == false {
            if let Some(index) = existing {
                favorites.remove(index);
                self.save(&favorites)
                    .map_err(|e| format!("could not save the favorites: {e}"))?;
            }
            return Ok(json!({ "favorites": favorites }));
        }
        if existing.is_none() {
            if favorites.len() >= MAX_FAVORITES {
                return Err("the favorites list is full".to_owned());
            }
            favorites.push(json!({ "path": path, "added_at": now_secs }));
            self.save(&favorites)
                .map_err(|e| format!("could not save the favorites: {e}"))?;
        }
        Ok(json!({ "favorites": favorites }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorites_are_added_once_removed_and_remembered() {
        let dir = std::env::temp_dir().join(format!("mv-favorites-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let favorites = Favorites::new(&dir);
        assert_eq!(favorites.list()["favorites"], json!([]));
        favorites
            .set("C:\\m\\a.mp3", &json!({ "favorite": true }), 10)
            .unwrap();
        favorites.set("C:\\m\\b.mp3", &json!({}), 20).unwrap();
        let again = favorites
            .set("C:\\m\\a.mp3", &json!({ "favorite": true }), 30)
            .unwrap();
        assert_eq!(
            again["favorites"].as_array().unwrap().len(),
            2,
            "marking twice does not duplicate"
        );
        assert_eq!(
            again["favorites"][0]["added_at"], 10,
            "the first date is kept"
        );
        assert_eq!(
            Favorites::new(&dir).list()["favorites"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let gone = favorites
            .set("C:\\m\\a.mp3", &json!({ "favorite": false }), 40)
            .unwrap();
        assert_eq!(gone["favorites"].as_array().unwrap().len(), 1);
        assert_eq!(gone["favorites"][0]["path"], "C:\\m\\b.mp3");
        std::fs::write(dir.join("favorites.json"), b"junk").unwrap();
        assert_eq!(Favorites::new(&dir).list()["favorites"], json!([]));
    }
}
