//! Sending a disc to gnudb (D107), only when the person asks for it and has typed their own email address. The entry is built
//! and checked by `mediaverse_disc_metadata::gnudb_submit`; this posts it to the CGI beside the lookup server.

use crate::drives::{Drives, failure};
use crate::helper::HelperError;
use crate::lookup::http_post_text;
use mediaverse_disc_metadata::gnudb_submit::{Submission, entry_text, problem};
use mediaverse_disc_metadata::settings::{CddbServer, Transport};
use mediaverse_disc_metadata::{DiscToc, discid};
use serde_json::{Value, json};
use std::time::Duration;

/// `…/cddb.cgi` becomes `…/submit.cgi` on the same server; only the web (http and https) transports can submit.
pub(crate) fn submit_url(server: &CddbServer) -> Option<String> {
    let scheme = match server.transport {
        Transport::Http => "http",
        Transport::Https => "https",
        Transport::Cddbp => return None,
    };
    let path = if server.path.contains("cddb.cgi") {
        server.path.replace("cddb.cgi", "submit.cgi")
    } else {
        format!(
            "{}/submit.cgi",
            server
                .path
                .trim_end_matches('/')
                .rsplit_once('/')
                .map_or("", |(dir, _)| dir)
        )
    };
    let default_port =
        (scheme == "http" && server.port == 80) || (scheme == "https" && server.port == 443);
    let host = if default_port {
        server.host.clone()
    } else {
        format!("{}:{}", server.host, server.port)
    };
    Some(format!("{scheme}://{host}{path}"))
}

/// What the server's answer means: `Ok` for "200 …", otherwise its own words.
pub(crate) fn read_answer(status: u16, body: &str) -> Result<String, String> {
    let first = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if status == 200 && first.starts_with("200") {
        return Ok(first.to_owned());
    }
    Err(if first.is_empty() {
        format!("gnudb answered HTTP {status}.")
    } else {
        format!("gnudb said: {first}")
    })
}

fn parse(args: &Value) -> Result<(DiscToc, Submission), String> {
    let text = |key: &str| args[key].as_str().unwrap_or("").trim().to_owned();
    let starts: Vec<u32> = args["toc"]["track_starts"]
        .as_array()
        .ok_or("The disc's table of contents is missing.")?
        .iter()
        .filter_map(|v| v.as_u64().map(|n| n as u32))
        .collect();
    let leadout = args["toc"]["leadout"]
        .as_u64()
        .ok_or("The disc's table of contents is missing.")? as u32;
    if starts.is_empty() {
        return Err("The disc's table of contents is missing.".to_owned());
    }
    let tracks = args["tracks"]
        .as_array()
        .ok_or("The track titles are missing.")?
        .iter()
        .map(|t| {
            (
                t["title"].as_str().unwrap_or("").trim().to_owned(),
                t["artist"]
                    .as_str()
                    .map(str::trim)
                    .filter(|a| !a.is_empty())
                    .map(str::to_owned),
            )
        })
        .collect();
    let submission = Submission {
        artist: text("artist"),
        album: text("album"),
        year: args["year"].as_u64().map(|y| y as u32),
        genre: text("genre"),
        tracks,
        compilation: args["compilation"] == true,
        category: match text("category") {
            chosen if chosen.is_empty() => {
                mediaverse_disc_metadata::gnudb_submit::category_for(&text("genre")).to_owned()
            }
            chosen => chosen,
        },
        email: text("email"),
    };
    Ok((
        DiscToc {
            track_starts: starts,
            leadout,
        },
        submission,
    ))
}

