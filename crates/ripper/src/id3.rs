//! ID3v2.3 tags for the MP3 library copies (decision D17). Version 2.3 is chosen because Windows
//! Explorer and most older players read it best. Everything is written by this module, so every byte
//! can be checked, and the same lesson as with FLAC applies: a tag is only trusted after being read
//! back and compared with what was meant to be written.
//!
//! ID3v2.3 text is ISO-8859-1 (encoding byte 0) or UTF-16 with a byte-order mark (encoding byte 1);
//! it has no UTF-8. Text that fits Latin-1 is stored that way, anything else as UTF-16.
//!
//! The same picture and lyrics model serves the library page, where the user pastes images and
//! lyrics by hand: a picture has a [`PictureKind`] (front cover, back cover or artist photo).

use std::fmt;

pub const MAX_PICTURE_BYTES: usize = 500 * 1024;
const MAX_TAG_BYTES: usize = 4 * 1024 * 1024;
const PADDING_BYTES: usize = 2048;

#[derive(Debug, Eq, PartialEq)]
pub enum Id3Error {
    /// The tag could not be built from what was given.
    Build(String),
    /// A tag that was read back is malformed or does not match what was written.
    Invalid(String),
}

impl fmt::Display for Id3Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Build(m) => write!(f, "the tag could not be built: {m}"),
            Self::Invalid(m) => write!(f, "the tag is not valid: {m}"),
        }
    }
}

impl std::error::Error for Id3Error {}

fn build<T>(message: impl Into<String>) -> Result<T, Id3Error> {
    Err(Id3Error::Build(message.into()))
}

fn invalid<T>(message: impl Into<String>) -> Result<T, Id3Error> {
    Err(Id3Error::Invalid(message.into()))
}

/// ID3 picture type 0, "Other": how many programs store an album's cover.
pub const OTHER_PICTURE: u8 = 0;

/// What an embedded picture shows. The numbers are ID3's picture types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PictureKind {
    FrontCover,
    BackCover,
    ArtistPhoto,
}

impl PictureKind {
    pub fn id3_type(self) -> u8 {
        match self {
            Self::FrontCover => 3,
            Self::BackCover => 4,
            Self::ArtistPhoto => 8,
        }
    }

    pub fn from_id3_type(value: u8) -> Option<Self> {
        match value {
            3 => Some(Self::FrontCover),
            4 => Some(Self::BackCover),
            8 => Some(Self::ArtistPhoto),
            _ => None,
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::FrontCover => "Front cover",
            Self::BackCover => "Back cover",
            Self::ArtistPhoto => "Artist",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Picture {
    pub kind: PictureKind,
    /// A JPEG or PNG exactly as it will be stored.
    pub data: Vec<u8>,
}

/// One line of synced lyrics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyncedLine {
    pub milliseconds: u32,
    pub text: String,
}

/// Everything that goes into one MP3's tag. Absent fields write no frame.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TagSet {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track: Option<(u32, Option<u32>)>,
    pub disc: Option<(u32, Option<u32>)>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub compilation: bool,
    pub pictures: Vec<Picture>,
    pub lyrics: Option<String>,
    pub synced_lyrics: Vec<SyncedLine>,
    /// The MusicBrainz recording id (a UUID), written as the standard `UFID` frame owned by `http://musicbrainz.org`,
    /// where Picard, Navidrome, Jellyfin and other software look for it.
    pub recording_id: Option<String>,
    /// The AcoustID (a UUID), written as the `TXXX` frame "Acoustid Id", as Picard does.
    pub acoustid_id: Option<String>,
}

/// The owner of the `UFID` frame that holds a MusicBrainz recording id.
const MUSICBRAINZ_UFID_OWNER: &str = "http://musicbrainz.org";
/// The description of the `TXXX` frame that holds the AcoustID.
const ACOUSTID_DESCRIPTION: &str = "Acoustid Id";

/// A UUID as MusicBrainz and AcoustID write ids: 8-4-4-4-12 hexadecimal digits.
pub fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_latin1(text: &str) -> bool {
    text.chars().all(|c| (c as u32) <= 0xFF)
}

/// Text as an ID3v2.3 string: the encoding byte and the bytes (no terminator).
fn encode_text(text: &str) -> (u8, Vec<u8>) {
    if is_latin1(text) {
        (0, text.chars().map(|c| c as u8).collect())
    } else {
        (1, utf16_with_bom(text))
    }
}

/// A string in UTF-16 with its byte-order mark (what encoding 1 requires for every string).
fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn terminator(encoding: u8) -> &'static [u8] {
    if encoding == 1 { &[0, 0] } else { &[0] }
}

fn frame(id: &str, body: Vec<u8>) -> Vec<u8> {
    let mut out = id.as_bytes().to_vec();
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&body);
    out
}

fn text_frame(id: &str, text: &str) -> Vec<u8> {
    let (encoding, bytes) = encode_text(text);
    let mut body = vec![encoding];
    body.extend_from_slice(&bytes);
    frame(id, body)
}

fn fraction(value: (u32, Option<u32>)) -> String {
    match value.1 {
        Some(total) => format!("{}/{total}", value.0),
        None => value.0.to_string(),
    }
}

/// Normalises line endings to the single `\n` the tag uses, and removes characters (NUL and other
/// controls except newline and tab) that would break the frame.
fn clean_lyrics(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

fn mime_of(data: &[u8]) -> Result<&'static str, Id3Error> {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Ok("image/jpeg")
    } else if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Ok("image/png")
    } else {
        build("a picture is not a JPEG or PNG image")
    }
}

