//! The Windows side of exclusive output: lists the sound cards and opens one in WASAPI exclusive mode (event driven), so the
//! sound reaches the card as it is, without Windows' mixer in between. Uses the audio parts of Microsoft's own `windows`
//! crate, which the program already depends on (no new dependency). Used from the playback thread only (COM objects stay there).

use crate::native_pcm::Format;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_SHAREMODE_EXCLUSIVE,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE, IAudioClient, IAudioRenderClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0, eConsole, eRender,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::{GUID, PCWSTR};

/// One sound card (or output) the person can choose.
#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Prepares Windows' COM for this thread (call once on the playback thread).
pub fn init_thread() {
    // SAFETY: plain COM initialisation of the calling thread; a repeated call is harmless.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Asks Windows to treat the playback thread as pro audio (steady timing, not pushed aside by other work).
pub fn boost_thread() {
    let mut index = 0u32;
    // SAFETY: registers the calling thread with the multimedia scheduler; the handle is released when the thread ends.
    unsafe {
        let _ = windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW(
            windows::core::w!("Pro Audio"),
            &mut index,
        );
    }
}

fn describe(error: &windows::core::Error) -> String {
    let message = error.message();
    if message.is_empty() {
        format!("Windows error {:#010x}", error.code().0 as u32)
    } else {
        format!("{} ({:#010x})", message.trim(), error.code().0 as u32)
    }
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    // SAFETY: creates Windows' own device enumerator.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| {
        format!(
            "Windows' sound device list could not be opened: {}",
            describe(&e)
        )
    })
}

fn device_id(device: &IMMDevice) -> Result<String, String> {
    // SAFETY: GetId returns a string allocated by COM, which is freed after copying it.
    unsafe {
        let id = device.GetId().map_err(|e| describe(&e))?;
        let text = id.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(id.0 as *const _));
        text
    }
}

fn device_name(device: &IMMDevice) -> String {
    // SAFETY: reads the friendly-name property; every allocation made here is freed.
    unsafe {
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else {
            return "Sound output".to_owned();
        };
        let Ok(value) =
            store.GetValue(&windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName)
        else {
            return "Sound output".to_owned();
        };
        let name = text_of(&value);
        name.unwrap_or_else(|| "Sound output".to_owned())
    }
}

/// # Safety
/// `value` must be a valid property value.
unsafe fn text_of(value: &PROPVARIANT) -> Option<String> {
    // SAFETY: the caller guarantees `value` is valid; the allocated string is freed after copying.
    unsafe {
        let text = PropVariantToStringAlloc(value).ok()?;
        let copy = text.to_string().ok();
        CoTaskMemFree(Some(text.0 as *const _));
        copy
    }
}

/// The active sound outputs, the one Windows uses by default first.
pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    init_thread(); // this runs on whichever thread handled the request
    let enumerator = enumerator()?;
    // SAFETY: ordinary COM calls on objects created above.
    unsafe {
        let default = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .and_then(|d| device_id(&d).ok());
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|e| describe(&e))?;
        let count = collection.GetCount().map_err(|e| describe(&e))?;
        let mut devices = Vec::new();
        for i in 0..count {
            let Ok(device) = collection.Item(i) else {
                continue;
            };
            let Ok(id) = device_id(&device) else { continue };
            devices.push(DeviceInfo {
                is_default: default.as_deref() == Some(id.as_str()),
                name: device_name(&device),
                id,
            });
        }
        devices.sort_by_key(|d| !d.is_default);
        Ok(devices)
    }
}

fn channel_mask(channels: u16) -> u32 {
    match channels {
        1 => 0x4,
        2 => 0x3,
        3 => 0x7,
        4 => 0x33,
        5 => 0x37,
        6 => 0x3F,
        7 => 0x13F,
        _ => 0x63F,
    }
}

fn wave_format(format: &Format) -> WAVEFORMATEXTENSIBLE {
    let block = format.frame_bytes() as u16;
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: 0xFFFE, // WAVE_FORMAT_EXTENSIBLE
            nChannels: format.channels,
            nSamplesPerSec: format.rate,
            nAvgBytesPerSec: format.rate * u32::from(block),
            nBlockAlign: block,
            wBitsPerSample: format.container_bits,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: format.valid_bits,
        },
        dwChannelMask: channel_mask(format.channels),
        // KSDATAFORMAT_SUBTYPE_PCM
        SubFormat: GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71),
    }
}

/// A sound card open in exclusive mode, with its buffer filled by the playback thread each time the card asks.
pub struct Stream {
    client: IAudioClient,
    render: IAudioRenderClient,
    event: HANDLE,
    pub format: Format,
    pub device_id: String,
    pub device_name: String,
    pub buffer_frames: u32,
    started: bool,
}

