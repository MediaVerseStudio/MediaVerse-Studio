//! Lyric AI (docs/lyric-ai-plan.md): the pure logic of finding the right lyrics for a song, checking them against the singing, and timing them.
//! Models, audio, files and the network are the caller's; this crate takes the numbers a speech model produced and the text, and returns decisions.

pub mod align;
pub mod check;
pub mod ctc;
pub mod identity;
pub mod text;
