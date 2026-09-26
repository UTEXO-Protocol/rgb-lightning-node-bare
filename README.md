# @utexo/rgb-lightning-node-bare

Release-based Bare bindings for RLN **0.13.0-beta.3**. Candidate **0.2.0-beta.1**;
not approved for migration or production rollout. See [UPGRADE-TRACKER.md](./UPGRADE-TRACKER.md).

## Installation Contract

Installation builds native artifacts from the exact source, submodule and adapter
identities in `package.json`. This is **not a no-Rust prebuilt installation**.
Requires Node 20+, Git, Rust 1.94.0, CMake 3.25+, a C/C++ toolchain, Xcode for Apple
targets and Android NDK 27.1.12297006 for Android. Header package 1.30.0 is locked;
desktop canaries run Bare 1.30.3. Header equality, required symbols, source graph,
wrapper fingerprint and artifact checksums are verified.

```sh
npm install @utexo/rgb-lightning-node-bare@0.2.0-beta.1
# Explicit desktop qualification:
RLN_BARE_TARGETS=darwin-arm64 npm run prepare-native
# Select a mobile family:
npm run prepare-native -- --platform ios
```

Default macOS builds Apple targets; Linux selects Android. Supported matrix:
darwin-arm64, ios-arm64, ios-arm64-simulator, ios-x64-simulator,
android-arm64, android-arm and android-x64. macOS x64 is not a released target.
An unavailable target fails; no older binary is substituted.

`RLN_BARE_JS_ONLY_INSTALL=1` is for JS-only tooling only (see the
installer's exact environment contract). It does not supply a working wallet.
`RLN_BARE_DEBUG=1` creates a debug-only qualification artifact with a distinct
provenance identity. Candidate artifact workflows never publish or mutate tags.

Keep Cargo target caches separate from Node and other source checkouts. A reused
Node target caused Rust type/trait mismatches; the identical source passed with
an isolated Bare target. Prefer the default source-local target directory.
The complete WDK dependency graph separately requires Bare >=1.32.0; its packed
desktop canary passed on 1.32.0. The separately tested Expo 56 / RN 0.85.3 /
Bare Kit 0.14.5 bundle reports embedded Bare 1.29.4; it passed iOS arm64 simulator
and Android arm64 4-KiB emulator checks. This does not lower the standalone CLI
floor or qualify physical devices.

## Runtime

`getRuntimeInfo()` reads compiled provenance and capabilities, checked against
the package's generated `runtime-contract.json`. Rebuild after source changes:

```sh
node scripts/runtime-contract.js
npm run prepare-native
npm test
```

Use `NativeExternalSigner.createWithStorage(seedHex, network, storageDir, false)`.
Strict signing is the default. Persist the private signer directory together with
the node state; seed-only or VSS-only recovery is not complete open-channel recovery.

Unlock uses `ldk_chain_sync: { mode: 'TransactionSync', config: { indexer_url } }`
or `{ mode: 'BlockSync', config: { bitcoind_rpc_username,
bitcoind_rpc_password, bitcoind_rpc_host, bitcoind_rpc_port } }`.
The top-level `indexer_url` is independently available for RGB. External-signer
unlock does not accept password or gossip configuration.

`refreshTransfers({ skip_sync })` returns per-batch status/failure details.
`listTransfers(assetId?, txid?)` supports asset-less and combined queries.
Unspents expose `utxo.exists`; do not treat missing outputs as spendable.

Native response integers outside JavaScript's safe range are exact decimal
strings; safe integers remain numbers. This preserves released node limits and
64-bit channel IDs. Unsafe numeric inputs, NaN and infinity still fail before
native calls. Full-range u64 request inputs are not supported.

## Excluded Capabilities and Migration

Snapshot/sync overlays, prepared-send/UTXO plans, imports, native operation
control and VSS namespace deletion are unavailable. Existing named stubs throw
`ERR_RLN_UNSUPPORTED_CAPABILITY` before native access. Routing fee caps are not
enforced by this RLN release and are rejected before payment submission.

The deployment owner confirmed no live wallets; this candidate is fresh-wallet
only and promises no legacy migration compatibility. Do not delete/recreate state
to bypass refusal or restore stale channel backups after new activity.

Real local transfers and diagnostic Lightning/APay flows are recorded in
`UPGRADE-TRACKER.md`. Strict outgoing signing and same-process reopen remain
blockers. VSS is excluded from this qualification. All declared targets build;
mobile runtime and adverse recovery qualification remain separate. Android 64-bit
artifacts are checked for 16 KiB LOAD/RELRO alignment. The input check alone is
insufficient: bare-link 3.3.0 with bare-lief 0.2.5 or 0.2.8 shifts the linked
Android library's RELRO end by 4 KiB. A 16-KiB arm64 emulator crashes at native
import; the 4-KiB emulator passes. Android 16-KiB release remains blocked.

Validate the final linked library as well as the prebuild, with NDK
`llvm-readobj` on PATH or supplied via `LLVM_READOBJ`:

```sh
node scripts/check-android-linked.js android-arm64 /absolute/path/to/linked.so
```

Use `android-x64` for x86_64. Run this after Bare Kit linking and check extracted
APK libraries too; `zipalign -c -P 16` alone cannot detect this ELF defect. The
candidate-artifact workflow now fails closed on the post-link check. Do not
disable RELRO, weaken validation, or describe a compile-only artifact as a mobile
runtime pass. See the linked WDK qualification report for exact reproduction.
The current overlay-dependent app must not be repinned blindly.