/// Builds a complete ID3v2.3 tag (header, frames, a little padding for later in-place edits).
pub fn write_tag(tags: &TagSet) -> Result<Vec<u8>, Id3Error> {
    let mut frames: Vec<u8> = Vec::new();
    for (id, value) in [
        ("TIT2", &tags.title),
        ("TPE1", &tags.artist),
        ("TALB", &tags.album),
        ("TPE2", &tags.album_artist),
    ] {
        if value.chars().any(char::is_control) {
            return build(format!(
                "the text of {id} contains control characters; clean it first"
            ));
        }
        if !value.is_empty() {
            frames.extend(text_frame(id, value));
        }
    }
    if let Some(track) = tags.track {
        frames.extend(text_frame("TRCK", &fraction(track)));
    }
    if let Some(disc) = tags.disc {
        frames.extend(text_frame("TPOS", &fraction(disc)));
    }
    if let Some(year) = tags.year {
        frames.extend(text_frame("TYER", &year.to_string()));
    }
    if let Some(genre) = &tags.genre {
        if genre.chars().any(char::is_control) {
            return build("the genre contains control characters; clean it first");
        }
        frames.extend(text_frame("TCON", genre));
    }
    if tags.compilation {
        frames.extend(text_frame("TCMP", "1"));
    }
    if let Some(id) = tags.recording_id.as_deref() {
        if !is_uuid(id) {
            return build("the MusicBrainz recording id is not a UUID");
        }
        // UFID: the owner (Latin-1, NUL-terminated), then the identifier as raw bytes.
        let mut body = MUSICBRAINZ_UFID_OWNER.as_bytes().to_vec();
        body.push(0);
        body.extend_from_slice(id.to_ascii_lowercase().as_bytes());
        frames.extend(frame("UFID", body));
    }
    if let Some(id) = tags.acoustid_id.as_deref() {
        if !is_uuid(id) {
            return build("the AcoustID is not a UUID");
        }
        // TXXX: the encoding byte, the description and the value, each Latin-1 and NUL-terminated (the value needs none).
        let mut body = vec![0];
        body.extend_from_slice(ACOUSTID_DESCRIPTION.as_bytes());
        body.push(0);
        body.extend_from_slice(id.to_ascii_lowercase().as_bytes());
        frames.extend(frame("TXXX", body));
    }

    for picture in &tags.pictures {
        frames.extend(picture_frame(picture)?);
    }
    frames.extend(lyrics_frames(tags.lyrics.as_deref(), &tags.synced_lyrics));
    assemble_tag(&frames)
}

/// One `APIC` frame for a picture (JPEG or PNG, at most [`MAX_PICTURE_BYTES`]).
fn picture_frame(picture: &Picture) -> Result<Vec<u8>, Id3Error> {
    if picture.data.len() > MAX_PICTURE_BYTES {
        return build(format!(
            "a picture is {} bytes; the limit is {MAX_PICTURE_BYTES}",
            picture.data.len()
        ));
    }
    let mime = mime_of(&picture.data)?;
    let mut body = vec![0u8]; // Latin-1 description
    body.extend_from_slice(mime.as_bytes());
    body.push(0);
    body.push(picture.kind.id3_type());
    body.extend_from_slice(picture.kind.description().as_bytes());
    body.push(0);
    body.extend_from_slice(&picture.data);
    Ok(frame("APIC", body))
}

/// The `USLT` (plain) and `SYLT` (synced) frames for the given lyrics; none for empty lyrics.
fn lyrics_frames(plain: Option<&str>, synced: &[SyncedLine]) -> Vec<u8> {
    let mut frames = Vec::new();
    if let Some(lyrics) = plain.map(clean_lyrics).filter(|l| !l.trim().is_empty()) {
        let (encoding, bytes) = encode_text(&lyrics);
        let mut body = vec![encoding];
        body.extend_from_slice(b"XXX");
        if encoding == 1 {
            body.extend_from_slice(&[0xFF, 0xFE]);
        }
        body.extend_from_slice(terminator(encoding)); // empty content descriptor
        body.extend_from_slice(&bytes);
        frames.extend(frame("USLT", body));
    }
    if !synced.is_empty() {
        let all_latin1 = synced.iter().all(|l| is_latin1(&l.text));
        let encoding = if all_latin1 { 0 } else { 1 };
        let mut body = vec![encoding];
        body.extend_from_slice(b"XXX");
        body.push(2); // timestamps in milliseconds
        body.push(1); // content type: lyrics
        if encoding == 1 {
            body.extend_from_slice(&[0xFF, 0xFE]);
        }
        body.extend_from_slice(terminator(encoding)); // empty content descriptor
        for line in synced {
            let text = clean_lyrics(&line.text).replace('\n', " ");
            // In UTF-16 every string carries its own byte-order mark, even when it is empty.
            let bytes: Vec<u8> = if encoding == 0 {
                text.chars().map(|c| c as u8).collect()
            } else {
                utf16_with_bom(&text)
            };
            body.extend_from_slice(&bytes);
            body.extend_from_slice(terminator(encoding));
            body.extend_from_slice(&line.milliseconds.to_be_bytes());
        }
        frames.extend(frame("SYLT", body));
    }
    frames
}

/// Wraps already-built frames in the tag header and padding.
fn assemble_tag(frames: &[u8]) -> Result<Vec<u8>, Id3Error> {
    let size = frames.len() + PADDING_BYTES;
    if size > MAX_TAG_BYTES {
        return build(format!(
            "the tag would be {size} bytes; the limit is {MAX_TAG_BYTES}"
        ));
    }
    let mut out = b"ID3".to_vec();
    out.extend_from_slice(&[3, 0, 0]);
    out.extend_from_slice(&[
        (size >> 21) as u8 & 0x7F,
        (size >> 14) as u8 & 0x7F,
        (size >> 7) as u8 & 0x7F,
        size as u8 & 0x7F,
    ]);
    out.extend_from_slice(frames);
    out.extend(std::iter::repeat(0).take(PADDING_BYTES));
    Ok(out)
}

