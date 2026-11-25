//! Development aid: prints the disc ids of the two test discs, and the URLs used to fetch fixtures.
use mediaverse_disc_metadata::{DiscToc, discid};
fn main() {
    let discs = [
        (
            "watchmen",
            vec![
                0u32, 15770, 32932, 48082, 64527, 79350, 93247, 109050, 125150, 143145, 162400,
                182457,
            ],
            198_077u32,
        ),
        (
            "operation-ivy",
            vec![
                0, 7675, 17727, 26075, 38390, 48240, 53010, 63047, 72080, 79087, 84137, 92697,
                104355, 112347, 118957, 129467, 138847, 145767, 156017, 165547, 174965, 184332,
                189715, 196725, 206355, 213917, 222867,
            ],
            228_660,
        ),
    ];
    for (name, starts, leadout) in discs {
        let toc = DiscToc {
            track_starts: starts,
            leadout,
        };
        println!(
            "{name}: musicbrainz={} cddb={}",
            discid::musicbrainz_id(&toc),
            discid::cddb_id(&toc)
        );
    }
}
