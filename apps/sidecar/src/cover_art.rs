//! Cover art (ADR 0005, decision D15): downloaded from the Cover Art Archive and saved as a plain
//! `cover.jpg` (or `cover.png`) next to the FLAC masters. It is never embedded in a FLAC; the MP3
//! step embeds it in the library copies.
//!
//! Downloaded images are untrusted input. They are accepted only if they are really a JPEG or PNG of
//! a sensible size and shape, and are written byte for byte as received (never decoded or
//! re-encoded here).

use crate::lookup::{SourceResult, fail, http_get};
use std::time::Duration;

/// Largest image accepted, in bytes. Cover images of a few hundred kilobytes are normal.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Largest image embedded in an MP3 (the matching limit in the tag writer is `id3::MAX_PICTURE_BYTES`).
pub const EMBED_LIMIT_BYTES: usize = 500 * 1024;
/// Largest side of a picture embedded in an MP3 (owner, 2026-11-05).
pub const EMBED_MAX_SIDE: u32 = 1000;
const MIN_SIDE: u32 = 150;
const MAX_SIDE: u32 = 6_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Jpeg,
    Png,
}

impl Kind {
    pub fn extension(self) -> &'static str {
        match self {
            Kind::Jpeg => "jpg",
            Kind::Png => "png",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageInfo {
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    /// A progressive JPEG: valid, but some older players and car stereos cannot show it.
    pub progressive: bool,
}

pub struct CoverImage {
    pub bytes: Vec<u8>,
    pub info: ImageInfo,
}

fn jpeg_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return Err("the JPEG data is damaged".to_owned());
        }
        let marker = bytes[at + 1];
        if marker == 0xFF {
            at += 1; // fill byte
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            at += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break; // end of image or start of scan: no size information came first
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let is_frame = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_frame {
            let frame = bytes
                .get(at + 4..at + 9)
                .ok_or("the JPEG header is cut short")?;
            let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
            let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
            let progressive = matches!(marker, 0xC2 | 0xC6 | 0xCA | 0xCE);
            return Ok(ImageInfo {
                kind: Kind::Jpeg,
                width,
                height,
                progressive,
            });
        }
        if length < 2 {
            return Err("the JPEG data is damaged".to_owned());
        }
        at += 2 + length;
    }
    Err("the JPEG has no size information".to_owned())
}

fn png_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    if bytes.len() < 33 || &bytes[12..16] != b"IHDR" {
        return Err("the PNG header is missing".to_owned());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok(ImageInfo {
        kind: Kind::Png,
        width,
        height,
        progressive: false,
    })
}

/// Whether an image may be embedded in an MP3: small enough, and not a progressive JPEG (which some
/// players and car stereos cannot show). Returns the reason when it may not.
pub fn embedding_problem(image: &CoverImage) -> Option<String> {
    // Owner, 2026-11-05: embedded pictures are JPEG and at most 1000 × 1000 pixels; the full size stays in the
    // folder. (The Cover Art Archive's 1200 px cover is then embedded from its 500 px JPEG.)
    if image.info.width.max(image.info.height) > EMBED_MAX_SIDE {
        return Some(format!(
            "it is {} × {} pixels, over the {EMBED_MAX_SIDE} pixel limit for embedding",
            image.info.width, image.info.height
        ));
    }
    if image.info.kind == Kind::Png {
        return Some("it is a PNG; embedded pictures are JPEG".to_owned());
    }
    if image.bytes.len() > crate::cover_art::EMBED_LIMIT_BYTES {
        return Some(format!(
            "it is {} KB, over the {} KB limit for embedding",
            image.bytes.len() / 1024,
            crate::cover_art::EMBED_LIMIT_BYTES / 1024
        ));
    }
    image
        .info
        .progressive
        .then(|| "it is a progressive JPEG".to_owned())
}

/// The kind and pixel size of a JPEG or PNG, without the checks for downloads (any size is reported).
pub fn image_info(bytes: &[u8]) -> Option<ImageInfo> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        jpeg_info(bytes).ok()
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        png_info(bytes).ok()
    } else {
        None
    }
}

