//! User-editable settings for every metadata service (ADR 0006): which services to use, where they
//! live (server, port, path or base URL), who we are to them, and any credentials.
//!
//! Services move and shut down, so nothing is hard-wired: the defaults can all be replaced, and
//! extra CDDB-compatible servers can be added. Credentials are held in [`Secret`]s that never print
//! in debug output and are replaced by `{"set": true|false}` in anything shown to the interface.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt;

/// A credential. `Debug` hides it; `Serialize` writes the real value, so it is only for the
/// settings file. Use [`MetadataSettings::public_view`] for anything shown to the user or logged.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_set(&self) -> bool {
        !self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.is_set() {
            "Secret(<set>)"
        } else {
            "Secret(<empty>)"
        })
    }
}

impl Serialize for Secret {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self(
            Option::<String>::deserialize(deserializer)?
                .unwrap_or_default()
                .trim()
                .to_owned(),
        ))
    }
}

/// Who we are to the services. MusicBrainz requires contact details in every request (an email or
/// web address); gnudb requires a valid-looking email address in every request, which becomes the
/// user and host parts of its `hello` identification. Both services say operators use it to contact
/// the developer or user if something goes wrong, so a dedicated address is a sensible choice.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct Identity {
    pub contact: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct MusicBrainzSettings {
    pub enabled: bool,
    pub base_url: String,
    pub min_interval_ms: u64,
    pub timeout_seconds: u64,
}

impl Default for MusicBrainzSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            base_url: "https://musicbrainz.org".to_owned(),
            min_interval_ms: 1100,
            timeout_seconds: 20,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    /// CDDB commands over a CGI script on a web server.
    Http,
    /// The same over a secure connection (the way gnudb recommends).
    Https,
    /// CDDB commands over a plain TCP connection (CDDBP).
    Cddbp,
}

/// One CDDB-compatible server (gnudb by default). Add more, or change this one if it moves.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct CddbServer {
    /// Shown to the user and recorded as the source of any answer.
    pub name: String,
    pub enabled: bool,
    pub transport: Transport,
    pub host: String,
    pub port: u16,
    /// For HTTP only: the CGI path.
    pub path: String,
    /// CDDB protocol level 1-6. Level 6 uses UTF-8; lower levels use ISO-8859-1.
    pub protocol_level: u8,
    /// The client name sent in `hello`. Some servers (gnudb) only accept registered names, so
    /// this can be changed to one you are allowed to use.
    pub client_name: String,
    pub client_version: String,
    pub min_interval_ms: u64,
    pub timeout_seconds: u64,
}

impl Default for CddbServer {
    fn default() -> Self {
        Self {
            name: "gnudb".to_owned(),
            enabled: true,
            transport: Transport::Https,
            host: "gnudb.gnudb.org".to_owned(),
            port: 443,
            path: "/~cddb/cddb.cgi".to_owned(),
            protocol_level: 6,
            client_name: "MediaVerseStudio".to_owned(),
            client_version: "0.1".to_owned(),
            min_interval_ms: 1000,
            timeout_seconds: 20,
        }
    }
}

/// Gracenote needs credentials from Gracenote and their API terms; this version only stores the
/// settings and reports the service as unavailable (ADR 0006).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
#[derive(Default)]
pub struct GracenoteSettings {
    pub enabled: bool,
    pub base_url: String,
    pub client_id: Secret,
    pub user_id: Secret,
}

/// AcoustID identifies a recording from its audio fingerprint. The application key identifies this
/// program to the service (it is not a personal key); free for non-commercial use, 3 requests per
/// second at most. Settings only for now: fingerprinting is not built yet (ADR 0006).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct AcoustIdSettings {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Secret,
    pub min_interval_ms: u64,
}

