#!/bin/bash
set -euo pipefail

# Downloads pre-built static libraries and bare addon prebuilds from
# GitHub Releases. Runs automatically via npm postinstall. Mirrors the
# pattern from @utexo/rgb-lib-bare.

REPO="${RLN_BARE_RELEASE_REPO:-UTEXO-Protocol/rgb-lightning-node-bare}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Derive version from package.json so a publish bump alone is enough to
# pull fresh prebuilds. Previously this was hardcoded and silently
# stayed on beta.4 across beta.5+ tags, which left every consumer
# running stale native code against a newer JS wrapper. Allow an
# override via RLN_BARE_RELEASE_VERSION for testing.
VERSION="${RLN_BARE_RELEASE_VERSION:-v$(node -p 'require("'"$PKG_DIR"'/package.json").version')}"

# Platform assets to download
# Format: "github_asset_name:local_path"
ASSETS=(
  # iOS / darwin static libs
  "librlncffi-ios-arm64.a:lib/ios-arm64/librlncffi.a"
  "librlncffi-ios-arm64-simulator.a:lib/ios-arm64-simulator/librlncffi.a"
  "librlncffi-ios-x64-simulator.a:lib/ios-x64-simulator/librlncffi.a"
  "librlncffi-darwin-arm64.a:lib/darwin-arm64/librlncffi.a"
  # Android static libs
  "librlncffi-android-arm64.a:lib/android-arm64/librlncffi.a"
  "librlncffi-android-arm.a:lib/android-arm/librlncffi.a"
  "librlncffi-android-x64.a:lib/android-x64/librlncffi.a"
  # iOS / darwin prebuilds
  "utexo__rgb-lightning-node-bare-ios-arm64.bare:prebuilds/ios-arm64/utexo__rgb-lightning-node-bare.bare"
  "utexo__rgb-lightning-node-bare-ios-arm64-simulator.bare:prebuilds/ios-arm64-simulator/utexo__rgb-lightning-node-bare.bare"
  "utexo__rgb-lightning-node-bare-ios-x64-simulator.bare:prebuilds/ios-x64-simulator/utexo__rgb-lightning-node-bare.bare"
  "utexo__rgb-lightning-node-bare-darwin-arm64.bare:prebuilds/darwin-arm64/utexo__rgb-lightning-node-bare.bare"
  # Android prebuilds
  "utexo__rgb-lightning-node-bare-android-arm64.bare:prebuilds/android-arm64/utexo__rgb-lightning-node-bare.bare"
  "utexo__rgb-lightning-node-bare-android-arm.bare:prebuilds/android-arm/utexo__rgb-lightning-node-bare.bare"
  "utexo__rgb-lightning-node-bare-android-x64.bare:prebuilds/android-x64/utexo__rgb-lightning-node-bare.bare"
)

cd "$PKG_DIR"

NEED_DOWNLOAD=false
for entry in "${ASSETS[@]}"; do
  LOCAL="${entry##*:}"
  if [ ! -f "$LOCAL" ]; then
    NEED_DOWNLOAD=true
    break
  fi
done

if [ "$NEED_DOWNLOAD" = false ]; then
  echo "[rgb-lightning-node-bare] All binary assets present, skipping download."
  exit 0
fi

echo "[rgb-lightning-node-bare] Downloading binary assets from $REPO@$VERSION..."

if command -v gh &>/dev/null; then
  USE_GH=true
else
  USE_GH=false
  echo "[rgb-lightning-node-bare] gh CLI not found, using curl"
fi

for entry in "${ASSETS[@]}"; do
  ASSET_NAME="${entry%%:*}"
  LOCAL_PATH="${entry##*:}"
  LOCAL_DIR="$(dirname "$LOCAL_PATH")"

  if [ -f "$LOCAL_PATH" ]; then
    echo "  ✓ $LOCAL_PATH (exists)"
    continue
  fi

  mkdir -p "$LOCAL_DIR"

  if [ "$USE_GH" = true ]; then
    echo "  ↓ $ASSET_NAME → $LOCAL_PATH"
    gh release download "$VERSION" \
      --repo "$REPO" \
      --pattern "$ASSET_NAME" \
      --output "$LOCAL_PATH" \
      --clobber
  else
    URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET_NAME"
    echo "  ↓ $URL → $LOCAL_PATH"
    curl -fSL "$URL" -o "$LOCAL_PATH"
  fi

  if [ -f "$LOCAL_PATH" ]; then
    SIZE=$(ls -lh "$LOCAL_PATH" | awk '{print $5}')
    echo "  ✓ $LOCAL_PATH ($SIZE)"
  else
    echo "  ✗ Failed to download $ASSET_NAME"
    exit 1
  fi
done

echo "[rgb-lightning-node-bare] All binary assets downloaded."
