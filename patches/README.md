# UTEXO local patches over `rgb-lightning-node` upstream

This directory holds patches we apply to the upstream
[`rgb-lightning-node`][rln] source tree **before** building the C-FFI
static lib (`librlncffi.a`). Both `@utexo/rgb-lightning-node-bare`
and `@utexo/rgb-lightning-node-nodejs` consume the same `rgb-lightning-node/bindings/c-ffi`
crate, so applying the patch once benefits both bindings.

## Files

| File | Targets upstream tag | Adds |
|---|---|---|
| `c-ffi-utexo-patches-v0.5.0-beta.1.patch` | [`v0.5.0-beta.1`](https://github.com/UTEXO-Protocol/rgb-lightning-node/releases/tag/v0.5.0-beta.1) | `rln_sdk_node_apay_new`, `rln_sdk_node_vss_clear_fence` C wrappers + supporting JSON request types |

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
2. Remove the `git apply` step from `scripts/build-cffi.sh` (if it was added).
3. Document the removal in `CHANGELOG.md` (note: "C-FFI wrappers now provided by upstream").

[rln]: https://github.com/UTEXO-Protocol/rgb-lightning-node