/// A change to one kind of picture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PictureChange {
    /// Replace any picture of this kind with this one.
    Set(Picture),
    /// Remove any picture of this kind.
    Remove(PictureKind),
}

/// A change to the lyrics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LyricsChange {
    /// Replace both the plain and the synced lyrics.
    Set {
        plain: String,
        synced: Vec<SyncedLine>,
    },
    Remove,
    /// Replace only the synced lyrics (empty: remove them); the plain lyrics, with the band's own layout and labels, stay exactly as they are.
    Synced(Vec<SyncedLine>),
}

/// What to change in an existing tag. Everything not mentioned is kept exactly as it is.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TagEdit {
    pub pictures: Vec<PictureChange>,
    pub lyrics: Option<LyricsChange>,
}

/// Builds the replacement tag for a file whose current tag is at the start of `file` (or that has
/// none). Only this program's own ID3v2.3 tags are edited: a tag in another version or with flags is
/// refused rather than guessed at, so nothing is silently lost.
pub fn edit_tag(file: &[u8], edit: &TagEdit) -> Result<Vec<u8>, Id3Error> {
    let existing = if file.starts_with(b"ID3") {
        read_frames(file)?
    } else {
        Vec::new()
    };
    let touches = |frame: &Frame, kinds: &[u8]| -> bool {
        match frame.id.as_str() {
            "APIC" => frame_picture(frame).is_ok_and(|(_, kind, _)| kinds.contains(&kind)),
            _ => false,
        }
    };
    let mut changed_kinds: Vec<u8> = edit
        .pictures
        .iter()
        .map(|change| match change {
            PictureChange::Set(picture) => picture.kind.id3_type(),
            PictureChange::Remove(kind) => kind.id3_type(),
        })
        .collect();
    // Many programs store the album cover as picture type 0 ("Other"): it is the front cover without its label,
    // so a new or removed front cover replaces it too (otherwise the old cover stays beside the new one).
    if changed_kinds.contains(&PictureKind::FrontCover.id3_type()) {
        changed_kinds.push(OTHER_PICTURE);
    }
    let replace_lyrics = edit.lyrics.is_some();
    let synced_only = matches!(edit.lyrics, Some(LyricsChange::Synced(_)));

    let mut frames: Vec<u8> = Vec::new();
    for old in &existing {
        let drop = touches(old, &changed_kinds)
            || (replace_lyrics && (old.id == "SYLT" || (old.id == "USLT" && !synced_only)));
        if !drop {
            frames.extend(frame(&old.id, old.body.clone()));
        }
    }
    for change in &edit.pictures {
        if let PictureChange::Set(picture) = change {
            frames.extend(picture_frame(picture)?);
        }
    }
    match &edit.lyrics {
        Some(LyricsChange::Set { plain, synced }) => {
            frames.extend(lyrics_frames(Some(plain), synced));
        }
        Some(LyricsChange::Synced(synced)) => frames.extend(lyrics_frames(None, synced)),
        _ => {}
    }
    assemble_tag(&frames)
}

/// One frame read back from a tag.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub id: String,
    pub body: Vec<u8>,
}

/// Total length of the tag at the start of `bytes` (header plus body), or an error if there is none
/// or it is malformed.
pub fn tag_length(bytes: &[u8]) -> Result<usize, Id3Error> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return invalid("the file has no ID3 tag at its start");
    }
    if bytes[3] != 3 || bytes[4] != 0 {
        return invalid(format!(
            "the tag is version 2.{}.{}, not 2.3.0",
            bytes[3], bytes[4]
        ));
    }
    if bytes[5] != 0 {
        return invalid(
            "the tag uses flags (unsynchronisation, extended header or experimental) that this program does not write",
        );
    }
    if bytes[6..10].iter().any(|b| b & 0x80 != 0) {
        return invalid("the tag size is not a valid synchsafe number");
    }
    let size = bytes[6..10]
        .iter()
        .fold(0usize, |acc, &b| (acc << 7) | usize::from(b));
    if size > MAX_TAG_BYTES || 10 + size > bytes.len() {
        return invalid("the tag is larger than the file or than the allowed limit");
    }
    Ok(10 + size)
}

/// True when any frame of the tag at the start of `bytes` has a flag set (see `read_frames`).
fn has_frame_flags(bytes: &[u8]) -> Result<bool, Id3Error> {
    let end = tag_length(bytes)?;
    let mut at = 10;
    while at + 10 <= end && bytes[at] != 0 {
        if bytes[at + 8] != 0 || bytes[at + 9] != 0 {
            return Ok(true);
        }
        let size = u32::from_be_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
            as usize;
        at += 10 + size;
    }
    Ok(false)
}

/// Parses the frames of the tag at the start of `bytes`. The rest of the tag after the last frame
/// must be zero padding.
pub fn read_frames(bytes: &[u8]) -> Result<Vec<Frame>, Id3Error> {
    let end = tag_length(bytes)?;
    let mut at = 10;
    let mut frames = Vec::new();
    while at + 10 <= end && bytes[at] != 0 {
        let id = &bytes[at..at + 4];
        if !id
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return invalid("a frame has an invalid name");
        }
        let size = u32::from_be_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
            as usize;
        // The second flag byte says how the frame is stored: compressed (0x80), encrypted (0x40) or with a group
        // byte (0x20) cannot be read here. The first byte only holds status flags ("discard if the tag/file is
        // altered", "read only"), which Windows Media Player sets on TLEN: the frame reads as usual, and is written
        // back without them (owner, 2026-11-05: The Mighty Mighty Bosstones' "When God Was Great" could not be saved).
        if bytes[at + 9] & 0xE0 != 0 {
            return invalid(
                "a frame is compressed, encrypted or grouped, which this program cannot edit",
            );
        }
        if size == 0 || at + 10 + size > end {
            return invalid("a frame is empty or runs past the end of the tag");
        }
        frames.push(Frame {
            id: String::from_utf8_lossy(id).into_owned(),
            body: bytes[at + 10..at + 10 + size].to_vec(),
        });
        at += 10 + size;
    }
    if bytes[at..end].iter().any(|&b| b != 0) {
        return invalid("there is data after the last frame that is not padding");
    }
    Ok(frames)
}

