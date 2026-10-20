'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const boundary = require('../json-boundary')

test('burn preserves the merged native contract, exact u64 tokens and failures', () => {
  const calls = []
  let fail = false
  const error = new Error('Rln(InvalidBurnRecipient): recipient required for BFA')
  const native = { burn: (...args) => {
    if (fail) throw error
    calls.push(args.at(-1))
    return '{"txid":"abc","batch_transfer_idx":2147483647}'
  } }
  const node = new (facade(native).SdkNode)({})
  const request = { asset_id: 'rgb:test', amount: '18446744073709551615',
    fee_rate: '1', min_confirmations: 0 }
  for (const method of ['burn', 'burnAsset']) {
    for (const recipient of [undefined, null, 'ab'.repeat(32)]) {
      const input = { ...request, burn_recipient: recipient }
      assert.deepEqual(node[method](input), { txid: 'abc', batch_transfer_idx: 2147483647 })
      assert.match(calls.at(-1), /"amount":18446744073709551615/)
      assert.match(calls.at(-1), /"fee_rate":1/)
      assert.equal(boundary.parse(calls.at(-1)).burn_recipient, recipient)
      assert.equal(input.amount, request.amount)
    }
    fail = true
    assert.throws(() => node[method](request), error)
    fail = false
  }
})

test('burn rejects invalid or lossy values before native submission', () => {
  let calls = 0
  const native = { burn: () => { calls++; return '{}' } }
  const node = new (facade(native).SdkNode)({})
  const request = { asset_id: 'rgb:test', amount: 1, fee_rate: 1, min_confirmations: 1 }
  for (const method of ['burn', 'burnAsset']) {
    for (const field of ['amount', 'fee_rate']) {
      for (const value of [-1, 1.5, NaN, Infinity, 2 ** 64, '-1', '1.5', '1e3', '01',
        '18446744073709551616', null, undefined, {}, true]) {
        assert.throws(() => node[method]({ ...request, [field]: value }))
      }
    }
    for (const min_confirmations of [-1, 256, 1.5, '1', null]) {
      assert.throws(() => node[method]({ ...request, min_confirmations }))
    }
    for (const burn_recipient of ['', '0x' + 'ab'.repeat(32), 'ab'.repeat(31), 'gg'.repeat(32), 1]) {
      assert.throws(() => node[method]({ ...request, burn_recipient }))
    }
    assert.throws(() => node[method]({ ...request, recipient: 'ab'.repeat(32) }), /Unknown burn/)
    for (const input of [null, undefined, [], { ...request, asset_id: '' }]) {
      assert.throws(() => node[method](input))
    }
  }
  assert.equal(calls, 0)
})
const identity = require('../runtime-contract.json')

function facade (native = {}, overrides = {}) {
  const root = path.resolve(__dirname, '..')
  const binding = { getRuntimeInfo: () => JSON.stringify({ ...identity, capabilities: [], ...overrides }), ...native }
  const result = {}
  const localRequire = createRequire(path.join(root, 'index.js'))
  vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), {
    exports: result, Buffer,
    require: (id) => id === './binding' ? binding : localRequire(id)
  })
  return result
}

test('native response integers preserve exact digits beyond the safe range', () => {
  assert.equal(boundary.parse('{"amount":9007199254740993}').amount, '9007199254740993')
  assert.equal(boundary.parse('{"channel_asset_max_amount":18446744073709551615}').channel_asset_max_amount, '18446744073709551615')
  assert.equal(boundary.parse('{"short_channel_id":989560465031299073}').short_channel_id, '989560465031299073')
  assert.deepEqual(boundary.parse('[-9223372036854775808,0,1.25,1e3]'), ['-9223372036854775808', 0, 1.25, 1000])
  assert.throws(() => boundary.parse('[1e999]'), { code: 'ERR_RLN_UNSAFE_NUMBER' })
  assert.throws(() => boundary.stringify({ amount: Infinity }), { code: 'ERR_RLN_UNSAFE_NUMBER' })
})

