/**
 * Canary 1 smoke test. Run with: bare test.js
 *
 * 1. Calls uniffiHealthcheck() and uniffiIsInitialized() — exercises the
 *    extern "C" boundary without standing up a node.
 * 2. Creates an SdkNode against a temp dir and shuts it down — exercises
 *    NodeHandle::new + the tokio runtime + clean shutdown.
 * 3. Builds a NativeExternalSigner, reads its bootstrap, initialises a
 *    fresh SdkNode against it, then shuts the node down — proves the
 *    external-signer boundary (VLS in-process signer + Arc handoff)
 *    works through the C-FFI on bare.
 */

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const {
  uniffiHealthcheck,
  uniffiIsInitialized,
  SdkNode,
  NativeExternalSigner
} = require('./index')

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
    enable_virtual_channels_v0: false,
    reuse_addresses: true
  })
  for (const method of [
    'rotateAddress',
    'listTransactionsByTxid',
    'listTransfersByTxid',
    'verifyMessage'
  ]) {
    if (typeof node[method] !== 'function') fail(`SdkNode.${method} is missing`)
  }
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

// ─── Step 3: external-signer boundary ─────────────────────────────────────
// A throwaway 32-byte seed (all-zero is rejected by some VLS validators, so
// use a deterministic non-zero pattern instead).
const SEED_HEX = '01'.repeat(32)
let signer
try {
  signer = NativeExternalSigner.create(SEED_HEX, 'regtest')
  console.log('✓ NativeExternalSigner created')
} catch (e) {
  fail(`NativeExternalSigner.create threw: ${e.message}`)
}

let bootstrap
try {
  bootstrap = signer.bootstrap()
  console.log('✓ bootstrap()',
    `node_id=${bootstrap.node_id.slice(0, 16)}…`,
    `xpub_van=${bootstrap.account_xpub_vanilla.slice(0, 16)}…`,
    `api_level=${bootstrap.api_level}`)
  for (const key of [
    'node_id', 'account_xpub_vanilla', 'account_xpub_colored',
    'master_fingerprint', 'protocol_version', 'api_level'
  ]) {
    if (bootstrap[key] === undefined) fail(`bootstrap missing field: ${key}`)
  }
} catch (e) {
  fail(`bootstrap() threw: ${e.message}`)
}

const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-canary-signer-'))
let node2
try {
  node2 = SdkNode.create({
    storage_dir_path: dataDir2,
    daemon_listening_port: 0,
    ldk_peer_listening_port: 0,
    network: 'regtest',
    max_media_upload_size_mb: 5,
    enable_virtual_channels_v0: false,
    reuse_addresses: true
  })
  console.log('✓ SdkNode created for signer canary')
} catch (e) {
  fail(`SdkNode.create (signer canary) threw: ${e.message}`)
}

try {
  node2.initWithNativeExternalSigner(signer)
  console.log('✓ initWithNativeExternalSigner — key source written to disk')
} catch (e) {
  fail(`initWithNativeExternalSigner threw: ${e.message}`)
}

try {
  const wrongSigner = NativeExternalSigner.create('02'.repeat(32), 'regtest')
  let mismatch
  try {
    node2.unlockWithNativeExternalSigner(wrongSigner, {})
  } catch (error) {
    mismatch = error
  } finally {
    wrongSigner.destroy()
  }
  if (!String(mismatch && mismatch.message ? mismatch.message : mismatch).includes('Rln(ExternalSignerMismatch)')) {
    fail(`unexpected signer mismatch error: ${mismatch}`)
  }
  console.log('✓ signer mismatch retains the typed C-FFI error tag')
} catch (e) {
  fail(`signer mismatch check threw: ${e.message}`)
}

try {
  const result = node2.verifyMessage(
    'is this compatible?',
    'rbgfioj114mh48d8egqx8o9qxqw4fmhe8jbeeabdioxnjk8z3t1ma1hu1fiswpakgucwwzwo6ofycffbsqusqdimugbh41n1g698hr9t'
  )
  if (!result || typeof result.valid !== 'boolean') {
    fail('verifyMessage should return { valid: boolean }')
  }
  console.log('✓ verifyMessage works while the external-signer node is locked')
} catch (e) {
  fail(`verifyMessage threw: ${e.message}`)
}

try {
  node2.shutdown()
  console.log('✓ signer canary SdkNode shutdown clean')
} catch (e) {
  fail(`signer canary shutdown threw: ${e.message}`)
}

console.log('\n✅ Canary 1 PASSED — bare ↔ C-FFI ↔ tokio ↔ LDK boot + external signer OK')