impl Stream {
    /// Opens the card (the one with this id, or Windows' default) with the first of `formats` it accepts in exclusive mode.
    pub fn open_exclusive(device: Option<&str>, formats: &[Format]) -> Result<Stream, String> {
        let enumerator = enumerator()?;
        // SAFETY: ordinary COM calls; every pointer passed points at a value that outlives the call.
        unsafe {
            let endpoint = match device {
                Some(id) if !id.is_empty() => {
                    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                    enumerator
                        .GetDevice(PCWSTR(wide.as_ptr()))
                        .map_err(|_| "The chosen sound output is not connected.".to_owned())?
                }
                _ => enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|_| "No sound output was found.".to_owned())?,
            };
            let id = device_id(&endpoint)?;
            let name = device_name(&endpoint);
            let mut last_problem =
                "The sound card does not accept this kind of audio in exclusive mode.".to_owned();
            for format in formats {
                let wfx = wave_format(format);
                let pointer = &wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;
                let client: IAudioClient = endpoint
                    .Activate(CLSCTX_ALL, None)
                    .map_err(|e| describe(&e))?;
                let support = client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, pointer, None);
                if support != windows::Win32::Foundation::S_OK {
                    continue;
                }
                let mut default_period = 0i64;
                client
                    .GetDevicePeriod(Some(&mut default_period), None)
                    .map_err(|e| describe(&e))?;
                let mut period = default_period.max(30_000);
                let mut client = client;
                let mut opened = client.Initialize(
                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    period,
                    period,
                    pointer,
                    None,
                );
                if let Err(error) = &opened {
                    if error.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                        // the card wants a whole number of its own blocks: ask how many fit, then start again with that length
                        let frames = client.GetBufferSize().map_err(|e| describe(&e))?;
                        period = (10_000_000.0 * f64::from(frames) / f64::from(format.rate) + 0.5)
                            as i64;
                        client = endpoint
                            .Activate(CLSCTX_ALL, None)
                            .map_err(|e| describe(&e))?;
                        opened = client.Initialize(
                            AUDCLNT_SHAREMODE_EXCLUSIVE,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            period,
                            period,
                            pointer,
                            None,
                        );
                    }
                }
                if let Err(error) = opened {
                    last_problem = if error.code().0 as u32 == 0x8889_000A {
                        "The sound card is in use by another program in exclusive mode.".to_owned()
                    } else if error.code().0 as u32 == 0x8889_000E {
                        "Windows is set to stop programs taking exclusive control of this sound card (Sound settings > Properties > Advanced).".to_owned()
                    } else {
                        format!(
                            "The sound card could not be opened exclusively: {}",
                            describe(&error)
                        )
                    };
                    continue;
                }
                let buffer_frames = client.GetBufferSize().map_err(|e| describe(&e))?;
                let event =
                    CreateEventW(None, false, false, PCWSTR::null()).map_err(|e| describe(&e))?;
                client.SetEventHandle(event).map_err(|e| describe(&e))?;
                let render: IAudioRenderClient = client.GetService().map_err(|e| describe(&e))?;
                return Ok(Stream {
                    client,
                    render,
                    event,
                    format: *format,
                    device_id: id,
                    device_name: name,
                    buffer_frames,
                    started: false,
                });
            }
            Err(last_problem)
        }
    }

    /// Fills the whole buffer through `fill(bytes, frames)`: used once before `start` and then each time the card asks.
    pub fn write(&mut self, fill: impl FnOnce(&mut [u8], usize)) -> Result<(), String> {
        let frames = self.buffer_frames as usize;
        // SAFETY: GetBuffer hands out exactly `buffer_frames` frames of memory owned by the card until ReleaseBuffer.
        unsafe {
            let pointer = self
                .render
                .GetBuffer(self.buffer_frames)
                .map_err(|e| describe(&e))?;
            let bytes = std::slice::from_raw_parts_mut(pointer, frames * self.format.frame_bytes());
            fill(bytes, frames);
            self.render
                .ReleaseBuffer(self.buffer_frames, 0)
                .map_err(|e| describe(&e))
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if !self.started {
            // SAFETY: plain COM call.
            unsafe { self.client.Start() }.map_err(|e| describe(&e))?;
            self.started = true;
        }
        Ok(())
    }

    /// Stops the card and empties its buffer (the next `write` and `start` begin afresh).
    pub fn stop(&mut self) {
        if self.started {
            // SAFETY: plain COM calls.
            unsafe {
                let _ = self.client.Stop();
                let _ = self.client.Reset();
            }
            self.started = false;
        }
    }

    /// Waits up to `milliseconds` for the card to ask for more sound.
    pub fn wait(&self, milliseconds: u32) -> bool {
        // SAFETY: waits on an event handle this stream owns.
        unsafe { WaitForSingleObject(self.event, milliseconds) == WAIT_OBJECT_0 }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop();
        // SAFETY: closes the event handle created in `open_exclusive`.
        unsafe {
            let _ = CloseHandle(self.event);
        }
    }
}
