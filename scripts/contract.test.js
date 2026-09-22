'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const boundary = require('../json-boundary')
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

test('unsafe native JSON cannot become an exact wallet balance', () => {
  assert.throws(() => boundary.parse('{"amount":9007199254740993}'), { code: 'ERR_RLN_UNSAFE_NUMBER' })
  assert.throws(() => boundary.stringify({ amount: Infinity }), { code: 'ERR_RLN_UNSAFE_NUMBER' })
})

test('compiled identity is checked before Bare handles are created', () => {
  assert.throws(() => facade({}, { rln_commit: 'old' }), /identity mismatch/)
  assert.ok(Object.isFrozen(facade().getRuntimeInfo()))
})

test('all excluded Bare methods fail without a native implementation', () => {
  const { SdkNode, UnsupportedCapabilityError } = facade()
  const node = new SdkNode({})
  for (const method of [
    'startUnlockWithNativeExternalSigner', 'nativeOperationStatus', 'adoptNativeOperation',
    'cancelNativeOperation', 'vssDeleteAll', 'syncWallet', 'walletSnapshot', 'prepareBtcSend',
    'commitPreparedBtcSend', 'cancelBtcSendPlan', 'prepareCreateUtxos', 'commitPreparedCreateUtxos',
    'cancelCreateUtxosPlan', 'listPendingVanillaTransactions', 'listAddressReceipts',
    'importRgbTransferConsignment', 'importRgbContract', 'prepareRgbSend',
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
