# RLN 0.13.0-beta.3 Upgrade Tracker

Status: implementation in progress. Draft PR, not release approval.

## Scope

- Target RLN `af03c7f1a65135a429f05a5820600338215954dc` (v0.13.0-beta.3).
- Target rust-lightning submodule `38d73bc918f27956590585d2bb83c86f059679b0`.
- Target RGB-lib v0.3.0-beta.34 and Rust 1.94.0.
- Candidate package line: `0.2.0-beta.1`; no npm publication in this task.
- Start from main. Do not merge dev/iris-wallet wholesale.
- No upstream wallet, channel, signer-policy, VSS or routing behavior patches.

## Implementation

| Work | Status | Required Evidence |
| --- | --- | --- |
| Dedicated upgrade branch | Done | `codex/rln-0.13.0-beta.3` |
| Released native graph and bounded C-FFI adapter | Implemented | Identical Node adapter and generated header; locked host debug build passed |
| Wrapper types, unsupported capability rejection, exact numbers | Verified locally | 29 JS/installer/root-resolution tests and declarations pass |
| Source install/provenance/artifact workflow | Implemented | Source, lock, wrapper, ABI and binary checks; packed install pending |
| Unit/type/lint/package checks | Partial | Types and JS contracts passed; native optimized and clean package tests underway |
| Linked native/runtime conformance | Partial | Debug macOS arm64 canary passed; optimized rebuild underway; mobile gates remain |
| Final diff review | In progress | Raw-handle, conversion and shutdown errors hardened; external maintainer review required |
| Cross-repository draft PR links | Done | Links below |

## Explicit Release Gates

| ID | Gate | Status |
| --- | --- | --- |
| G1 | Existing colored-channel state can be refused by released 0.13; exact old-artifact migration qualification and operational drain/close procedure required | Blocked |
| G2 | Old password-encrypted mnemonic records are not automatically supported; distinguish WDK external-signer key-source records | Blocked |
| G3 | Full desktop/mobile build and runtime target matrix | Pending |
| G4 | Controlled two-node/regtest and operator-coordinated LSP asset flow | Blocked: operator/environment evidence required |
| G5 | Integrator zero-channel report root cause | Unproven: deployed build IDs and server provisioning logs required |
| G6 | Current app depends on excluded overlay features | Separate adoption gate; do not change app pins |
| G7 | Candidate publication, promotion and merge | Not authorized by this draft-PR task |

Excluded capabilities: coherent wallet snapshot/FullSync, native operation registry,
prepared-send plans and inventories, address receipts, RLN import APIs, VSS delete-all
and native routing fee caps. Persistent signer and address-attested APay forwarding
are allowed only because their underlying behavior is already released.

No automatic wallet reset, seed-only recreation, stale-state rollback, implicit
virtual-channel trust change, or replacement of an unsupported safety guarantee with
a weaker implementation.

## Verification Log

- Baseline source/branch audit completed before implementation.
- Results below will distinguish mocked tests, linked host smoke, compile-only
  cross-builds, device tests and funded/network qualification.
- No funded transaction or production wallet has been used.
- `npm run check:types`: pass. `npm run test:installer`: 29 passed.
- macOS arm64 debug canary passed: persistent signer/init/disposal/reopen plus
  invalid raw handle, handle kind, string, bool and u16 argument cases.
- A raw Bare getter crashed on a non-external argument before returning an error.
  Reproduced and fixed by checking value type first, then validating ownership,
  environment and handle kind in a registry. No unchecked UTF-8/malloc conversions.
- Raw destroy now reports failed shutdown and retains its handle/teardown callback.
  JS fault-injection tests cover shutdown/destroy retry; native shutdown-failure
  and hard-kill durability still require network fixtures.
- Streamed symbol inspection avoids the former 64 MiB buffer limit. Pinned
  bare-headers 1.30.0 builds against Bare 1.30.3; package-export resolution tested.
- Explicit Apple C/C++ deployment flags fix the 27/13 floor mismatch. Debug
  builds reported a large unwind table; optimized qualification remains separate.
- Native source builds are intentional. Tarballs exclude generated `lib/` and
  `prebuilds/`; no debug binary is accidentally packaged. No npm publication.
- Mobile SDK/NDK builds and device/emulator canaries are not yet qualified.

## Coordinated Drafts

- [Node #22](https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs/pull/22)
- [Bare #20](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/pull/20)
- [WDK #43](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/pull/43)