/// The project's AcoustID application key, when the build was given one (`MEDIAVERSE_ACOUSTID_KEY` in the environment of the build). An application key identifies
/// the program to AcoustID and is meant to ship with it, but it is kept out of the public source: the packager supplies it at build time
/// (`tools/make-installer.ps1` reads it from a private file). A build without it, such as one made from the source, starts with no key and the Settings page asks.
pub const BUILT_IN_ACOUSTID_KEY: &str = match option_env!("MEDIAVERSE_ACOUSTID_KEY") {
    Some(key) => key,
    None => "",
};

impl Default for AcoustIdSettings {
    fn default() -> Self {
        Self {
            // Looking songs up sends fingerprints of the ripped songs to AcoustID, so the service stays switched off until the person switches it on; the key is
            // already filled in when the build has one.
            enabled: false,
            base_url: "https://api.acoustid.org".to_owned(),
            api_key: Secret::new(BUILT_IN_ACOUSTID_KEY),
            min_interval_ms: 340,
        }
    }
}

/// Discogs (ADR 0009): searched for albums MusicBrainz does not know, with the person's own personal access
/// token (discogs.com > Settings > Developers), so each person accepts Discogs' API terms themselves. 60
/// authenticated requests a minute. Only its CC0 catalogue data is used, never its images; its suggestions
/// carry "Data provided by Discogs" with a link, and are fetched again before being shown when older than six
/// hours (API Terms of Use, 27 May 2025).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct DiscogsSettings {
    pub enabled: bool,
    pub base_url: String,
    pub token: Secret,
    pub min_interval_ms: u64,
}

impl Default for DiscogsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: "https://api.discogs.com".to_owned(),
            token: Secret::default(),
            min_interval_ms: 1100,
        }
    }
}

/// Extra sources of artist photos (D107), tried only for artists Wikimedia has no photo for. Each is used only when the
/// person has typed their own key (TheAudioDB's, Fanart.tv's personal key), so each person accepts those services' terms.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ArtistPhotoSettings {
    pub audiodb_key: Secret,
    pub fanart_key: Secret,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct CoverArtSettings {
    pub enabled: bool,
    pub base_url: String,
}

impl Default for CoverArtSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            base_url: "https://coverartarchive.org".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct MetadataSettings {
    pub identity: Identity,
    pub musicbrainz: MusicBrainzSettings,
    pub cddb_servers: Vec<CddbServer>,
    pub gracenote: GracenoteSettings,
    pub acoustid: AcoustIdSettings,
    pub discogs: DiscogsSettings,
    pub photos: ArtistPhotoSettings,
    pub cover_art: CoverArtSettings,
}

impl Default for MetadataSettings {
    fn default() -> Self {
        let cddbp = CddbServer {
            name: "gnudb (CDDBP)".to_owned(),
            enabled: false,
            transport: Transport::Cddbp,
            port: 8880,
            path: String::new(),
            ..CddbServer::default()
        };
        Self {
            identity: Identity::default(),
            musicbrainz: MusicBrainzSettings::default(),
            cddb_servers: vec![CddbServer::default(), cddbp],
            gracenote: GracenoteSettings::default(),
            acoustid: AcoustIdSettings::default(),
            discogs: DiscogsSettings::default(),
            photos: ArtistPhotoSettings::default(),
            cover_art: CoverArtSettings::default(),
        }
    }
}

/// Splits `scheme://authority/rest`, returning the scheme and authority.
fn url_parts(url: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    Some((scheme, authority))
}

fn check_url(label: &str, url: &str, problems: &mut Vec<String>) {
    match url_parts(url) {
        Some((scheme, authority))
            if matches!(scheme, "http" | "https") && !authority.is_empty() =>
        {
            if authority.contains('@') {
                problems.push(format!(
                    "{label}: do not put a user name or password in the address."
                ));
            }
            if url.chars().any(char::is_whitespace) {
                problems.push(format!("{label}: the address cannot contain spaces."));
            }
        }
        _ => problems.push(format!(
            "{label}: enter a full address starting with http:// or https://."
        )),
    }
}

fn host_of(url: &str) -> String {
    url_parts(url)
        .map(|(_, authority)| authority.split(':').next().unwrap_or("").to_lowercase())
        .unwrap_or_default()
}

