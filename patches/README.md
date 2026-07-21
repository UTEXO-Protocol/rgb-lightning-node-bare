# UTEXO local patches over `rgb-lightning-node` upstream

This directory holds optional patches we apply to the upstream
[`rgb-lightning-node`][rln] source tree **before** building the C-FFI
static lib (`librlncffi.a`). Both `@utexo/rgb-lightning-node-bare`
and `@utexo/rgb-lightning-node-nodejs` consume the same `rgb-lightning-node/bindings/c-ffi`
crate, so applying the patch once benefits both bindings.

## Files

| File | Targets upstream tag | Adds |
|---|---|---|
| `c-ffi-utexo-patches-v0.9.0-beta.3.patch` | [`v0.9.0-beta.3`](https://github.com/UTEXO-Protocol/rgb-lightning-node/releases/tag/v0.9.0-beta.3) | Versioned dual-keychain sync and bounded, decimal-safe wallet snapshots |
| `c-ffi-utexo-patches-v0.5.0-beta.1.patch` | [`v0.5.0-beta.1`](https://github.com/UTEXO-Protocol/rgb-lightning-node/releases/tag/v0.5.0-beta.1) | `rln_sdk_node_apay_new`, `rln_sdk_node_vss_clear_fence` C wrappers + supporting JSON request types |

The `v0.9.0-beta.3` overlay is byte-identical to the copy in the NodeJS
binding repository. Routine synchronization FullSyncs both Vanilla and
Colored keychains, recovery synchronization FullScans both keychains, and all
snapshot monetary values cross the JavaScript boundary as decimal strings.

## Why a patch rather than a fork?

The UniFFI surface in upstream already exposes `apay_new` (`src/uniffi_api/mod.rs:1396`) and `vss_clear_fence` (`src/uniffi_api/mod.rs:335`). We only add the **`extern "C"` wrappers** in `bindings/c-ffi/`, which call the existing UniFFI methods via the same `block_on_sdk` pattern as every other wrapper.

These wrappers are pure passthrough. They should be upstreamed once Roman is ready — at which point this patch goes away and the upstream tag is the only source of truth.

## How to apply

From the `rgb-lightning-node` source tree, with `v0.5.0-beta.1` checked out:

```sh
git checkout v0.5.0-beta.1
git apply /path/to/this/patches/c-ffi-utexo-patches-v0.5.0-beta.1.patch

# verify
grep -c "rln_sdk_node_apay_new\|rln_sdk_node_vss_clear_fence" bindings/c-ffi/src/lib.rs
# expected: 4
```

Then build the C-FFI static lib via `scripts/build-cffi.sh` from this package, which expects the source tree at `../../rgb-lightning-node/bindings/c-ffi/`.

## When upstream catches up

If a future `rgb-lightning-node` release exposes both wrappers natively in `bindings/c-ffi/`:

1. Delete this patch.
2. Keep the release workflow's optional overlay handling for older tags.
3. Document the removal in `CHANGELOG.md` (note: "C-FFI wrappers now provided by upstream").

[rln]: https://github.com/UTEXO-Protocol/rgb-lightning-node

## c-ffi-utexo-patches-v0.6.0-beta.1.patch

Intentionally empty. The apay_new / vss_clear_fence / vss_backup / hodl
c-ffi wrappers this series used to add were merged upstream into
rgb-lightning-node (PRs #62/#63/#66) and ship in tag v0.6.0-beta.1, so no
overlay is needed. The release workflow skips applying an empty patch.

Tags without a matching file are built directly from upstream. A patch file
is required only when that specific RLN tag needs a binding-local overlay.
