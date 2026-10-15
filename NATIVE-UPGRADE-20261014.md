# Native upgrade: October 14, 2026

Historical artifact/source checkpoint. The current signer/session lifecycle
overlay and its qualification are tracked in
[NATIVE-UPGRADE-20261015.md](NATIVE-UPGRADE-20261015.md).

Candidate `0.2.0-beta.4` targets published RLN SDK `v0.17.0-beta.3`.
The existing `release/rln-0.15.0-beta.3` branch retains its review history.
The candidate has not been merged, tagged or published to npm or a GitHub release.

## Exact source identity

- RLN: `ecc69f20308231400561f6f060fea88acfa40cc4`, version `0.17.0-beta.3`
- LDK: `79b9eb5166546c62692d3a672986f385c7fe047d`
- rgb-lib: `v0.3.0-beta.50-bfa`, `1b951af0c8233308c919975552487be19ad2a930`
- Shared adapter SHA-256: `bbec56a1ef9c05feb9d50a9edab556837be872f482bf1183493a4f449f45275d`
- C-FFI lock SHA-256: `5fcdc9ad9179d3230e48973cdfa514a863d13a837752027febf8ea04713bbeb5`
- Bare wrapper SHA-256: `36ae181f6feb775e93848125334e92dbfad7ddbdc0643667ea1f5e8a0e429651`
- Bare recipe SHA-256: `bcc14b617ba4ac0818dcf8c496bacc27ca35bdf3c20ca840d04c9d82b57c62b7`
- Node wrapper SHA-256: `3647ddc882ff0e04133f69d14123f2dba3c111ca31d47ffc4946a4bf402ef30d`
- Node recipe SHA-256: `07c989d17d2bf6be5cbb6d9e491937316dd67a68dd09aafa755aa91dc4ec7a84`
- Node lock SHA-256: `de8eedbec81519cafbdf02c3445654d31ec6fbda8181be42f5926dcaf7911108`
- Rust: `1.94.0`; Apple deployment targets macOS 13.0/iOS 16.0; Android NDK `27.1.12297006`, API 29

Both adapters contain identical bytes and change only the eight allowlisted
C-FFI files. Every other reviewed Git dependency revision is retained. The SDK
version is now reported honestly. No new Lightning entrypoints are exposed;
Iris continues to enforce its on-chain-only profile.

## Qualification

Both source and locked Git graphs and declarations are verified. Bare's 56 and
Node's 29 unit checks pass locally. The final seven-target Bare matrix passed
and the complete imported release-artifact gate passes. Final Node optimized
platform qualification also passes all five targets and its complete artifact
gate, against the Node identities above. The Node candidate report records its
separate source/artifact origins and actual runtime versions.
Historical 0.15/0.16 binaries and tests are not evidence for this source.

All seven Bare targets must pass checksum, archive/addon symbol and provenance
gates. Android keeps byte-preserving staging, RELRO/DYNAMIC/GOT, Rust TLS lifetime
and 64-bit 16-KiB checks. All five Node targets must pass optimized native load,
identity/lifecycle/error canaries and ten Rust adapter tests on actual runtimes.
Missing or stale artifacts cannot substitute for the new source.

Known signer reopen, pending witness accounting, crash reservation, native
dependency security review, physical-device and funded/mobile qualification
gates remain open until fresh tests resolve them. Artifact matrices do not
constitute production approval. See the historical tracker and WDK production
gate report for reproductions.

## macOS 27 build compatibility

An initial clean host build reproduced Rust's [proc-macro stripping defect](https://github.com/rust-lang/rust/issues/157750): dyld rejects an unaligned LINKEDIT string pool. The release and development build-override profiles now set `strip = "none"` for compile-time dependencies in the C-FFI manifest and Node wrapper. Shipped target optimization and stripping remain unchanged. No caller environment flag is required. The failed trace remains local evidence, and qualification is repeated against these final identities.

Bare recipe provenance now binds the source-build orchestration and C-FFI/CMake shell scripts rather than only the CMake script. Node sidecars additionally bind `buildRecipeSha256` to its installer/build orchestration. This rejects artifacts built under older build recipes. No previous artifact is restamped as a pass.

Fresh cargo-audit reports ten lockfile vulnerabilities: five Quinn findings, rkyv, rsa and three legacy webpki findings. Quinn/rkyv/rsa are absent from the selected normal/build graph on all targets. Legacy webpki is active through minreq/rustls0.21 and remains a release security gate; no incompatible dependency version is forced into upstream runtime code.

## Final Bare artifact qualification

The [seven-target build-only matrix](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/actions/runs/38536155379) passed against implementation
`796632c61d9cb43741ef55c36a3b8f1091ec42f7`. All six mobile archives and addons
were downloaded, verified and centralized with their original hashes and
provenance. The original local Darwin arm64 output is preserved; it passed
actual macOS 27 native canaries. The full seven-target release gate passes.
Android hosted byte-preserving staging and 64-bit ELF protection gates pass.
The mobile targets are compiled/packaged qualification, not device execution.

Public source/artifact origin and hash evidence is in the shared workspace's
`release-evidence/2026-10-14/native-bare-artifact-origins.json`.
The verified directory is the Bare checkout; consumers can import it with
`RLN_BARE_ARTIFACTS_DIR` without private source access or a source rebuild.
Normal source builds require `$HOME/.cargo/bin` on PATH so pinned Cargo helper
executables can be probed; no caller-specific compiler strip workaround is
needed. The old unqualified Node final-strip result is not part of this gate.

## Current funded Bare boundaries

The stable Bare host artifact (`4f373f0`), wrapper (`36ae181`), recipe (`bcc14b6`)
and adapter (`bbec56a`) are unchanged across these isolated regtest scenarios.
Passing cases cover twelve external-unlock controls, fourteen asset checks,
eleven BFA burn steps, seven address-policy checks, six cold-copy checks, eight
BTC reorg checks, the three-delay default interruption fixture's eight checks,
and nine disk-full checks. Independent exact beta50 burn proof validation also
passes. Passing these scenarios does not establish broader recovery safety.

Five distinct functional gates remain failed: unlocked same-process signer
reopen (P01), widened crash interruption (P02), RGB reorg recovery (P03), pending
witness balance double counting (P04), and event ordering (P06).
The clean seven-delay interruption fixture passes its zero-ms case but at ten
ms restores zero instead of 2,000,000; it definitively reproduces P02.
Node's final widened seven-delay pass does not close this Bare failure.

Earlier failed attempts remain diagnostic evidence: a default 100-ms attempt
overlapped npm peer installation, an initial widened attempt failed a funding
sync precondition, and the initial burn fixture mismatch failed before burn
submission. They are preserved rather than relabeled as passes.
See `release-evidence/2026-10-14/onchain-test-index.json` for original attempts
and the WDK production gate report for current scenario boundaries.
The five functional gates, active native TLS advisories and physical-device
qualification remain open. No publication or production approval follows.
