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

  build_target "aarch64-apple-ios"     "ios-arm64"           "export SDKROOT='$IOS_SDK'"
  build_target "aarch64-apple-ios-sim" "ios-arm64-simulator" "export SDKROOT='$IOS_SIM_SDK'"
  build_target "x86_64-apple-ios"      "ios-x64-simulator"   "export SDKROOT='$IOS_SIM_SDK'"
fi

echo ""
echo "=== Build complete ==="
ls -lhR "$OUT_DIR"
