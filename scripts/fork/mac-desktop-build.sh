#!/usr/bin/env bash
# Builds the fork's desktop app for an Apple Silicon Mac (unsigned, ad-hoc signed) at a given
# version. The fork's nightly releases have no macOS build, so run this on the Mac from a copy of
# the commit a release was built from, with that release's version, so the app matches the server.
#
# Usage: scripts/fork/mac-desktop-build.sh <version> [output-dir]
#   scripts/fork/mac-desktop-build.sh 0.1.8-nightly.20261106.52 ~/t3-build/out
#
# Getting the source onto the Mac: `git clone` from GitHub has stalled there, so download the
# commit's tarball (the script runs from a plain directory too):
#   curl -fsSL --http1.1 -o src.tgz https://codeload.github.com/willsmanley/t3-code/tar.gz/<sha>
#   mkdir src && tar -xzf src.tgz -C src --strip-components=1 && cd src
#
# It installs only what the desktop app needs (no mobile), downloads the repository's pinned Node
# and pnpm into ~/.cache/t3code-fork-mac, and needs about 6 GB free. Installing the result:
# quit "T3 Code (Nightly)", move the old app aside, `ditto -x -k <zip> <dir>` and move the app
# into /Applications. A new ad-hoc build asks once more for the "t3code Safe Storage" keychain
# item (Always Allow) and may need its Accessibility, Screen Recording and Input Monitoring
# permissions granted again.
set -euo pipefail

version="${1:?usage: mac-desktop-build.sh <version> [output-dir]}"
out_dir="${2:-$PWD/release-mac}"
repo=willsmanley/t3-code
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/t3code-fork-mac"

log() { printf '\n==> %s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { echo "mac-desktop-build: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "run this on an Apple Silicon Mac"
[ -f package.json ] && [ -f scripts/build-desktop-artifact.ts ] || die "run this from the repository root"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

node_version="$(sed -n '/"engines"/,/}/s/.*"node": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$node_version" ] && [ -n "$pnpm_version" ] || die "could not read the pinned Node or pnpm version"

node_dir="$cache_dir/node-v$node_version-darwin-arm64"
if [ ! -x "$node_dir/bin/node" ]; then
  log "Downloading Node $node_version"
  mkdir -p "$cache_dir"
  tarball="node-v$node_version-darwin-arm64.tar.xz"
  curl -fsSL -o "$cache_dir/$tarball" "https://nodejs.org/dist/v$node_version/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | grep " $tarball\$" |
    (cd "$cache_dir" && shasum -a 256 -c -)
  tar -xJf "$cache_dir/$tarball" -C "$cache_dir"
  rm -f "$cache_dir/$tarball"
fi
pnpm_dir="$cache_dir/pnpm-$pnpm_version"
export PATH="$node_dir/bin:$pnpm_dir/bin:$PATH"
if [ ! -x "$pnpm_dir/bin/pnpm" ]; then
  log "Installing pnpm $pnpm_version"
  npm install -g --prefix "$pnpm_dir" "pnpm@$pnpm_version" >/dev/null
fi
export PATH="$PWD/node_modules/.bin:$PATH"

# Public client settings, the same as scripts/fork/nightly-release.sh.
export T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
export T3CODE_CLERK_JWT_TEMPLATE=t3-relay
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
export T3CODE_RELAY_URL=https://relay.t3.codes
export T3CODE_DESKTOP_UPDATE_REPOSITORY="$repo"
export T3CODE_RELEASE_BASE_URL="https://github.com/$repo/releases/download"
export T3CODE_TELEMETRY_CHANNEL=dev

log "Installing dependencies"
pnpm install --frozen-lockfile --filter @t3tools/monorepo --filter "@t3tools/desktop..." \
  --filter "t3..." --filter ./scripts
vp run --filter @t3tools/desktop ensure:electron

log "Building $version"
node scripts/update-release-package-versions.ts "$version"
T3CODE_AUTO_UPDATE=false vp run build:desktop

log "Packaging"
T3CODE_DESKTOP_VERSION="$version" T3CODE_DESKTOP_PLATFORM=mac T3CODE_DESKTOP_TARGET=dmg \
  T3CODE_DESKTOP_ARCH=arm64 T3CODE_DESKTOP_OUTPUT_DIR="$out_dir" T3CODE_DESKTOP_SKIP_BUILD=true \
  T3CODE_DESKTOP_SIGNED=false \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version "$version" --skip-build --output-dir "$out_dir"
ls -la "$out_dir"
log "Done"
