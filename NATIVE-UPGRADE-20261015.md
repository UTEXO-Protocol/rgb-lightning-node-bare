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

The final canonical 26-file overlay is
`7f89dc518f8fe69dc6baf62c4ee96e9d5a25d6b6ae70ab529c7b4bcc65979c90`.
Focused native/C-FFI qualification passes 45 tests; Bare unit/installer checks
pass 57 tests. Earlier locally built Darwin arm64 Bare and Node binaries each
passed 123 lifecycle cycles (246 total), four failed-unlock rollback cases
across both runtimes and six additional early-host-free sessions. Those local
binary results retain their own artifact identities. Independent final native
review reports no actionable correctness finding within its reviewed scope.

The canonical [seven-target Bare CI matrix](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/actions/runs/38698325319)
passed at source `c56718bb340fc062b0e4075d91974f820deaf834`: Darwin arm64,
all three iOS slices and Android arm/arm64/x64. Every original ZIP passed its
GitHub SHA-256 and exact source, wrapper, recipe, lock, architecture and artifact
admission checks. All seven static libraries and prebuilds were imported into
the repository's ignored caches through the standard artifact installer;
all 14 files and the manifest match the admitted assembled package. Both the
assembled package and repository release-artifact gates pass. Original
archives, sidecars and successful CI logs are retained; no old artifact was restamped.

The companion [five-target Node runtime matrix](https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs/actions/runs/38698331825)
also passed at source `2caa14962e6a7e10549c888880d46c85aee0b81d`, with actual
optimized native execution on Darwin arm64/x64, GNU Linux arm64/x64 and musl
Linux x64. All five addons and original provenance sidecars were admitted and
imported without rebuilding or changing identity-bearing source; assembled
and repository release-artifact gates pass. GNU artifacts report a glibc 2.34
floor; musl was executed in real musl userland. These CI runtime checks cover
native identity, offline persistence/lifecycle, errors and adapter tests.
Bare mobile CI covers compilation and packaging; device/app acceptance is
separate. Artifact admission does not establish full release qualification.

Additional hosted qualification uses the exact original CI Darwin bytes on
macOS 27.0.1 in three configurations: Bare 1.33.4 arm64, Node 22.23.3 arm64 and
official Intel Node 22.23.3 under verified Rosetta translation. Each passes its
native canary, 20 fixed-port lifecycle cycles, one additional early-host-free
session with real signing, and a clean packed WDK consumer's same-process
reopen. All closed checkpoints release wallet/signer descriptors and listeners
immediately, without settling retries. These 60 CI-artifact cycles are separate
from the earlier 246 locally built binary cycles. The selected artifact hashes
and live OS mappings are recorded in the `ci-bare-arm64`, `ci-node-arm64` and
`ci-node-x64-rosetta` qualification summaries under the workspace evidence
directory `release-evidence/2026-10-15/signer-lifecycle-fix/`.

All three original iOS inputs, the full XCFramework and the normal Iris worklet
are admitted. A standalone Foundation C-FFI executable linked to the exact CI
iOS simulator library (`12052118b413f33eabee69d994e35657dcac01378106d01463840a8c5213ee19`)
passes 18 native lifecycle cycles, two forced-failure same-SDK retries and
three additional early-host-free sessions with real signing on the existing
iPhone 18 Pro iOS 27 simulator. Closed wallet/signer descriptors and listeners
are zero. `ios27-native-cli/qualification-summary.json` records that native
scope; it does not establish Iris UI, authentication, background or financial
acceptance, physical-device behavior or the app sandbox.

Debug and Release QA builds pass static provenance, iOS slice, scene manifest,
export and signature checks. Three standalone Release cold launches with Metro
stopped reach the normal locked screen. Subsequent normal OS authentication
reaches application UI with balances unavailable, Send Continue disabled and
native resources `0/0/0`, consistent with the unchanged production gateway
guard. This is scoped startup/authentication/fail-closed evidence; funded
Release and production-gateway behavior remain unqualified.

The normal on-chain Debug regtest scope on the existing iPhone 18 Pro/iOS 27
simulator now passes the following exact-artifact acceptance:

- Fresh BTC receipt of 2,000,000 sat and exactly one reviewed/native-authenticated
  10,000-sat send (2,845-sat fee), followed by four 20,000-sat RGB outputs
  (5,665-sat fee). Authentication-cancellation controls submit no payment/setup.
- One 2-USDT BFA receipt and one 0.5-USDT return both settle, leaving Iris
  1.50 USDT and the holder 16.98 USDT, preserving the 18.48-USDT test-pair total.
  The pending return survives manual lock/reopen before receiver ACK with the
  same anchor and exactly one pending entry; it settles only after ACK,
  broadcast and confirmation. Independent native/Esplora accounting verifies
  the result, fees, unspent outputs and absence of duplicate or mint/burn entries.
- Ten valid manual lock/reopen cycles release signer/wallet database/listener
  resources to `0/0/0` and reopen to `1/2/1` after normal authentication.
  Each valid cycle stays within its process; the ten cycles span a separately
  recorded cold restart. Funded cold authentication restores 1.50 settled USDT
  and 1,901,490 native vanilla sat.
- Actual device Home backgrounding passes a 10.59-second return without locking
  and three long returns (35.95, 35.67 and 35.60 seconds) that resume locked at
  `0/0/0`, then authenticate to `1/2/1` with funds preserved. Offscreen snapshots
  still show live resources; zero-resource claims apply to resumed locked
  checkpoints. The earlier AXe Home attempt did not background the app and is
  invalidated, not counted as a product background result.

This qualifies the P01 repair for these normal funded Debug simulator lifecycle
cases, in addition to the separately recorded host/native scopes. It is not
full Release, Android, physical-device, public Signet/mainnet, channel or general
crash/recovery qualification. The independent roundtrip and background records
are `bfa-setup/fresh-btc-bfa-roundtrip-ledger.json` and
`ios27/background-lifecycle-qualified.json` under the evidence directory above.

Two adverse observations remain explicit. The first normal erasure attempt
failed verified erasure after clean native shutdown; a normal Metro reload
resumed the already authorized journal and cleared the seed/journal, SQLCipher
artifacts and native wallet path. Its first-failure cause remains unresolved;
this is not a clean first-attempt erasure pass. A separate interrupted Debug
reload attempt retained one signer descriptor (`1/0/0`) until cold restart and
is excluded from the ten valid cycles. A successful retry does not relabel it.
Final UI history has exactly four BTC/BFA receipt/payment entries; the outgoing
BFA detail is Settled with 142/3 confirmations and the 5,100-sat fee. Two normal
refreshes preserve balances without duplicate entries. These financial results
are local Debug regtest; positive funded Release acceptance remains separate.
October 14 observations retain their original dated identities.

The reviewed, user-authorized canonical local ownership overlay is an accepted
P01 correction path; an upstream merge or process isolation is not required.
P01 passes the host/native and normal iOS 27 Debug regtest scopes above.
Android, positive funded Release and public-deployment closure remain open,
as do P02/P03/P04/P06, security and distribution gates. The first erasure
failure and interrupted Debug reload remain unqualified boundaries.

Iris remains on-chain only. Iris has not shipped, so existing-wallet migration
is excluded; local simulator wallets may be reset. The same funded test wallet
must retain its balances, history and signer state across locks and restarts.
Channel payments, VSS failure recovery and other production/security gates are
separate. No merge, npm publication, tag or GitHub release is authorized here.
