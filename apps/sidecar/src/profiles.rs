//! On-disk storage for drive profiles: one JSON file per drive under `<data dir>/drive-profiles`.

use mediaverse_ripper::profile::{DriveIdentity, DriveProfile};
use std::path::{Path, PathBuf};

pub struct ProfileStore {
    dir: PathBuf,
}

impl ProfileStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("drive-profiles"),
        }
    }

    fn path_for(&self, identity: &DriveIdentity) -> PathBuf {
        let name: String = identity
            .key()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        self.dir.join(format!("{name}.json"))
    }

    /// Returns the stored profile, or `None` if there is none or the file is unreadable.
    pub fn load(&self, identity: &DriveIdentity) -> Option<DriveProfile> {
        let bytes = std::fs::read(self.path_for(identity)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Writes the profile atomically (temp file, then rename).
    pub fn save(&self, profile: &DriveProfile) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.path_for(&profile.identity);
        let temp = path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(profile).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, path)
    }

    pub fn list(&self) -> Vec<DriveProfile> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut profiles: Vec<DriveProfile> = entries
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok())
            .collect();
        profiles.sort_by_key(|profile| profile.identity.key());
        profiles
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_ripper::profile::{Connection, Field};

    fn profile(model: &str) -> DriveProfile {
        DriveProfile::new(
            DriveIdentity {
                vendor: "ASUS".to_owned(),
                model: model.to_owned(),
                revision: "3.11".to_owned(),
                connection: Connection::Unknown,
            },
            "0.1.0",
        )
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-profiles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn saves_loads_and_lists_profiles_per_drive() {
        let store = ProfileStore::new(&temp("roundtrip"));
        assert!(store.list().is_empty());

        let mut first = profile("BW-16D1HT");
        first.read_offset = Some(Field::measured(6));
        store.save(&first).unwrap();
        store.save(&profile("OTHER")).unwrap();

        assert_eq!(store.load(&first.identity), Some(first.clone()));
        assert_eq!(store.list().len(), 2);

        first.read_offset = Some(Field::measured(7));
        store.save(&first).unwrap();
        assert_eq!(
            store.list().len(),
            2,
            "saving again replaces, not duplicates"
        );
        assert_eq!(
            store.load(&first.identity).unwrap().read_offset,
            Some(Field::measured(7))
        );
    }

    #[test]
    fn a_corrupt_file_is_ignored_not_fatal() {
        let dir = temp("corrupt");
        let store = ProfileStore::new(&dir);
        let drive = profile("BW-16D1HT");
        store.save(&drive).unwrap();
        std::fs::write(store.path_for(&drive.identity), b"{ not json").unwrap();
        assert_eq!(store.load(&drive.identity), None);
        assert!(store.list().is_empty());
    }
}
