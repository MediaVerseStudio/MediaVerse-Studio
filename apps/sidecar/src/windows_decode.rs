//! Decoding an audio file to a 16-bit PCM WAV with Windows' own decoders (Media Foundation), for converting library
//! files to MP3 (owner, 2026-11-04). Windows ships and licenses the decoders (AAC/M4A, WMA, FLAC, WAV, MP3, and
//! more when its media extensions are installed), so the program bundles no codec of its own. This module is the
//! only place that talks to Media Foundation; elsewhere `decode_to_wav` is just a function that may fail.

use std::path::Path;

/// Writes the first audio stream of `source` to `wav` as 16-bit PCM at its own sample rate and channel count.
/// Returns the length in milliseconds.
#[cfg(windows)]
pub fn decode_to_wav(source: &Path, wav: &Path) -> Result<u64, String> {
    use std::io::{BufWriter, Seek, SeekFrom, Write};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::core::HSTRING;

    struct Session;
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    let failed = |what: &str, error: windows::core::Error| format!("{what}: {}", error.message());
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| failed("Windows could not start its media support", e))?;
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(|e| {
            CoUninitialize();
            failed("Windows could not start its media support", e)
        })?;
        let _session = Session;

        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(source.as_os_str()), None)
            .map_err(|e| failed("Windows cannot read this kind of file on this computer", e))?;
        let audio = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(|e| failed("reading the file", e))?;
        reader
            .SetStreamSelection(audio, true)
            .map_err(|e| failed("the file has no sound Windows can read", e))?;
        let wanted = MFCreateMediaType().map_err(|e| failed("reading the file", e))?;
        wanted
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|e| failed("reading the file", e))?;
        wanted
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|e| failed("reading the file", e))?;
        wanted
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|e| failed("reading the file", e))?;
        reader
            .SetCurrentMediaType(audio, None, &wanted)
            .map_err(|e| failed("Windows cannot decode this file's sound", e))?;
        let actual = reader
            .GetCurrentMediaType(audio)
            .map_err(|e| failed("reading the file", e))?;
        let channels = actual
            .GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)
            .map_err(|e| failed("reading the file", e))?;
        let rate = actual
            .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
            .map_err(|e| failed("reading the file", e))?;
        if channels == 0 || channels > 8 || rate < 8_000 || rate > 384_000 {
            return Err(format!(
                "unexpected sound format ({channels} channels at {rate} Hz)"
            ));
        }

        let file = std::fs::File::create(wav)
            .map_err(|e| format!("could not write the temporary WAV: {e}"))?;
        let mut out = BufWriter::new(file);
        let header = |data: u32| {
            let block = channels * 2;
            let mut h = Vec::with_capacity(44);
            h.extend_from_slice(b"RIFF");
            h.extend_from_slice(&(36 + data).to_le_bytes());
            h.extend_from_slice(b"WAVEfmt ");
            h.extend_from_slice(&16u32.to_le_bytes());
            h.extend_from_slice(&1u16.to_le_bytes());
            h.extend_from_slice(&(channels as u16).to_le_bytes());
            h.extend_from_slice(&rate.to_le_bytes());
            h.extend_from_slice(&(rate * block).to_le_bytes());
            h.extend_from_slice(&(block as u16).to_le_bytes());
            h.extend_from_slice(&16u16.to_le_bytes());
            h.extend_from_slice(b"data");
            h.extend_from_slice(&data.to_le_bytes());
            h
        };
        let io = |e: std::io::Error| format!("could not write the temporary WAV: {e}");
        out.write_all(&header(0)).map_err(io)?;
        let mut bytes: u64 = 0;
        loop {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(audio, 0, None, Some(&mut flags), None, Some(&mut sample))
                .map_err(|e| failed("decoding stopped", e))?;
            if let Some(sample) = sample {
                let buffer = sample
                    .ConvertToContiguousBuffer()
                    .map_err(|e| failed("decoding stopped", e))?;
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut length = 0u32;
                buffer
                    .Lock(&mut data, None, Some(&mut length))
                    .map_err(|e| failed("decoding stopped", e))?;
                let written = if data.is_null() {
                    Ok(())
                } else {
                    out.write_all(std::slice::from_raw_parts(data, length as usize))
                };
                let _ = buffer.Unlock();
                written.map_err(io)?;
                bytes += u64::from(length);
                if bytes > u64::from(u32::MAX - 64) {
                    return Err("the song is too long to convert in one piece".to_owned());
                }
            }
            if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                break;
            }
            if flags & (MF_SOURCE_READERF_ERROR.0 as u32) != 0 {
                return Err("Windows reported an error while decoding".to_owned());
            }
        }
        if bytes == 0 {
            return Err("no sound was decoded".to_owned());
        }
        out.seek(SeekFrom::Start(0)).map_err(io)?;
        out.write_all(&header(bytes as u32)).map_err(io)?;
        out.flush().map_err(io)?;
        Ok(bytes * 1000 / u64::from(rate * channels * 2))
    }
}

#[cfg(not(windows))]
pub fn decode_to_wav(_source: &Path, _wav: &Path) -> Result<u64, String> {
    Err("converting to MP3 is only available on Windows".to_owned())
}
