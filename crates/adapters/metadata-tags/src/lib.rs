use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey, TagExt};
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TrackMetadata {
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub artist: Option<String>,
    pub genre: Option<String>,
    pub release_year: Option<u32>,
    pub track_number: Option<u32>,
    pub title: Option<String>,
    /// The compilation flag ("TCMP" in ID3v2, "COMPILATION" in FLAC and Ogg, "cpil" in MP4). `None` leaves whatever
    /// the file has; `Some(true)` sets it; `Some(false)` removes it. When writing only.
    pub compilation: Option<bool>,
}

pub fn read_track_metadata(path: &Path) -> Result<TrackMetadata, MetadataError> {
    read_track_details(path).map(|(metadata, _)| metadata)
}

/// What the file itself says beyond its tags, for the library's columns.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileFacts {
    pub length_ms: Option<u64>,
    pub bitrate_kbps: Option<u32>,
    pub disc_number: Option<u32>,
}

/**
 * Reads a file's tags the usual way, and when that fails, once more leniently: a single damaged frame (a date that
 * is not four digits, as in the owner's "Countin' Cards") otherwise hides every tag of the file (owner, 2026-11-05).
 * The lenient read skips what it cannot parse.
 */
pub fn read_tagged(path: &Path) -> lofty::error::Result<lofty::file::TaggedFile> {
    use lofty::config::{ParseOptions, ParsingMode};
    lofty::read_from_path(path).or_else(|first| {
        lofty::probe::Probe::open(path)
            .map(|probe| probe.options(ParseOptions::new().parsing_mode(ParsingMode::Relaxed)))
            .and_then(|probe| probe.read())
            .map_err(|_| first)
    })
}

