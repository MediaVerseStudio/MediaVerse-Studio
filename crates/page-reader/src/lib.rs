//! Lyrics by photo: reads the text lines in a photo of a booklet page (`ocr`), turns them into song panels with a title,
//! stanzas and a matching track (`layout`), and repairs the reader's usual mistakes with a word list counted from lyrics the
//! person already has (`vocab`). `layout` and `vocab` are plain logic with no models, so they are unit tested.

pub mod habits;
pub mod layout;
pub mod ocr;
pub mod vision;
pub mod vocab;

pub use habits::Habits;
pub use layout::{Panel, TrackMatch, match_tracks, panels_from_lines, unify_repeats};
pub use ocr::{PageReader, TextLine, crop_jpegs, part_jpeg, prepared_jpeg};
pub use vision::{borrow_breaks, songs_from_reading};
pub use vocab::Vocabulary;
