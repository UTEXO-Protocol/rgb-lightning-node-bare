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
desktop canary passed on 1.32.0. That does not qualify a mobile embedded runtime.

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

JSON integer values beyond JavaScript's safe integer range fail explicitly.
There is no claim of lossless full-u64 numeric JSON support.

## Excluded Capabilities and Migration

Snapshot/sync overlays, prepared-send/UTXO plans, imports, native operation
control and VSS namespace deletion are unavailable. Existing named stubs throw
`ERR_RLN_UNSUPPORTED_CAPABILITY` before native access. Routing fee caps are not
enforced by this RLN release and are rejected before payment submission.

Existing colored channels and pre-scrypt password-wallet mnemonic records have
known release compatibility gates. Do not delete/recreate state, bypass refusal,
or restore stale channel backups after new activity. Use the approved migration
procedure only after exact old-artifact fixtures have passed; that gate is open.

Native mobile runtime, network, migration, VSS-failure and signed APay roundtrip
qualification remain explicit release gates. The app's current overlay-dependent
runtime is not compatible with this candidate and must not be repinned blindly.