test('compiled identity is checked before Bare handles are created', () => {
  assert.throws(() => facade({}, { rln_commit: 'old' }), /identity mismatch/)
  assert.ok(Object.isFrozen(facade().getRuntimeInfo()))
})

test('signer revocation is explicit, terminal, retryable and separate from host-handle release', () => {
  const calls = []
  const handle = {}
  let fail = true
  let revoked = false
  const { NativeExternalSigner } = facade({
    nativeExternalSignerShutdown (value) {
      assert.equal(value, handle)
      calls.push('shutdown')
      if (fail) throw new Error('revocation failed')
      revoked = true
      return '{}'
    },
    nativeExternalSignerBootstrap () {
      if (revoked) throw new Error('signer shut down')
      return '{"node_id":"fixture"}'
    },
    nativeExternalSignerDestroy () { calls.push('free') }
  })
  const signer = new NativeExternalSigner(handle)
  assert.throws(() => signer.shutdown(), /revocation failed/)
  assert.equal(signer.bootstrap().node_id, 'fixture')
  assert.equal(signer._shutdown, false)
  fail = false
  signer.shutdown()
  signer.shutdown()
  assert.throws(() => signer.bootstrap(), /shut down/)
  signer.destroy()
  signer.destroy()
  assert.deepEqual(calls, ['shutdown', 'shutdown', 'free'])

  // Ordinary host-handle disposal must not revoke state still owned by RLN.
  calls.length = 0
  const earlyDrop = new NativeExternalSigner(handle)
  earlyDrop.destroy()
  assert.deepEqual(calls, ['free'])
  assert.throws(() => earlyDrop.shutdown(), /destroyed/)
})

test('both external unlock entrypoints preserve optional Ethereum RPC and native errors', () => {
  for (const method of ['unlockWithNativeExternalSigner', 'unlockWithAttachedExternalSigner']) {
    const bindingMethod = method === 'unlockWithNativeExternalSigner'
      ? 'sdkNodeUnlockWithNativeExternalSigner' : 'sdkNodeUnlockWithAttachedExternalSigner'
    const requests = []
    const error = new Error('Rln(InvalidIndexer): Ethereum RPC unavailable')
    let fail = false
    const node = new (facade({ [bindingMethod]: (...args) => {
      if (fail) throw error
      requests.push(JSON.parse(args.at(-1)))
    } }).SdkNode)({})
    const invoke = request => method === 'unlockWithNativeExternalSigner'
      ? node[method]({ _handle: {} }, request) : node[method](request)
    for (const request of [{}, { eth_rpc_url: null }, { eth_rpc_url: 'http://127.0.0.1:29545' }]) {
      invoke(request)
      assert.deepEqual(requests.at(-1), request)
    }
    fail = true
    assert.throws(() => invoke({ eth_rpc_url: 'http://127.0.0.1:29545' }), error)
  }
})

test('local export preserves hex bytes, native paths and errors', () => {
  const calls = []
  const error = new Error('Rln(UnknownTransfer): missing consignment')
  const native = {
    getConsignment: (_node, ...args) => {
      if (args[1] === 'missing') throw error
      calls.push(args)
      return '{"bytes_hex":"00ff80"}'
    },
    getConsignmentPath: () => '{"path":"/local/wallet/transfer/consignment.rgb"}'
  }
  const node = new (facade(native).SdkNode)({})
  assert.deepEqual(node.getConsignment('asset', 'txid'), { bytes_hex: '00ff80' })
  assert.deepEqual(calls, [['asset', 'txid']])
  assert.equal(node.getConsignmentPath('asset', 'txid').path, '/local/wallet/transfer/consignment.rgb')
  assert.throws(() => node.getConsignment('asset', 'missing'), error)
})

