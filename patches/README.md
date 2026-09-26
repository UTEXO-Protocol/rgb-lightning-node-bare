# Released C-FFI Adapter

Only `c-ffi-release-adapter-v0.13.0-beta.3.patch` is supported.
Its hash, exact RLN/submodule commits and corrected C-FFI lock hash are pinned in
`package.json` and checked before compilation.

The adapter is confined to eight binding/build files. It exposes released
persistent-signer and address-attested APay methods, complete invoice metadata,
tagged RGB assignments and a compiled provenance descriptor. It corrects the
released C-FFI dependency resolution without changing upstream core behavior.

Old overlay implementations are deliberately absent. See `UPGRADE-TRACKER.md`.
