# Signer and session lifecycle repair: October 15, 2026

This unpublished `0.2.0-beta.4` candidate uses RLN `v0.17.0-beta.3`
(`ecc69f20308231400561f6f060fea88acfa40cc4`), LDK
`79b9eb5166546c62692d3a672986f385c7fe047d` and rgb-lib
`v0.3.0-beta.50-bfa` (`1b951af0c8233308c919975552487be19ad2a930`).
The dependency graph and C-FFI lock checksum are unchanged.

The previous eight-file adapter is superseded by the explicitly allowlisted,
shared native lifecycle overlay. Its complete checksum is in `package.json`
and `runtime-contract.json`; compiled information and artifact sidecars bind
that checksum. Old binaries and October 14 passes cannot qualify this change.
See [SIGNER-LIFECYCLE.md](SIGNER-LIFECYCLE.md) for the ownership contract.

## Implementation

- Explicit signer revocation rejects new calls, drains current calls and drops
  backend/transport state even with outstanding clones. Ordinary free/GC stays
  ownership-only. Persistent VLS restore and high-water construction are retained.
- Session workers, fee pollers, peer workers, transaction broadcasts and async
  monitor persistence have owned completion. Cancellation releases a port-zero
  listener directly; gossip-verifier feedback uses weak references.
- Shutdown drains background work, finishes final persistence and broadcasts,
  releases owners and checks manager destruction. Concurrent terminal shutdown
  waits for and shares the teardown outcome. Native attachment and request
  admission reject a closing node.
- Partial startup has ordered cleanup. VSS fence handover follows completed
  persistence; uncertain cleanup retains ownership instead of declaring success.
- Errors propagate through UniFFI/C-FFI and host wrappers. WDK retains failed
  cleanup handles for retry. Final build admission rechecks exact native source
  without mutating it after compilation.

## Qualification

Implementation and focused tests are complete; rebuilt artifact and mobile
qualification are in progress. Results must identify this exact overlay,
wrapper, recipe and original artifact checksums. Required acceptance includes
immediate same-store reopen without relying on explicit revocation; repeated
sessions with operating-system resource observations; concurrent signer and
shutdown tests; and actual iOS 27 lock/unlock with BTC/BFA send and receive.

Iris remains on-chain only. Iris has not shipped, so existing-wallet migration
is excluded; local simulator wallets may be reset. The same funded test wallet
must retain its balances, history and signer state across locks and restarts.
Channel payments, VSS failure recovery and other production/security gates are
separate. No merge, npm publication, tag or GitHub release is authorized here.
