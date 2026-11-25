//! Disc identifiers. A disc is looked up by an id computed from its table of contents.
//!
//! * MusicBrainz disc id: SHA-1 of the track layout, base64-encoded with a URL-safe alphabet.
//! * CDDB (freedb/gnudb) id: a short checksum of track start times plus the length.
//! * AccurateRip ids live in `mediaverse_accuraterip` and are used for verification, not names.

use crate::DiscToc;

/// SHA-1, implemented here to avoid a dependency for one 20-byte hash. Not for security use.
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());

    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (i, &word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(word);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, temp);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut out = [0u8; 20];
    for (chunk, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(state) {
        chunk.copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// Standard base64 with MusicBrainz's substitutions: `+` -> `.`, `/` -> `_`, `=` -> `-`.
fn musicbrainz_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &b)| acc | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(value >> (18 - 6 * i) & 0x3F) as usize] as char);
            } else {
                out.push('-');
            }
        }
    }
    out
}

/// The MusicBrainz disc id: SHA-1 over the hexadecimal text of the first and last track numbers
/// and 100 offsets (lead-out first, then each track, zero-padded), where offsets are LSN + 150.
pub fn musicbrainz_id(toc: &DiscToc) -> String {
    let count = toc.track_count();
    let mut text = format!("{:02X}{:02X}", 1, count);
    for slot in 0..100 {
        let offset = match slot {
            0 => toc.leadout + 150,
            n if n <= count => toc.track_starts[n - 1] + 150,
            _ => 0,
        };
        text.push_str(&format!("{offset:08X}"));
    }
    musicbrainz_base64(&sha1(text.as_bytes()))
}

/// The CDDB disc id as eight lower-case hexadecimal digits.
pub fn cddb_id(toc: &DiscToc) -> String {
    let digit_sum = |mut n: u32| {
        let mut sum = 0;
        while n > 0 {
            sum += n % 10;
            n /= 10;
        }
        sum
    };
    let checksum: u32 = toc
        .track_starts
        .iter()
        .map(|&start| digit_sum((start + 150) / 75))
        .sum();
    let id = ((checksum % 255) << 24) | (toc.seconds() << 8) | toc.track_count() as u32;
    format!("{id:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha1_matches_the_published_test_vectors() {
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        assert_eq!(
            hex(&sha1(&vec![b'a'; 1_000_000])),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }

    #[test]
    fn base64_uses_the_musicbrainz_alphabet_and_padding() {
        // 0xFB 0xFF 0xBE encodes to "+/++" in standard base64.
        assert_eq!(musicbrainz_base64(&[0xFB, 0xFF, 0xBE]), "._..");
        assert_eq!(musicbrainz_base64(&[0x00]), "AA--");
        assert_eq!(musicbrainz_base64(&[0x00, 0x00]), "AAA-");
        assert_eq!(musicbrainz_base64(&sha1(b"abc")).len(), 28);
    }

    fn watchmen() -> DiscToc {
        DiscToc {
            track_starts: vec![
                0, 15770, 32932, 48082, 64527, 79350, 93247, 109050, 125150, 143145, 162400, 182457,
            ],
            leadout: 198_077,
        }
    }

    #[test]
    fn cddb_id_matches_the_accuraterip_crates_independent_calculation() {
        assert_eq!(cddb_id(&watchmen()), "860a510c");
    }

    #[test]
    fn musicbrainz_ids_have_the_right_shape_and_depend_on_every_offset() {
        let id = musicbrainz_id(&watchmen());
        assert_eq!(id.len(), 28);
        assert!(id.ends_with('-'));
        assert!(
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        );
        let mut other = watchmen();
        other.track_starts[5] += 1;
        assert_ne!(musicbrainz_id(&other), id);
        let mut longer = watchmen();
        longer.leadout += 1;
        assert_ne!(musicbrainz_id(&longer), id);
    }
}
