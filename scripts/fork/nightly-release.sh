#!/usr/bin/env bash
# Builds the fork's nightly release on this machine and publishes it to the fork's GitHub
# releases. It makes the same files as .github/workflows/custom-nightly-linux.yml (Linux
# desktop, SSH runtime archive, signed Android APK, SHA256SUMS), so the desktop updater and
# the phone pick it up the same way. See docs/fork/upstream-sync.md, step 8.
#
# Usage: scripts/fork/nightly-release.sh [--ref <commit>] [--no-publish] [--force]
#
#   --ref         commit to build (default: the fork's main on GitHub). Only main publishes.
#   --no-publish  build and check everything, then stop before the release.
#   --force       build even when a release already exists for the commit.
#
# It builds in a fresh detached worktree next to this checkout (../nightly-build) and leaves
# it there when a step fails. Run it under the host's build governor if it has one.
#
# Android signing: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS,
# as in the workflow. When they are unset it reads the Bitwarden item named by
# T3CODE_ANDROID_SIGNING_ITEM, which needs an unlocked vault (BW_SESSION). Push notifications
# need the fork's Firebase config in T3CODE_ANDROID_GOOGLE_SERVICES_FILE (default
# ~/.config/t3code-fork/google-services.json); without it the APK builds with no push.
set -euo pipefail

repo=willsmanley/t3-code
upstream_url=https://github.com/pingdotgg/t3code.git
# Public certificate fingerprint of the fork's signing key, as in the workflow.
signing_cert_sha256=6debb2ea31768f3634b1ff7b81e234d7d8d8e234ec34615c8d60b5cdc6691d83
signing_item="${T3CODE_ANDROID_SIGNING_ITEM:-T3 Code Fork Android signing key}"
google_services="${T3CODE_ANDROID_GOOGLE_SERVICES_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/t3code-fork/google-services.json}"

ref=""
publish=true
force=false
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift 2 ;;
    --no-publish) publish=false; shift ;;
    --force) force=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { echo "nightly-release: $*" >&2; exit 1; }

checkout="$(git rev-parse --show-toplevel)"
build_dir="$(dirname "$checkout")/nightly-build"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/t3code-fork-nightly"
secrets_dir="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/t3code-nightly.XXXXXX")"
chmod 700 "$secrets_dir"
trap 'rm -rf "$secrets_dir"' EXIT

main_sha="$(git ls-remote "https://github.com/$repo.git" refs/heads/main | cut -f1)"
test -n "$main_sha" || die "could not read the fork's main"
if [ -z "$ref" ]; then
  sha="$main_sha"
else
  sha="$(git rev-parse --verify "$ref^{commit}")"
fi
if [ "$publish" = true ] && [ "$sha" != "$main_sha" ]; then
  die "$sha is not the fork's main ($main_sha); only main publishes. Use --no-publish for a test build."
fi
git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q "https://github.com/$repo.git" "$sha"

releases="$(gh api "repos/$repo/releases?per_page=100" --jq '.[] | "\(.tag_name) \(.target_commitish)"')"
if [ "$force" = false ] && printf '%s\n' "$releases" | grep " $sha\$" >/dev/null; then
  echo "A nightly release already exists for $sha:"
  printf '%s\n' "$releases" | grep " $sha\$"
  exit 0
fi

# The number names the release and is the APK's version code, so it has to grow past both the
# workflow's run numbers and every earlier release, or the phone refuses the update.
last_release="$(printf '%s\n' "$releases" | sed -n 's/^v[^ ]*-nightly\.[0-9]\{8\}\.\([0-9]\{1,\}\) .*/\1/p' | sort -n | tail -n 1)"
last_run="$(gh run list -R "$repo" -w custom-nightly-linux.yml -L 1 --json number --jq '.[0].number // 0' 2>/dev/null || echo 0)"
number=$(( ${last_release:-0} > ${last_run:-0} ? ${last_release:-0} + 1 : ${last_run:-0} + 1 ))
date="$(date -u +%Y%m%d)"

