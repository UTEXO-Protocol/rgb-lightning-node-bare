# @utexo/rgb-lightning-node-bare

[Bare]-runtime native addon for [`rgb-lightning-node`][rgb-lightning-node]
(RLN) — the Lightning + RGB daemon built on LDK and [`rgb-lib`][rgb-lib].
This package wraps RLN's C FFI in a `.bare` addon so the daemon can run
**inside a Bare worklet** alongside the rest of the [Tether WDK] chain
modules.

It is the mobile/worklet counterpart to
[`@utexo/rgb-lightning-node-nodejs`][rgb-lightning-node-nodejs]: the same
underlying Rust C-FFI (`librlncffi.a`) and the same `SdkNode` +
`NativeExternalSigner` JavaScript surface, so the WDK layer
([`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning]) is identical across
runtimes. It mirrors the [`@utexo/rgb-lib-bare`][rgb-lib-bare] build and
release pattern (`cmake-bare` + static linking, prebuilds via GitHub
Releases).

> Status: pre-1.0 beta. The API surface is stable across the 0.1.0-beta
> line; native artifacts are distributed per release tag.

## Contents

- [Why Bare](#why-bare)
- [Platform support](#platform-support)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [API surface](#api-surface)
- [Seed handling](#seed-handling)
- [Architecture](#architecture)
- [Build and release (maintainers)](#build-and-release-maintainers)
- [License](#license)

## Why Bare

The Node.js sibling covers desktop and server. This package exists for one
specific consumer: [`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning] running
inside the [Tether WDK], which executes its chain-specific wallet logic in
a [Bare] worklet — a sandboxed JS runtime hosted via
[react-native-bare-kit] on mobile or as a subprocess on desktop.

For RGB-over-Lightning to join WDK, RLN's daemon must be callable from
inside that worklet, which means:

- The native code **links statically** into a single `.bare` addon. Bare
  worklets can't `dlopen` shared libraries the way Node can, and iOS App
  Store policy forbids dynamic linking regardless.
- The JS API has the **same shape** as the Node sibling, so the WDK package
  writes one runtime-agnostic code path and selects the binding at
  module-load time.

Consumers don't import this package directly — they depend on
`@utexo/wdk-rgb-lightning`, which loads this addon when it detects the Bare
runtime.

## Platform support

Per-target static libs (`librlncffi.a`) and `.bare` prebuilds are attached
to this repo's GitHub Releases; `postinstall` downloads the matching
artifacts, and `cmake-bare` resolves the right one at load time.

| Platform           | Target                       | Linking |
|--------------------|------------------------------|---------|
| macOS arm64        | `aarch64-apple-darwin`       | Static  |
| iOS arm64          | `aarch64-apple-ios`          | Static  |
| iOS arm64 sim      | `aarch64-apple-ios-sim`      | Static  |
| iOS x64 sim        | `x86_64-apple-ios`           | Static  |
| Android arm64      | `aarch64-linux-android`      | Static  |
| Android armv7      | `armv7-linux-androideabi`    | Static  |
| Android x64        | `x86_64-linux-android`       | Static  |

Static linking is mandatory on iOS and yields a single self-contained
`.bare` addon on Android and macOS.

## Requirements

- Node.js >= 18 (for `cmake-bare` and the postinstall script)
- [Bare] runtime (to actually load and run the addon)

## Installation

```sh
npm install @utexo/rgb-lightning-node-bare
```

The `postinstall` (`scripts/download-libs.sh`) downloads the matching
static libs and `.bare` prebuilds from the GitHub Release for the installed
version — no Rust toolchain or cross-compiler needed on the consumer
machine.

You don't normally depend on this package directly — it's an optional peer
dependency of [`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning]. Install it
explicitly only when building something that runs inside a Bare worklet and
calls RLN without the WDK layer.

## Usage

The addon exposes two classes (`SdkNode`, `NativeExternalSigner`) plus
module-level helpers. Requests and responses are plain JavaScript objects;
JSON marshalling to/from the C-FFI happens at this layer.

The example below uses the **external-signer** lifecycle — the mode the WDK
ships with, where the host owns the seed.

```js
const rln = require('@utexo/rgb-lightning-node-bare')

// 1. Module-level init (idempotent; sets up the process-global tokio runtime).
rln.sdkInitialize({})

// 2. Create the node handle (does not open the network yet).
const node = rln.SdkNode.create({
  storage_dir_path: '/path/to/persistent/dir',
  daemon_listening_port: 0,
  ldk_peer_listening_port: 0,
  network: 'regtest',
  max_media_upload_size_mb: 5,
  enable_virtual_channels_v0: false
})

// 3. Build the in-process VLS signer from a host-owned 32-byte seed (64-char hex).
const signer = rln.NativeExternalSigner.create(seedHex, 'regtest')

// 4. First-launch init writes the key-source file to storage_dir_path.
//    On every subsequent launch RLN throws Rln(Conflict) — swallow it.
try {
  node.initWithNativeExternalSigner(signer)
} catch (e) {
  if (!String(e.message).includes('Conflict')) throw e
}

// 5. Bring the node online.
node.unlockWithNativeExternalSigner(signer, {
  bitcoind_rpc_username: 'user',
  bitcoind_rpc_password: 'pass',
  bitcoind_rpc_host: '127.0.0.1',
  bitcoind_rpc_port: 18443,
  indexer_url: 'tcp://localhost:50001',
  proxy_endpoint: 'rpc://localhost:3000/json-rpc',
  announce_addresses: [],
  announce_alias: 'my-node'
})

console.log(node.nodeInfo().pubkey)

// ...later
node.shutdown()
```

The addon also supports a **password / mnemonic** mode where RLN owns the
seed and encrypts it on disk (`node.init(password, mnemonic?)` then
`node.unlock({ ...rpcArgs, password })`). The WDK does not use this mode;
see [`index.js`](./index.js) for the contract.

## API surface

Request bodies follow the JSON schemas in `rgb-lightning-node`'s
`openapi.yaml`. Methods return parsed objects (or throw on the C-FFI error
branch).

**Module-level** — `uniffiHealthcheck()`, `uniffiIsInitialized()`,
`sdkInitialize(request)`, `sdkShutdown()`. Call `sdkInitialize` once before
creating any node.

**`NativeExternalSigner`** — `create(seedHex, network, permissivePolicy = true)`,
`bootstrap()`, `destroy()`.

**`SdkNode`**

| Group | Methods |
|-------|---------|
| Lifecycle | `create`, `init`, `unlock`, `shutdown` |
| External signer | `initWithNativeExternalSigner`, `attachNativeExternalSigner`, `unlockWithNativeExternalSigner`, `initWithExternalSigner`, `unlockWithAttachedExternalSigner`, `detachExternalSigner` |
| Info / sync | `nodeInfo`, `networkInfo`, `sync` (legacy), `syncWallet`, `walletSnapshot`, `address` / `getAddress`, `rotateAddress` |
| Peers | `connectPeer`, `disconnectPeer`, `listPeers` |
| Channels | `openChannel`, `closeChannel`, `listChannels`, `getChannelId` |
| Invoices | `lnInvoice`, `decodeLnInvoice`, `invoiceStatus`, `rgbInvoice`, `decodeRgbInvoice`, `cancelHodlInvoice`, `claimHodlInvoice` |
| Payments | `sendPayment`, `keysend`, `listPayments`, `getPayment` |
| Swaps | `makerInit`, `makerExecute`, `taker`, `listSwaps`, `getSwap` |
| RGB issuance | `issueAssetNia`, `issueAssetUda`, `issueAssetCfa`, `issueAssetIfa` |
| RGB assets | `listAssets`, `assetBalance`, `assetMetadata`, `sendRgb`, `inflate`, `listTransfers`, `listTransfersByTxid`, `refreshTransfers`, `failTransfers`, `getAssetMedia`, `postAssetMedia` |
| BTC | `btcBalance`, `sendBtc`, `listTransactions`, `listTransactionsByTxid`, `listUnspents`, `createUtxos`, `estimateFee` |
| VSS | `vssClearFence`, `vssBackup` |
| APay | `apayNew` |
| Signing / onion / diagnostics | `signMessage`, `verifyMessage`, `sendOnionMessage`, `checkIndexerUrl`, `checkProxyEndpoint` |

`syncWallet({ mode })` is the production synchronization contract. `routine`
updates every revealed Vanilla and Colored script with `FullSync`; `recovery`
discovers both keychains with `FullScan`. It reports each keychain separately
instead of hiding a partial failure. `walletSnapshot(request)` then reads a
versioned, bounded snapshot without another implicit sync. Every monetary
amount is base-10 text, and Lightning claimable balances remain distinct from
inbound/outbound routing capacities.

The C-FFI symbols backing these are declared in [`rln.h`](./rln.h) and
wrapped in [`binding.cc`](./binding.cc); see [`index.js`](./index.js) for
the authoritative JS method list.

## Seed handling

RLN never sees the BIP-39 mnemonic. The host (WDK) derives a 32-byte
BIP-32 entropy and passes it as `seedHex` to `NativeExternalSigner.create`.
`initWithNativeExternalSigner` writes only public identifying data (xpubs,
node id, master fingerprint) to the key-source file on disk. The same
mnemonic re-derives the same `seedHex` on every launch, so the LDK node
identity stays stable across restarts. The VLS signer state lives entirely
in process memory; all channel-state cryptography happens in-process via
`signer-external` / `vls-protocol-signer`. The JS signer handle can be
dropped (`destroy()` or GC) once RLN has cloned its `Arc` ref via
attach/init/unlock.

## Architecture

```
rgb-lightning-node (Rust)            ← source of truth, cloned per release tag
  └── bindings/c-ffi/                ← cbindgen → rln.h
        └── cargo rustc                → librlncffi.a (static, one per target)
              ↑
rgb-lightning-node-bare (this repo)  ← cmake-bare + binding.cc
  └── binding.cc                     ← wraps the C FFI with Bare's <js.h> API
  └── CMakeLists.txt                 ← links librlncffi.a statically
        ↓
      utexo__rgb-lightning-node-bare.bare   ← the loadable Bare addon
```

The difference from
[`@utexo/rgb-lightning-node-nodejs`][rgb-lightning-node-nodejs]: napi-rs
links dynamically at runtime (one `.node` per host), while `cmake-bare`
links statically at build time, producing one self-contained `.bare` file
usable inside any Bare worklet.

## Git commit installs with a native overlay

Git commits can expose C-FFI behavior that has not been promoted to a package
release yet. Such commits declare `utexoNativeOverlay` in `package.json` with
an exact upstream tag and commit, patch path and SHA-256, Rust toolchain, iOS
deployment target, and output target list. During `postinstall` the package:

1. verifies the metadata and patch checksum;
2. verifies any existing static libraries and Bare addons contain the required
   wallet snapshot symbols;
3. optionally imports artifacts from the explicitly trusted
   `RLN_BARE_ARTIFACTS_DIR`; or
4. clones the exact upstream commit, applies only the checksum-pinned patch,
   installs the pinned Rust targets, builds the declared outputs, and verifies
   their symbols before succeeding.

`RLN_BARE_SOURCE_DIR` may point to an exact local checkout for development. It
must be at the configured commit and either pristine or have the complete
configured patch already applied. Both overrides are build inputs controlled
by the caller; neither bypasses commit, patch, file, or symbol validation.
Registry packages without `utexoNativeOverlay` continue to download artifacts
from their matching GitHub release.

The current overlay intentionally declares the three iOS outputs only. Android
continues to use the last released artifacts until an Android overlay target is
built and promoted; the installer does not substitute an older Android binary
for this newer C-FFI contract.

## Build and release (maintainers)

Releases are cut by the **Build and Release (Bare)** GitHub Actions
workflow ([`.github/workflows/release.yml`](./.github/workflows/release.yml)),
triggered either by a `repository_dispatch` (`rln-release`) from
`rgb-lightning-node` or manually via `workflow_dispatch` with an
`rln_version` input (e.g. `v0.6.0-beta.1`). The workflow:

1. Clones `rgb-lightning-node` at the pinned tag and applies the C-FFI
   patch series at [`patches/`](./patches) (a no-op when the tag already
   carries the C-FFI surface upstream).
2. Cross-compiles `librlncffi.a` for all seven targets.
3. Builds the `.bare` prebuilds via `cmake-bare`.
4. Attaches the static libs and prebuilds to a GitHub Release and runs
   `npm publish`.

For a local build:

```sh
# Cross-compile the Rust C-FFI static lib (per platform group):
bash scripts/build-cffi.sh darwin
bash scripts/build-cffi.sh ios
bash scripts/build-cffi.sh android

# Build the .bare prebuilds via cmake-bare:
bash scripts/build-prebuilds.sh darwin-arm64
bash scripts/build-prebuilds.sh ios-arm64
bash scripts/build-prebuilds.sh ios-arm64-simulator
bash scripts/build-prebuilds.sh ios-x64-simulator
bash scripts/build-prebuilds.sh android-arm64
bash scripts/build-prebuilds.sh android-arm
bash scripts/build-prebuilds.sh android-x64
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

[Bare]: https://github.com/holepunchto/bare
[cmake-bare]: https://github.com/holepunchto/cmake-bare
[react-native-bare-kit]: https://github.com/holepunchto/react-native-bare-kit
[Tether WDK]: https://github.com/tetherto/wdk
[rgb-lightning-node]: https://github.com/UTEXO-Protocol/rgb-lightning-node
[rgb-lightning-node-nodejs]: https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs
[rgb-lib]: https://github.com/UTEXO-Protocol/rgb-lib
[rgb-lib-bare]: https://github.com/UTEXO-Protocol/rgb-lib-bare
[wdk-rgb-lightning]: https://github.com/UTEXO-Protocol/wdk-rgb-lightning