test('released mainnet rejection propagates through Bare', () => {
  const error = new Error('Rln(LightningUnsupportedOnMainnet): Lightning unsupported on mainnet')
  const node = new (facade({ sendPayment: () => { throw error } }).SdkNode)({})
  assert.throws(() => node.sendPayment({ invoice: 'invoice' }), error)
})

test('all excluded Bare methods fail without a native implementation', () => {
  const { SdkNode, UnsupportedCapabilityError } = facade()
  const node = new SdkNode({})
  for (const method of [
    'startUnlockWithNativeExternalSigner', 'nativeOperationStatus', 'adoptNativeOperation',
    'cancelNativeOperation', 'vssDeleteAll', 'syncWallet', 'walletSnapshot', 'prepareBtcSend',
    'commitPreparedBtcSend', 'cancelBtcSendPlan', 'prepareCreateUtxos', 'commitPreparedCreateUtxos',
    'cancelCreateUtxosPlan', 'listPendingVanillaTransactions', 'listAddressReceipts',
    'prepareRgbSend',
    'commitPreparedRgbSend', 'cancelRgbSendPlan', 'listPendingRgbSendPlans'
  ]) assert.throws(() => node[method]({}), UnsupportedCapabilityError, method)
})

test('refresh preserves nulls and batch failures', () => {
  const response = { transfers: { 1: { updated_status: 'WaitingBroadcast', failure: null },
    2: { updated_status: null, failure: { name: 'Network', message: 'offline' } } } }
  const node = new (facade({ refreshTransfers: () => JSON.stringify(response) }).SdkNode)({})
  assert.deepEqual(node.refreshTransfers({}), response)
})

test('caps and unsafe inputs cannot reach Bare payment submission', () => {
  let calls = 0
  const node = new (facade({ sendPayment: () => { calls++; return '{}' } }).SdkNode)({})
  assert.throws(() => node.sendPayment({ invoice: 'invoice', max_total_routing_fee_msat: 0 }), { code: 'ERR_RLN_UNSUPPORTED_CAPABILITY' })
  assert.throws(() => node.sendPayment({ invoice: 'invoice', amt_msat: 2 ** 64 }), RangeError)
  assert.equal(calls, 0)
})

test('Bare transfer filters retain independent optionality', () => {
  const calls = []
  const node = new (facade({ listTransfers: (_node, ...args) => { calls.push(args); return '[]' } }).SdkNode)({})
  node.listTransfers()
  node.listTransfers('asset', 'txid')
  node.listTransfers({ asset_id: 'asset', txid: 'txid' })
  assert.deepEqual(calls, [[null, null], ['asset', 'txid'], ['asset', 'txid']])
})

test('Bare shutdown and destroy failures preserve retryable handles', () => {
  let shutdowns = 0
  let destroys = 0
  const handle = {}
  const node = new (facade({
    sdkNodeShutdown () { if (++shutdowns === 1) throw new Error('flush failed') },
    sdkNodeDestroy () { if (++destroys === 1) throw new Error('destroy failed') }
  }).SdkNode)(handle)
  assert.throws(() => node.shutdown(), /flush failed/)
  assert.equal(destroys, 0)
  assert.equal(node._handle, handle)
  assert.throws(() => node.shutdown(), /destroy failed/)
  assert.equal(node._handle, handle)
  node.shutdown()
  node.shutdown()
  assert.equal(node._closed, true)
  assert.equal(node._handle, null)
  assert.equal(shutdowns, 3)
})

