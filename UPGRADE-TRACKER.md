# RLN 0.13.0-beta.3 Upgrade Tracker

Status: 2026-09-24 local released-runtime qualification completed within the
recorded scope, with strict-signer, same-process reopen, force-close recovery and
Android 16-KiB packaging blockers.
Draft PR, not release approval. CI applies only to its reported commit.

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
| Released native graph and bounded C-FFI adapter | Implemented | Identical Node adapter and generated header; locked host debug and optimized builds passed |
| Wrapper types, unsupported capability rejection, exact numbers | Verified locally | 33 JS/installer/root-resolution/ELF tests and declarations pass |
| Source install/provenance/artifact workflow | Verified on host | Source, lock, wrapper, ABI and binary checks; clean packed source install passed with isolated cache |
| Unit/type/lint/package checks | Verified on host | 33 tests, declarations, optimized native canary and packed WDK consumer passed |
| Linked native/runtime conformance | Partial | Debug/optimized macOS arm64 canaries passed; WDK consumer passed on Bare 1.32.0; mobile gates remain |
| Final diff review | In progress | Raw-handle, conversion and shutdown errors hardened; external maintainer review required |
| Cross-repository draft PR links | Done | Links below |

## Explicit Release Gates

| ID | Gate | Status |
| --- | --- | --- |
| G1 | Existing colored-channel migration | Out of scope: owner confirmed no live wallets on 2026-09-24; fresh wallets only, no migration compatibility promise |
| G2 | Old password-encrypted mnemonic migration | Out of scope under the same owner decision; no reset or stale-state rollback workaround |
| G3 | Full desktop/mobile build and runtime target matrix | All seven declared artifacts compile/verify. iOS arm64 simulator and Android arm64 4-KiB emulator pass actual RN worklet checks. Android 16-KiB post-link ELF fails and crashes at import. Physical devices excluded, other mobile architectures compile-only |
| G4 | Controlled two-node/regtest and operator-coordinated LSP asset flow | Real local Node/Bare flows executed; strict outgoing signer and same-process reopen blockers remain. Deployed Signet/mainnet LSP qualification is separate |
| G5 | Integrator zero-channel report root cause | Unproven: deployed build IDs and server provisioning logs required |
| G6 | Current app depends on excluded overlay features | Separate adoption gate; do not change app pins |
| G7 | Candidate publication, promotion and merge | Not authorized by this draft-PR task |
| G8 | GitHub OAuth credential lacked workflow scope | Resolved: user refreshed authorization; implementation through 22ce493 pushed successfully on 2026-09-23. Draft #20 contains the implementation and CI has started. No safeguards removed |
| G9 | Rust type/trait mismatches after sharing Node Cargo target | Isolated build passed unchanged. Use a dedicated cache per package/source checkout; precise Cargo invalidation cause not established |
| G10 | Full WDK transitive dependency graph requires newer Bare than native-only canary | Packed WDK failed on 1.30.3 because bare-type 1.3.0 requires >=1.32.0, then passed on pinned 1.32.0. Native-only canary still passes on 1.30.3 |

Excluded capabilities: coherent wallet snapshot/FullSync, native operation registry,
prepared-send plans and inventories, address receipts, RLN import APIs, VSS delete-all
and native routing fee caps. Persistent signer and address-attested APay forwarding
are allowed only because their underlying behavior is already released.

No automatic wallet reset, seed-only recreation, stale-state rollback, implicit
virtual-channel trust change, or replacement of an unsupported safety guarantee with
a weaker implementation.

## Verification Log

### 2026-09-24 Non-Device Follow-Up

- Added `scripts/check-android-linked.js` and two regressions (33 tests total).
  The candidate-artifact workflow now checks output after bare-link, not just the
  input prebuild. Current published tooling fails this gate; it is not waived.
- Original Android arm64/x64 prebuilds pass 16-KiB checks. bare-link 3.3.0 with
  bare-lief 0.2.5 or 0.2.8 shifts RELRO incorrectly. The 16-KiB arm64 emulator
  crashes during native build-info import; the same APK passes on 4-KiB pages.
  The 0.2.8 arm64 and x64 outputs also fail the post-link check. ZIP alignment
  alone passed the crashing APK. No ELF/RELRO patch or protection bypass added.
