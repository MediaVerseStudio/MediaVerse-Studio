//! Development aid: prints the AccurateRip database URL for a disc.
//! usage: disc_url <leadout-lsn> <track-start-lsn>...
use mediaverse_accuraterip::{database_url, disc_ids};

fn main() {
    let numbers: Vec<u32> = std::env::args()
        .skip(1)
        .map(|a| a.parse().expect("number"))
        .collect();
    let (leadout, starts) = numbers.split_first().expect("leadout then track starts");
    let (id1, id2, cddb) = disc_ids(starts, *leadout);
    println!("{}", database_url(starts.len(), id1, id2, cddb));
}