test('approved RGB imports preserve payloads, exact metadata and native failures', () => {
  for (const method of ['importRgbContract', 'importRgbTransferConsignment']) {
    let received
    const native = { [method]: (_handle, request) => {
      received = JSON.parse(request)
      return '{"asset_id":"rgb:expected","already_imported":false,"metadata":{"max_supply":18446744073709551615}}'
    } }
    const node = new (facade(native).SdkNode)({})
    const request = method === 'importRgbContract'
      ? { contract_base64: 'YQ==', expected_asset_id: 'rgb:expected' }
      : { consignment_base64: 'YQ==', offchain_txid: 'a'.repeat(64), expected_asset_id: 'rgb:expected' }
    assert.equal(node[method](request).metadata.max_supply, '18446744073709551615')
    assert.deepEqual(received, request)
    native[method] = () => { throw new Error('invalid contract') }
    const failed = new (facade(native).SdkNode)({})
    assert.throws(() => failed[method](request), /invalid contract/)
  }
})


test('compiled VSS policy metadata is exposed read-only', () => {
  const policy = { supported: true, code: null, reason: null }
  const runtime = facade({}, { capabilities: ['vss-backup-v1'], vss_policy: policy }).getRuntimeInfo()
  assert.deepEqual(runtime.vss_policy, policy)
  assert.ok(Object.isFrozen(runtime.vss_policy))
  assert.throws(() => { runtime.vss_policy.supported = false }, TypeError)
})


test('VSS checkpoint and read-only info forward exact versions and native errors', () => {
  const payload = '{"version":9007199254740993}'
  const info = '{"backup_exists":true,"version":9007199254740993,"backup_required":false,"last_auto_backup_failed":false}'
  const node = new (facade({ sdkNodeVssBackup: () => payload, sdkNodeVssBackupInfo: () => info }).SdkNode)({})
  assert.deepEqual(node.vssBackup(), { version: '9007199254740993' })
  assert.deepEqual(node.vssBackupInfo(), { backup_exists: true, version: '9007199254740993', backup_required: false, last_auto_backup_failed: false })
})


test('restore preparation and local provenance preserve native bounded receipt', () => {
  const receipt = { restored: true, status: 'restored', network: 'signet', node_id: '02' + '11'.repeat(32), master_fingerprint: 'a1b2c3d4', version: 7 }
  const node = new (facade({ sdkNodePrepareVssRestore: () => JSON.stringify(receipt), sdkNodeVssRestoreInfo: () => JSON.stringify({ ...receipt, unlocked: false }) }).SdkNode)({})
  assert.deepEqual(node.prepareVssRestore(), receipt)
  assert.deepEqual(node.vssRestoreInfo(), { ...receipt, unlocked: false })
})


test('automatic backup policy is boolean-only and completion metadata preserves exact versions', () => {
 const metadata = '{"schema_version":1,"automatic_backup_enabled":true,"last_backup":{"version":9007199254740993,"completed_at_ms":1792391012345,"network":"signet","vss_url":"https://example.com/vss","node_id":"node"}}'
 const calls = []
 let failure = false
 const set = raw => { calls.push(JSON.parse(raw)); if (failure) throw new Error('native policy failed'); return JSON.stringify({ automatic_backup_enabled: JSON.parse(raw).enabled }) }
 const node = new (facade({ sdkNodeVssBackupMetadata: () => metadata, sdkNodeSetVssAutomaticBackupEnabled: (_handle, raw) => set(raw) }).SdkNode)({})
 assert.equal(node.vssBackupMetadata().last_backup.version, '9007199254740993')
 assert.equal(node.vssBackupMetadata().last_backup.completed_at_ms, 1792391012345)
 assert.deepEqual(node.setVssAutomaticBackupEnabled(false), { automatic_backup_enabled: false })
 assert.deepEqual(node.setVssAutomaticBackupEnabled(true), { automatic_backup_enabled: true })
 assert.deepEqual(calls, [{ enabled: false }, { enabled: true }])
 for (const value of [null,undefined,0,1,'false','true',{},[]]) assert.throws(() => node.setVssAutomaticBackupEnabled(value), /must be a boolean/)
 assert.equal(calls.length, 2)
 failure = true
 assert.throws(() => node.setVssAutomaticBackupEnabled(false), /native policy failed/)
})