/// The tags and the file facts, from one read of the file.
pub fn read_track_details(path: &Path) -> Result<(TrackMetadata, FileFacts), MetadataError> {
    let tagged_file = read_tagged(path).map_err(|error| MetadataError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let properties = tagged_file.properties();
    let facts = FileFacts {
        length_ms: Some(properties.duration().as_millis() as u64).filter(|ms| *ms > 0),
        bitrate_kbps: properties
            .audio_bitrate()
            .or(properties.overall_bitrate())
            .filter(|b| *b > 0),
        disc_number: tag.and_then(|t| t.disk()),
    };

    Ok((
        tag.map_or_else(TrackMetadata::default, |tag| TrackMetadata {
            album: tag.album().map(|value| value.into_owned()),
            album_artist: tag.get_string(&ItemKey::AlbumArtist).map(ToOwned::to_owned),
            artist: tag.artist().map(|value| value.into_owned()),
            genre: tag.genre().map(|value| value.into_owned()),
            release_year: tag.year(),
            track_number: tag.track(),
            title: tag.title().map(|value| value.into_owned()),
            compilation: None,
        }),
        facts,
    ))
}

/// The tag editor's save: every field set to the given value (`None` or empty removes it). Written the same safe
/// way as Fix tags (`patch_track_metadata`): edited in the file's own tag, checked on a copy, then swapped in.
pub fn write_track_metadata(path: &Path, metadata: &TrackMetadata) -> Result<(), MetadataError> {
    let text = |value: &Option<String>| value.clone().filter(|v| !v.trim().is_empty());
    let mut changes = vec![
        (TagField::Title, text(&metadata.title)),
        (TagField::Artist, text(&metadata.artist)),
        (TagField::Album, text(&metadata.album)),
        (TagField::AlbumArtist, text(&metadata.album_artist)),
        (TagField::Genre, text(&metadata.genre)),
        (TagField::Year, metadata.release_year.map(|y| y.to_string())),
        (
            TagField::Track,
            metadata
                .track_number
                .filter(|t| *t > 0)
                .map(|t| t.to_string()),
        ),
    ];
    // The compilation flag: not part of the official ID3 specification, but written by iTunes and read by most
    // players and servers. `None` leaves it as it is.
    match metadata.compilation {
        Some(true) => changes.push((TagField::Compilation, Some("1".to_owned()))),
        Some(false) => changes.push((TagField::Compilation, None)),
        None => {}
    }
    patch_track_metadata(path, &changes).map(|_| ())
}

/// Sets the year as the recording date (ID3v2 TDRC, written as TYER in v2.3; DATE in FLAC and Ogg; ©day in MP4),
/// keeping a month and day already there. lofty's own `set_year` stores a "Year" item that ID3v2 has no frame
/// for, so in an MP3 the year was silently dropped when the tag was saved.
fn set_year(tag: &mut lofty::tag::Tag, year: u32) {
    let rest = tag
        .get_string(&ItemKey::RecordingDate)
        .filter(|d| d.len() > 4 && d.is_char_boundary(4))
        .map(|d| d[4..].to_owned())
        .unwrap_or_default();
    tag.remove_key(&ItemKey::Year);
    tag.insert_text(ItemKey::RecordingDate, format!("{year:04}{rest}"));
}

fn remove_year(tag: &mut lofty::tag::Tag) {
    tag.remove_key(&ItemKey::Year);
    tag.remove_key(&ItemKey::RecordingDate);
}

/// Saves `tag` into the file at `path` as ID3v2.3 where ID3 is used (what this program writes everywhere: Windows
/// Explorer and older players read it best). For ID3 the recording date is put in as a real timestamp frame: a
/// plain text one is discarded when the tag is written as v2.3, which is how years were being lost.
fn save_tag(tag: lofty::tag::Tag, path: &Path) -> Result<(), String> {
    if tag.tag_type() != lofty::tag::TagType::Id3v2 {
        return tag
            .save_to_path(path, write_options())
            .map_err(|e| e.to_string());
    }
    id3_from_general(tag)?
        .save_to_path(path, write_options())
        .map_err(|e| e.to_string())
}

static WRITE_ID3V24: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Which ID3v2 version MP3 tags are written as: ID3v2.3 unless the person chose ID3v2.4 in the advanced settings
/// (owner, 2026-11-04: v2.3 by default because older players, an iPod Classic for one, misread v2.4).
pub fn set_write_id3v24(v24: bool) {
    WRITE_ID3V24.store(v24, std::sync::atomic::Ordering::Relaxed);
}

pub fn writes_id3v24() -> bool {
    WRITE_ID3V24.load(std::sync::atomic::Ordering::Relaxed)
}

fn write_options() -> WriteOptions {
    WriteOptions::default().use_id3v23(!writes_id3v24())
}

/// A general tag as an ID3v2 tag ready to write: the recording date as a real timestamp frame (a plain text one is
/// discarded when written as v2.3, which is how years were lost) and no frame lofty would write unreadably.
fn id3_from_general(tag: lofty::tag::Tag) -> Result<lofty::id3::v2::Id3v2Tag, String> {
    use lofty::id3::v2::{Frame, FrameId, Id3v2Tag, TimestampFrame};
    let date = tag.get_string(&ItemKey::RecordingDate).map(str::to_owned);
    let mut id3: Id3v2Tag = tag.into();
    if let Some(date) = date {
        // iTunes writes "2004-01-01T08:00:00Z"; anything that does not parse keeps at least its year.
        let stamp = date
            .trim()
            .parse::<lofty::tag::items::Timestamp>()
            .ok()
            .or_else(|| {
                let year: u16 = date.trim().get(..4)?.parse().ok()?;
                Some(lofty::tag::items::Timestamp {
                    year,
                    ..Default::default()
                })
            });
        if let Some(stamp) = stamp {
            id3.insert(Frame::Timestamp(TimestampFrame::new(
                FrameId::Valid("TDRC".into()),
                lofty::TextEncoding::UTF8,
                stamp,
            )));
        }
    }
    without_empty_utf16(id3)
}

/// Copies every tag value that has an ID3v2 place, and the pictures, from one file into a new MP3 (made from it by
/// a conversion). The MP3 must have no tag yet. Checked by reading the MP3 back.
pub fn copy_tags(from: &Path, to: &Path) -> Result<(), MetadataError> {
    let read_error = |path: &Path, error: lofty::error::LoftyError| MetadataError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    };
    let write_error = |message: String| MetadataError::Write {
        path: to.to_path_buf(),
        message,
    };
    let source = lofty::read_from_path(from).map_err(|e| read_error(from, e))?;
    let Some(tag) = source.primary_tag().or_else(|| source.first_tag()) else {
        return Ok(());
    };
    let mut general = tag.clone();
    general.re_map(lofty::tag::TagType::Id3v2);
    let id3 = id3_from_general(general).map_err(write_error)?;
    id3.save_to_path(to, write_options())
        .map_err(|e| write_error(e.to_string()))?;
    let wanted = read_track_metadata(from)?;
    let got = read_track_metadata(to)?;
    let same = |a: &Option<String>, b: &Option<String>| {
        a.as_deref().map(str::trim) == b.as_deref().map(str::trim)
    };
    if !(same(&wanted.title, &got.title)
        && same(&wanted.artist, &got.artist)
        && same(&wanted.album, &got.album)
        && wanted.track_number == got.track_number
        && wanted.release_year == got.release_year)
    {
        return Err(write_error(format!(
            "the copied tags read back differently: {got:?}"
        )));
    }
    let pictures = |path: &Path| {
        lofty::read_from_path(path).map(|f| f.primary_tag().map_or(0, |t| t.pictures().len()))
    };
    if pictures(from).unwrap_or(0) > 0 && pictures(to).unwrap_or(0) == 0 {
        return Err(write_error("the cover picture was not copied".to_owned()));
    }
    Ok(())
}

