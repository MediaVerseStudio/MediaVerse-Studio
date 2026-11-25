rusty-chromaprint 0.3.0 declares "MIT" in its Cargo.toml but its crate and repository contain no licence file.
It is a Rust port of Chromaprint (https://github.com/acoustid/chromaprint), so the notice that must accompany it
is Chromaprint's: LICENSE-chromaprint.md is a verbatim copy of that project's LICENSE.md (downloaded 2026-11-16 from
https://raw.githubusercontent.com/acoustid/chromaprint/master/LICENSE.md). Its MIT section (Copyright (C) 2010-2016
Lukas Lalinsky) is the one that applies to the ported code; the LGPL 2.1 remark in that file concerns FFmpeg code
bundled in the original C++ library, which the Rust port replaces with rubato and rustfft (see third_party/provenance.toml).
tools/licences/make-licence-pack.cjs uses files in this folder only for a library that ships none of its own.
