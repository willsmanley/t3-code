#!/usr/bin/env bash
# Builds the fork's macOS desktop app (Apple Silicon, .zip) on Linux, then signs it with the
# Developer ID certificate and notarizes it, the way ctx builds its macOS release on Linux:
# Zig + Apple's macOS SDK for the one Rust helper, rcodesign for signing and notarization.
# Nothing else is compiled: Electron and the native packages ship macOS builds.
#
# Usage: scripts/fork/mac-desktop-build-linux.sh <version> <output-dir> [--unsigned]
#   Run from the repository root after `pnpm install` and `vp run build:desktop` (with the
#   release version already applied), as scripts/fork/nightly-release.sh does.
#   Writes T3-Code-<version>-arm64.zip and nightly-mac.yml (the updater manifest) to <output-dir>.
#
# Inputs:
#   T3CODE_MACOS_SDK_ARCHIVE  macOS SDK archive (default: the ctx release factory's pinned copy).
#                             Licensed Apple bytes: never commit or publish it.
#   Signing secrets           APPLE_CODESIGN_CERT_P12_B64, APPLE_CODESIGN_CERT_PASSWORD,
#                             NOTARY_ISSUER, NOTARY_KEY_ID, NOTARY_KEY_P8_B64 from the environment,
#                             or else from Infisical (the ctx project, as ctx's macOS signing does).
#   cargo-zigbuild            must be installed (cargo install cargo-zigbuild --locked).
set -euo pipefail

version="${1:?usage: mac-desktop-build-linux.sh <version> <output-dir> [--unsigned]}"
out_dir="${2:?usage: mac-desktop-build-linux.sh <version> <output-dir> [--unsigned]}"
sign=true
[ "${3:-}" = --unsigned ] && sign=false