# Signing material goes in a private temp directory that is removed on exit.
if [ -z "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  test -n "${BW_SESSION:-}" || die "set ANDROID_KEYSTORE_* or unlock Bitwarden (BW_SESSION) first"
  bw get item "$signing_item" > "$secrets_dir/item.json"
  ANDROID_KEYSTORE_BASE64="$(jq -r '.notes' "$secrets_dir/item.json" | grep -E '^[A-Za-z0-9+/=]+$' | tail -n 1)"
  ANDROID_KEYSTORE_PASSWORD="$(jq -r '.fields[] | select(.name | startswith("keystore password")) | .value' "$secrets_dir/item.json")"
  ANDROID_KEY_ALIAS="$(jq -r '.fields[] | select(.name == "key alias") | .value' "$secrets_dir/item.json")"
  rm -f "$secrets_dir/item.json"
fi
test -n "${ANDROID_KEYSTORE_PASSWORD:-}" && test -n "${ANDROID_KEY_ALIAS:-}" || die "incomplete Android signing settings"
export ANDROID_KEYSTORE_PASSWORD
keystore="$secrets_dir/release.p12"
printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$keystore"
unset ANDROID_KEYSTORE_BASE64

log "Building $sha as nightly number $number in $build_dir"
if [ -e "$build_dir" ]; then
  git worktree list --porcelain | grep -x "worktree $build_dir" >/dev/null || die "$build_dir exists and is not a worktree"
  git worktree remove --force "$build_dir"
fi
git worktree add --detach "$build_dir" "$sha"
cd "$build_dir"

# Use the Node version the repository pins, like setup-vp does in the workflow. The CLI
# single executable embeds the Node that builds it.
node_version="$(jq -r '.engines.node' package.json)"
node_dir="$cache_dir/node-v$node_version-linux-x64"
if [ ! -x "$node_dir/bin/node" ]; then
  log "Downloading Node $node_version"
  mkdir -p "$cache_dir"
  tarball="node-v$node_version-linux-x64.tar.xz"
  curl -fsSL -o "$cache_dir/$tarball" "https://nodejs.org/dist/v$node_version/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | grep " $tarball\$" |
    (cd "$cache_dir" && sha256sum -c -)
  tar -xJf "$cache_dir/$tarball" -C "$cache_dir"
  rm -f "$cache_dir/$tarball"
fi
export PATH="$node_dir/bin:$build_dir/node_modules/.bin:$PATH"

export T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
export T3CODE_CLERK_JWT_TEMPLATE=t3-relay
export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
export T3CODE_RELAY_URL=https://relay.t3.codes
export T3CODE_DESKTOP_UPDATE_REPOSITORY="$repo"
export T3CODE_RELEASE_BASE_URL="https://github.com/$repo/releases/download"
export T3CODE_TELEMETRY_CHANNEL=dev

log "Installing dependencies"
pnpm install --frozen-lockfile
vp run --filter @t3tools/desktop ensure:electron

export GITHUB_OUTPUT="$build_dir/.nightly-output"
: > "$GITHUB_OUTPUT"
node scripts/resolve-nightly-release.ts --date "$date" --run-number "$number" --sha "$sha" --github-output
version="$(sed -n 's/^version=//p' "$GITHUB_OUTPUT" | tail -n 1)"
tag="$(sed -n 's/^tag=//p' "$GITHUB_OUTPUT" | tail -n 1)"
name="$(sed -n 's/^name=//p' "$GITHUB_OUTPUT" | tail -n 1)"
test -n "$version" && test -n "$tag" && test -n "$name" || die "could not resolve the nightly version"
log "Version $version"

assets="$build_dir/release-assets"
mkdir -p "$assets"

# The Android build runs first, before the desktop steps rewrite package versions.
log "Building the Android APK"
(
  export APP_VARIANT=preview
  export T3CODE_MOBILE_APP_NAME="T3 Code Fork"
  export T3CODE_ANDROID_PACKAGE=com.willsmanley.t3code
  export T3CODE_ANDROID_VERSION_CODE="$number"
  export T3CODE_MOBILE_UPDATES_ENABLED=0
  # Holding power opens a new thread in this project (docs/fork/features.md, F13).
  export T3CODE_ASSISTANT_PROJECT_ROOT=/home/daddy/personal
  export EXPO_NO_GIT_STATUS=1
  export T3CODE_MOBILE_VERSION="$version"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  if [ -d /usr/lib/jvm/java-17-openjdk-amd64 ]; then
    export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
  fi
  if [ -f "$google_services" ]; then
    export T3CODE_ANDROID_GOOGLE_SERVICES_FILE="$google_services"
    export T3CODE_ANDROID_DIRECT_PUSH=1
    echo "Building with the fork's Firebase project for direct push."
  else
    echo "No Firebase config at $google_services; building without push notifications."
  fi
  cd apps/mobile
  pnpm exec expo prebuild --clean --platform android --no-install
  (cd android && ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a)
  # Expo's release build uses the debug key, so re-sign the APK with the fork's key.
  build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)"
  apk="$assets/T3-Code-Fork-$version-arm64.apk"
  "$build_tools/apksigner" sign \
    --ks "$keystore" \
    --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
    --key-pass env:ANDROID_KEYSTORE_PASSWORD \
    --out "$apk" \
    android/app/build/outputs/apk/release/app-release.apk
  rm -f "$apk.idsig"
  certs="$("$build_tools/apksigner" verify --print-certs "$apk")"
  digests="$(printf '%s\n' "$certs" | sed -n 's/^.*Signer.* certificate SHA-256 digest: //p' | sort -u)"
  if [ "$digests" != "$signing_cert_sha256" ]; then
    printf '%s\n' "$certs" >&2
    echo "APK signer does not match $signing_cert_sha256" >&2
    exit 1
  fi
  # sed reads all of it; head would stop aapt2 early and fail the pipe.
  "$build_tools/aapt2" dump badging "$apk" | sed -n 1p
)
rm -f "$keystore"

