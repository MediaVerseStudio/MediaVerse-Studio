#!/usr/bin/env bash
# Builds the pinned libcdio and libcdio-paranoia as static MinGW-w64 (UCRT64) libraries.
# Run from the repo root inside MSYS2 UCRT64 (MSYSTEM=UCRT64), e.g. via tools/build-libcdio-mingw.ps1.
# Requires: gcc, make, autoconf, automake, libtool (pacman). Sources must already be downloaded to
# third_party/source/ and verified with tools/verify-native-source.ps1.
# Output: third_party/build/libcdio-native/prefix (ignored by Git; never committed or shipped
# without the corresponding-source and notice requirements in third_party/README.md).
set -euo pipefail
[ "${MSYSTEM:-}" = "UCRT64" ] || { echo "Run inside the MSYS2 UCRT64 environment." >&2; exit 2; }

ROOT=$(pwd)
SRC=$ROOT/third_party/source
B=$ROOT/third_party/build/libcdio-native
CDIO_REV=68ea374f83d5e63122168e4e182b15ba10e0d2eb
PARANOIA_REV=384f4dac7e211cce67a14f3df53fc596965b6c94

rm -rf "$B"; mkdir -p "$B/src/libcdio" "$B/src/libcdio-paranoia" "$B/prefix"
P=$(cd "$B/prefix" && pwd)
tar xzf "$SRC/libcdio-$CDIO_REV.tar.gz" -C "$B/src/libcdio" --strip-components=1
tar xzf "$SRC/libcdio-paranoia-$PARANOIA_REV.tar.gz" -C "$B/src/libcdio-paranoia" --strip-components=1

# Only `include` and `lib` are built: the doc/ directory needs a texinfo setup we do not require.
build() {
  (cd "$B/src/$1" && autoreconf -fi && shift && ./configure --prefix="$P" "$@" \
    && for d in include lib; do make -C $d -j"$(nproc)" && make -C $d install; done \
    && make install-pkgconfigDATA)
}

build libcdio --disable-shared --enable-static --disable-cxx --disable-vcd-info \
  --without-cd-drive --without-cd-info --without-cdda-player --without-cd-read \
  --without-iso-info --without-iso-read --disable-example-progs --disable-cddb --disable-joliet
export PKG_CONFIG_PATH=$P/lib/pkgconfig
build libcdio-paranoia --disable-shared --enable-static --disable-cxx \
  --disable-example-progs --without-cd-paranoia --without-cd-info

ls "$P/lib"/*.a
