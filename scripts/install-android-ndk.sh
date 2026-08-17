#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NDK_VERSION="$(node -p "require('${REPO_ROOT}/package.json').utexoNativeOverlay.androidNdkVersion")"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ -z "$SDK_ROOT" ]]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [[ -d "$candidate" ]]; then
      SDK_ROOT="$candidate"
      break
    fi
  done
fi

if [[ -z "$SDK_ROOT" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME must identify the Android SDK" >&2
  exit 1
fi

if command -v sdkmanager >/dev/null 2>&1; then
  SDKMANAGER="$(command -v sdkmanager)"
else
  SDKMANAGER="$(find "$SDK_ROOT/cmdline-tools" -type f -path '*/bin/sdkmanager' | sort | tail -n 1)"
fi

if [[ -z "${SDKMANAGER:-}" || ! -x "$SDKMANAGER" ]]; then
  echo "sdkmanager was not found under $SDK_ROOT" >&2
  exit 1
fi

NDK_ROOT="$SDK_ROOT/ndk/$NDK_VERSION"
SOURCE_PROPERTIES="$NDK_ROOT/source.properties"

if [[ ! -f "$SOURCE_PROPERTIES" ]]; then
  "$SDKMANAGER" --sdk_root="$SDK_ROOT" --install "ndk;$NDK_VERSION" >&2
fi

if [[ ! -f "$SOURCE_PROPERTIES" ]]; then
  echo "Android NDK $NDK_VERSION was not installed at $NDK_ROOT" >&2
  exit 1
fi

INSTALLED_VERSION="$(sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "$SOURCE_PROPERTIES" | head -n 1 | tr -d '\r')"
if [[ "$INSTALLED_VERSION" != "$NDK_VERSION" ]]; then
  echo "Android NDK contract mismatch: expected $NDK_VERSION, found $INSTALLED_VERSION" >&2
  exit 1
fi

printf '%s\n' "$NDK_ROOT"