/// Decodes the text of a text-like body slice given its encoding byte. Accepts ISO-8859-1 and
/// UTF-16 with a byte-order mark only.
fn decode_text(encoding: u8, bytes: &[u8]) -> Result<String, Id3Error> {
    match encoding {
        0 => Ok(bytes.iter().map(|&b| char::from(b)).collect()),
        1 => {
            let (little, rest) = match bytes {
                [0xFF, 0xFE, rest @ ..] => (true, rest),
                [0xFE, 0xFF, rest @ ..] => (false, rest),
                _ if bytes.is_empty() => return Ok(String::new()),
                _ => return invalid("UTF-16 text has no byte-order mark"),
            };
            if rest.len() % 2 != 0 {
                return invalid("UTF-16 text has an odd number of bytes");
            }
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|p| {
                    if little {
                        u16::from_le_bytes([p[0], p[1]])
                    } else {
                        u16::from_be_bytes([p[0], p[1]])
                    }
                })
                .collect();
            String::from_utf16(&units).or_else(|_| invalid("UTF-16 text is not valid"))
        }
        other => invalid(format!(
            "text uses encoding {other}, which ID3v2.3 does not allow"
        )),
    }
}

/// The text of a text frame (`T...`) body.
pub fn frame_text(frame: &Frame) -> Result<String, Id3Error> {
    let (&encoding, rest) = frame
        .body
        .split_first()
        .ok_or(Id3Error::Invalid("an empty text frame".to_owned()))?;
    let text = decode_text(encoding, rest)?;
    Ok(text.trim_end_matches('\0').to_owned())
}

/// A picture frame (`APIC`) read back.
pub fn frame_picture(frame: &Frame) -> Result<(String, u8, Vec<u8>), Id3Error> {
    let body = &frame.body;
    let encoding = *body
        .first()
        .ok_or(Id3Error::Invalid("an empty picture frame".to_owned()))?;
    let mime_end = body[1..]
        .iter()
        .position(|&b| b == 0)
        .ok_or(Id3Error::Invalid("a picture has no MIME type".to_owned()))?
        + 1;
    let mime = String::from_utf8_lossy(&body[1..mime_end]).into_owned();
    let kind = *body
        .get(mime_end + 1)
        .ok_or(Id3Error::Invalid("a picture is cut short".to_owned()))?;
    let desc_start = mime_end + 2;
    let desc_end = if encoding == 1 {
        body[desc_start..]
            .chunks_exact(2)
            .position(|p| p == [0, 0])
            .map(|i| desc_start + i * 2 + 2)
    } else {
        body[desc_start..]
            .iter()
            .position(|&b| b == 0)
            .map(|i| desc_start + i + 1)
    }
    .ok_or(Id3Error::Invalid(
        "a picture description is not terminated".to_owned(),
    ))?;
    Ok((mime, kind, body[desc_end..].to_vec()))
}

/// A plain-lyrics frame (`USLT`) read back: the lyrics text.
pub fn frame_lyrics(frame: &Frame) -> Result<String, Id3Error> {
    let body = &frame.body;
    let encoding = *body
        .first()
        .ok_or(Id3Error::Invalid("an empty lyrics frame".to_owned()))?;
    if body.len() < 5 {
        return invalid("a lyrics frame is cut short");
    }
    let descriptor_start = 4;
    let end = if encoding == 1 {
        body[descriptor_start..]
            .chunks_exact(2)
            .position(|p| p == [0, 0])
            .map(|i| descriptor_start + i * 2 + 2)
    } else {
        body[descriptor_start..]
            .iter()
            .position(|&b| b == 0)
            .map(|i| descriptor_start + i + 1)
    }
    .ok_or(Id3Error::Invalid(
        "a lyrics descriptor is not terminated".to_owned(),
    ))?;
    decode_text(encoding, &body[end..])
}

/// A synced-lyrics frame (`SYLT`) read back.
pub fn frame_synced(frame: &Frame) -> Result<Vec<SyncedLine>, Id3Error> {
    let body = &frame.body;
    if body.len() < 7 {
        return invalid("a synced lyrics frame is cut short");
    }
    let encoding = body[0];
    if body[4] != 2 || body[5] != 1 {
        return invalid(
            "synced lyrics must use millisecond timestamps and the lyrics content type",
        );
    }
    let step = if encoding == 1 { 2 } else { 1 };
    let mut at = 6;
    // Skip the content descriptor.
    while at + step <= body.len() && body[at..at + step].iter().any(|&b| b != 0) {
        at += step;
    }
    at += step;
    let mut lines = Vec::new();
    while at < body.len() {
        let start = at;
        while at + step <= body.len() && body[at..at + step].iter().any(|&b| b != 0) {
            at += step;
        }
        if at + step + 4 > body.len() {
            return invalid("a synced lyrics line is cut short");
        }
        let text = decode_text(encoding, &body[start..at])?;
        at += step;
        let milliseconds = u32::from_be_bytes([body[at], body[at + 1], body[at + 2], body[at + 3]]);
        at += 4;
        lines.push(SyncedLine { milliseconds, text });
    }
    Ok(lines)
}

