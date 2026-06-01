# @utexo/rgb-lightning-node-bare

[Bare]-runtime native addon for [`rgb-lightning-node`][rgb-lightning-node]
(RLN) — the Lightning + RGB daemon built on LDK and [`rgb-lib`][rgb-lib].
This package wraps RLN's C FFI in a `.bare` addon so the daemon can run
**inside a Bare worklet** alongside the rest of the [Tether WDK] chain
modules.

Mirrors the [`@utexo/rgb-lib-bare`][rgb-lib-bare] pattern 1:1: same build
chain (`cmake-bare` + static linking), same release flow (prebuilds via
GitHub Releases), same JS-API shape as the Node.js sibling
([`@utexo/rgb-lightning-node-nodejs`][rgb-lightning-node-nodejs]) so the
WDK layer is identical across runtimes.

## Why Bare?

The Node.js sibling covers desktop / server. This package exists for one
specific consumer: **[`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning]**
running inside the [Tether WDK]. WDK executes its chain-specific wallet
logic in a [Bare] worklet — a sandboxed JS runtime hosted via
[react-native-bare-kit] on mobile or as a subprocess on desktop.

For RGB-over-Lightning to join WDK, RLN's daemon code needs to be
callable from inside that worklet, which means:

- The native code must **link statically** into a `.bare` addon (worklets
  can't `dlopen` shared libs the way Node can — and iOS App Store policy
  forbids dynamic linking anyway).
- The JS API must have the **same shape** as the Node sibling so
  [`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning] writes one code path
  that works in both runtimes (the WDK package picks the right binding
  at module-load time).

Consumers don't import this package directly — they import
`@utexo/wdk-rgb-lightning`, which selects this addon when it detects
the bare runtime.

## Platform support

Pre-built static libs (`librlncffi.a`) plus `.bare` prebuilds are
distributed as a single package; `cmake-bare` picks the right one at
install time.

| Platform        | Target                       | Linking |
|-----------------|------------------------------|---------|
| iOS arm64       | `aarch64-apple-ios`          | Static  |
| iOS arm64 sim   | `aarch64-apple-ios-sim`      | Static  |
| iOS x64 sim     | `x86_64-apple-ios`           | Static  |
| macOS arm64     | `aarch64-apple-darwin`       | Static  |
| Android arm64   | `aarch64-linux-android`      | Static  |
| Android arm     | `armv7-linux-androideabi`    | Static  |
| Android x64     | `x86_64-linux-android`       | Static  |

Static linking is required for iOS (App Store policy) and gives a single
self-contained `.bare` addon on Android.

## Requirements

- Node.js 18+ (for `cmake-bare` and the postinstall script)
- [bare] runtime (for actually running the addon)

## Installation

You don't normally install this package directly — it's a transitive
peer dependency of [`@utexo/wdk-rgb-lightning`][wdk-rgb-lightning]. If
you're building something that runs inside a bare worklet and need RLN
directly, install it explicitly:

```sh
npm install @utexo/rgb-lightning-node-bare
```

A postinstall script downloads the matching prebuilds from this repo's
GitHub Releases — no Rust toolchain or cross-compiler is needed on the
consumer machine.

## Usage

The addon exposes two classes (`SdkNode` and `NativeExternalSigner`)
plus a few module-level helpers. The example below shows the
**external-signer** lifecycle — the only mode the WDK ships with.

