# RLN 0.15 release tracker

Candidate `0.2.0-beta.3`, branch `release/rln-0.15.0-beta.3`, based on
`release/rln-0.13.0-beta.3`. No npm publication or production approval.

## Merged External-Signer BFA Follow-up

The current source is RLN `a17b685615750536f0320db1cd3f3ba68a8f1c57`,
the exact PR #192 merge. LDK, rgb-lib and the approved C-FFI lock are unchanged.
Both unlock entrypoints accept optional `eth_rpc_url`. Source installation now
fetches the exact commit instead of requiring a release tag. Runtime identity
includes `external-signer-eth-rpc-v1`; old binaries are not accepted.
External-signer burn remains unsupported.

Current BFA results, RN comparison and remaining gates are maintained in the
[WDK BFA report](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/blob/release/rln-0.15.0-beta.3/BFA-QUALIFICATION.md).
The qualification below records the previous candidate, not a retest of every
platform or failure mode against this new source.

## October 9 Artifact Qualification

All seven current-source Bare prebuilds pass the local release-artifact gate:
Darwin arm64, iOS device arm64, iOS simulator arm64/x64, and Android
arm64/armv7/x64. This verifies exact source/adapter identity, release profile,
checksums and target-specific artifact requirements, not execution on every
target. No native dependency or adapter revision changed for these builds.

Iris's final three-ABI Release APK/AAB and generated APK splits pass native
payload/provenance, signature and alignment checks. Each ABI contains 72 native
libraries; the final 64-bit Android outputs pass 16-KiB checks using Iris's
byte-preserving staging. This is not a pass for the generic bare-link rewrite.
The artifacts use local test signing and an explicit Signet configuration;
they have not been store-signed or interactively qualified as Release builds.
Local evidence is retained in
`/tmp/iris-android-release-signet-verification-20261009.json` and
`/tmp/iris-android-split-verification-20261009.json`.

The arm64 16-KiB Android Debug app passed the recorded BTC send/receive and
settled RGB-receive flows. RGB send remains unexecuted. Funded same-process
reopen still fails with a signer database lock, and the incoming RGB pending
display still double-counts before settlement. Artifact checks do not resolve
those runtime failures or replace physical-device qualification.

`ORG_READ_TOKEN` is now configured. Attempt 2 of
[contract CI](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/actions/runs/37629619939)
passed the host debug build, native tests and package checks.

The optimized [seven-target candidate run](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/actions/runs/37925315347)
completed with five passing jobs (Darwin arm64, all three iOS targets, Android
armv7). Android arm64 and x64 compiled but failed the production post-link check.
The arm64 failure is reproduced locally with `bare-link@3.3.2` and
`bare-lief@0.2.9`: RELRO shifts by 4096 bytes and the dynamic table moves into a
separate writable LOAD outside RELRO. Increasing alignment or ignoring the
raw end would not establish equivalent protection. The linked-ELF gate now
also checks DYNAMIC/GOT coverage and excludes mutable data from RELRO; the
45-test installer/wrapper suite passes. Both original 64-bit prebuilds pass the
stronger checks. No ELF protection was weakened and no native source changed.

## Previous Candidate Qualification

- Pin RLN `e2b39d5ae8da74525eafb58bc39b9a614c756a73`, LDK
  `6d6d061f840264296e7de2b1c64dac6c0dd7eb26`, rgb-lib beta.42-bfa and its
  four BFA overrides. Source allowlists and locked builds verify the graph.
- Replace the import backport with an eight-file C-FFI adapter. Released imports
  remain; no RLN/rgb-lib/LDK/VLS behavior patch is added.
- Expose released consignment bytes/path. Preserve strict persistent signing,
  lossless JSON and explicit unsupported capability errors.
- Verify packed prebuild identity/checksums before reuse. Publication requires
  the complete release artifact matrix; no silent old-binary fallback.
- 41 wrapper/installer tests and declarations pass. Actual native identity,
  error/lifecycle and mainnet Lightning rejection canaries pass on macOS arm64.
- Funded WDK tests pass for NIA/IFA/CFA/UDA receive/send/balance/export,
  six-decimal IFA contract import/settlement and bounded disk-full recovery.

## Open gates

Private-source authentication is resolved. Generic Android post-link safety,
anonymous target-runtime qualification and license/notices review remain
publication gates. Local original-artifact availability is complete, but the
two failing Android CI jobs intentionally do not publish qualified artifacts.

Host debug and optimized builds, native canaries and fresh packed-consumer
installs pass. Both optimized runtimes also pass the funded four-schema/export
matrix. Iris's app-owned staging avoids the rewrite, but does not fix the
generic linker or qualify another application's packaging. Remaining runtime qualification is open;
historical 0.13 results are not reused as passes.

Fresh native failures include unlocked same-process signer reopen, strict
outbound Lightning and mature BTC force-close sweeping. Node crash tests also
reproduce an orphaned BTC input reservation after send preparation: the coin
remains on-chain, but spendable balance is zero. No native state was reset.

Five RustSec lockfile findings remain. rkyv/rsa are absent from the selected
normal/build graph; legacy rustls-webpki 0.101.7 is active through minreq and
esplora-client. Security applicability/remediation review remains open. Production
npm audit passes; that does not qualify native dependencies.

The [WDK release tracker](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/blob/release/rln-0.15.0-beta.3/RELEASE-0.15-TRACKER.md)
contains the full evidence, ownership, compatibility and remaining PR/issue list.
Mainnet Lightning, mainnet IFA and external-signer burn remain unsupported.
Iris, the WDK base upgrade, existing-wallet migration and physical devices are
outside this change. UPGRADE-TRACKER.md is historical 0.13 evidence.

Draft reviews: [WDK #45](https://github.com/UTEXO-Protocol/wdk-rgb-lightning/pull/45),
[Node #24](https://github.com/UTEXO-Protocol/rgb-lightning-node-nodejs/pull/24),
[Bare #22](https://github.com/UTEXO-Protocol/rgb-lightning-node-bare/pull/22).
WDK CI passes. Native source access now works; the hosted seven-target result
and remaining Android failures are recorded above. No registry package or
release tag was created. Burn support merged upstream in RLN #194 at
`f1105c207f4750a4258ae7b0df45d7e4caa04b4f`; this candidate still pins #192.
Enabling burn requires a deliberate source update, binding/API work, durable
operation recovery and a fresh qualification cycle, not only changing a flag.
