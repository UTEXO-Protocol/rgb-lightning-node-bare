#!/bin/bash
set -euo pipefail

# ============================================================================
# Build librlncffi.a for darwin-arm64 + iOS targets.
#
# Mirrors rgb-lib-bare's build-ios.sh: uses `cargo rustc --crate-type
# staticlib` against the bindings/c-ffi crate in rgb-lightning-node, drops
# the resulting .a into lib/<target>/, copies the cbindgen header.
#
# Usage:
#   bash scripts/build-cffi.sh           # darwin host + iOS triple
#   bash scripts/build-cffi.sh darwin    # darwin only (canary 1)
#   bash scripts/build-cffi.sh ios       # iOS triple only
#
# Set CFFI_DIR to override the c-ffi source location.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-all}"

if [ -z "${CFFI_DIR:-}" ]; then
  CFFI_DIR="$(cd "$PKG_DIR/../../rgb-lightning-node/bindings/c-ffi" 2>/dev/null && pwd)" || {
    echo "ERROR: rgb-lightning-node/bindings/c-ffi not found"
    echo "  Set CFFI_DIR=/path/to/rgb-lightning-node/bindings/c-ffi"
    exit 1
  }
fi

OUT_DIR="$PKG_DIR/lib"

echo "=== Building rln C-FFI static libraries ==="
echo "Source: $CFFI_DIR"
echo "Output: $OUT_DIR"
echo "Mode:   $MODE"

build_target() {
  local RUST_TARGET="$1"
  local DIR_NAME="$2"
  local EXTRA_ENV="${3:-}"

  echo ""
  echo "--- Building for $RUST_TARGET → $DIR_NAME ---"

  cd "$CFFI_DIR"

  if [ -n "$EXTRA_ENV" ]; then
    eval "$EXTRA_ENV"
  fi

  if [ -z "$RUST_TARGET" ]; then
    cargo rustc --release --lib --crate-type staticlib 2>&1 | tail -3
    mkdir -p "$OUT_DIR/$DIR_NAME"
    cp target/release/librlncffi.a "$OUT_DIR/$DIR_NAME/"
  else
    cargo rustc --release --target "$RUST_TARGET" --lib --crate-type staticlib 2>&1 | tail -3
    mkdir -p "$OUT_DIR/$DIR_NAME"
    cp "target/$RUST_TARGET/release/librlncffi.a" "$OUT_DIR/$DIR_NAME/"
  fi

  strip -S "$OUT_DIR/$DIR_NAME/librlncffi.a" 2>/dev/null || true

  SIZE=$(ls -lh "$OUT_DIR/$DIR_NAME/librlncffi.a" | awk '{print $5}')
  echo "✅ $DIR_NAME: $SIZE"
}

if [ "$MODE" = "darwin" ] || [ "$MODE" = "all" ]; then
  build_target "" "darwin-arm64"
  cp "$CFFI_DIR/rln.h" "$PKG_DIR/rln.h"
  echo "✅ Header copied"
fi

if [ "$MODE" = "ios" ] || [ "$MODE" = "all" ]; then
  IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
  IOS_SIM_SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)

  # iOS deployment floor. v0.5.0-beta.1's dep tree pulls in
  # aws_lc_sys (via rustls's aws_lc_rs crypto provider, PR #53) whose
  # prebuilt objects target iOS 26.5; Rust's `aarch64-apple-ios`
  # target defaults to iOS 10.0, and the linker refuses to mix. We
  # bump to 16.0 — matches the upstream RLN's Swift Package target,
  # well above aws_lc_sys's floor, and broad enough to cover every
  # device the demo runs on. Override via env if you need older.
  IOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"

  build_target "aarch64-apple-ios"     "ios-arm64"           "export SDKROOT='$IOS_SDK' IPHONEOS_DEPLOYMENT_TARGET='$IOS_DEPLOYMENT_TARGET'"
  build_target "aarch64-apple-ios-sim" "ios-arm64-simulator" "export SDKROOT='$IOS_SIM_SDK' IPHONEOS_DEPLOYMENT_TARGET='$IOS_DEPLOYMENT_TARGET'"
  build_target "x86_64-apple-ios"      "ios-x64-simulator"   "export SDKROOT='$IOS_SIM_SDK' IPHONEOS_DEPLOYMENT_TARGET='$IOS_DEPLOYMENT_TARGET'"
fi

# Android — uses cargo-ndk to set NDK linker / sysroot env vars.
# Prereqs: rustup targets installed, cargo-ndk installed
# (`cargo install cargo-ndk`), ANDROID_NDK_HOME exported.
build_android_target() {
  local NDK_ABI="$1"        # e.g. arm64-v8a, armeabi-v7a, x86_64
  local RUST_TARGET="$2"    # cargo rustc target triple
  local DIR_NAME="$3"       # lib/<DIR_NAME>/

  echo ""
  echo "--- Building for $RUST_TARGET → $DIR_NAME (Android NDK ABI $NDK_ABI) ---"

  cd "$CFFI_DIR"
  cargo ndk -t "$NDK_ABI" rustc --release --lib --crate-type staticlib 2>&1 | tail -3
  mkdir -p "$OUT_DIR/$DIR_NAME"
  cp "target/$RUST_TARGET/release/librlncffi.a" "$OUT_DIR/$DIR_NAME/"

  # Use llvm-strip from the NDK; macOS `strip` corrupts ELF archives with a
  # "truncated or malformed archive" error at ld.lld link time.
  LLVM_STRIP="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip"
  [ -x "$LLVM_STRIP" ] && "$LLVM_STRIP" --strip-debug "$OUT_DIR/$DIR_NAME/librlncffi.a" 2>/dev/null || true
  SIZE=$(ls -lh "$OUT_DIR/$DIR_NAME/librlncffi.a" | awk '{print $5}')
  echo "✅ $DIR_NAME: $SIZE"
}

if [ "$MODE" = "android" ] || [ "$MODE" = "all" ]; then
  if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    echo "ERROR: ANDROID_NDK_HOME not set"
    echo "  e.g. export ANDROID_NDK_HOME=\$HOME/Library/Android/sdk/ndk/<version>"
    exit 1
  fi
  if ! command -v cargo-ndk >/dev/null 2>&1; then
    echo "ERROR: cargo-ndk not installed. Run: cargo install cargo-ndk"
    exit 1
  fi

  build_android_target "arm64-v8a"   "aarch64-linux-android"     "android-arm64"
  build_android_target "armeabi-v7a" "armv7-linux-androideabi"   "android-arm"
  build_android_target "x86_64"      "x86_64-linux-android"      "android-x64"
fi

echo ""
echo "=== Build complete ==="
ls -lhR "$OUT_DIR"