impl MetadataSettings {
    /// Every problem with these settings, in plain language. Empty means they can be saved.
    pub fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();

        let mb = &self.musicbrainz;
        if mb.enabled {
            check_url("MusicBrainz server", &mb.base_url, &mut problems);
            if host_of(&mb.base_url) == "musicbrainz.org" && mb.min_interval_ms < 1000 {
                problems.push("MusicBrainz allows about one request per second per address; keep the minimum interval at 1000 ms or more for musicbrainz.org.".to_owned());
            }
        }
        if !(1..=120).contains(&mb.timeout_seconds) {
            problems.push("MusicBrainz timeout must be between 1 and 120 seconds.".to_owned());
        }

        let mut names: Vec<String> = Vec::new();
        for server in &self.cddb_servers {
            let label = format!("CDDB server '{}'", server.name);
            if server.name.trim().is_empty() {
                problems.push("Every CDDB server needs a name.".to_owned());
            }
            let lowered = server.name.trim().to_lowercase();
            if lowered == "musicbrainz" || names.contains(&lowered) {
                problems.push(format!(
                    "{label}: that name is already used by another source."
                ));
            }
            names.push(lowered);
            if server.host.trim().is_empty()
                || server.host.contains(char::is_whitespace)
                || server.host.contains('/')
                || server.host.contains("://")
            {
                problems.push(format!(
                    "{label}: enter just the server's host name, such as gnudb.gnudb.org."
                ));
            }
            if server.port == 0 {
                problems.push(format!("{label}: the port must be between 1 and 65535."));
            }
            if server.transport != Transport::Cddbp && !server.path.starts_with('/') {
                problems.push(format!(
                    "{label}: the path must start with a slash, such as /~cddb/cddb.cgi."
                ));
            }
            if !(1..=6).contains(&server.protocol_level) {
                problems.push(format!(
                    "{label}: the protocol level must be between 1 and 6."
                ));
            }
            if server.client_name.trim().is_empty() || server.client_version.trim().is_empty() {
                problems.push(format!(
                    "{label}: the client name and version cannot be empty."
                ));
            }
            if !(1..=120).contains(&server.timeout_seconds) {
                problems.push(format!(
                    "{label}: the timeout must be between 1 and 120 seconds."
                ));
            }
        }