sdk_archive="${T3CODE_MACOS_SDK_ARCHIVE:-/home/daddy/.local/share/agent-runs/ctx-release-2.3.0/inputs/sdk/MacOSX26.2.sdk.repacked.tar.gz}"
sdk_sha256=633818058e889a08e0be4ca985741e8678578af8da9ce1f8a85a6218b452c0fb
zig_version=0.15.2
zig_sha256=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
rcodesign_version=0.29.0
rcodesign_sha256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
infisical_project="${T3CODE_MACOS_SIGNING_INFISICAL_PROJECT:-590927ab-758e-41b0-9e15-4cf070e87cf4}"
infisical_env="${T3CODE_MACOS_SIGNING_INFISICAL_ENV:-prod}"
deployment_target=13.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/t3code-fork-mac-cross"
log() { printf '\n==> %s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { echo "mac-desktop-build-linux: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this builds the macOS app on Linux; on a Mac use mac-desktop-build.sh"
[ -f package.json ] && [ -f scripts/build-desktop-artifact.ts ] || die "run this from the repository root"
command -v cargo-zigbuild >/dev/null || die "cargo-zigbuild is missing (cargo install cargo-zigbuild --locked)"
mkdir -p "$out_dir" "$cache_dir"
out_dir="$(cd "$out_dir" && pwd)"

fetch() { # url sha256 destination
  [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null && return 0
  curl -fsSL -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c --quiet - || die "checksum mismatch for $1"
  mv "$3.part" "$3"
}

log "Preparing the macOS SDK and tools"
sdk_root="$cache_dir/sdk-${sdk_sha256:0:12}/MacOSX.sdk"
if [ ! -d "$sdk_root" ]; then
  [ -f "$sdk_archive" ] || die "macOS SDK archive not found: $sdk_archive"
  echo "$sdk_sha256  $sdk_archive" | sha256sum -c --quiet - || die "macOS SDK archive does not match the pin"
  rm -rf "$cache_dir/sdk-${sdk_sha256:0:12}.part"
  mkdir -p "$cache_dir/sdk-${sdk_sha256:0:12}.part"
  tar -xzf "$sdk_archive" -C "$cache_dir/sdk-${sdk_sha256:0:12}.part"
  mv "$cache_dir/sdk-${sdk_sha256:0:12}.part" "$cache_dir/sdk-${sdk_sha256:0:12}"
fi
zig_dir="$cache_dir/zig-x86_64-linux-$zig_version"
if [ ! -x "$zig_dir/zig" ]; then
  fetch "https://ziglang.org/download/$zig_version/zig-x86_64-linux-$zig_version.tar.xz" "$zig_sha256" "$zig_dir.tar.xz"
  tar -xJf "$zig_dir.tar.xz" -C "$cache_dir" && rm -f "$zig_dir.tar.xz"
fi
rcodesign="$cache_dir/rcodesign-$rcodesign_version"
if [ ! -x "$rcodesign" ]; then
  name="apple-codesign-$rcodesign_version-x86_64-unknown-linux-musl"
  fetch "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/$rcodesign_version/$name.tar.gz" \
    "$rcodesign_sha256" "$cache_dir/$name.tar.gz"
  tar -xzf "$cache_dir/$name.tar.gz" -C "$cache_dir" "$name/rcodesign"
  mv "$cache_dir/$name/rcodesign" "$rcodesign" && rmdir "$cache_dir/$name" && rm -f "$cache_dir/$name.tar.gz"
fi

log "Building the resource monitor for aarch64-apple-darwin"
PATH="$zig_dir:$PATH" SDKROOT="$sdk_root" MACOSX_DEPLOYMENT_TARGET="$deployment_target" \
  cargo zigbuild --locked --release --manifest-path native/resource-monitor/Cargo.toml \
  --target aarch64-apple-darwin

log "Packaging $version"
stage_out="$(mktemp -d "${TMPDIR:-/tmp}/t3code-mac-package.XXXXXX")"
work="$(mktemp -d "${TMPDIR:-/tmp}/t3code-mac-sign.XXXXXX")"
secrets="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/t3code-mac-secrets.XXXXXX")"
chmod 700 "$secrets"
trap 'rm -rf "$stage_out" "$work" "$secrets"' EXIT
# sips and iconutil stand-ins make the app icon; the build calls them by name.
PATH="$here/mac-linux-tools:$PATH" \
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  T3CODE_DESKTOP_VERSION="$version" T3CODE_DESKTOP_PLATFORM=mac T3CODE_DESKTOP_TARGET=zip \
  T3CODE_DESKTOP_ARCH=arm64 T3CODE_DESKTOP_OUTPUT_DIR="$stage_out" T3CODE_DESKTOP_SKIP_BUILD=true \
  T3CODE_DESKTOP_SIGNED=false \
  node scripts/build-desktop-artifact.ts --platform mac --target zip --arch arm64 \
  --build-version "$version" --skip-build --output-dir "$stage_out"
zip_name="T3-Code-$version-arm64.zip"
[ -f "$stage_out/$zip_name" ] || die "packaging did not produce $zip_name"
manifest="$(cd "$stage_out" && ls -- *-mac.yml | head -n 1)"
[ -n "$manifest" ] || die "packaging did not produce an updater manifest"

if [ "$sign" = false ]; then
  cp "$stage_out/$zip_name" "$stage_out/$manifest" "$out_dir/"
  log "Built unsigned $out_dir/$zip_name"
  exit 0
fi

log "Reading signing secrets"
secret() { # name
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"; return; fi
  infisical secrets get "$1" --projectId "$infisical_project" --env "$infisical_env" --path / --plain --silent
}
secret APPLE_CODESIGN_CERT_P12_B64 | base64 -d > "$secrets/cert.p12"
# Infisical ends the value with a newline that isn't part of the password.
secret APPLE_CODESIGN_CERT_PASSWORD | python3 -c 'import sys; d = sys.stdin.buffer.read(); sys.stdout.buffer.write(d[:-1] if d.endswith(b"\n") else d)' \
  > "$secrets/cert.password"
# rcodesign can't open every .p12 cipher, so hand it PEM files (as ctx's signing does).
for legacy in "" -legacy; do
  openssl pkcs12 $legacy -in "$secrets/cert.p12" -passin "file:$secrets/cert.password" \
    -clcerts -nokeys -out "$secrets/cert.pem" >/dev/null 2>&1 &&
    openssl pkcs12 $legacy -in "$secrets/cert.p12" -passin "file:$secrets/cert.password" \
      -nocerts -nodes -out "$secrets/key.pem" >/dev/null 2>&1 && break
  rm -f "$secrets/cert.pem" "$secrets/key.pem"
done
rm -f "$secrets/cert.p12" "$secrets/cert.password"
secret NOTARY_KEY_P8_B64 | base64 -d > "$secrets/notary.p8"
"$rcodesign" encode-app-store-connect-api-key -o "$secrets/notary.json" \
  "$(secret NOTARY_ISSUER)" "$(secret NOTARY_KEY_ID)" "$secrets/notary.p8" >/dev/null
rm -f "$secrets/notary.p8"
[ -s "$secrets/cert.pem" ] && [ -s "$secrets/key.pem" ] && [ -s "$secrets/notary.json" ] ||
  die "incomplete signing secrets (could the certificate password be wrong?)"

log "Signing"
(cd "$work" && unzip -q "$stage_out/$zip_name")
app_name="$(cd "$work" && ls -d -- *.app | head -n 1)"
app="$work/$app_name"
product="${app_name%.app}"
# The same entitlements as the upstream signed build (scripts/build-desktop-artifact.ts), minus the
# passkey ones, which need T3's own provisioning profile.
cat > "$work/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
PLIST
# Hardened runtime on every executable (notarization requires it); entitlements on the app and
# its Electron helpers. rcodesign keeps a nested binary's existing flags and entitlements when it
# signs the bundle, so sign the nested executables first, one by one. (Scoped settings can't be
# used: rcodesign reads the "@" in paths like node_modules/@cursor/... as a scope expression.)
sign_args=(--pem-file "$secrets/cert.pem" --pem-file "$secrets/key.pem")
main_exe="$app/Contents/MacOS/$product"
while IFS= read -r -d '' file; do
  [ "$file" = "$main_exe" ] && continue
  file -b "$file" | grep -q 'Mach-O.*executable' || continue
  extra=()
  case "$file" in "$app/Contents/Frameworks/$product Helper"*.app/Contents/MacOS/*)
    extra=(--entitlements-xml-file "$work/entitlements.plist") ;;
  esac
  "$rcodesign" sign "${sign_args[@]}" --code-signature-flags runtime "${extra[@]}" "$file" >/dev/null
done < <(find "$app" -type f -print0)
"$rcodesign" sign "${sign_args[@]}" --code-signature-flags runtime \
  --entitlements-xml-file "$work/entitlements.plist" "$app" >/dev/null
# rcodesign verifies single binaries only; Apple's notarization below checks the whole app.
"$rcodesign" verify "$main_exe" >/dev/null

log "Notarizing (Apple usually answers in a few minutes)"
"$rcodesign" notary-submit --api-key-file "$secrets/notary.json" --wait --max-wait-seconds 3600 \
  --staple "$app"

log "Writing $zip_name"
rm -f "$out_dir/$zip_name"
(cd "$work" && zip -qryX "$out_dir/$zip_name" "$app_name")
sha512="$(openssl dgst -sha512 -binary "$out_dir/$zip_name" | base64 -w0)"
size="$(stat -c '%s' "$out_dir/$zip_name")"
cat > "$out_dir/$manifest" <<YAML
version: $version
files:
  - url: $zip_name
    sha512: $sha512
    size: $size
path: $zip_name
sha512: $sha512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
YAML
log "Built, signed and notarized $out_dir/$zip_name"