```js
const rln = require('@utexo/rgb-lightning-node-bare')

// 1. Module-level init (idempotent, sets up the static tokio runtime).
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

// 3. Build the in-process VLS signer from a host-owned 32-byte seed.
const signer = rln.NativeExternalSigner.create(seedHex, 'regtest')

// 4. First-launch init (writes key-source file to storage_dir_path).
//    On subsequent launches RLN throws Rln(Conflict) — swallow it.
try { node.initWithNativeExternalSigner(signer) }
catch (e) { if (!String(e.message).includes('Conflict')) throw e }

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

See `index.js` for the full method list — channels, invoices (BOLT11 +
RGB + hodl), payments (BOLT11 + keysend), atomic swaps, RGB asset
issuance / transfers / media, BTC ops, signing, diagnostics.

> **Note on seed handling.** RLN never sees the BIP-39 mnemonic. The
> host (WDK) derives a 32-byte BIP-32 entropy from the mnemonic and
> passes it as `seedHex` to `NativeExternalSigner.create`. RLN's
> `initWithNativeExternalSigner` writes only public identifying data
> (xpubs, node id, master fingerprint) to the key-source file on disk.
> The same mnemonic re-derives the same `seedHex` on every launch, so
> the LDK node identity stays stable across restarts.

## C FFI coverage

The addon wraps RLN's C FFI in `binding.cc` (see `binding.js` for the
exported list). Coverage includes:

- **Lifecycle** — `sdkNodeNew`, `sdkNodeInit`, `sdkNodeUnlock`,
  `sdkNodeShutdown`, plus the external-signer variants
  (`initWith…`, `attachNative…`, `unlockWithNative…`,
  `unlockWithAttachedExternalSigner`, `detachExternalSigner`)
- **Module-level** — `uniffiHealthcheck`, `uniffiIsInitialized`,
  `sdkInitialize`, `sdkShutdown`
- **Node info / sync** — `nodeInfo`, `networkInfo`, `sync`, `address`
- **Peers + channels** — `connectPeer`, `disconnectPeer`, `listPeers`,
  `openChannel`, `closeChannel`, `listChannels`, `getChannelId`
- **Invoices** — `lnInvoice`, `decodeLnInvoice`, `invoiceStatus`,
  `rgbInvoice`, `decodeRgbInvoice`, `cancelHodlInvoice`,
  `claimHodlInvoice`
- **Payments** — `sendPayment`, `keysend`, `listPayments`, `getPayment`
- **Swaps** — `makerInit`, `makerExecute`, `taker`, `listSwaps`,
  `getSwap`
- **RGB assets** — `issueAssetNia` / `Uda` / `Cfa` / `Ifa`,
  `listAssets`, `assetBalance`, `assetMetadata`, `sendRgb`, `inflate`,
  `listTransfers`, `refreshTransfers`, `failTransfers`,
  `getAssetMedia`, `postAssetMedia`
- **BTC** — `btcBalance`, `sendBtc`, `listTransactions`,
  `listUnspents`, `createUtxos`, `estimateFee`
- **VSS** — `vssClearFence` (takeover after a stale ownership fence)
- **APay** — `apayNew` (receiver-side LSP registration)
- **Onion / signing / diagnostics** — `sendOnionMessage`,
  `signMessage`, `checkIndexerUrl`, `checkProxyEndpoint`

## Build and publish (maintainers)

```sh
# Update the rgb-lightning-node submodule to the desired tag/SHA
git submodule update --init --recursive

# Install Node dependencies (cmake-bare, cmake-npm)
npm install --ignore-scripts

# Cross-compile the Rust C-FFI static lib for every target
bash scripts/build-cffi.sh darwin
bash scripts/build-cffi.sh ios
bash scripts/build-cffi.sh android

# Build the .bare prebuilds via cmake-bare
bash scripts/build-prebuilds.sh darwin-arm64
bash scripts/build-prebuilds.sh ios-arm64
bash scripts/build-prebuilds.sh ios-arm64-simulator
bash scripts/build-prebuilds.sh ios-x64-simulator
bash scripts/build-prebuilds.sh android-arm
bash scripts/build-prebuilds.sh android-arm64
bash scripts/build-prebuilds.sh android-x64

# Upload assets to a GitHub Release
gh release create v0.1.0-beta.X \
  lib/*/librlncffi.a prebuilds/*/utexo__rgb-lightning-node-bare.bare
```

## Architecture

```
rgb-lightning-node (Rust)            ← source of truth, as a submodule
  └── bindings/c-ffi/                ← cbindgen → rln.h
        └── cargo rustc                → librlncffi.a (static, per target)
              ↑
rgb-lightning-node-bare (this repo)  ← cmake-bare + binding.cc
  └── binding.cc                     ← wraps the C FFI with bare's <js.h> API
  └── CMakeLists.txt                 ← links librlncffi.a statically
        ↓
      utexo__rgb-lightning-node-bare.bare   ← the loadable bare addon
```

The key difference from [`@utexo/rgb-lightning-node-nodejs`][rgb-lightning-node-nodejs]:
napi-rs links dynamically at runtime (one `.node` per host platform),
while `cmake-bare` links statically at build time so the result is one
self-contained `.bare` file usable inside any bare worklet.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

[Bare]: https://github.com/holepunchto/bare
[bare]: https://github.com/holepunchto/bare
[cmake-bare]: https://github.com/holepunchto/cmake-bare
[react-native-bare-kit]: https://github.com/holepunchto/react-native-bare-kit
[Tether WDK]: https://github.com/tetherto/wdk
[rgb-lightning-node]: https://github.com/UTEXO-Protocol/rgb-lightning-node
[rgb-lightning-node-nodejs]: https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs
[rgb-lib]: https://github.com/UTEXO-Protocol/rgb-lib
[rgb-lib-bare]: https://github.com/UTEXO-Protocol/rgb-lib-bare
[wdk-rgb-lightning]: https://github.com/UTEXO-Protocol/wdk-rgb-lightning
