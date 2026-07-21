#!/bin/bash
set -euo pipefail

# Build .bare native addon prebuilds. Mirrors rgb-lib-bare/scripts/build-prebuilds.sh.
#
# Usage:
#   bash scripts/build-prebuilds.sh           # all available targets
#   bash scripts/build-prebuilds.sh darwin-arm64
#
# Prereqs:
#   - npm install
#   - lib/<target>/librlncffi.a built (run scripts/build-cffi.sh first)
#   - CMake 3.25+

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PKG_DIR"

ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/27.1.12297006}"
ANDROID_TOOLCHAIN="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"
IOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"

build_target() {
  local TARGET_NAME="$1"
  local BUILD_DIR="build-prebuild-$TARGET_NAME"

  if [ ! -f "lib/$TARGET_NAME/librlncffi.a" ]; then
    echo "  ↷ skipping $TARGET_NAME (no static lib)"
    return 0
  fi

  echo ""
  echo "--- Building prebuild for $TARGET_NAME ---"

  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"

  CMAKE_ARGS=(
    -Dcmake-bare_DIR="$PKG_DIR/node_modules/cmake-bare"
    -Dcmake-npm_DIR="$PKG_DIR/node_modules/cmake-npm"
  )

  case "$TARGET_NAME" in
    ios-arm64)
      CMAKE_ARGS+=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_DEPLOYMENT_TARGET") ;;
    ios-arm64-simulator)
      CMAKE_ARGS+=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_DEPLOYMENT_TARGET") ;;
    ios-x64-simulator)
      CMAKE_ARGS+=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_DEPLOYMENT_TARGET") ;;
    darwin-arm64)
      CMAKE_ARGS+=(
        -DCMAKE_OSX_ARCHITECTURES=arm64
        -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
      ) ;;
    darwin-x64)
      CMAKE_ARGS+=(
        -DCMAKE_OSX_ARCHITECTURES=x86_64
        -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
      ) ;;
    android-arm64)
      CMAKE_ARGS+=(-DCMAKE_TOOLCHAIN_FILE="$ANDROID_TOOLCHAIN" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24) ;;
    android-arm)
      CMAKE_ARGS+=(-DCMAKE_TOOLCHAIN_FILE="$ANDROID_TOOLCHAIN" -DANDROID_ABI=armeabi-v7a -DANDROID_PLATFORM=android-24) ;;
    android-x64)
      CMAKE_ARGS+=(-DCMAKE_TOOLCHAIN_FILE="$ANDROID_TOOLCHAIN" -DANDROID_ABI=x86_64 -DANDROID_PLATFORM=android-24) ;;
    android-ia32)
      CMAKE_ARGS+=(-DCMAKE_TOOLCHAIN_FILE="$ANDROID_TOOLCHAIN" -DANDROID_ABI=x86 -DANDROID_PLATFORM=android-24) ;;
  esac

  cmake -B "$BUILD_DIR" -S . "${CMAKE_ARGS[@]}" 2>&1 | tail -5
  cmake --build "$BUILD_DIR" 2>&1 | tail -10

  BARE_FILE=$(find "$BUILD_DIR" -name "*.bare" -type f | head -1)

  if [ -z "$BARE_FILE" ]; then
    echo "  ✗ No .bare file produced for $TARGET_NAME"
    rm -rf "$BUILD_DIR"
    return 1
  fi

  mkdir -p "prebuilds/$TARGET_NAME"
  cp "$BARE_FILE" "prebuilds/$TARGET_NAME/utexo__rgb-lightning-node-bare.bare"

  SIZE=$(ls -lh "prebuilds/$TARGET_NAME/utexo__rgb-lightning-node-bare.bare" | awk '{print $5}')
  echo "  ✅ prebuilds/$TARGET_NAME/utexo__rgb-lightning-node-bare.bare ($SIZE)"

  rm -rf "$BUILD_DIR"
}

if [ $# -ge 1 ]; then
  build_target "$1"
else
  for target in darwin-arm64 darwin-x64 ios-arm64 ios-arm64-simulator ios-x64-simulator \
                android-arm64 android-arm android-x64 android-ia32; do
    build_target "$target"
  done
fi

echo ""
echo "=== Prebuilds complete ==="
ls -lhR prebuilds/ 2>/dev/null || true
