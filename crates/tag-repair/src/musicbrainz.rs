//! Releases as MusicBrainz describes them (a fuzzy TOC search or a release lookup), with what tag repair
//! needs: every medium's tracks with their lengths, the edition's details, and the album's genres.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Release {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// "2004-11-02", "2004" or empty.
    pub date: String,
    pub country: String,
    pub barcode: String,
    pub label: String,
    pub catalog_number: String,
    pub release_group_id: String,
    /// The album's first release date (of any edition), for the original year.
    pub first_release_date: String,
    /// Genres of the album (release group), most voted first, as MusicBrainz spells them ("alternative rock").
    pub genres: Vec<String>,
    pub media: Vec<Medium>,
    /// Where the release came from: "musicbrainz" or "discogs".
    pub source: String,
    /// The release's page on that site (Discogs requires a link beside its data).
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Medium {
    pub position: u32,
    pub format: String,
    pub tracks: Vec<ReleaseTrack>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReleaseTrack {
    pub number: u32,
    pub title: String,
    /// The track's own artist when it differs from the album's (a guest or a compilation).
    pub artist: String,
    pub length_ms: Option<u64>,
    pub recording_id: String,
}

impl Release {
    /// The year this edition came out, or else the album's first year.
    pub fn year(&self) -> Option<u32> {
        year_of(&self.date).or_else(|| year_of(&self.first_release_date))
    }

    /// "2004 · Virgin · US · CD" for the list of editions.
    pub fn edition_label(&self, medium: &Medium) -> String {
        let mut parts = Vec::new();
        if let Some(year) = self.year() {
            parts.push(year.to_string());
        }
        for part in [&self.label, &self.country, &medium.format] {
            if !part.is_empty() {
                parts.push(part.clone());
            }
        }
        parts.join(" · ")
    }
}

fn year_of(date: &str) -> Option<u32> {
    date.get(..4)?
        .parse()
        .ok()
        .filter(|year| (1900..=2100).contains(year))
}

/// The releases in a MusicBrainz reply: a TOC search (`{"releases": [...]}`), a release search (the same), or one
/// release (`{"id": ..., "media": ...}`).
pub fn parse_releases(json: &str) -> Result<Vec<Release>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("MusicBrainz sent unreadable data: {e}"))?;
    if let Some(error) = root["error"].as_str() {
        return Err(format!("MusicBrainz said: {error}"));
    }
    let list: Vec<&Value> = match root["releases"].as_array() {
        Some(releases) => releases.iter().collect(),
        None if root["media"].is_array() => vec![&root],
        None => return Err("MusicBrainz sent no releases.".to_owned()),
    };
    Ok(list.into_iter().map(release).collect())
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// "A Perfect Circle", "Artist feat. Guest": names joined with their join phrases.
fn credit(value: &Value) -> String {
    value
        .as_array()
        .map(|credits| {
            credits
                .iter()
                .map(|credit| {
                    format!(
                        "{}{}",
                        credit["name"].as_str().unwrap_or_default(),
                        credit["joinphrase"].as_str().unwrap_or_default()
                    )
                })
                .collect::<String>()
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn release(value: &Value) -> Release {
    let artist = credit(&value["artist-credit"]);
    let label_info = value["label-info"]
        .as_array()
        .and_then(|labels| labels.first());
    let group = &value["release-group"];
    let mut genres: Vec<(String, u64)> = group["genres"]
        .as_array()
        .or_else(|| value["genres"].as_array())
        .map(|genres| {
            genres
                .iter()
                .map(|g| (text(&g["name"]), g["count"].as_u64().unwrap_or(0)))
                .filter(|(name, _)| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    genres.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let media = value["media"]
        .as_array()
        .map(|media| {
            media
                .iter()
                .enumerate()
                .map(|(index, medium)| Medium {
                    position: medium["position"]
                        .as_u64()
                        .map_or(index as u32 + 1, |n| n as u32),
                    format: text(&medium["format"]),
                    tracks: medium["tracks"]
                        .as_array()
                        .map(|tracks| {
                            tracks
                                .iter()
                                .enumerate()
                                .map(|(i, track)| {
                                    let own = credit(&track["artist-credit"]);
                                    ReleaseTrack {
                                        number: track["position"]
                                            .as_u64()
                                            .map_or(i as u32 + 1, |n| n as u32),
                                        title: track["title"]
                                            .as_str()
                                            .or_else(|| track["recording"]["title"].as_str())
                                            .unwrap_or_default()
                                            .to_owned(),
                                        artist: if own.is_empty() || own == artist {
                                            String::new()
                                        } else {
                                            own
                                        },
                                        length_ms: track["length"]
                                            .as_u64()
                                            .or_else(|| track["recording"]["length"].as_u64()),
                                        recording_id: text(&track["recording"]["id"]),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Release {
        id: text(&value["id"]),
        title: text(&value["title"]),
        artist,
        date: text(&value["date"]),
        country: text(&value["country"]),
        barcode: text(&value["barcode"]),
        label: label_info
            .map(|info| text(&info["label"]["name"]))
            .unwrap_or_default(),
        catalog_number: label_info
            .map(|info| text(&info["catalog-number"]))
            .unwrap_or_default(),
        release_group_id: text(&group["id"]),
        first_release_date: text(&group["first-release-date"]),
        genres: genres.into_iter().map(|(name, _)| name).collect(),
        media,
        source: "musicbrainz".into(),
        url: format!("https://musicbrainz.org/release/{}", text(&value["id"])),
    }
}

/// A MusicBrainz genre as a tag: "alternative rock" → "Alternative Rock", "hip hop" → "Hip Hop", "r&b" → "R&B".
pub fn genre_tag(genre: &str) -> String {
    genre
        .split(' ')
        .map(|word| {
            if word.len() <= 3 && word.contains('&') {
                return word.to_uppercase();
            }
            word.split('-')
                .map(|part| {
                    let mut chars = part.chars();
                    chars
                        .next()
                        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join("-")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genres_become_tags() {
        assert_eq!(genre_tag("alternative rock"), "Alternative Rock");
        assert_eq!(genre_tag("r&b"), "R&B");
        assert_eq!(genre_tag("lo-fi"), "Lo-Fi");
    }
}