        if self.gracenote.enabled && !self.gracenote.base_url.trim().is_empty() {
            check_url("Gracenote server", &self.gracenote.base_url, &mut problems);
        }
        let acoustid = &self.acoustid;
        if acoustid.enabled {
            check_url("AcoustID server", &acoustid.base_url, &mut problems);
            if acoustid.api_key.expose().chars().any(char::is_whitespace) {
                problems.push("The AcoustID key cannot contain spaces.".to_owned());
            }
            if host_of(&acoustid.base_url) == "api.acoustid.org" && acoustid.min_interval_ms < 334 {
                problems.push("AcoustID allows at most 3 requests per second; keep the minimum interval at 334 ms or more for api.acoustid.org.".to_owned());
            }
        }
        let discogs = &self.discogs;
        if discogs.enabled {
            check_url("Discogs server", &discogs.base_url, &mut problems);
            if discogs.token.expose().chars().any(char::is_whitespace) {
                problems.push("The Discogs token cannot contain spaces.".to_owned());
            }
            if host_of(&discogs.base_url) == "api.discogs.com" && discogs.min_interval_ms < 1000 {
                problems.push("Discogs allows 60 requests a minute; keep the minimum interval at 1000 ms or more for api.discogs.com.".to_owned());
            }
        }
        if self.cover_art.enabled {
            check_url("Cover art server", &self.cover_art.base_url, &mut problems);
        }
        for (label, key) in [
            ("TheAudioDB", &self.photos.audiodb_key),
            ("Fanart.tv", &self.photos.fanart_key),
        ] {
            if key
                .expose()
                .chars()
                .any(|c| c.is_whitespace() || c == '/' || c == '?' || c == '&')
            {
                problems.push(format!(
                    "The {label} key can only contain the letters and numbers it was given as."
                ));
            }
        }
        problems
    }

    /// Things that are switched on but not filled in yet. These do not stop settings from being
    /// saved (they may be completed later); the source concerned reports `needs_setup` instead of
    /// being queried, and the settings page points them out.
    pub fn incomplete(&self) -> Vec<(&'static str, String)> {
        let mut gaps = Vec::new();
        if self.musicbrainz.enabled && self.identity.contact.trim().is_empty() {
            gaps.push((
                "musicbrainz",
                "MusicBrainz requires contact details: enter your email address or a web address under Identity.".to_owned(),
            ));
        }
        if self.cddb_servers.iter().any(|server| server.enabled)
            && !crate::cddb::looks_like_email(&self.identity.contact)
        {
            gaps.push((
                "cddb",
                "CDDB servers such as gnudb require a valid email address in every request. Enter one under Identity.".to_owned(),
            ));
        }
        if self.acoustid.enabled && !self.acoustid.api_key.is_set() {
            gaps.push((
                "acoustid",
                "AcoustID is turned on but has no application key. Enter the key from your AcoustID application page, or turn AcoustID off.".to_owned(),
            ));
        }
        if self.discogs.enabled && !self.discogs.token.is_set() {
            gaps.push(("discogs", "Discogs is turned on but has no personal access token. Make one at discogs.com > Settings > Developers, or turn Discogs off.".to_owned()));
        }
        gaps
    }

    /// The settings as shown to the interface or written to logs: credentials become
    /// `{"set": true|false}` so they can be seen to exist but never read back.
    pub fn public_view(&self) -> Value {
        let mut view = serde_json::to_value(self).unwrap_or(Value::Null);
        for key in ["client_id", "user_id"] {
            view["gracenote"][key] =
                json!({ "set": self.gracenote.client_id_or_user(key).is_set() });
        }
        view["acoustid"]["api_key"] = json!({ "set": self.acoustid.api_key.is_set() });
        view["discogs"]["token"] = json!({ "set": self.discogs.token.is_set() });
        view["photos"]["audiodb_key"] = json!({ "set": self.photos.audiodb_key.is_set() });
        view["photos"]["fanart_key"] = json!({ "set": self.photos.fanart_key.is_set() });
        view["setup_needed"] = Value::Array(
            self.incomplete()
                .into_iter()
                .map(|(source, message)| json!({ "source": source, "message": message }))
                .collect(),
        );
        view
    }

    /// Applies a partial update from the interface: objects merge field by field, anything else
    /// (including `null` and lists) replaces. A credential field that is absent, or is the
    /// `{"set": ...}` placeholder from [`public_view`], keeps its stored value; `null` or `""`
    /// clears it. The result is validated and returned only if it has no problems.
    pub fn with_update(&self, update: &Value) -> Result<MetadataSettings, Vec<String>> {
        fn merge(base: &mut Value, update: &Value) {
            match (base, update) {
                // The placeholder shown for a credential: leave the stored value alone.
                (_, Value::Object(update)) if update.len() == 1 && update.contains_key("set") => {}
                (Value::Object(base), Value::Object(update)) => {
                    for (key, value) in update {
                        merge(base.entry(key.clone()).or_insert(Value::Null), value);
                    }
                }
                (slot, value) => *slot = value.clone(),
            }
        }
        let mut merged = serde_json::to_value(self).map_err(|e| vec![e.to_string()])?;
        merge(&mut merged, update);
        let settings: MetadataSettings = serde_json::from_value(merged)
            .map_err(|e| vec![format!("These settings could not be read: {e}")])?;
        let problems = settings.validate();
        if problems.is_empty() {
            Ok(settings)
        } else {
            Err(problems)
        }
    }
}

