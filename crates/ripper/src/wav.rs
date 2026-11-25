//! Minimal WAV (RIFF) writer for CD audio: 16-bit stereo, 44.1 kHz. Used for the verified
//! intermediate file that later steps (FLAC and MP3 encoding) read from.

use std::io::{self, Write};

const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
const BITS: u16 = 16;

/// Reads a 16-bit stereo 44.1 kHz PCM WAV file back into packed samples. Anything else (other
/// formats, truncated data, odd sizes) is an error, so a damaged or foreign file is never encoded.
pub fn read_wav(bytes: &[u8]) -> io::Result<Vec<u32>> {
    let bad = |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("not a WAV file"));
    }
    let mut position = 12;
    let mut format_ok = false;
    while position + 8 <= bytes.len() {
        let id = &bytes[position..position + 4];
        let size =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        let body = position + 8;
        match id {
            b"fmt " => {
                let fmt = bytes
                    .get(body..body + 16)
                    .ok_or_else(|| bad("truncated format chunk"))?;
                let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
                let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
                if (tag, channels, rate, bits) != (1, CHANNELS, SAMPLE_RATE, BITS) {
                    return Err(bad("expected 16-bit stereo 44.1 kHz PCM"));
                }
                format_ok = true;
            }
            b"data" => {
                if !format_ok {
                    return Err(bad("audio data before the format chunk"));
                }
                let data = bytes
                    .get(body..body + size)
                    .ok_or_else(|| bad("truncated audio data"))?;
                if !size.is_multiple_of(4) {
                    return Err(bad("audio data is not a whole number of stereo samples"));
                }
                return Ok(data
                    .chunks_exact(4)
                    .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect());
            }
            _ => {}
        }
        position = body + size + (size & 1); // chunks are padded to even sizes
    }
    Err(bad("no audio data in the WAV file"))
}

/// Writes `samples` (stereo pairs packed as `left | right << 16`) as a WAV stream.
pub fn write_wav<W: Write>(mut out: W, samples: &[u32]) -> io::Result<()> {
    let data_len = u32::try_from(samples.len() * 4).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "audio is too long for a WAV file",
        )
    })?;
    let block_align = CHANNELS * BITS / 8;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&CHANNELS.to_le_bytes())?;
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * u32::from(block_align)).to_le_bytes())?;
    out.write_all(&block_align.to_le_bytes())?;
    out.write_all(&BITS.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())?;
    // Little-endian `u32` of `left | right << 16` is exactly the interleaved L, R byte order.
    for chunk in samples.chunks(16_384) {
        let bytes: Vec<u8> = chunk
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        out.write_all(&bytes)?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_accuraterip::pack_samples;

    #[test]
    fn writes_a_valid_header_and_the_samples_unchanged() {
        let samples = [0x0002_0001u32, 0xFFFF_8000, 0, 7];
        let mut bytes = Vec::new();
        write_wav(&mut bytes, &samples).unwrap();

        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 36 + 16);
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 2); // channels
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            44_100
        );
        assert_eq!(
            u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
            176_400
        ); // byte rate
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 16);
        assert_eq!(bytes.len(), 44 + 16);
        assert_eq!(pack_samples(&bytes[44..]), samples);
    }

    #[test]
    fn reads_back_what_was_written_and_rejects_foreign_files() {
        let samples: Vec<u32> = (0..5_000u32)
            .map(|i| i.wrapping_mul(2_654_435_761))
            .collect();
        let mut bytes = Vec::new();
        write_wav(&mut bytes, &samples).unwrap();
        assert_eq!(read_wav(&bytes).unwrap(), samples);

        assert!(read_wav(b"not a wav").is_err());
        assert!(
            read_wav(&bytes[..bytes.len() - 3]).is_err(),
            "truncated data"
        );
        let mut mono = bytes.clone();
        mono[22] = 1; // channel count
        assert!(read_wav(&mono).is_err());
        let mut odd_rate = bytes.clone();
        odd_rate[24] = 0x80; // sample rate
        assert!(read_wav(&odd_rate).is_err());
    }

    #[test]
    fn skips_unknown_chunks_before_the_audio() {
        let samples = [1u32, 2, 3];
        let mut plain = Vec::new();
        write_wav(&mut plain, &samples).unwrap();
        let mut with_list = plain[..36].to_vec();
        with_list.extend_from_slice(b"LIST");
        with_list.extend_from_slice(&3u32.to_le_bytes());
        with_list.extend_from_slice(&[9, 9, 9, 0]); // 3 bytes plus the pad byte
        with_list.extend_from_slice(&plain[36..]);
        assert_eq!(read_wav(&with_list).unwrap(), samples);
    }

    #[test]
    fn handles_audio_longer_than_one_write_chunk() {
        let samples: Vec<u32> = (0..40_000u32).collect();
        let mut bytes = Vec::new();
        write_wav(&mut bytes, &samples).unwrap();
        assert_eq!(pack_samples(&bytes[44..]), samples);
    }
}