- Expo 56 / RN 0.85.3 / Bare Kit 0.14.5 (embedded Bare 1.29.4) Release app passes
  strict real wallet/send, Bare TLS certificate checks, lifecycle, cold restart
  and teardown on iOS 26.5 simulator and Android API 36 4-KiB emulator. This
  separate bundled profile does not lower WDK's standalone Bare 1.32 CLI floor.
- Host Bare strict disk-full, dispatched-send interruption, longer-fork reorg and
  complete-state cold-copy recovery pass. HODL double-process recovery and BTC
  mature-output sweep plus re-spend pass under permissive diagnostics only.
- Strict BTC sweep fails in the released native path. RGB force-close commitment
  is rejected by Core signature verification on both native bindings, including
  Node strict mode; the later RGB recovery steps are blocked. Exact component
  root causes require upstream investigation, not invented package workarounds.
- See WDK's linked qualification report for all run IDs, failed fixture attempts,
  scope boundaries and retained private evidence. No physical device was used.

### 2026-09-24 Local Follow-Up

- Fixed normal node-info failure on u64::MAX: exact response integer tokens now
  become decimal strings outside the safe range; unsafe numeric inputs still fail.
  Pinned lossless-json 4.3.1 and rebuilt optimized native artifacts.
- Real strict Node/Bare on-chain NIA/IFA/CFA/UDA receipts and witness transfers pass
  with two-sided settlement and reconciled balances.
- Separately labelled permissive regtest diagnostics pass standard BTC/RGB
  Lightning, keysend, HODL, hard process restart, post-restart payment and channel
  closes. These do not qualify strict signing or mainnet.
- Node/Bare IFA LSP diagnostics pass real standard-channel provisioning, signed
  APay registration/proof/payment/claim and both bridge directions. On-chain
  delivery was checked independently of Lightning success.
- Strict outbound payments still stall awaiting signer; incoming LSP funding and
  proof verification succeed. No signer policy was weakened.
- Same-process persistent signer recreation fails after actual unlock, even for
  an unfunded Node wallet. Both wrappers free their node/signer handles. Released
  announcement-task retention is a leading upstream lifetime explanation; no
  upstream patch or database-lock bypass was added.
- VSS is disabled in this profile; upstream VSS repair is outside this task.
  Existing-wallet migration is excluded by owner decision, not a remaining gate.
- Full commands, run IDs, limitations and upstream evidence:
  [WDK qualification](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/blob/codex/rln-0.13.0-beta.3/tests/regtest/QUALIFICATION.md).

### Target And Packaging Results

- All seven optimized native target artifacts passed a fresh full installer
  verification: darwin-arm64, three iOS variants, and Android arm64/arm/x64.
- Android arm64/x64 builds now explicitly set 16 KiB max/common page alignment;
  installer parses LLVM JSON and rejects nonaligned LOAD/RELRO segments, including
  imported artifacts. Two negative/positive tests raise the JS suite to 31.
- iOS dynamic-lookup and NDK CMake minimum-version deprecation warnings remain
  recorded; these builds are not device-runtime evidence.
- Packed Bare/WDK consumer passes on Bare 1.32.0 with the current verified host
  artifacts; prior normal source-build packed installation also passed. No install
  scripts bypassed. Production npm audit reports zero vulnerabilities.

### Earlier Implementation Evidence

- Baseline source/branch audit completed before implementation.
- Results below will distinguish mocked tests, linked host smoke, compile-only
  cross-builds, device tests and funded/network qualification.
- Only disposable local regtest wallets were funded. No real-network funds or production wallets were used.
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
- At that earlier stage mobile builds were pending; current build results are
  recorded above. Device/emulator canaries remain unqualified.
- Optimized build and final 29-test/native canary rerun passed. Optimized link
  did not emit the debug unwind-table or deployment-floor warnings.
- Clean packed native/WDK source installation passed on a dedicated Cargo cache;
  complete WDK exports, compiled identity, persistent signer and offline lifecycle
  passed on Bare 1.32.0. Source/dependency caches assisted installation; this was
  not a prebuilt or network/migration qualification test.

## Coordinated Drafts

- [Node #22](https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs/pull/22)
- [Bare #20](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/pull/20)
- [WDK #43](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/pull/43)