impl GracenoteSettings {
    fn client_id_or_user(&self, key: &str) -> &Secret {
        if key == "client_id" {
            &self.client_id
        } else {
            &self.user_id
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_contact() -> MetadataSettings {
        let mut settings = MetadataSettings::default();
        settings.identity.contact = "me@example.com".to_owned();
        settings
    }

    #[test]
    fn the_discogs_token_is_never_shown_and_survives_other_changes() {
        let settings = with_contact()
            .with_update(&json!({ "discogs": { "enabled": true, "token": "abcDEF123" } }))
            .unwrap();
        assert_eq!(settings.discogs.token.expose(), "abcDEF123");
        let view = settings.public_view();
        assert_eq!(view["discogs"]["token"], json!({ "set": true }));
        assert!(!view.to_string().contains("abcDEF123"));
        // The page sends the placeholder back with other changes: the token stays.
        let again = settings
            .with_update(
                &json!({ "discogs": { "token": { "set": true }, "min_interval_ms": 1500 } }),
            )
            .unwrap();
        assert_eq!(again.discogs.token.expose(), "abcDEF123");
        assert!(
            MetadataSettings::default()
                .incomplete()
                .iter()
                .all(|(source, _)| *source != "discogs"),
            "off by default"
        );
        assert!(
            with_contact()
                .with_update(&json!({ "discogs": { "enabled": true, "min_interval_ms": 200 } }))
                .is_err()
        );
    }

    #[test]
    fn defaults_describe_gnudb_over_https_and_musicbrainz() {
        let settings = MetadataSettings::default();
        assert_eq!(settings.cddb_servers[0].host, "gnudb.gnudb.org");
        assert_eq!(
            (
                settings.cddb_servers[0].port,
                settings.cddb_servers[0].transport
            ),
            (443, Transport::Https)
        );
        assert_eq!(settings.cddb_servers[0].path, "/~cddb/cddb.cgi");
        assert_eq!(
            (
                settings.cddb_servers[1].port,
                settings.cddb_servers[1].transport,
                settings.cddb_servers[1].enabled
            ),
            (8880, Transport::Cddbp, false)
        );
        assert_eq!(settings.musicbrainz.min_interval_ms, 1100);
        assert!(!settings.gracenote.enabled);
        assert_eq!(settings.acoustid.base_url, "https://api.acoustid.org");
        assert!(!settings.acoustid.enabled, "off until a key is entered");
    }

    #[test]
    fn acoustid_needs_a_key_and_respects_its_rate_limit_and_stays_masked() {
        let mut settings = with_contact();
        settings.acoustid.enabled = true;
        assert!(
            settings.validate().is_empty(),
            "saving without a key is allowed"
        );
        assert!(settings.incomplete().iter().any(
            |(source, message)| *source == "acoustid" && message.contains("no application key")
        ));
        settings.acoustid.api_key = Secret::new("TEST-KEY-1234");
        assert!(settings.validate().is_empty(), "{:?}", settings.validate());
        assert!(settings.incomplete().is_empty());
        settings.acoustid.min_interval_ms = 100;
        assert!(
            settings
                .validate()
                .iter()
                .any(|p| p.contains("3 requests per second"))
        );
        settings.acoustid.min_interval_ms = 340;
        settings.acoustid.api_key = Secret::new("has space");
        assert!(
            settings
                .validate()
                .iter()
                .any(|p| p.contains("cannot contain spaces"))
        );

        settings.acoustid.api_key = Secret::new("TEST-KEY-1234");
        assert!(!format!("{settings:?}").contains("TEST-KEY-1234"));
        let view = settings.public_view();
        assert!(!view.to_string().contains("TEST-KEY-1234"));
        assert_eq!(view["acoustid"]["api_key"], json!({ "set": true }));

        // Replacing, keeping and clearing the key through updates.
        let kept = settings.with_update(&view).unwrap();
        assert_eq!(kept.acoustid.api_key.expose(), "TEST-KEY-1234");
        let replaced = settings
            .with_update(&json!({ "acoustid": { "api_key": "NEW-KEY-5678" } }))
            .unwrap();
        assert_eq!(replaced.acoustid.api_key.expose(), "NEW-KEY-5678");
        let cleared = settings
            .with_update(&json!({ "acoustid": { "enabled": false, "api_key": null } }))
            .unwrap();
        assert!(!cleared.acoustid.api_key.is_set());
    }

    #[test]
    fn missing_contact_details_are_flagged_as_incomplete_not_invalid() {
        let defaults = MetadataSettings::default();
        assert!(
            defaults.validate().is_empty(),
            "defaults can always be saved"
        );
        let gaps = defaults.incomplete();
        assert_eq!(
            gaps.iter().map(|g| g.0).collect::<Vec<_>>(),
            ["musicbrainz", "cddb"]
        );
        assert!(gaps[0].1.contains("requires contact details"));
        assert!(gaps[1].1.contains("valid email address"));
        assert_eq!(
            defaults.public_view()["setup_needed"][0]["source"],
            "musicbrainz"
        );
        assert!(with_contact().incomplete().is_empty());
        let mut off = MetadataSettings::default();
        off.musicbrainz.enabled = false;
        for server in &mut off.cddb_servers {
            server.enabled = false;
        }
        assert!(
            off.incomplete().is_empty(),
            "turned off, nothing is required"
        );
        let mut web_address = with_contact();
        web_address.identity.contact = "https://example.org/me".to_owned();
        let gaps = web_address.incomplete();
        assert_eq!(
            gaps.len(),
            1,
            "a web address satisfies MusicBrainz but not gnudb: {gaps:?}"
        );
        assert_eq!(gaps[0].0, "cddb");
    }

    #[test]
    fn servers_can_be_moved_and_added() {
        let mut settings = with_contact();
        settings.cddb_servers[0].host = "freedb.example.org".to_owned();
        settings.cddb_servers[0].port = 8080;
        settings.cddb_servers.push(CddbServer {
            name: "my mirror".to_owned(),
            host: "10.0.0.5".to_owned(),
            port: 8880,
            transport: Transport::Cddbp,
            ..CddbServer::default()
        });
        settings.musicbrainz.base_url = "https://mb.example.org:5000".to_owned();
        settings.musicbrainz.min_interval_ms = 100; // fine for a private mirror
        assert!(settings.validate().is_empty(), "{:?}", settings.validate());
    }

    #[test]
    fn bad_values_are_explained() {
        let mut settings = with_contact();
        settings.musicbrainz.base_url = "musicbrainz.org".to_owned();
        settings.cddb_servers[0].host = "http://gnudb.org/".to_owned();
        settings.cddb_servers[0].port = 0;
        settings.cddb_servers[0].path = "cddb.cgi".to_owned();
        settings.cddb_servers[0].protocol_level = 9;
        settings.cddb_servers[1].name = "GNUDB".to_owned(); // duplicate, ignoring case
        let problems = settings.validate().join("\n");
        for expected in [
            "starting with http",
            "just the server's host name",
            "between 1 and 65535",
            "start with a slash",
            "between 1 and 6",
            "already used",
        ] {
            assert!(
                problems.contains(expected),
                "missing '{expected}' in:\n{problems}"
            );
        }
    }

    #[test]
    fn the_musicbrainz_rate_rule_and_url_credentials_are_enforced() {
        let mut settings = with_contact();
        settings.musicbrainz.min_interval_ms = 200;
        assert!(
            settings
                .validate()
                .iter()
                .any(|p| p.contains("one request per second"))
        );
        settings.musicbrainz.min_interval_ms = 1100;
        settings.musicbrainz.base_url = "https://user:pass@musicbrainz.org".to_owned();
        assert!(
            settings
                .validate()
                .iter()
                .any(|p| p.contains("user name or password"))
        );
    }

    #[test]
    fn credentials_never_appear_in_debug_output_or_the_public_view() {
        let mut settings = with_contact();
        settings.gracenote = GracenoteSettings {
            enabled: true,
            base_url: "https://example.org".into(),
            client_id: Secret::new("CLIENT-SECRET-123"),
            user_id: Secret::default(),
        };
        let debug = format!("{settings:?}");
        assert!(!debug.contains("CLIENT-SECRET-123"), "{debug}");
        let view = settings.public_view().to_string();
        assert!(!view.contains("CLIENT-SECRET-123"), "{view}");
        assert_eq!(
            settings.public_view()["gracenote"]["client_id"],
            json!({ "set": true })
        );
        assert_eq!(
            settings.public_view()["gracenote"]["user_id"],
            json!({ "set": false })
        );
        // The stored form does keep the value, so it survives a restart.
        assert!(
            serde_json::to_string(&settings)
                .unwrap()
                .contains("CLIENT-SECRET-123")
        );
    }

    #[test]
    fn updates_keep_unmentioned_credentials_and_can_replace_or_clear_them() {
        let mut stored = with_contact();
        stored.gracenote.client_id = Secret::new("old-id");
        stored.gracenote.user_id = Secret::new("old-user");

        // The interface sends back what it was shown, plus a change elsewhere.
        let mut sent = stored.public_view();
        sent["musicbrainz"]["timeout_seconds"] = json!(30);
        let updated = stored.with_update(&sent).unwrap();
        assert_eq!(updated.gracenote.client_id.expose(), "old-id");
        assert_eq!(updated.gracenote.user_id.expose(), "old-user");
        assert_eq!(updated.musicbrainz.timeout_seconds, 30);

        let replaced = stored
            .with_update(&json!({ "gracenote": { "client_id": "new-id", "user_id": null } }))
            .unwrap();
        assert_eq!(replaced.gracenote.client_id.expose(), "new-id");
        assert!(
            !replaced.gracenote.user_id.is_set(),
            "null clears a credential"
        );

        let untouched = stored
            .with_update(&json!({ "cover_art": { "enabled": false } }))
            .unwrap();
        assert_eq!(untouched.gracenote.client_id.expose(), "old-id");
        assert_eq!(untouched.identity.contact, "me@example.com");
        assert!(!untouched.cover_art.enabled);
    }

    #[test]
    fn invalid_updates_are_rejected_whole() {
        let stored = with_contact();
        let problems = stored
            .with_update(&json!({ "cddb_servers": [{ "name": "x", "host": "", "port": 80 }] }))
            .unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("host name")),
            "{problems:?}"
        );
        assert!(
            stored
                .with_update(&json!({ "cddb_servers": "nonsense" }))
                .is_err()
        );
        assert_eq!(
            stored,
            with_contact(),
            "the stored settings are never changed by a failed update"
        );
    }