/// One field `patch_track_metadata` can set or remove.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum TagField {
    Title,
    Artist,
    Album,
    AlbumArtist,
    Genre,
    Year,
    Track,
    Disc,
    /// The compilation flag (TCMP in ID3v2): "1" sets it.
    Compilation,
    /// MusicBrainz release (edition) id: TXXX "MusicBrainz Album Id" in ID3v2, as Picard and Navidrome write it.
    MusicBrainzReleaseId,
    /// MusicBrainz release group (the album as a whole) id: TXXX "MusicBrainz Release Group Id".
    MusicBrainzReleaseGroupId,
    /// The language of the words (TLAN in ID3v2, LANGUAGE in FLAC and Ogg), as an ISO 639-2 code. "zxx" means no linguistic content: an instrumental.
    Language,
    /// The volume-levelling gain the program worked out for the song and for its album, as "+4.30 dB", and the loudest sample as a number (ReplayGain
    /// tags: TXXX REPLAYGAIN_* in ID3v2, the same names in FLAC). Players, Jellyfin and the phone apps that honour ReplayGain apply them.
    ReplayGainTrackGain,
    ReplayGainTrackPeak,
    ReplayGainAlbumGain,
    ReplayGainAlbumPeak,
}

impl TagField {
    pub fn name(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Artist => "artist",
            Self::Album => "album",
            Self::AlbumArtist => "album_artist",
            Self::Genre => "genre",
            Self::Year => "year",
            Self::Track => "track",
            Self::Disc => "disc",
            Self::Compilation => "compilation",
            Self::MusicBrainzReleaseId => "mb_release_id",
            Self::MusicBrainzReleaseGroupId => "mb_release_group_id",
            Self::Language => "language",
            Self::ReplayGainTrackGain => "rg_track_gain",
            Self::ReplayGainTrackPeak => "rg_track_peak",
            Self::ReplayGainAlbumGain => "rg_album_gain",
            Self::ReplayGainAlbumPeak => "rg_album_peak",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [
            Self::Title,
            Self::Artist,
            Self::Album,
            Self::AlbumArtist,
            Self::Genre,
            Self::Year,
            Self::Track,
            Self::Disc,
            Self::Compilation,
            Self::MusicBrainzReleaseId,
            Self::MusicBrainzReleaseGroupId,
            Self::Language,
            Self::ReplayGainTrackGain,
            Self::ReplayGainTrackPeak,
            Self::ReplayGainAlbumGain,
            Self::ReplayGainAlbumPeak,
        ]
        .into_iter()
        .find(|field| field.name() == name)
    }
}

