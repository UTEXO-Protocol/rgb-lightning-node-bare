# Changelog

All notable changes to `@utexo/rgb-lightning-node-bare` are documented
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while pre-`1.0`.

## [Unreleased]

### Changed
- Upstream `rgb-lightning-node` reference moved from SHA `0824529`
  (rmn-boiko fork tip) to the official tag
  [`v0.5.0-beta.1`](https://github.com/UTEXO-Protocol/rgb-lightning-node/releases/tag/v0.5.0-beta.1).
  The two trees are byte-identical
  (`2a31b8a97c64334aa5e30385e079b18a08f805a1`) — pre-built beta.11
  artifacts from the SHA pin are functionally equivalent to a fresh
  build from the tag. The next bare cut should record the tag as the
  upstream reference.

### Added
- `patches/` directory containing the C-FFI wrapper patches we apply
  on top of `rgb-lightning-node` (`apay_new` + `vss_clear_fence`
  wrappers — not yet upstream). See `patches/README.md` for the
  rationale and apply instructions.

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
