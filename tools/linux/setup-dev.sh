#!/usr/bin/env bash
# Prepares Ubuntu 24.04 (a real PC, a virtual machine or WSL) to build MediaVerse Studio for Linux.
#
#   bash tools/linux/setup-dev.sh
#
# Installs system packages (asks for your password through sudo), Rust through rustup if it is missing, and Node.js 24
# from nodejs.org (checked against its published SHA-256) into /usr/local if the one here is too old. Safe to run again.
set -euo pipefail

packages=(
  # building the Rust sidecar (TLS uses the system's OpenSSL)
  build-essential pkg-config libssl-dev git curl ca-certificates xz-utils
  # running and testing the desktop program
  libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libnotify4 libatspi2.0-0t64 libxss1 libxtst6 xdg-utils xvfb
)
sudo apt-get update
sudo apt-get install -y "${packages[@]}"

if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component rustfmt
fi

node_major="$(command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0)"
if [ "$node_major" -lt 24 ]; then
  base="https://nodejs.org/dist/latest-v24.x"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  curl -sSfL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  file="$(awk '/linux-x64\.tar\.xz$/ { print $2 }' "$work/SHASUMS256.txt")"
  curl -sSfL "$base/$file" -o "$work/$file"
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$work/$file" -C /usr/local --strip-components=1 --no-same-owner
fi

echo
echo "Ready. Open a new terminal (so cargo is found), then:  bash tools/linux/package.sh"
