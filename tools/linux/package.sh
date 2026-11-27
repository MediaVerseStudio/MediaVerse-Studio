#!/usr/bin/env bash
# Builds a Linux TEST copy of MediaVerse Studio in dist-app/linux:
#   mediaverse-studio_<version>_amd64.deb        for Ubuntu 24.04 and newer
#   mediaverse-studio-<version>-linux-x64.tar.gz the same program as a folder, for other distributions (untested)
#
# Needs what tools/linux/setup-dev.sh installs. The Windows twin is tools/package-windows.ps1. Not in this build yet:
# the CD helper, LAME, and the downloads for the Lyric AI and the photo reader.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="$root/web/app"
out="$root/dist-app/linux"
name="mediaverse-studio"
export PATH="$HOME/.cargo/bin:$PATH"

base_version="$(node -p "require('$app/package.json').version")"
commit="$(git -C "$root" rev-parse --short HEAD)"
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then commit="$commit.modified"; fi
# "~" sorts before the plain version, so a later proper release replaces this test build.
version="$base_version~test+g$commit"

echo "Building the Rust sidecar (release)..."
cargo build --release --locked -p mediaverse_sidecar --manifest-path "$root/Cargo.toml"

echo "Building the web page..."
(
  cd "$app"
  [ -d node_modules ] || npm ci
  # Downloads the Electron runtime if it is not here yet, checked against the checksums in the npm package.
  node node_modules/electron/install.js
  npm run build
)

stage="$out/stage"
program="$stage/deb/opt/$name"
rm -rf "$out"
mkdir -p "$program"
cp -a "$app/node_modules/electron/dist/." "$program/"
mv "$program/electron" "$program/$name"
rm -f "$program/resources/default_app.asar"

resources="$program/resources/app"
mkdir -p "$resources/electron"
cp -a "$app/dist" "$resources/dist"
find "$app/electron" -maxdepth 1 \( -name '*.js' ! -name '*.test.js' -o -name '*.html' -o -name 'icon.png' -o -name 'icon.ico' \) -exec cp {} "$resources/electron/" \;
if [ -d "$app/electron/icons" ]; then cp -a "$app/electron/icons" "$resources/electron/icons"; fi
cat > "$resources/package.json" <<EOF
{ "name": "$name", "productName": "MediaVerse Studio", "version": "$base_version", "desktopName": "$name.desktop", "main": "electron/main.js" }
EOF
echo "$commit" > "$resources/commit.txt"

install -m 755 "$root/target/release/mediaverse_sidecar" "$program/resources/mediaverse_sidecar"
node "$root/tools/licences/make-licence-pack.cjs" "$program/licenses" "$commit" linux

cat > "$program/README-TEST-BUILD.txt" <<EOF
MediaVerse Studio $base_version - Linux TEST build (commit $commit)

Run ./$name in this folder. The installed .deb sets the program's sandbox up by itself; from this folder, do it once:

  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

Settings, the library list, playlists and flags are kept in ~/.config/MediaVerse Studio.

Not in this build yet: reading CDs, converting other formats to MP3, and the Lyric AI and photo reader downloads.

Licences, notices and how to get the source: the licenses folder (licenses/README.txt).
EOF

# ---- the folder as an archive
cp -a "$program" "$stage/$name-$base_version-linux-x64"
tar -C "$stage" -czf "$out/$name-$base_version-linux-x64.tar.gz" "$name-$base_version-linux-x64"

# ---- the .deb
deb="$stage/deb"
mkdir -p "$deb/DEBIAN" "$deb/usr/bin" "$deb/usr/share/applications" "$deb/usr/share/icons/hicolor/256x256/apps"
ln -s "/opt/$name/$name" "$deb/usr/bin/$name"
cp "$app/electron/icon.png" "$deb/usr/share/icons/hicolor/256x256/apps/$name.png"
cat > "$deb/usr/share/applications/$name.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MediaVerse Studio
Comment=Organize, fix, play and share your music
Exec=/usr/bin/$name
Icon=$name
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupWMClass=$name
EOF
cat > "$program/resources/apparmor-profile" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile $name "/opt/$name/$name" flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
EOF
installed_kb="$(du -sk --exclude=DEBIAN "$deb" | cut -f1)"
cat > "$deb/DEBIAN/control" <<EOF
Package: $name
Version: $version
Architecture: amd64
Maintainer: MediaVerse Studio <contact@mediaverse.studio>
Installed-Size: $installed_kb
Depends: libc6 (>= 2.39), libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libnotify4, libatspi2.0-0t64 | libatspi2.0-0, libxss1, libxtst6, libssl3t64 | libssl3, xdg-utils
Section: sound
Priority: optional
Homepage: https://mediaverse.studio
Description: Organize, fix, play and share your music (test build)
 A test build of MediaVerse Studio for Linux. Free software under the GNU GPL,
 version 3 or later.
EOF
cat > "$deb/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
# The program's sandbox: a root-owned helper, and on Ubuntu 24.04 and newer a profile that lets it make user namespaces.
chown root:root /opt/$name/chrome-sandbox
chmod 4755 /opt/$name/chrome-sandbox
if [ -d /etc/apparmor.d ] && [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
  cp /opt/$name/resources/apparmor-profile /etc/apparmor.d/$name
  apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/$name || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
EOF
cat > "$deb/DEBIAN/postrm" <<EOF
#!/bin/sh
set -e
if [ "\$1" = remove ] || [ "\$1" = purge ]; then
  if [ -e /etc/apparmor.d/$name ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser --remove /etc/apparmor.d/$name || true; fi
    rm -f /etc/apparmor.d/$name
  fi
fi
EOF
chmod 755 "$deb/DEBIAN/postinst" "$deb/DEBIAN/postrm"
# Readable by everyone whatever this account's umask is.
chmod -R u+rwX,go+rX,go-w "$deb"
dpkg-deb --root-owner-group --build "$deb" "$out/${name}_${version}_amd64.deb"

rm -rf "$stage"
(cd "$out" && sha256sum ./*.deb ./*.tar.gz > SHA256SUMS.txt)
echo
echo "Done. In $out:"
ls -lh "$out"
