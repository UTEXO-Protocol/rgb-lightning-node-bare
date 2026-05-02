/**
 * Canary 1 smoke test. Run with: bare test.js
 *
 * 1. Calls uniffiHealthcheck() and uniffiIsInitialized() — exercises the
 *    extern "C" boundary without standing up a node.
 * 2. Creates an SdkNode against a temp dir and shuts it down — exercises
 *    NodeHandle::new + the tokio runtime + clean shutdown.
 *
 * Step 2 is the load-bearing canary: it proves LDK initialisation +
 * the static tokio runtime work inside a bare runtime.
 */

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const { uniffiHealthcheck, uniffiIsInitialized, SdkNode } = require('./index')

function fail (msg) {
  console.error('✗', msg)
  process.exit(1)
}

console.log('=== Canary 1: rgb-lightning-node-bare smoke test ===')

// ─── Step 1: extern "C" boundary ──────────────────────────────────────────
const hc = uniffiHealthcheck()
console.log('healthcheck:', hc)
if (hc !== 'rgb_lightning_node_uniffi_ready') fail('unexpected healthcheck output')

const initialised = uniffiIsInitialized()
console.log('isInitialized:', initialised)
if (typeof initialised !== 'boolean') fail('isInitialized should return bool')

// ─── Step 2: spin up an SdkNode (tokio + LDK boot) ────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-canary-'))
console.log('dataDir:', dataDir)

let node
try {
  node = SdkNode.create({
    storage_dir_path: dataDir,
    daemon_listening_port: 0,        // 0 = let OS pick (we don't unlock here)
    ldk_peer_listening_port: 0,
    network: 'regtest',
    max_media_upload_size_mb: 5,
    enable_virtual_channels_v0: false
  })
  console.log('✓ SdkNode created')
} catch (e) {
  fail(`SdkNode.create threw: ${e.message}`)
}

try {
  node.shutdown()
  console.log('✓ SdkNode shutdown clean')
} catch (e) {
  fail(`shutdown threw: ${e.message}`)
}

console.log('\n✅ Canary 1 PASSED — bare ↔ C-FFI ↔ tokio ↔ LDK boot OK')