/// Checks that `bytes` really is a usable cover image. Never trusts a file name or content type.
pub fn validate_image(bytes: &[u8]) -> Result<ImageInfo, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "the image is too large ({} bytes; the limit is {MAX_IMAGE_BYTES})",
            bytes.len()
        ));
    }
    let info = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        jpeg_info(bytes)?
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        png_info(bytes)?
    } else {
        return Err("the download is not a JPEG or PNG image".to_owned());
    };
    if info.width < MIN_SIDE
        || info.height < MIN_SIDE
        || info.width > MAX_SIDE
        || info.height > MAX_SIDE
    {
        return Err(format!(
            "the image is {}x{} pixels, outside the accepted {MIN_SIDE} to {MAX_SIDE} range",
            info.width, info.height
        ));
    }
    let ratio = f64::from(info.width) / f64::from(info.height);
    if !(0.5..=2.0).contains(&ratio) {
        return Err(format!(
            "the image is {}x{} pixels, which is not cover-shaped",
            info.width, info.height
        ));
    }
    Ok(info)
}

/// A MusicBrainz release id: hexadecimal digits and dashes only (so it cannot alter the URL).
pub fn is_release_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Fetches the front cover for a release. Tries the 1200-pixel version, then 500. "Not found" is an
/// ordinary answer (many releases have no art), reported as the code `no_cover`.
pub fn fetch_front_cover(
    base_url: &str,
    release: &str,
    user_agent: &str,
    timeout: Duration,
) -> SourceResult<CoverImage> {
    fetch_front_cover_sizes(
        base_url,
        release,
        user_agent,
        timeout,
        &["front-1200", "front-500"],
    )
}

/// Like [`fetch_front_cover`] with the sizes to try, in order (`front-1200`, `front-500`, `front-250`).
pub fn fetch_front_cover_sizes(
    base_url: &str,
    release: &str,
    user_agent: &str,
    timeout: Duration,
    sizes: &[&str],
) -> SourceResult<CoverImage> {
    if !is_release_id(release) {
        return fail(
            "bad_release_id",
            "The cover art id is not a valid release id.",
        );
    }
    fetch_front_path(
        &format!("{}/release/{release}", base_url.trim_end_matches('/')),
        user_agent,
        timeout,
        sizes,
    )
}

/// The release group's front cover, for a pressing that has none of its own.
pub fn fetch_group_front(
    base_url: &str,
    group_id: &str,
    user_agent: &str,
    timeout: Duration,
    sizes: &[&str],
) -> SourceResult<CoverImage> {
    if !is_release_id(group_id) {
        return fail(
            "bad_release_id",
            "The cover art id is not a valid release id.",
        );
    }
    fetch_front_path(
        &format!(
            "{}/release-group/{group_id}",
            base_url.trim_end_matches('/')
        ),
        user_agent,
        timeout,
        sizes,
    )
}

/// One picture at an address already checked (`allowed_cover_url`): iTunes, Deezer, or the cover archive.
pub fn fetch_image_url(url: &str, user_agent: &str, timeout: Duration) -> SourceResult<CoverImage> {
    if !mediaverse_disc_metadata::streaming::allowed_cover_url(url) {
        return fail(
            "bad_image",
            "That picture address is not one this program will open.",
        );
    }
    let reply = http_get(url, user_agent, timeout)?;
    match reply.status {
        200 => validate_image(&reply.body)
            .map(|info| CoverImage {
                bytes: reply.body,
                info,
            })
            .map_err(|problem| {
                (
                    "bad_image".to_owned(),
                    format!("The cover art could not be used: {problem}."),
                )
            }),
        404 => fail("no_cover", "No front cover is available at that address."),
        429 | 503 => fail(
            "rate_limited",
            "The cover art server is busy. Try again later.",
        ),
        other => fail(
            "bad_image",
            format!("The cover art could not be used: the server answered HTTP {other}."),
        ),
    }
}