fn field_value(tag: &lofty::tag::Tag, field: TagField) -> Option<String> {
    let text = match field {
        TagField::Title => tag.title().map(|v| v.into_owned()),
        TagField::Artist => tag.artist().map(|v| v.into_owned()),
        TagField::Album => tag.album().map(|v| v.into_owned()),
        TagField::AlbumArtist => tag.get_string(&ItemKey::AlbumArtist).map(ToOwned::to_owned),
        TagField::Genre => tag.genre().map(|v| v.into_owned()),
        TagField::Year => tag.year().map(|v| v.to_string()),
        TagField::Track => tag.track().map(|v| v.to_string()),
        TagField::Disc => tag.disk().map(|v| v.to_string()),
        TagField::Compilation => tag
            .get_string(&ItemKey::FlagCompilation)
            .map(ToOwned::to_owned),
        TagField::MusicBrainzReleaseId => tag
            .get_string(&ItemKey::MusicBrainzReleaseId)
            .map(ToOwned::to_owned),
        TagField::MusicBrainzReleaseGroupId => tag
            .get_string(&ItemKey::MusicBrainzReleaseGroupId)
            .map(ToOwned::to_owned),
        TagField::Language => tag.get_string(&ItemKey::Language).map(ToOwned::to_owned),
        TagField::ReplayGainTrackGain => tag
            .get_string(&ItemKey::ReplayGainTrackGain)
            .map(ToOwned::to_owned),
        TagField::ReplayGainTrackPeak => tag
            .get_string(&ItemKey::ReplayGainTrackPeak)
            .map(ToOwned::to_owned),
        TagField::ReplayGainAlbumGain => tag
            .get_string(&ItemKey::ReplayGainAlbumGain)
            .map(ToOwned::to_owned),
        TagField::ReplayGainAlbumPeak => tag
            .get_string(&ItemKey::ReplayGainAlbumPeak)
            .map(ToOwned::to_owned),
    };
    text.filter(|value| !value.trim().is_empty())
}

fn set_field(
    tag: &mut lofty::tag::Tag,
    field: TagField,
    value: Option<&str>,
) -> Result<(), String> {
    let number = |text: &str| {
        text.trim()
            .parse::<u32>()
            .map_err(|_| format!("“{text}” is not a number for {}", field.name()))
    };
    match (field, value) {
        (TagField::Title, Some(v)) => tag.set_title(v.to_owned()),
        (TagField::Title, None) => tag.remove_title(),
        (TagField::Artist, Some(v)) => tag.set_artist(v.to_owned()),
        (TagField::Artist, None) => tag.remove_artist(),
        (TagField::Album, Some(v)) => tag.set_album(v.to_owned()),
        (TagField::Album, None) => tag.remove_album(),
        (TagField::AlbumArtist, Some(v)) => {
            tag.insert_text(ItemKey::AlbumArtist, v.to_owned());
        }
        (TagField::AlbumArtist, None) => tag.remove_key(&ItemKey::AlbumArtist),
        (TagField::Genre, Some(v)) => tag.set_genre(v.to_owned()),
        (TagField::Genre, None) => tag.remove_genre(),
        (TagField::Year, Some(v)) => set_year(tag, number(v)?),
        (TagField::Year, None) => remove_year(tag),
        (TagField::Track, Some(v)) => tag.set_track(number(v)?),
        (TagField::Track, None) => tag.remove_track(),
        (TagField::Disc, Some(v)) => tag.set_disk(number(v)?),
        (TagField::Disc, None) => tag.remove_disk(),
        (TagField::Compilation, Some(v)) => {
            tag.insert_text(ItemKey::FlagCompilation, v.to_owned());
        }
        (TagField::Compilation, None) => tag.remove_key(&ItemKey::FlagCompilation),
        (TagField::MusicBrainzReleaseId, Some(v)) => {
            tag.insert_text(ItemKey::MusicBrainzReleaseId, v.trim().to_owned());
        }
        (TagField::MusicBrainzReleaseId, None) => tag.remove_key(&ItemKey::MusicBrainzReleaseId),
        (TagField::MusicBrainzReleaseGroupId, Some(v)) => {
            tag.insert_text(ItemKey::MusicBrainzReleaseGroupId, v.trim().to_owned());
        }
        (TagField::MusicBrainzReleaseGroupId, None) => {
            tag.remove_key(&ItemKey::MusicBrainzReleaseGroupId)
        }
        (TagField::Language, Some(v)) => {
            tag.insert_text(ItemKey::Language, v.trim().to_owned());
        }
        (TagField::Language, None) => tag.remove_key(&ItemKey::Language),
        (TagField::ReplayGainTrackGain, Some(v)) => {
            tag.insert_text(ItemKey::ReplayGainTrackGain, v.trim().to_owned());
        }
        (TagField::ReplayGainTrackGain, None) => tag.remove_key(&ItemKey::ReplayGainTrackGain),
        (TagField::ReplayGainTrackPeak, Some(v)) => {
            tag.insert_text(ItemKey::ReplayGainTrackPeak, v.trim().to_owned());
        }
        (TagField::ReplayGainTrackPeak, None) => tag.remove_key(&ItemKey::ReplayGainTrackPeak),
        (TagField::ReplayGainAlbumGain, Some(v)) => {
            tag.insert_text(ItemKey::ReplayGainAlbumGain, v.trim().to_owned());
        }
        (TagField::ReplayGainAlbumGain, None) => tag.remove_key(&ItemKey::ReplayGainAlbumGain),
        (TagField::ReplayGainAlbumPeak, Some(v)) => {
            tag.insert_text(ItemKey::ReplayGainAlbumPeak, v.trim().to_owned());
        }
        (TagField::ReplayGainAlbumPeak, None) => tag.remove_key(&ItemKey::ReplayGainAlbumPeak),
    }
    Ok(())
}

