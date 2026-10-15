# Explicit signer shutdown and owned sessions

This candidate embeds RLN `v0.17.0-beta.3` at
`ecc69f20308231400561f6f060fea88acfa40cc4`, with the exact shared overlay in
`patches/release-adapter-v0.17.0-beta.3.patch`. The overlay now includes native
lifecycle repairs as well as the C adapter. It is not an unmodified upstream
binary. `utexoNativeOverlay.patchSha256`, `runtime-contract.json`, the compiled
build information and artifact sidecars bind that complete source change.

## Required host order

Drain application operations, shut down every node using the signer, explicitly
revoke the signer, then release its host handle:

```js
node.shutdown()
signer.shutdown()
signer.destroy()
```

`signer.shutdown()` is terminal and idempotent. It closes admission to new
signer calls, waits for calls already holding the native state guard and drops
both backend and transport while holding an exclusive guard. Outstanding native
clones become unusable. This releases the persistent VLS/redb store without
waiting for wrapper garbage collection. Poisoned-state recovery revokes state
instead of silently skipping cleanup.

`destroy()` and garbage collection release only the caller's handle. Existing
callers may still release that handle after attach/init/unlock while RLN owns
its native clone. They do not revoke a running wallet. Keep the handle until
shutdown when explicit revocation is required. Never revoke before attached
nodes finish their final persistence operations.

WDK performs this order and reports teardown errors. A failed step retains the
handles needed for teardown retry and blocks further wallet operations. Do not
silence a shutdown failure, delete signer files or open a replacement wallet
while the old session is still stopping.

## Native cleanup

The shared runtime patch owns session workers, cancellation and completion;
releases the actual inbound listener even when configured with port zero;
removes strong gossip-verifier feedback cycles; and drains worker/connection
resources during teardown. Critical persistence and broadcast completions must
remain admitted until final background-processor persistence has finished.
Partial startup also owns and cleans up resources it has already created.
Terminal shutdown explicitly closes the metadata database pool on its owning
runtime, so parked SQLx connection-return work cannot retain a SQLite file after
close. An ordinary REST wallet lock keeps its database available for unlocking.

The compiled capabilities `native-signer-shutdown-v1` and
`owned-session-cleanup-v1` identify this implementation. Artifact admission must
reject the older overlay and stale wrapper binaries. Build success alone does
not establish that cleanup or repeated lock/unlock works: retain actual native
same-store reopen, operating-system resource and funded mobile evidence.

## Terminal environment follow-up

Bare `95e2c844dc2c76e3f83d6f1a0dcf76d74f17fef7` adds same-environment
terminal signer ownership cleanup; wrapper SHA-256 is
`ca3ac291fbb4af86fc0d091805f9f544031298f6ce94a66b99f8f1acd763d4f7`.
An external-object GC finalizer need not run when a worker terminates. Terminal
cleanup therefore drains that environment's nodes before revoking/freeing its
signers; ordinary GC remains ownership-only and other environments remain usable.
The shared native overlay and upstream dependency graph are unchanged.

The [dated follow-up](NATIVE-UPGRADE-20261015.md#environment-and-erasure-follow-up)
records 100 local full-node terminations, the new seven-target CI build, and
Iris's separate cold authorized-journal recovery plus three first-attempt
erasures. Five actual full Metro reloads on an unfunded wallet also pass in one
process (`1/2/1` → `0/0/0` → authenticated same-store `1/2/1`), as does fresh
BTC/BFA receive/send and another full reload before BFA acknowledgment. Three
funded manual cycles, short/long background, funded cold restart and final
history/refresh checks also pass.
Arbitrary crash recovery remains unqualified; worker tests and mobile
compilation do not substitute for app acceptance.

## Qualification boundaries

Iris remains on-chain only. This change does not enable Lightning in Iris or
qualify channel payments, force closes, VSS failure recovery or other existing
release gates. Iris has not shipped; wallet migration is not a requirement.
Fresh local simulator wallets may be reset for testing. Persistence across
lock/unlock and process restarts remains required and must be tested without
resetting the store between those steps.

No merge or publication is part of this change. Current qualification results
are recorded in the release tracker with their exact source and artifact
identities.
