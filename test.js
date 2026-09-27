'use strict'

const assert = {
  equal (a, b) { if (a !== b) throw new Error('Values differ: ' + a + ' != ' + b) },
  ok (value) { if (!value) throw new Error('Expected truthy value') },
  match (value, pattern) { if (!pattern.test(value)) throw new Error('Pattern mismatch') },
  deepEqual (a, b) { this.equal(JSON.stringify(a), JSON.stringify(b)) },
  throws (fn, expected) {
    let caught
    try { fn() } catch (error) { caught = error }
    if (!caught) throw new Error('Expected failure')
    if (expected instanceof RegExp && !expected.test(caught.message)) throw caught
    if (expected?.code && expected.code !== caught.code) throw caught
  }
}
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { NativeExternalSigner, SdkNode, getRuntimeInfo } = require('./index')
const expected = require('./runtime-contract.json')
const info = getRuntimeInfo()
assert.equal(info.rln_commit, expected.rln_commit)
assert.equal(info.adapter_sha256, expected.adapter_sha256)
assert.equal(info.wrapper_sha256, expected.wrapper_sha256)
assert.equal(info.lock_sha256, expected.lock_sha256)
assert.ok(info.capabilities.includes('persistent-native-signer'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-bare-release-canary-'))
const signerDir = path.join(root, 'signer')
const nodeDir = path.join(root, 'node')
let signer
let node
let bootstrap
try {
  // Public deterministic fixture seed: this wallet must never be funded.
  signer = NativeExternalSigner.createWithStorage('01'.repeat(32), 'regtest', signerDir)
  bootstrap = signer.bootstrap()
  assert.match(bootstrap.node_id, /^(02|03)[a-f0-9]{64}$/)
  node = SdkNode.create({
    storage_dir_path: nodeDir,
    daemon_listening_port: 0,
    ldk_peer_listening_port: 0,
    network: 'regtest',
    max_media_upload_size_mb: 5,
    enable_virtual_channels_v0: false,
    reuse_addresses: true
  })
  assert.throws(() => node.apayNewWithAddress('02'.repeat(33), 'canary', 'example.com'), /NotInitialized/)
  for (const method of ['syncWallet', 'walletSnapshot', 'prepareBtcSend', 'vssDeleteAll']) {
    assert.throws(() => node[method]({}), { code: 'ERR_RLN_UNSUPPORTED_CAPABILITY' })
  }
  const raw = require('./binding')
  for (const invalid of [undefined, null, {}, 1, 'node']) {
    assert.throws(() => raw.nodeInfo(invalid))
    assert.throws(() => raw.nativeExternalSignerDestroy(invalid))
  }
  assert.throws(() => raw.nodeInfo(signer._handle))
  assert.throws(() => raw.nativeExternalSignerBootstrap(node._handle))
  assert.throws(() => raw.nativeExternalSignerDestroy(node._handle))
  assert.throws(() => raw.sdkNodeDestroy(signer._handle))
  assert.throws(() => raw.nativeExternalSignerNew('01'.repeat(32), 'regtest', 'false'))
  assert.throws(() => raw.signMessage(node._handle, 42))
  assert.throws(() => raw.signMessage(node._handle, 'bad\\0value'))
  assert.throws(() => raw.btcBalance(node._handle, 0))
  for (const value of [-1, 0, 65536, 1.5, NaN, Infinity, '1']) {
    assert.throws(() => raw.estimateFee(node._handle, value))
  }
  node.initWithNativeExternalSigner(signer)
  assert.throws(() => node.unlockWithNativeExternalSigner(signer, {}), /ldk_chain_sync/)
  assert.throws(() => node.sendPayment({ invoice: 'unused', max_total_routing_fee_msat: 0 }), {
    code: 'ERR_RLN_UNSUPPORTED_CAPABILITY'
  })
  node.shutdown()
  node.shutdown()
  node = undefined
  signer.destroy()
  signer.destroy()
  assert.throws(() => signer.bootstrap(), /destroyed/)
  signer = NativeExternalSigner.createWithStorage('01'.repeat(32), 'regtest', signerDir)
  assert.deepEqual(signer.bootstrap(), bootstrap)
  assert.equal(fs.statSync(signerDir).mode & 0o777, 0o700)
  assert.throws(() => NativeExternalSigner.create('01'.repeat(32), 'mainnet', true))
} finally {
  if (node) node.shutdown()
  if (signer) signer.destroy()
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('Native identity, offline init, errors, disposal and persistent signer reopen passed.')
