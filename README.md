# @utexo/rgb-lightning-node-bare

Bare native addon wrapping [`rgb-lightning-node`](https://github.com/UTEXO-Protocol/rgb-lightning-node)'s
C-FFI for use inside [Bare](https://github.com/holepunchto/bare-runtime)
worklets — both standalone (server / desktop) and embedded
(`react-native-bare-kit` on iOS / Android).

Mirrors the
[`@utexo/rgb-lib-bare`](https://github.com/UTEXO-Protocol/rgb-lib-bare)
pattern 1:1.

> Status: **canary**. Currently exposes only the lifecycle smoke-test
> slice (`uniffiHealthcheck`, `uniffiIsInitialized`, `sdkNodeNew/init/
> unlock/shutdown`, `nodeInfo`). Full `SdkNode` surface still to wire up.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  JS (worklet)                                           │
│    require('@utexo/rgb-lightning-node-bare')            │
│       → SdkNode.create(...).init(...).unlock(...)       │
└──────────────────────────┬──────────────────────────────┘
                           │ require-addon
┌──────────────────────────▼──────────────────────────────┐
│  binding.cc  (Bare C++ shim, <bare.h> + <js.h>)         │
└──────────────────────────┬──────────────────────────────┘
                           │ extern "C"
┌──────────────────────────▼──────────────────────────────┐
│  librlncffi.a (Rust C-FFI from rgb-lightning-node       │
│                bindings/c-ffi, PR #25)                  │
│    → wraps SdkNode (UniFFI surface)                     │
│      → block_on_sdk(...) over a static tokio runtime    │
│        → LDK + rgb-lib + electrum                       │
└─────────────────────────────────────────────────────────┘
```

## Build

```sh
# 1. Build the Rust C-FFI static lib
bash scripts/build-cffi.sh darwin     # darwin-arm64 host build
bash scripts/build-cffi.sh ios        # ios-arm64 + sim triples

# 2. Build the .bare addon prebuild
bash scripts/build-prebuilds.sh darwin-arm64
bash scripts/build-prebuilds.sh ios-arm64-simulator

# 3. Smoke test (darwin)
bare test.js
```

The Rust step requires `rgb-lightning-node/bindings/c-ffi/` checked
out next to this package by default; override with `CFFI_DIR=...`.

The `--lib --crate-type staticlib` flags are required when invoking
`cargo rustc` for iOS — see scripts/build-cffi.sh for context.

## Distribution

Pre-built static libs and `.bare` modules are not committed to git
(too large, GitHub limits files to 100 MB). They ship via GitHub
Releases — the same approach `@utexo/rgb-lib-bare` uses.

## License

MIT