impl Drives {
    /// The `submit_gnudb` command. Returns `{discid, message}` when gnudb accepted the entry.
    pub(crate) fn submit_gnudb(&self, args: &Value) -> Result<Value, HelperError> {
        let (toc, submission) = parse(args).map_err(|m| failure("invalid_submission", m))?;
        if let Some(why) = problem(&toc, &submission) {
            return Err(failure("invalid_submission", why));
        }
        let settings = self.metadata.current();
        let server = settings
            .cddb_servers
            .iter()
            .filter(|s| s.enabled)
            .find(|s| submit_url(s).is_some())
            .ok_or_else(|| {
                failure(
                    "no_server",
                    "No gnudb server that works over the web is switched on in Settings.",
                )
            })?;
        let url = submit_url(server).expect("checked above");
        let program = format!("{} {}", server.client_name, server.client_version);
        let body = entry_text(&toc, &submission, &program);
        let id = discid::cddb_id(&toc);
        self.metadata
            .wait_turn(&server.name, Duration::from_millis(server.min_interval_ms));
        let headers = [
            ("Category", submission.category.as_str()),
            ("Discid", id.as_str()),
            ("User-Email", submission.email.as_str()),
            ("Submit-Mode", "submit"),
            ("Charset", "UTF-8"),
            (
                "X-Cddbd-Note",
                "Sent from MediaVerse Studio by the owner of the disc",
            ),
        ];
        let reply = http_post_text(
            &url,
            &program,
            Duration::from_secs(server.timeout_seconds.max(10)),
            &headers,
            &body,
        )
        .map_err(|(code, message)| failure(&code, message))?;
        match read_answer(reply.status, &String::from_utf8_lossy(&reply.body)) {
            Ok(message) => {
                Ok(json!({ "discid": id, "message": message, "category": submission.category }))
            }
            Err(message) => Err(failure("rejected", message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn the_submit_address_sits_beside_the_lookup_one() {
        let mut server = CddbServer::default();
        server.transport = Transport::Http;
        server.host = "gnudb.gnudb.org".into();
        server.port = 80;
        server.path = "/~cddb/cddb.cgi".into();
        assert_eq!(
            submit_url(&server).as_deref(),
            Some("http://gnudb.gnudb.org/~cddb/submit.cgi")
        );
        server.transport = Transport::Https;
        server.port = 8443;
        assert_eq!(
            submit_url(&server).as_deref(),
            Some("https://gnudb.gnudb.org:8443/~cddb/submit.cgi")
        );
        server.path = "/other/lookup".into();
        assert_eq!(
            submit_url(&server).as_deref(),
            Some("https://gnudb.gnudb.org:8443/other/submit.cgi")
        );
        server.transport = Transport::Cddbp;
        assert_eq!(submit_url(&server), None);
    }

    #[test]
    fn the_answer_is_read_as_accepted_or_in_the_servers_words() {
        assert_eq!(
            read_answer(200, "200 OK, submission has been sent.\n"),
            Ok("200 OK, submission has been sent.".to_owned())
        );
        assert_eq!(
            read_answer(200, "501 Invalid header information [email address]"),
            Err("gnudb said: 501 Invalid header information [email address]".to_owned())
        );
        assert_eq!(
            read_answer(500, ""),
            Err("gnudb answered HTTP 500.".to_owned())
        );
    }

    #[test]
    fn a_post_carries_the_headers_and_the_raw_entry() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = vec![0u8; 8192];
            let mut got = 0;
            loop {
                let n = stream.read(&mut buffer[got..]).unwrap();
                got += n;
                let text = String::from_utf8_lossy(&buffer[..got]).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let _ = stream.write_all(b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n200 OK, submission has been sent.\r\n");
            String::from_utf8_lossy(&buffer[..got]).into_owned()
        });
        let headers = [
            ("Category", "rock"),
            ("Discid", "19024103"),
            ("User-Email", "me@example.com"),
            ("Submit-Mode", "submit"),
        ];
        let reply = http_post_text(
            &format!("http://127.0.0.1:{port}/~cddb/submit.cgi"),
            "Test 1",
            Duration::from_secs(5),
            &headers,
            "# xmcd\nDISCID=19024103\n",
        )
        .unwrap();
        assert_eq!(reply.status, 200);
        let request = handle.join().unwrap();
        assert!(
            request.starts_with("POST /~cddb/submit.cgi HTTP/1.1"),
            "{request}"
        );
        let lower = request.to_lowercase();
        assert!(
            lower.contains("category: rock")
                && lower.contains("discid: 19024103")
                && lower.contains("user-email: me@example.com")
                && lower.contains("submit-mode: submit"),
            "{request}"
        );
        assert!(
            request.ends_with("# xmcd\nDISCID=19024103\n"),
            "the entry is sent raw: {request}"
        );
    }

    #[test]
    fn the_arguments_are_read_and_a_missing_toc_is_refused() {
        let args = json!({ "toc": { "track_starts": [0, 100], "leadout": 300 }, "artist": " A ", "album": "B", "year": 2019, "genre": "Rock", "category": "rock", "email": "x@y.zz", "tracks": [{ "title": "One" }, { "title": "Two", "artist": "G" }] });
        let (toc, s) = parse(&args).unwrap();
        assert_eq!(
            (
                toc.track_count(),
                toc.leadout,
                s.artist.as_str(),
                s.tracks[1].1.as_deref()
            ),
            (2, 300, "A", Some("G"))
        );
        assert!(parse(&json!({ "artist": "A" })).is_err());
        assert_eq!(s.category, "rock");
        let (_, picked) = parse(&json!({ "toc": { "track_starts": [0], "leadout": 9 }, "genre": "Reggae", "category": "", "tracks": [] })).unwrap();
        assert_eq!(
            picked.category, "reggae",
            "an empty category is picked from the genre"
        );
    }
}