enum Edited {
    General(lofty::tag::Tag),
    Id3(lofty::id3::v2::Id3v2Tag),
}

/// An MP3's own ID3v2 tag, with every frame as it is in the file.
fn read_id3(path: &Path) -> Result<lofty::id3::v2::Id3v2Tag, String> {
    use lofty::config::ParseOptions;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("could not open the file: {e}"))?;
    // Leniently too when needed (see `read_tagged`): a frame that cannot be parsed is left out of the edited tag.
    let mpeg = match lofty::mpeg::MpegFile::read_from(
        &mut file,
        ParseOptions::new().read_properties(false),
    ) {
        Ok(mpeg) => mpeg,
        Err(first) => {
            let mut again =
                std::fs::File::open(path).map_err(|e| format!("could not open the file: {e}"))?;
            let relaxed = ParseOptions::new()
                .read_properties(false)
                .parsing_mode(lofty::config::ParsingMode::Relaxed);
            lofty::mpeg::MpegFile::read_from(&mut again, relaxed).map_err(|_| first.to_string())?
        }
    };
    mpeg.id3v2()
        .cloned()
        .ok_or_else(|| "the ID3v2 tag could not be read".to_owned())
}

/// Frames holding an empty UTF-16 string (a blank picture or comment description, say) are switched to Latin-1
/// when all their text fits it, which changes nothing they say. lofty writes an empty UTF-16 string without the
/// byte order mark ID3v2.3 asks for, and then refuses to read the file it wrote. Every other frame is kept as it
/// is; if the rebuilt tag would hold a different number of frames, nothing is changed and the write is refused.
fn without_empty_utf16(tag: lofty::id3::v2::Id3v2Tag) -> Result<lofty::id3::v2::Id3v2Tag, String> {
    use lofty::TextEncoding;
    use lofty::id3::v2::{Frame, Id3v2Tag};
    // UTF-8 counts too: ID3v2.3 has no UTF-8, so lofty writes those frames as UTF-16.
    let utf16 = |encoding: TextEncoding| {
        matches!(
            encoding,
            TextEncoding::UTF16 | TextEncoding::UTF16BE | TextEncoding::UTF8
        )
    };
    let latin1 = |texts: &[&str]| texts.iter().all(|t| t.chars().all(|c| u32::from(c) < 256));
    let empty = |texts: &[&str]| texts.iter().any(|t| t.is_empty());
    let count = (&tag).into_iter().count();
    let mut rebuilt = Id3v2Tag::new();
    rebuilt.set_flags(*tag.flags());
    for mut frame in tag {
        let texts_and_encoding: Option<(Vec<String>, &mut TextEncoding)> = match &mut frame {
            Frame::Comment(f) => Some((
                vec![f.description.clone(), f.content.clone()],
                &mut f.encoding,
            )),
            Frame::UnsynchronizedText(f) => Some((
                vec![f.description.clone(), f.content.clone()],
                &mut f.encoding,
            )),
            Frame::UserText(f) => Some((
                vec![f.description.clone(), f.content.clone()],
                &mut f.encoding,
            )),
            Frame::UserUrl(f) => Some((vec![f.description.clone()], &mut f.encoding)),
            Frame::Picture(f) => Some((
                vec![f.picture.description().unwrap_or_default().to_owned()],
                &mut f.encoding,
            )),
            Frame::Text(f) => Some((vec![f.value.clone()], &mut f.encoding)),
            _ => None,
        };
        if let Some((texts, encoding)) = texts_and_encoding {
            let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
            if utf16(*encoding) && empty(&texts) && latin1(&texts) {
                *encoding = TextEncoding::Latin1;
            }
        }
        rebuilt.insert(frame);
    }
    if (&rebuilt).into_iter().count() != count {
        return Err("this file's tag has repeated frames that could not be kept exactly, so it was left as it is".to_owned());
    }
    Ok(rebuilt)
}