fn fetch_front_path(
    prefix: &str,
    user_agent: &str,
    timeout: Duration,
    sizes: &[&str],
) -> SourceResult<CoverImage> {
    let mut last_problem = None;
    for size in sizes {
        let reply = http_get(&format!("{prefix}/{size}"), user_agent, timeout)?;
        match reply.status {
            200 => match validate_image(&reply.body) {
                Ok(info) => {
                    return Ok(CoverImage {
                        bytes: reply.body,
                        info,
                    });
                }
                Err(problem) => last_problem = Some(problem),
            },
            404 => {}
            429 | 503 => {
                return fail(
                    "rate_limited",
                    "The cover art server is busy. Try again later.",
                );
            }
            other => last_problem = Some(format!("the server answered HTTP {other}")),
        }
    }
    match last_problem {
        Some(problem) => fail(
            "bad_image",
            format!("The cover art could not be used: {problem}."),
        ),
        None => fail("no_cover", "No front cover is available for this release."),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A minimal but structurally valid baseline JPEG of the given size (no real picture data).
    pub fn tiny_jpeg(width: u16, height: u16, progressive: bool) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        out.extend_from_slice(b"JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        out.extend_from_slice(&[
            0xFF,
            if progressive { 0xC2 } else { 0xC0 },
            0x00,
            0x11,
            0x08,
        ]);
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[
            0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9,
        ]);
        out
    }

    pub fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        out
    }

    #[test]
    fn accepts_real_looking_jpegs_and_pngs_and_reads_their_size() {
        let jpeg = validate_image(&tiny_jpeg(1200, 1200, false)).unwrap();
        assert_eq!(
            (jpeg.kind, jpeg.width, jpeg.height, jpeg.progressive),
            (Kind::Jpeg, 1200, 1200, false)
        );
        assert_eq!(jpeg.kind.extension(), "jpg");
        assert!(
            validate_image(&tiny_jpeg(500, 500, true))
                .unwrap()
                .progressive
        );
        let png = validate_image(&tiny_png(600, 590)).unwrap();
        assert_eq!((png.kind, png.width, png.height), (Kind::Png, 600, 590));
        assert_eq!(png.kind.extension(), "png");
    }

    #[test]
    fn rejects_things_that_are_not_usable_covers() {
        assert!(
            validate_image(b"<html>404 not found</html>")
                .unwrap_err()
                .contains("not a JPEG or PNG")
        );
        assert!(validate_image(b"GIF89a....").is_err());
        assert!(validate_image(&[]).is_err());
        assert!(
            validate_image(&tiny_jpeg(50, 50, false))
                .unwrap_err()
                .contains("outside the accepted")
        );
        assert!(
            validate_image(&tiny_jpeg(9000, 9000, false))
                .unwrap_err()
                .contains("outside the accepted")
        );
        assert!(
            validate_image(&tiny_jpeg(1000, 200, false))
                .unwrap_err()
                .contains("not cover-shaped")
        );
        let mut huge = tiny_jpeg(1000, 1000, false);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(validate_image(&huge).unwrap_err().contains("too large"));
        // Truncated or damaged headers do not panic.
        for cut in 0..tiny_jpeg(800, 800, false).len() {
            let _ = validate_image(&tiny_jpeg(800, 800, false)[..cut]);
        }
        let mut damaged = tiny_jpeg(800, 800, false);
        damaged[2] = 0x00;
        assert!(validate_image(&damaged).is_err() || validate_image(&damaged).is_ok());
        assert!(validate_image(&tiny_png(800, 800)[..20]).is_err());
    }

    #[test]
    fn release_ids_cannot_change_the_request() {
        assert!(is_release_id("7a5c73ca-9819-49dc-baec-bb99573720c8"));
        for bad in [
            "",
            "7a5c73ca",
            "../../etc/passwd",
            "7a5c73ca-9819-49dc-baec-bb99573720c8/../x",
            "7a5c73ca-9819-49dc-baec-bb99573720c8?x=y",
            "zzzzzzzz-9819-49dc-baec-bb99573720c8",
        ] {
            assert!(!is_release_id(bad), "{bad}");
        }
    }
}
