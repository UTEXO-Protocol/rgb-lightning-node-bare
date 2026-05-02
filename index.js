/**
 * @utexo/rgb-lightning-node-bare — JS façade for the canary slice of the
 * rgb-lightning-node C-FFI.
 */

const binding = require('./binding')

// Module-level helpers
exports.uniffiHealthcheck = function () {
  return binding.uniffiHealthcheck()
}

exports.uniffiIsInitialized = function () {
  // Native returns "true" / "false" string; convert to bool.
  return binding.uniffiIsInitialized() === 'true'
}

// Lifecycle
//
// Usage:
//   const node = SdkNode.create({ ...JsonSdkInitRequest })
//   const mnemonic = node.init('password', undefined)   // optional mnemonic
//   node.unlock({ ...JsonSdkUnlockRequest })
//   const info = node.nodeInfo()
//   node.shutdown()
//
// `node` is an opaque handle (JS external); the GC destructor calls
// rln_sdk_node_shutdown + free_sdk_node automatically, but explicit
// shutdown() is recommended.
class SdkNode {
  constructor (handle) {
    this._handle = handle
    this._closed = false
  }

  static create (request) {
    const handle = binding.sdkNodeNew(JSON.stringify(request))
    return new SdkNode(handle)
  }

  init (password, mnemonic) {
    return binding.sdkNodeInit(this._handle, password, mnemonic ?? null)
  }

  unlock (request) {
    binding.sdkNodeUnlock(this._handle, JSON.stringify(request))
  }

  shutdown () {
    if (this._closed) return
    binding.sdkNodeShutdown(this._handle)
    this._closed = true
  }

  nodeInfo () {
    return JSON.parse(binding.nodeInfo(this._handle))
  }
}

exports.SdkNode = SdkNode
