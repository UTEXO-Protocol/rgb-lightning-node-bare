# @utexo/rgb-lightning-node-bare

Release-based Bare bindings for RLN **0.15.0-beta.3 plus merged PR #192**,
commit `a17b685615750536f0320db1cd3f3ba68a8f1c57`. Candidate **0.2.0-beta.3**;
not approved for production rollout. See [RELEASE-0.15-TRACKER.md](./RELEASE-0.15-TRACKER.md).

## Installation Contract

Installation first verifies packed prebuilds against source, submodule, adapter,
wrapper and artifact hashes. Matching prebuilds need no Rust toolchain. Otherwise
it builds the exact source identities in `package.json`; no stale binary is
substituted. Publication requires all seven release prebuilds. This candidate is
not published and is not fully qualified.

Source builds need access to three private upstream BFA repositories even when
BFA is unused. Authorized CI uses `ORG_READ_TOKEN` through
`node scripts/with-source-access.js npm run prepare-native`; credentials are
restricted to those repositories and are not embedded in artifacts. Anonymous
clean installs and redistribution approval remain publication gates.

Source building requires Node 20+, Git, Rust 1.94.0, CMake 3.25+, a C/C++ toolchain, Xcode for Apple
targets and Android NDK 27.1.12297006 for Android. Header package 1.30.0 is locked;
desktop canaries run Bare 1.30.3. Header equality, required symbols, source graph,
wrapper fingerprint and artifact checksums are verified.

```sh
npm install @utexo/rgb-lightning-node-bare@0.2.0-beta.3
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
The complete WDK dependency graph requires Bare >=1.33.0 with current dependency
resolution. RLN 0.15 funded WDK tests run on Bare 1.33.0. Earlier simulator and
emulator results in `UPGRADE-TRACKER.md` used RLN 0.13; they do not qualify these
new native artifacts or physical devices.

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
Both external-signer unlock entrypoints accept optional `eth_rpc_url` for BFA
bridge-event validation. Use the Ethereum RPC for the asset's bridge chain;
omitted/null preserve non-BFA behavior. The source installer fetches the exact
merge commit, not a floating branch or the older release binary. The runtime
advertises `external-signer-eth-rpc-v1`. External-signer burn remains unsupported.

`refreshTransfers({ skip_sync })` returns per-batch status/failure details.
`listTransfers(assetId?, txid?)` supports asset-less and combined queries.
Unspents expose `utxo.exists`; do not treat missing outputs as spendable.

Native response integers outside JavaScript's safe range are exact decimal
strings; safe integers remain numbers. This preserves released node limits and
64-bit channel IDs. Unsafe numeric inputs, NaN and infinity still fail before
native calls. Full-range u64 request inputs are not supported.

## Excluded Capabilities and Migration

Contract and transfer-consignment metadata imports are released in RLN 0.15
(PR #128). They grant no balance and do not bypass native receive/settlement.
There is no import backport; see `patches/README.md`.

`getConsignment(assetId, txid)` returns `{ bytes_hex }` from a locally saved
transfer, and `getConsignmentPath(assetId, txid)` returns `{ path }`. Missing
assets/transfers propagate native errors. Do not expose sandbox paths to dApps.
WDK exposes `Uint8Array` bytes instead and no filesystem path API.

Snapshot/sync overlays, prepared-send/UTXO plans, native operation
control and VSS namespace deletion are unavailable. Existing named stubs throw
`ERR_RLN_UNSUPPORTED_CAPABILITY` before native access. Routing fee caps are not
enforced by this RLN release and are rejected before payment submission.

The deployment owner confirmed no live wallets; this candidate is fresh-wallet
only and promises no legacy migration compatibility. Do not delete/recreate state
to bypass refusal or restore stale channel backups after new activity.

Real local transfers and diagnostic Lightning/APay flows are recorded in
`RELEASE-0.15-TRACKER.md`. Strict outgoing signing and same-process reopen remain
blockers. VSS is excluded from this qualification. Historical artifacts for all
declared targets do not qualify this release. Mobile runtime and adverse recovery
qualification remain separate.

Android consumers must use the public [Android staging integration](./android/README.md)
with `react-native-bare-kit@0.15.5` and NDK `27.1.12297006`. Its Gradle hook
verifies and packages the original RLN addon byte-for-byte after `bare-link`,
preserving RELRO/DYNAMIC/GOT protection and 16-KiB layout. Installing the npm
package alone does not apply the hook. It supports ARM64, ARMv7 and x86-64,
with one JS-loaded RLN version and no incoming native RLN dependency.

The generic `bare-link@3.3.2` / `bare-lief@0.2.9` or `0.2.10` rewrite still
misaligns RELRO and moves DYNAMIC outside it. The staging integration avoids
that rewrite for RLN; it does not fix the upstream linker or relax its checks.

Validate the final linked library as well as the prebuild, with NDK
`llvm-readobj` on PATH or supplied via `LLVM_READOBJ`:

```sh
node scripts/check-android-linked.js android-arm64 /absolute/path/to/linked.so
```

Use `android-x64` for x86_64. Run this after Bare Kit linking and check extracted
APK libraries too; `zipalign -c -P 16` alone cannot detect this ELF defect. The
candidate-artifact workflow uses the same verified staging path and fails closed.
Do not disable RELRO, weaken validation, or describe a compile-only artifact as
a mobile runtime pass. Apps with their own staging must replace that hook when
adopting this one, not apply both. See the [release tracker](./RELEASE-0.15-TRACKER.md)
for current evidence and historical raw-link CI failures.
The current overlay-dependent app must not be repinned blindly.
