#!/usr/bin/env bash
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${CFFI_DIR:?Use npm run prepare-native to prepare verified RLN source}"
: "${RLN_ADAPTER_SHA256:?Missing adapter provenance}"
: "${RLN_WRAPPER_SHA256:?Missing wrapper provenance}"
: "${RLN_LOCK_SHA256:?Missing lock provenance}"

MODE="${1:?An exact target is required}"
PROFILE=release
if [ "${RLN_BARE_DEBUG:-0}" = 1 ]; then
  PROFILE=debug
  export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false
fi

case "$MODE" in
  darwin-arm64) RUST_TARGET=aarch64-apple-darwin ;;
  darwin-x64) RUST_TARGET=x86_64-apple-darwin ;;
  ios-arm64) RUST_TARGET=aarch64-apple-ios; export SDKROOT="$(xcrun --sdk iphoneos --show-sdk-path)" ;;
  ios-arm64-simulator) RUST_TARGET=aarch64-apple-ios-sim; export SDKROOT="$(xcrun --sdk iphonesimulator --show-sdk-path)" ;;
  ios-x64-simulator) RUST_TARGET=x86_64-apple-ios; export SDKROOT="$(xcrun --sdk iphonesimulator --show-sdk-path)" ;;
  android-arm64) RUST_TARGET=aarch64-linux-android; NDK_ABI=arm64-v8a ;;
  android-arm) RUST_TARGET=armv7-linux-androideabi; NDK_ABI=armeabi-v7a ;;
  android-x64) RUST_TARGET=x86_64-linux-android; NDK_ABI=x86_64 ;;
  *) echo "Unsupported exact native target: $MODE" >&2; exit 1 ;;
esac

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"
case "$MODE" in
  darwin-*) DEPLOYMENT_FLAG="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" ;;
  ios-*-simulator) DEPLOYMENT_FLAG="-mios-simulator-version-min=$IPHONEOS_DEPLOYMENT_TARGET" ;;
  ios-*) DEPLOYMENT_FLAG="-miphoneos-version-min=$IPHONEOS_DEPLOYMENT_TARGET" ;;
  *) DEPLOYMENT_FLAG= ;;
esac
# Some C dependency build scripts only track CFLAGS, not the deployment env var.
if [ -n "$DEPLOYMENT_FLAG" ]; then
  export CFLAGS="${CFLAGS:-} $DEPLOYMENT_FLAG"
  export CXXFLAGS="${CXXFLAGS:-} $DEPLOYMENT_FLAG"
fi
cd "$CFFI_DIR"
if [[ "$MODE" == android-* ]]; then
  : "${ANDROID_NDK_HOME:?A pinned Android NDK is required}"
  COMMAND=(cargo ndk -t "$NDK_ABI" -P "${ANDROID_API_LEVEL:-29}" rustc)
else
  COMMAND=(cargo rustc --target "$RUST_TARGET")
fi
COMMAND+=(--locked --lib --crate-type staticlib)
if [ "$PROFILE" = release ]; then COMMAND+=(--release); fi
"${COMMAND[@]}"

ARTIFACT="${CARGO_TARGET_DIR:-$CFFI_DIR/target}/$RUST_TARGET/$PROFILE/librlncffi.a"
test -s "$ARTIFACT"
cmp "$CFFI_DIR/rln.h" "$PKG_DIR/rln.h"
mkdir -p "$PKG_DIR/lib/$MODE"
cp "$ARTIFACT" "$PKG_DIR/lib/$MODE/librlncffi.a"
echo "Built and header-verified $MODE"
