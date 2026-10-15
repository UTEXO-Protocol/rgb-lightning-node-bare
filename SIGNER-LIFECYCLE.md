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

The compiled capabilities `native-signer-shutdown-v1` and
`owned-session-cleanup-v1` identify this implementation. Artifact admission must
reject the older overlay and stale wrapper binaries. Build success alone does
not establish that cleanup or repeated lock/unlock works: retain actual native
same-store reopen, operating-system resource and funded mobile evidence.

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