/// Reads a written tag back and checks that it holds exactly what `expected` describes: every text
/// frame equal, pictures equal byte for byte and of the right kind, lyrics equal. Nothing extra.
pub fn check_tag(bytes: &[u8], expected: &TagSet) -> Result<(), Id3Error> {
    // This program never writes frame flags: any flag in a tag it wrote is a fault.
    if has_frame_flags(bytes)? {
        return invalid("a frame has flags set, which this program never writes");
    }
    let frames = read_frames(bytes)?;
    let reference = read_frames(&write_tag(expected)?)?;
    let describe = |frames: &[Frame]| -> Result<Vec<(String, Vec<u8>)>, Id3Error> {
        let mut out = Vec::new();
        for f in frames {
            // Validate each frame's own structure while describing it.
            match f.id.as_str() {
                id if id.starts_with('T') => {
                    frame_text(f)?;
                }
                "APIC" => {
                    let (mime, kind, data) = frame_picture(f)?;
                    if mime_of(&data).ok() != Some(mime.as_str()) {
                        return invalid("a picture's MIME type does not match its data");
                    }
                    if PictureKind::from_id3_type(kind).is_none() {
                        return invalid(format!("a picture has an unexpected type {kind}"));
                    }
                }
                "USLT" => {
                    frame_lyrics(f)?;
                }
                "SYLT" => {
                    frame_synced(f)?;
                }
                "UFID" => {
                    let valid = f
                        .body
                        .iter()
                        .position(|&b| b == 0)
                        .is_some_and(|nul| nul > 0 && nul + 1 < f.body.len());
                    if !valid {
                        return invalid("a UFID frame has no owner or no identifier");
                    }
                }
                other => return invalid(format!("the tag has an unexpected frame {other}")),
            }
            out.push((f.id.clone(), f.body.clone()));
        }
        Ok(out)
    };
    if describe(&frames)? == describe(&reference)? {
        Ok(())
    } else {
        invalid("the tag read back is not the tag that was written")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg() -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        data.extend(std::iter::repeat(0xAB).take(2000));
        data.extend_from_slice(&[0xFF, 0xD9]);
        data
    }

    fn png() -> Vec<u8> {
        let mut data = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        data.extend(std::iter::repeat(0x11).take(500));
        data
    }

    fn full() -> TagSet {
        TagSet {
            title: "Zürich – 東京".into(),
            artist: "Band".into(),
            album: "Album".into(),
            album_artist: "Various Artists".into(),
            track: Some((5, Some(12))),
            disc: Some((2, Some(3))),
            year: Some(1996),
            genre: Some("Rock".into()),
            compilation: true,
            pictures: vec![
                Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(),
                },
                Picture {
                    kind: PictureKind::BackCover,
                    data: png(),
                },
                Picture {
                    kind: PictureKind::ArtistPhoto,
                    data: jpeg(),
                },
            ],
            lyrics: Some("First line\r\nSecond line\nThird é".into()),
            synced_lyrics: vec![
                SyncedLine {
                    milliseconds: 1500,
                    text: "First line".into(),
                },
                SyncedLine {
                    milliseconds: 90_250,
                    text: "Second 東京".into(),
                },
            ],
            recording_id: Some("b9ad642e-b012-41c7-b72a-42cf4911f9ff".into()),
            acoustid_id: Some("7C8F5A4E-8F3B-4B0E-9F77-3C0E1F2A9B11".into()),
        }
    }

    #[test]
    fn the_musicbrainz_and_acoustid_ids_are_standard_frames_and_bad_ids_are_refused() {
        let bytes = write_tag(&full()).unwrap();
        let frames = read_frames(&bytes).unwrap();
        let ufid = frames
            .iter()
            .find(|f| f.id == "UFID")
            .expect("a UFID frame");
        assert_eq!(
            ufid.body,
            [
                b"http://musicbrainz.org".as_slice(),
                &[0],
                b"b9ad642e-b012-41c7-b72a-42cf4911f9ff"
            ]
            .concat(),
            "owner, NUL, the id as ASCII"
        );
        let txxx = frames
            .iter()
            .find(|f| f.id == "TXXX")
            .expect("a TXXX frame");
        assert_eq!(
            txxx.body,
            [
                [0u8].as_slice(),
                b"Acoustid Id",
                &[0],
                b"7c8f5a4e-8f3b-4b0e-9f77-3c0e1f2a9b11"
            ]
            .concat(),
            "Latin-1, description, NUL, the id in lower case"
        );
        check_tag(&bytes, &full()).unwrap();
        assert!(
            write_tag(&TagSet {
                recording_id: Some("not-a-uuid".into()),
                ..TagSet::default()
            })
            .is_err()
        );
        assert!(
            write_tag(&TagSet {
                acoustid_id: Some("b9ad642e-b012-41c7-b72a-42cf4911f9fg".into()),
                ..TagSet::default()
            })
            .is_err()
        );
        assert!(
            write_tag(&TagSet {
                title: "x".into(),
                ..TagSet::default()
            })
            .map(|b| read_frames(&b)
                .unwrap()
                .iter()
                .all(|f| f.id != "UFID" && f.id != "TXXX"))
            .unwrap(),
            "no ids, no frames"
        );
    }

    #[test]
    fn writes_a_valid_v2_3_header_and_pads_with_zeros() {
        let bytes = write_tag(&full()).unwrap();
        assert_eq!(&bytes[..6], b"ID3\x03\x00\x00");
        assert_eq!(tag_length(&bytes).unwrap(), bytes.len());
        assert!(bytes[bytes.len() - PADDING_BYTES..].iter().all(|&b| b == 0));
        read_frames(&bytes).unwrap();
    }

    #[test]
    fn a_full_tag_reads_back_exactly() {
        let tags = full();
        let bytes = write_tag(&tags).unwrap();
        check_tag(&bytes, &tags).unwrap();
        let frames = read_frames(&bytes).unwrap();
        let text = |id: &str| frame_text(frames.iter().find(|f| f.id == id).unwrap()).unwrap();
        assert_eq!(text("TIT2"), "Zürich – 東京");
        assert_eq!(text("TRCK"), "5/12");
        assert_eq!(text("TPOS"), "2/3");
        assert_eq!(text("TYER"), "1996");
        assert_eq!(text("TCMP"), "1");
        assert_eq!(text("TPE2"), "Various Artists");
        let pictures: Vec<_> = frames
            .iter()
            .filter(|f| f.id == "APIC")
            .map(|f| frame_picture(f).unwrap())
            .collect();
        assert_eq!(
            pictures
                .iter()
                .map(|p| (p.0.as_str(), p.1))
                .collect::<Vec<_>>(),
            [("image/jpeg", 3), ("image/png", 4), ("image/jpeg", 8)]
        );
        assert_eq!(pictures[1].2, png(), "pictures are stored byte for byte");
        let lyrics = frame_lyrics(frames.iter().find(|f| f.id == "USLT").unwrap()).unwrap();
        assert_eq!(
            lyrics, "First line\nSecond line\nThird é",
            "line endings are normalised to a newline"
        );
        let synced = frame_synced(frames.iter().find(|f| f.id == "SYLT").unwrap()).unwrap();
        assert_eq!(synced, tags.synced_lyrics);
    }

    #[test]
    fn plain_latin_text_uses_iso_8859_1_and_other_text_uses_utf16() {
        let bytes = write_tag(&TagSet {
            title: "Café".into(),
            artist: "日本".into(),
            ..TagSet::default()
        })
        .unwrap();
        let frames = read_frames(&bytes).unwrap();
        assert_eq!(frames[0].body[0], 0, "Café fits ISO-8859-1");
        assert_eq!(frames[0].body[1..], [b'C', b'a', b'f', 0xE9]);
        assert_eq!(frames[1].body[0], 1, "Japanese needs UTF-16");
        assert_eq!(
            &frames[1].body[1..3],
            &[0xFF, 0xFE],
            "with a byte-order mark"
        );
    }

    #[test]
    fn empty_tags_and_optional_frames_are_left_out() {
        let bytes = write_tag(&TagSet {
            title: "Only".into(),
            ..TagSet::default()
        })
        .unwrap();
        let frames = read_frames(&bytes).unwrap();
        assert_eq!(
            frames.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["TIT2"]
        );
        let none = write_tag(&TagSet::default()).unwrap();
        assert!(read_frames(&none).unwrap().is_empty());
    }

    #[test]
    fn unsafe_input_is_refused_not_written() {
        assert!(
            write_tag(&TagSet {
                title: "bad\nname".into(),
                ..TagSet::default()
            })
            .is_err()
        );
        assert!(
            write_tag(&TagSet {
                genre: Some("a\0b".into()),
                ..TagSet::default()
            })
            .is_err()
        );
        let not_an_image = Picture {
            kind: PictureKind::FrontCover,
            data: b"GIF89a".to_vec(),
        };
        assert!(
            write_tag(&TagSet {
                pictures: vec![not_an_image],
                ..TagSet::default()
            })
            .is_err()
        );
        let mut big = jpeg();
        big.resize(MAX_PICTURE_BYTES + 1, 0);
        assert!(
            write_tag(&TagSet {
                pictures: vec![Picture {
                    kind: PictureKind::FrontCover,
                    data: big
                }],
                ..TagSet::default()
            })
            .unwrap_err()
            .to_string()
            .contains("limit")
        );
        // Lyrics may contain newlines and tabs but not NUL or other controls.
        let bytes = write_tag(&TagSet {
            lyrics: Some("a\0b\u{7}c\td\ne".into()),
            ..TagSet::default()
        })
        .unwrap();
        let frames = read_frames(&bytes).unwrap();
        assert_eq!(frame_lyrics(&frames[0]).unwrap(), "abc\td\ne");
    }

    #[test]
    fn faults_in_a_written_tag_are_caught() {
        let tags = full();
        let good = write_tag(&tags).unwrap();
        let mut v24 = good.clone();
        v24[3] = 4;
        assert!(
            check_tag(&v24, &tags)
                .unwrap_err()
                .to_string()
                .contains("not 2.3.0")
        );
        let mut flagged = good.clone();
        flagged[5] = 0x80;
        assert!(
            check_tag(&flagged, &tags).is_err(),
            "unsynchronisation flag"
        );
        let mut bad_size = good.clone();
        bad_size[6] = 0xFF;
        assert!(
            check_tag(&bad_size, &tags).is_err(),
            "size is not synchsafe"
        );
        assert!(
            check_tag(&good[..good.len() - 100], &tags).is_err(),
            "truncated"
        );
        assert!(check_tag(b"no tag here at all", &tags).is_err());
        let mut junk = good.clone();
        let last = junk.len() - 1;
        junk[last] = 1;
        assert!(
            check_tag(&junk, &tags)
                .unwrap_err()
                .to_string()
                .contains("not padding")
        );
        let mut other = tags.clone();
        other.title = "Different".into();
        assert!(check_tag(&good, &other).is_err(), "altered text");
        let mut missing = tags.clone();
        missing.pictures.pop();
        assert!(check_tag(&good, &missing).is_err(), "an extra picture");
        let mut flags = good.clone();
        flags[10 + 8] = 1; // a frame flag
        assert!(check_tag(&flags, &tags).is_err());
    }

    #[test]
    fn every_single_byte_change_in_the_frames_is_either_caught_or_harmless_text() {
        let tags = TagSet {
            title: "Song".into(),
            artist: "Band".into(),
            track: Some((3, Some(9))),
            pictures: vec![Picture {
                kind: PictureKind::FrontCover,
                data: jpeg(),
            }],
            ..TagSet::default()
        };
        let good = write_tag(&tags).unwrap();
        let frames_end = good.len() - PADDING_BYTES;
        let mut accepted = 0;
        for i in 10..frames_end {
            let mut damaged = good.clone();
            damaged[i] ^= 0x01;
            if check_tag(&damaged, &tags).is_ok() {
                accepted += 1;
            }
        }
        assert_eq!(
            accepted, 0,
            "any change at all to a written tag must be noticed when compared with the intended tag"
        );
        // The size field is different: changing it leaves a valid tag with other padding, but the
        // tag's length changes, so the MP3 check (audio must start exactly where the tag ends) sees it.
        for i in 6..10 {
            let mut damaged = good.clone();
            damaged[i] ^= 0x01;
            assert_ne!(tag_length(&damaged).ok(), Some(good.len()), "byte {i}");
        }
    }
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    fn jpeg(fill: u8) -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        data.extend(std::iter::repeat(fill).take(200));
        data.extend_from_slice(&[0xFF, 0xD9]);
        data
    }

    fn base() -> Vec<u8> {
        let tags = TagSet {
            title: "Song".into(),
            artist: "Band".into(),
            album: "Album".into(),
            pictures: vec![
                Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(1),
                },
                Picture {
                    kind: PictureKind::ArtistPhoto,
                    data: jpeg(2),
                },
            ],
            lyrics: Some("Old words".into()),
            synced_lyrics: vec![SyncedLine {
                milliseconds: 100,
                text: "Old".into(),
            }],
            ..TagSet::default()
        };
        let mut file = write_tag(&tags).unwrap();
        file.extend_from_slice(b"AUDIO");
        file
    }

    fn pictures_of(file: &[u8]) -> Vec<(u8, Vec<u8>)> {
        read_frames(file)
            .unwrap()
            .iter()
            .filter(|f| f.id == "APIC")
            .map(|f| frame_picture(f).map(|(_, k, d)| (k, d)).unwrap())
            .collect()
    }

    #[test]
    fn setting_one_picture_kind_keeps_everything_else() {
        let file = base();
        let tag = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![PictureChange::Set(Picture {
                    kind: PictureKind::BackCover,
                    data: jpeg(9),
                })],
                lyrics: None,
            },
        )
        .unwrap();
        let mut edited = tag;
        edited.extend_from_slice(b"AUDIO");
        let pictures = pictures_of(&edited);
        assert_eq!(pictures.len(), 3);
        assert!(
            pictures.contains(&(3, jpeg(1)))
                && pictures.contains(&(8, jpeg(2)))
                && pictures.contains(&(4, jpeg(9)))
        );
        let frames = read_frames(&edited).unwrap();
        assert_eq!(
            frame_text(frames.iter().find(|f| f.id == "TIT2").unwrap()).unwrap(),
            "Song"
        );
        assert_eq!(
            frame_lyrics(frames.iter().find(|f| f.id == "USLT").unwrap()).unwrap(),
            "Old words",
            "lyrics untouched"
        );
    }

    #[test]
    fn a_frame_with_status_flags_is_read_and_edited_but_a_compressed_one_is_refused() {
        // As Windows Media Player writes TLEN: "discard if the tag is altered" (0x80 in the first flag byte).
        let mut frames = frame("TIT2", b"\x00Decide".to_vec());
        let mut tlen = frame("TLEN", b"\x00164133".to_vec());
        tlen[8] = 0x80;
        frames.extend(tlen.clone());
        let header = |n: usize| {
            let n = n as u32;
            vec![
                b'I',
                b'D',
                b'3',
                3,
                0,
                0,
                ((n >> 21) & 0x7F) as u8,
                ((n >> 14) & 0x7F) as u8,
                ((n >> 7) & 0x7F) as u8,
                (n & 0x7F) as u8,
            ]
        };
        let mut file = header(frames.len());
        file.extend(&frames);
        let read = read_frames(&file).unwrap();
        assert_eq!(
            read.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["TIT2", "TLEN"]
        );
        let edited = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![PictureChange::Set(Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(3),
                })],
                lyrics: None,
            },
        )
        .unwrap();
        assert!(
            pictures_of(&edited).contains(&(3, jpeg(3))),
            "the cover can be saved"
        );
        assert_eq!(
            frame_text(
                read_frames(&edited)
                    .unwrap()
                    .iter()
                    .find(|f| f.id == "TLEN")
                    .unwrap()
            )
            .unwrap(),
            "164133"
        );

        // Compressed (0x80 in the second flag byte): refused rather than guessed at.
        let mut packed = frame("TIT2", b"\x00x".to_vec());
        packed[9] = 0x80;
        let mut bad = header(packed.len());
        bad.extend(&packed);
        assert!(read_frames(&bad).is_err());
    }

    #[test]
    fn a_new_front_cover_replaces_a_cover_stored_as_other() {
        // An APIC frame of type 0 ("Other"), as other programs write the cover.
        let mut body = vec![0u8];
        body.extend_from_slice(b"image/jpeg\0");
        body.push(OTHER_PICTURE);
        body.push(0);
        body.extend_from_slice(&jpeg(5));
        let file = write_tag(&TagSet {
            title: "Song".into(),
            pictures: vec![Picture {
                kind: PictureKind::BackCover,
                data: jpeg(4),
            }],
            ..TagSet::default()
        })
        .unwrap();
        let mut frames: Vec<u8> = read_frames(&file)
            .unwrap()
            .iter()
            .flat_map(|f| frame(&f.id, f.body.clone()))
            .collect();
        frames.extend(frame("APIC", body));
        let mut tagged = b"ID3\x03\x00\x00".to_vec();
        let n = frames.len() as u32;
        tagged.extend_from_slice(&[
            ((n >> 21) & 0x7F) as u8,
            ((n >> 14) & 0x7F) as u8,
            ((n >> 7) & 0x7F) as u8,
            (n & 0x7F) as u8,
        ]);
        tagged.extend(frames);
        assert!(pictures_of(&tagged).contains(&(OTHER_PICTURE, jpeg(5))));
        let edited = edit_tag(
            &tagged,
            &TagEdit {
                pictures: vec![PictureChange::Set(Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(7),
                })],
                lyrics: None,
            },
        )
        .unwrap();
        let pictures = pictures_of(&edited);
        assert!(
            pictures.contains(&(3, jpeg(7))) && pictures.contains(&(4, jpeg(4))),
            "{pictures:?}"
        );
        assert!(
            !pictures.iter().any(|(k, _)| *k == OTHER_PICTURE),
            "the untyped cover is replaced"
        );
    }

    #[test]
    fn replacing_and_removing_a_kind_affects_only_that_kind() {
        let file = base();
        let replaced = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![PictureChange::Set(Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(7),
                })],
                lyrics: None,
            },
        )
        .unwrap();
        let mut f = replaced.clone();
        f.extend_from_slice(b"AUDIO");
        let pictures = pictures_of(&f);
        assert_eq!(
            pictures.iter().filter(|(k, _)| *k == 3).count(),
            1,
            "one front cover, not two"
        );
        assert!(pictures.contains(&(3, jpeg(7))) && pictures.contains(&(8, jpeg(2))));

        let removed = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![PictureChange::Remove(PictureKind::ArtistPhoto)],
                lyrics: None,
            },
        )
        .unwrap();
        let mut f = removed;
        f.extend_from_slice(b"AUDIO");
        assert_eq!(pictures_of(&f), vec![(3, jpeg(1))]);
    }

    #[test]
    fn lyrics_are_replaced_as_a_pair_or_removed() {
        let file = base();
        let set = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Set {
                    plain: "New\nwords é".into(),
                    synced: vec![],
                }),
            },
        )
        .unwrap();
        let frames = read_frames(&set).unwrap();
        assert_eq!(
            frame_lyrics(frames.iter().find(|f| f.id == "USLT").unwrap()).unwrap(),
            "New\nwords é"
        );
        assert!(
            !frames.iter().any(|f| f.id == "SYLT"),
            "the old synced lyrics are gone"
        );
        assert_eq!(
            pictures_of(&[set.clone(), b"AUDIO".to_vec()].concat()).len(),
            2,
            "pictures untouched"
        );

        let cleared = edit_tag(
            &file,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Remove),
            },
        )
        .unwrap();
        let frames = read_frames(&cleared).unwrap();
        assert!(!frames.iter().any(|f| f.id == "USLT" || f.id == "SYLT"));
    }

    #[test]
    fn replacing_only_the_synced_lyrics_keeps_the_plain_words_as_they_were() {
        let with_words = edit_tag(
            &base(),
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Set {
                    plain: "[Chorus]\nHey ho (x2)".into(),
                    synced: vec![],
                }),
            },
        )
        .unwrap();
        let timed = edit_tag(
            &with_words,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Synced(vec![SyncedLine {
                    milliseconds: 1500,
                    text: "Hey ho".into(),
                }])),
            },
        )
        .unwrap();
        let frames = read_frames(&timed).unwrap();
        assert_eq!(
            frame_lyrics(frames.iter().find(|f| f.id == "USLT").unwrap()).unwrap(),
            "[Chorus]\nHey ho (x2)",
            "the band's words and labels are untouched"
        );
        let synced = frame_synced(frames.iter().find(|f| f.id == "SYLT").unwrap()).unwrap();
        assert_eq!(synced.len(), 1);
        assert_eq!(synced[0].milliseconds, 1500);

        let untimed = edit_tag(
            &timed,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Synced(vec![])),
            },
        )
        .unwrap();
        let frames = read_frames(&untimed).unwrap();
        assert!(frames.iter().any(|f| f.id == "USLT"));
        assert!(!frames.iter().any(|f| f.id == "SYLT"));
    }

    #[test]
    fn a_file_with_no_tag_gets_one_and_unsupported_tags_are_refused() {
        let tag = edit_tag(
            b"\xFF\xFB\x90\x00",
            &TagEdit {
                pictures: vec![PictureChange::Set(Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(5),
                })],
                lyrics: None,
            },
        )
        .unwrap();
        assert_eq!(pictures_of(&tag).len(), 1);
        let mut v24 = base();
        v24[3] = 4;
        assert!(
            edit_tag(&v24, &TagEdit::default()).is_err(),
            "other tag versions are not edited"
        );
        assert!(
            edit_tag(
                &base(),
                &TagEdit {
                    pictures: vec![PictureChange::Set(Picture {
                        kind: PictureKind::FrontCover,
                        data: b"not an image".to_vec()
                    })],
                    lyrics: None
                }
            )
            .is_err()
        );
        assert!(
            edit_tag(
                &base(),
                &TagEdit {
                    pictures: vec![PictureChange::Set(Picture {
                        kind: PictureKind::FrontCover,
                        data: vec![0xFF, 0xD8, 0xFF]
                            .into_iter()
                            .chain(std::iter::repeat(0).take(MAX_PICTURE_BYTES))
                            .collect()
                    })],
                    lyrics: None
                }
            )
            .is_err()
        );
    }
}
