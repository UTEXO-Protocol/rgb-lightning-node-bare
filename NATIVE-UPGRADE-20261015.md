# Signer and session lifecycle repair: October 15, 2026

## Environment and erasure follow-up

Current implementations are Bare `95e2c844dc2c76e3f83d6f1a0dcf76d74f17fef7`,
Iris `cef3e1ebfa5e4b2fafca574ea9796f559157d7c2`, Node
`6079afea5859193dea39f390376219d8dbfef332` (regression-only), and unchanged WDK
`81182153193c9910e89a9d91b1d457e0725787aa`. Bare wrapper SHA-256 is
`ca3ac291fbb4af86fc0d091805f9f544031298f6ce94a66b99f8f1acd763d4f7`;
the 26-file `7f89dc51` overlay, RLN/LDK/rgb-lib and C-FFI lock are unchanged.

Worker termination reproduced retained signer ownership when the external-object
GC finalizer did not run. The maintained Bare wrapper now drains same-environment
nodes before terminal signer revocation/free. Its 58 unit/installer tests, 100
local full-node terminations with 201 OS checkpoints, and separate 18 portable
worker cases pass. The new [seven-target CI run](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/actions/runs/38718114135)
and three Android staging checks pass; original-byte/provenance admission and
the isolated complete assembled-package gate pass. All 14 original native files
were imported byte-for-byte through the standard installer and the repository
artifact gate passed. The app continues using separately archived local Apple
bytes, unchanged by that import. Mobile CI remains compilation/packaging evidence.
The current Node regression-only runtime rerun has four completed passes and
Darwin x64 still running at the recorded `11:24 UTC` observation; its preceding
five-target qualification below retains its original source.

Fresh normal erasure controls confirmed app-owned Expo KV writer contention
(`SQLITE_BUSY`). Iris serializes that shared resource, drains normal storage/key
work and coordinates journal recovery across remounts. The rebuilt iOS 27 Debug
app passes cold authorized-journal recovery and three fresh CREATE → first
authenticated Settings erasures in one process, each `1/2/1` → `0/0/0`, with
all four databases/keys, native directory and journal absent and no retry/reload.
Five full Metro Debug reloads pass in the same PID `16174` on an unfunded
wallet, each active `1/2/1` → locked `0/0/0` → normally authenticated same-store
reopen `1/2/1`, without injected methods, GC, restart or settling retry. Fresh
BTC receive/send passes: 2,000,000 sat in, exactly one confirmed 10,000-sat
payment, 2,845-sat fee and 1,987,155-sat change independently verified. RGB setup
confirms four 20,000-sat outputs/5,665-sat fee. BFA 2 USDT in / 0.5 USDT out
settles, with a 5,100-sat return fee and conserved Iris 1.50 + holder 15.48 =
16.98-USDT new baseline. An additional full Metro reload before holder ACK
preserves the same pending anchor and one send through `1/2/1` → `0/0/0` →
normally authenticated `1/2/1`, without resubmission. Three funded manual cycles
pass; short background (5.355 s) stays active without authentication, long
background (40.422 s) reaches offscreen `0/0/0` and normally reopens in PID
`16174`. Funded cold restart enters PID `60403` locked at `0/0/0` and normally
reopens at `1/2/1`, preserving balances. The final independent ledger conserves
BTC/USDT: Iris 1,976,390 sat (1,901,490 vanilla + 74,900 colored), holder
97,492 sat, external 10,000 sat and four fees 14,121 sat. Final refreshes and all
history filters preserve four unique transactions with no pending/duplicate
entry; exact confirmed return anchor and 5,100-sat fee match. Exact
evidence and build-fixture limitations are in the [Iris follow-up](https://github.com/UTEXO-Protocol/utexo-mobile/blob/release/rln-0.15.0-beta.3/docs/engineering/lifecycle-recovery-validation-20261015.md).
The preceding qualification below retains its original artifacts and counts;
none is transferred to the new wrapper. No aggregate production approval follows.

## Preceding native qualification

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
artifacts and native wallet path. That historical exception was not captured;
the subsequent confirmed cause and fixed erasure scope are recorded above.
The historical attempt is not a clean first-attempt pass. A separate interrupted Debug
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
failure remains historical evidence; the follow-up recovery/first-erasure cases
pass, as do five unfunded full Metro reloads, fresh BTC/BFA roundtrips and an
additional funded pre-ACK reload. Three funded manual cycles, short/long
background, funded cold restart and final history/refresh checks also pass. Arbitrary crash recovery is not
qualified by these scoped cases.

Iris remains on-chain only. Iris has not shipped, so existing-wallet migration
is excluded; local simulator wallets may be reset. The same funded test wallet
must retain its balances, history and signer state across locks and restarts.
Channel payments, VSS failure recovery and other production/security gates are
separate. No merge, npm publication, tag or GitHub release is authorized here.
