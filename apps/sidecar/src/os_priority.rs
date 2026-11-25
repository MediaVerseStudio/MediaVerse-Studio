//! Library-wide background work (scans of every song, fingerprinting, tag checks) must not get in the way of what the
//! person is doing: playing music, a rip being encoded, the page answering clicks (PC pass, D123).
//!
//! On Windows a thread can enter *background mode*: the system lowers its processor priority, its disk priority and its
//! memory priority together, and gives them back when the thread ends. Other platforms do nothing. Failing to enter the
//! mode is harmless (the work just runs at the normal priority).

/// Puts the calling thread into background mode for the rest of its life.
#[cfg(windows)]
pub fn background_thread() -> bool {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
    };
    // SAFETY: both calls take no pointers; GetCurrentThread returns a pseudo handle that is always valid for this thread.
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN).is_ok() }
}

#[cfg(not(windows))]
pub fn background_thread() -> bool {
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn entering_background_mode_does_not_disturb_the_thread() {
        // Run on a thread of its own so the test thread keeps its priority. Windows answers true.
        let ok = std::thread::spawn(|| {
            let entered = super::background_thread();
            let sum: u64 = (0..1000u64).sum();
            (entered, sum)
        })
        .join()
        .unwrap();
        assert_eq!(ok.1, 499_500);
        #[cfg(windows)]
        assert!(ok.0, "background mode refused");
    }
}