    #[test]
    fn settings_round_trip_and_tolerate_missing_fields() {
        let settings = with_contact();
        let text = serde_json::to_string(&settings).unwrap();
        assert_eq!(
            serde_json::from_str::<MetadataSettings>(&text).unwrap(),
            settings
        );
        let sparse: MetadataSettings =
            serde_json::from_str(r#"{"identity":{"contact":"a@b.c"}}"#).unwrap();
        assert_eq!(
            sparse.cddb_servers.len(),
            2,
            "defaults fill in anything an older settings file lacks"
        );
        assert_eq!(sparse.identity.contact, "a@b.c");
        let old: MetadataSettings =
            serde_json::from_str(r#"{"identity":{"contact":"a@b.c","user":"old","host":"old"}}"#)
                .unwrap();
        assert_eq!(
            old.identity.contact, "a@b.c",
            "settings files from before the identity change still load"
        );
    }
}

#[cfg(test)]
mod built_in_key_tests {
    use super::*;

    #[test]
    fn a_build_given_a_key_starts_with_it_and_stays_switched_off() {
        let defaults = AcoustIdSettings::default();
        assert_eq!(defaults.api_key.expose(), BUILT_IN_ACOUSTID_KEY);
        assert_eq!(
            defaults.api_key.is_set(),
            option_env!("MEDIAVERSE_ACOUSTID_KEY").is_some_and(|k| !k.is_empty())
        );
        assert!(!defaults.enabled, "looking songs up is the person's choice");
        println!(
            "built-in key length seen by the test: {}",
            BUILT_IN_ACOUSTID_KEY.len()
        );
    }
}