/// `set_field` for an ID3v2 tag edited in place: only the frame for `field` is added, replaced or removed.
fn set_id3_field(
    tag: &mut lofty::id3::v2::Id3v2Tag,
    field: TagField,
    value: Option<&str>,
) -> Result<(), String> {
    use lofty::id3::v2::{Frame, FrameId, TextInformationFrame, TimestampFrame};
    let number = |text: &str| {
        text.trim()
            .parse::<u32>()
            .map_err(|_| format!("“{text}” is not a number for {}", field.name()))
    };
    let text_frame = |id: &'static str, value: &str| {
        Frame::Text(TextInformationFrame::new(
            FrameId::Valid(id.into()),
            lofty::TextEncoding::UTF8,
            value.to_owned(),
        ))
    };
    let remove = |tag: &mut lofty::id3::v2::Id3v2Tag, id: &'static str| {
        tag.remove(&FrameId::Valid(id.into())).for_each(drop)
    };
    match (field, value) {
        (TagField::Title, Some(v)) => tag.set_title(v.to_owned()),
        (TagField::Title, None) => tag.remove_title(),
        (TagField::Artist, Some(v)) => tag.set_artist(v.to_owned()),
        (TagField::Artist, None) => tag.remove_artist(),
        (TagField::Album, Some(v)) => tag.set_album(v.to_owned()),
        (TagField::Album, None) => tag.remove_album(),
        (TagField::AlbumArtist, Some(v)) => {
            tag.insert(text_frame("TPE2", v));
        }
        (TagField::AlbumArtist, None) => remove(tag, "TPE2"),
        (TagField::Genre, Some(v)) => tag.set_genre(v.to_owned()),
        (TagField::Genre, None) => tag.remove_genre(),
        (TagField::Year, Some(v)) => {
            let year = number(v)?;
            let stamp = lofty::tag::items::Timestamp {
                year: u16::try_from(year).map_err(|_| format!("{year} is not a year"))?,
                ..Default::default()
            };
            // The old date goes first: lofty's insert replaces a date frame only when it holds the same date, so a
            // full one ("2010-11-30", from a reissue's tags) stayed beside the new year and was read back instead.
            for id in ["TDRC", "TYER", "TDAT", "TIME"] {
                remove(tag, id);
            }
            tag.insert(Frame::Timestamp(TimestampFrame::new(
                FrameId::Valid("TDRC".into()),
                lofty::TextEncoding::UTF8,
                stamp,
            )));
        }
        (TagField::Year, None) => {
            remove(tag, "TDRC");
            remove(tag, "TYER");
        }
        (TagField::Track, Some(v)) => tag.set_track(number(v)?),
        (TagField::Track, None) => tag.remove_track(),
        (TagField::Disc, Some(v)) => tag.set_disk(number(v)?),
        (TagField::Disc, None) => tag.remove_disk(),
        (TagField::Compilation, Some(v)) => {
            tag.insert(text_frame("TCMP", v));
        }
        (TagField::Compilation, None) => remove(tag, "TCMP"),
        (TagField::MusicBrainzReleaseId, Some(v)) => {
            tag.insert_user_text("MusicBrainz Album Id".to_owned(), v.trim().to_owned());
        }
        (TagField::MusicBrainzReleaseId, None) => {
            tag.remove_user_text("MusicBrainz Album Id");
        }
        (TagField::MusicBrainzReleaseGroupId, Some(v)) => {
            tag.insert_user_text(
                "MusicBrainz Release Group Id".to_owned(),
                v.trim().to_owned(),
            );
        }
        (TagField::MusicBrainzReleaseGroupId, None) => {
            tag.remove_user_text("MusicBrainz Release Group Id");
        }
        (TagField::Language, Some(v)) => {
            tag.insert(text_frame("TLAN", v.trim()));
        }
        (TagField::Language, None) => remove(tag, "TLAN"),
        (TagField::ReplayGainTrackGain, Some(v)) => {
            tag.insert_user_text("REPLAYGAIN_TRACK_GAIN".to_owned(), v.trim().to_owned());
        }
        (TagField::ReplayGainTrackGain, None) => {
            tag.remove_user_text("REPLAYGAIN_TRACK_GAIN");
        }
        (TagField::ReplayGainTrackPeak, Some(v)) => {
            tag.insert_user_text("REPLAYGAIN_TRACK_PEAK".to_owned(), v.trim().to_owned());
        }
        (TagField::ReplayGainTrackPeak, None) => {
            tag.remove_user_text("REPLAYGAIN_TRACK_PEAK");
        }
        (TagField::ReplayGainAlbumGain, Some(v)) => {
            tag.insert_user_text("REPLAYGAIN_ALBUM_GAIN".to_owned(), v.trim().to_owned());
        }
        (TagField::ReplayGainAlbumGain, None) => {
            tag.remove_user_text("REPLAYGAIN_ALBUM_GAIN");
        }
        (TagField::ReplayGainAlbumPeak, Some(v)) => {
            tag.insert_user_text("REPLAYGAIN_ALBUM_PEAK".to_owned(), v.trim().to_owned());
        }
        (TagField::ReplayGainAlbumPeak, None) => {
            tag.remove_user_text("REPLAYGAIN_ALBUM_PEAK");
        }
    }
    Ok(())
}

