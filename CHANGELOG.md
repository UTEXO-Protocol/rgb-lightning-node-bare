# Changelog

All notable changes to `@utexo/rgb-lightning-node-bare` are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while pre-`1.0`.

## [Unreleased]

### Added
- `SdkNode.verifyMessage(message, signature)` with canonical Lightning
  zbase32 verification, including locked external-signer nodes.
- `rotateAddress()`, `listTransactionsByTxid()`, and
  `listTransfersByTxid()` wrappers required by WDK's read-only account.
- A release smoke test that loads the built Darwin addon and exercises node
  creation, external-signer initialization, and locked-state verification.

### Changed
- Tag-specific C-FFI overlays are optional; current RLN tags build directly
  from upstream when no overlay exists.
- CI and local package tests use the Bare runtime explicitly and reproducible
  `npm ci` installs.

### Fixed
- Replaced the nonexistent `cmake-bare-rebuild` package script with the
  repository's supported prebuild script.
- Release version commits now include `package-lock.json`.

## [0.1.0-beta.12] — 2026-06-01

### Added
- `sdkNodeVssBackup` wrapper — exposes upstream `vss_backup()`
  UniFFI method (uniffi_api/mod.rs:346). Returns `{ version }`
  of the snapshot just persisted; for app-controlled VSS flush
  checkpoints. Built against `rgb-lightning-node` v0.5.0-beta.1 +
  the refreshed C-FFI patch series at `patches/`.

### Fixed
- iOS cross-build: set `IPHONEOS_DEPLOYMENT_TARGET=16.0` in
  `scripts/build-cffi.sh`. v0.5.0-beta.1's rustls integration
  pulled in `aws_lc_sys` whose prebuilt object files target iOS
  26.5; Rust's `aarch64-apple-ios` defaults to iOS 10.0 and the
  linker refused to mix. 16.0 matches upstream RLN's Swift
  Package floor and unblocks all 3 iOS targets.

## [0.1.0-beta.11] — 2026-05-31

### Added
- `sdkNodeApayNew` wrapper — receiver-side async-payments registration
  against an LSP (upstream RLN PR #51). Built against
  `rgb-lightning-node` at SHA `0824529`.

## [0.1.0-beta.10] — 2026-05-28

### Added
- `sdkNodeVssClearFence` wrapper — forcibly takes over a stale VSS
  ownership fence after a previous node died holding it.

## [0.1.0-beta.9] — 2026-05-27

### Changed
- Rebuilt against `rgb-lightning-node` v0.4.3-beta.1.

### Added
- `vss_clear_fence` C-FFI surface.

## [0.1.0-beta.8] — 2026-05-26

### Added
- VSS cloud backup feature and APay receiver-side surface, built
  against `rgb-lightning-node` v0.4.0-beta.1.

## [0.1.0-beta.7] — 2026-05-25

### Added
- Locally cherry-picked PR #34 (openchannel race fix) into the C-FFI
  build until merged upstream.

## [0.1.0-beta.6] — 2026-05-25

### Fixed
- Postinstall script now derives `VERSION` from `package.json` instead
  of hardcoding it — fixes failed prebuild downloads after version bumps.

## [0.1.0-beta.5] — 2026-05-22

### Changed
- Rebuilt against the merged `feat/external-signer` branch of
  `rgb-lightning-node`.

## [0.1.0-beta.4] — 2026-05-14

### Added
- Postinstall now fetches prebuilds from GitHub Releases — removes
  the need to clone Rust toolchains on consumer machines.

## [0.1.0-beta.3] — 2026-05-13

### Added
- Android target prebuilds (arm64, arm, x64).

## [0.1.0-beta.2] — 2026-05-13

### Added
- Initial public beta: bare addon wrapping `rgb-lightning-node` C-FFI,
  built against `rmn-boiko/feat/external-signer` ~`6dbeebc` with RGB
  channel support.