log "Building the desktop app and SSH runtime"
node scripts/update-release-package-versions.ts "$version"
T3CODE_AUTO_UPDATE=true vp run build:desktop
node apps/server/scripts/cli.ts build-exe --verbose
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
monitor_dir="$build_dir/.cli-resource-monitor"
mkdir -p "$monitor_dir/linux-x64"
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor "$monitor_dir/linux-x64/"
node scripts/build-cli-archive.ts \
  --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor_dir" \
  --output-dir "$assets"
node scripts/smoke-cli-archive.ts \
  --archive "$assets/t3-$version-linux-x64.tar.gz" \
  --expect-version "$version"
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  T3CODE_DESKTOP_VERSION="$version" \
  T3CODE_DESKTOP_PLATFORM=linux \
  T3CODE_DESKTOP_TARGET=AppImage \
  T3CODE_DESKTOP_ARCH=x64 \
  T3CODE_DESKTOP_OUTPUT_DIR="$assets" \
  T3CODE_DESKTOP_SKIP_BUILD=true \
  T3CODE_DESKTOP_SIGNED=false \
  node scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --build-version "$version" --skip-build --output-dir "$assets"

(cd "$assets" && sha256sum -- *.AppImage *.deb "t3-$version-linux-x64.tar.gz" *.apk > SHA256SUMS)
ls -la "$assets"

if [ "$publish" = false ]; then
  log "Built $tag without publishing. Files: $assets"
  exit 0
fi

# The fork's main may have moved during the build; the release still names the commit it built.
log "Publishing $tag"
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release upload "$tag" "$assets"/* --repo "$repo" --clobber
else
  gh release create "$tag" "$assets"/* \
    --repo "$repo" \
    --target "$sha" \
    --title "$name" \
    --prerelease \
    --latest=false \
    --generate-notes
fi
cd "$checkout"
git worktree remove --force "$build_dir"
log "Published https://github.com/$repo/releases/tag/$tag"