/// The given fields as one file has them now (None where absent or blank); nothing is written.
pub fn read_tag_fields(
    path: &Path,
    fields: &[TagField],
) -> Result<Vec<(TagField, Option<String>)>, MetadataError> {
    let tagged = read_tagged(path).map_err(|e| MetadataError::Read {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    Ok(fields
        .iter()
        .map(|f| (*f, tag.and_then(|t| field_value(t, *f))))
        .collect())
}

/// Sets (`Some`) or removes (`None`) only the given fields of one file and leaves everything else in it as it was.
/// A file without the usual tag for its type gets one, started from whatever other tag it has (an old ID3v1 tag,
/// say), so no value it already showed is lost. The new tag is written to a copy beside the file and read back;
/// only when it reads back correctly does the copy replace the file, so a failure never leaves a half-written song.
/// Returns each field's value from before the change, for an undo.
pub fn patch_track_metadata(
    path: &Path,
    changes: &[(TagField, Option<String>)],
) -> Result<Vec<(TagField, Option<String>)>, MetadataError> {
    let read_error = |error: lofty::error::LoftyError| MetadataError::Read {
        path: path.to_path_buf(),
        message: error.to_string(),
    };
    let write_error = |message: String| MetadataError::Write {
        path: path.to_path_buf(),
        message,
    };
    let tagged = read_tagged(path).map_err(read_error)?;
    let tag_type = tagged.primary_tag_type();
    let mut tag = match tagged.tag(tag_type) {
        Some(tag) => tag.clone(),
        None => match tagged.first_tag() {
            Some(other) => {
                let mut copy = other.clone();
                copy.re_map(tag_type);
                copy
            }
            None => lofty::tag::Tag::new(tag_type),
        },
    };
    let before: Vec<(TagField, Option<String>)> = changes
        .iter()
        .map(|(field, _)| (*field, field_value(&tag, *field)))
        .collect();
    // An MP3 that already has an ID3v2 tag is edited in that tag itself, frame by frame. Going through lofty's
    // general tag rebuilds every frame instead, and an old tag (an iTunes ID3v2.2 tag, say) can come back with
    // frames written in a form that cannot be read again.
    let id3 = if tagged.file_type() == lofty::file::FileType::Mpeg
        && tagged.tag(lofty::tag::TagType::Id3v2).is_some()
    {
        Some(read_id3(path).map_err(write_error)?)
    } else {
        None
    };
    let edited = match id3 {
        Some(id3) => {
            let mut id3 = without_empty_utf16(id3).map_err(write_error)?;
            for (field, value) in changes {
                set_id3_field(
                    &mut id3,
                    *field,
                    value.as_deref().filter(|v| !v.trim().is_empty()),
                )
                .map_err(write_error)?;
            }
            Edited::Id3(id3)
        }
        None => {
            for (field, value) in changes {
                set_field(
                    &mut tag,
                    *field,
                    value.as_deref().filter(|v| !v.trim().is_empty()),
                )
                .map_err(write_error)?;
            }
            Edited::General(tag)
        }
    };

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // The copy keeps the file's own extension: that is how its kind is recognised when it is read back.
    let copy = path.with_file_name(format!(".mediaverse-writing.{name}"));
    let result = (|| {
        std::fs::copy(path, &copy).map_err(|e| format!("could not copy the file: {e}"))?;
        match edited {
            Edited::General(tag) => save_tag(tag, &copy)?,
            Edited::Id3(id3) => id3
                .save_to_path(&copy, write_options())
                .map_err(|e| e.to_string())?,
        }
        // Read the copy back: the right values, and still a playable file of the same kind.
        let check = read_tagged(&copy)
            .map_err(|e| format!("the written file could not be read back: {e}"))?;
        // No tag at all is right when every value was removed (an empty tag is not written).
        let written = check.tag(tag_type);
        for (field, value) in changes {
            let wanted = value.as_deref().map(str::trim).filter(|v| !v.is_empty());
            let got = written.and_then(|tag| field_value(tag, *field));
            let same = match (wanted, got.as_deref().map(str::trim)) {
                (None, None) => true,
                (Some(w), Some(g))
                    if matches!(field, TagField::Year | TagField::Track | TagField::Disc) =>
                {
                    w.parse::<u32>().ok() == g.parse::<u32>().ok()
                }
                (Some(w), Some(g)) => w == g,
                _ => false,
            };
            if !same {
                return Err(format!("{} did not read back as written", field.name()));
            }
        }
        let (old, new) = (
            tagged.properties().duration().as_millis(),
            check.properties().duration().as_millis(),
        );
        if old.abs_diff(new) > 1000 {
            return Err("the written file's length differs from the original".to_owned());
        }
        std::fs::rename(&copy, path).map_err(|e| {
            format!("could not replace the file (is it open in another program?): {e}")
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&copy);
    }
    result.map_err(write_error)?;
    Ok(before)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MetadataError {
    Read { path: PathBuf, message: String },
    NoWritableTag(PathBuf),
    Write { path: PathBuf, message: String },
}

impl fmt::Display for MetadataError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, message } => {
                write!(
                    formatter,
                    "Could not read tags from '{}': {message}",
                    path.display()
                )
            }
            Self::NoWritableTag(path) => {
                write!(formatter, "No writable tag exists in '{}'.", path.display())
            }
            Self::Write { path, message } => {
                write!(
                    formatter,
                    "Could not write tags to '{}': {message}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for MetadataError {}
