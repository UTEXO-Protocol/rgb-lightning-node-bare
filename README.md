# @utexo/rgb-lightning-node-bare

Release-based Bare bindings for RLN **0.17.0-beta.3**,
commit `ecc69f20308231400561f6f060fea88acfa40cc4`. Candidate **0.2.0-beta.5**;
not approved for production rollout. Includes an explicitly hashed native
signer/session lifecycle repair. See [NATIVE-UPGRADE-20261015.md](./NATIVE-UPGRADE-20261015.md)
for current qualification and [RELEASE-0.15-TRACKER.md](./RELEASE-0.15-TRACKER.md)
for historical restrictions.

## VSS availability

VSS backup is enabled. Set `vss_url` to an HTTPS service such as
`https://vss-server.utexo.com/vss`, then initialize and unlock the wallet normally.
Use `vssBackup()` for an explicit checkpoint and `vssBackupInfo()` for actual
remote snapshot status. Omitting the URL or passing `null` keeps local-only
operation. See [VSS-SAFETY.md](./VSS-SAFETY.md) for configuration, explicit fence
recovery, status semantics and the upstream external-signer credential boundary.

## Installation Contract

The published wrapper contains the Darwin addon and requires three exact-version
`0.2.0-beta.5` data packages on every host:

| Required package | Native targets |
| --- | --- |
| `@utexo/rgb-lightning-node-bare-ios` | `ios-arm64`, `ios-arm64-simulator`, `ios-x64-simulator` |
| `@utexo/rgb-lightning-node-bare-android-arm` | `android-arm`, `android-arm64` |
| `@utexo/rgb-lightning-node-bare-android-x64` | `android-x64` |

The data packages have no lifecycle scripts, executable entry points, dependencies
or host filters. This partition reduces each new upload below 128 MiB. The
already-published iOS package remains byte-for-byte identical; all seven original
native files, compiled fingerprints and build provenance remain unchanged.

Postinstall validates every package identity, manifest, runtime contract and native
hash before copying any payload. It restores the six canonical mobile
`prebuilds/<target>` paths and verifies all seven targets on every host, including
installations that omit optional dependencies. Missing or inconsistent payloads
fail installation without a source-build fallback. No Rust toolchain is needed
for these packed artifacts.
If lifecycle scripts were skipped, complete assembly explicitly before bundling
or using the package:

```sh
npm --prefix node_modules/@utexo/rgb-lightning-node-bare run hydrate-native
```

`RLN_BARE_JS_ONLY_INSTALL=1` remains an explicit tooling-only opt-out and does not
provide a qualified wallet runtime. Source builds use the separate, existing
`prepare-native` command. Publication requires all seven verified release files
and all three matching staged data payloads; this candidate is not approved for production
rollout.

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
npm install @utexo/rgb-lightning-node-bare@0.2.0-beta.5
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
advertises `external-signer-eth-rpc-v1` and `external-signer-burn-v1`.

`burn({ asset_id, amount, burn_recipient?, fee_rate, min_confirmations })`
(also named `burnAsset`) returns `{ txid, batch_transfer_idx }`.
`burn_recipient` is optional/null for non-BFA assets and required for BFA:
exactly 32 bytes encoded as 64 hex characters without a `0x` prefix.
Burn amount and fee rate accept safe integer numbers or exact decimal strings;
both become native u64 JSON numbers. Confirmation count must fit u8.
Signing, validation and transaction submission use merged RLN, not an overlay.

`refreshTransfers({ skip_sync })` returns per-batch status/failure details.
`listTransfers(assetId?, txid?)` supports asset-less and combined queries.
Unspents expose `utxo.exists`; do not treat missing outputs as spendable.

Native response integers outside JavaScript's safe range are exact decimal
strings; safe integers remain numbers. This preserves released node limits and
64-bit channel IDs. Unsafe numeric inputs, NaN and infinity still fail before
native calls. Full-range u64 request inputs are supported only by the typed
burn boundary; other request methods retain their existing number-only contract.

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
blockers. VSS qualification is recorded separately in `VSS-SAFETY.md`. Historical artifacts for all
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

## Maintaining the split distribution

The repository uses `native/ios`, `native/android-arm` and `native/android-x64`
npm workspaces so `npm ci --ignore-scripts` installs a source checkout before new
companion versions exist on npm. The lockfile links these local data workspaces;
the published wrapper requires the exact registry versions. No `file:` dependency
is published.

After preparing or importing all seven original release artifacts, stage and
verify every payload, then pack all four packages with Node 22.23.3/npm 12.0.1
(the qualified beta.5 packing toolchain). Public source and native files use
their canonical Git/archive modes; keep the generated overlay manifest at its
recorded mode:

```sh
umask 022
npm ci --ignore-scripts
npm run prepare-native -- --platform all
npm run stage:payloads
npm run check:distribution
mkdir -p /tmp/bare-pack
npm pack --workspace native/ios --workspace native/android-arm --workspace native/android-x64 --json --ignore-scripts --pack-destination /tmp/bare-pack
npm pack --workspaces=false --json --ignore-scripts --pack-destination /tmp/bare-pack
python3 scripts/verify-distribution-archives.py /tmp/bare-pack/utexo-rgb-lightning-node-bare-0.2.0-beta.5.tgz /tmp/bare-pack/utexo-rgb-lightning-node-bare-ios-0.2.0-beta.5.tgz /tmp/bare-pack/utexo-rgb-lightning-node-bare-android-arm-0.2.0-beta.5.tgz /tmp/bare-pack/utexo-rgb-lightning-node-bare-android-x64-0.2.0-beta.5.tgz
```

`stage:ios-payload` remains an iOS-only compatibility command; it does not prepare
the Android workspaces. The archive gate checks exact wrapper/source inventory
and permissions, required exact dependencies, data-only payloads, unchanged
native fingerprints and one assignment of each of the seven native targets.
The wrapper and Android archives remain bounded to 128 MiB. iOS has a separate
reviewed, version-specific archive checksum and size: beta.5 is 143,638,135 bytes,
below the previous 146,197,231-byte iOS ceiling. Unknown versions and changed
archive bytes fail admission.

The immutable published beta.4 iOS archive retains its exact legacy checksum
and source identity. Beta.5 does not reuse or overwrite that npm version.
All three beta.5 data companions must be published and independently verified
before the beta.5 wrapper. Each publication needs separate package-source,
artifact and builder provenance verification. Native compilation keeps its
original identity; package versioning is not a native rebuild. Preparation and
candidate-artifact workflows do not publish or authorize publication.

## Bitcoin message signing

Use `getMessageSigningAddress()`, `signMessageBip322(message, address)` and the offline `verifyMessageBip322(message, address, signature, network)` for BIP-322 simple address proofs. The first version signs the canonical first vanilla Taproot address with the native external signer; it preserves exact UTF-8 and emits a `smp` prefix. It does not replace the existing Lightning node-identity signing API. See [BIP322.md](./BIP322.md) for supported forms, limits, custody and verification.
