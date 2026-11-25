// Links the pinned static libcdio build (tools/build-libcdio-mingw.ps1) when targeting
// x86_64-pc-windows-gnu. On every other target the helper compiles to a stub that reports the
// platform as unsupported, so `cargo build --workspace` keeps working on the default MSVC target.
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=MEDIAVERSE_MINGW_LIB");
    let windows_gnu = env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows")
        && env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "gnu");
    if !windows_gnu {
        return;
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let libcdio = manifest.join("../../third_party/build/libcdio-native/prefix/lib");
    println!("cargo:rustc-link-search=native={}", libcdio.display());
    // libiconv.a comes from the MSYS2 UCRT64 toolchain used to build libcdio.
    let mingw_lib =
        env::var("MEDIAVERSE_MINGW_LIB").unwrap_or_else(|_| "C:/msys64/ucrt64/lib".to_owned());
    println!("cargo:rustc-link-search=native={mingw_lib}");
    // Order matters for static libraries: paranoia needs cdda, which needs cdio.
    println!("cargo:rustc-link-lib=static=cdio_paranoia");
    println!("cargo:rustc-link-lib=static=cdio_cdda");
    println!("cargo:rustc-link-lib=static=cdio");
    println!("cargo:rustc-link-lib=static=iconv");
    println!("cargo:rustc-link-lib=winmm");
    println!("cargo:rustc-link-lib=ws2_32");
}
