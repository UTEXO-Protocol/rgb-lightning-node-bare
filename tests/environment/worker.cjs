'use strict'
// The runner resolves these to immutable absolute paths before packing.
const fs = require('__BARE_FS__')
const native = require('__NATIVE_PACKAGE__')
const { directory, mode } = Bare.Thread.self.data
const report = { mode, financialCalls: 0, runtimeInfo: native.getRuntimeInfo() }

try {
  const request = {
    storage_dir_path: directory + '/wallet', network: 'regtest',
    daemon_listening_port: 0, ldk_peer_listening_port: 0,
    max_media_upload_size_mb: 5, enable_virtual_channels_v0: false,
    reuse_addresses: true
  }
  // Public test entropy. No address, invoice, sync or payment is requested.
  if (mode === 'node-first') global.node = native.SdkNode.create(request)
  global.signer = native.NativeExternalSigner.createWithStorage('35'.repeat(32), 'regtest', directory + '/signer', false)
  report.bootstrap = global.signer.bootstrap()
  if (mode !== 'signer-only') {
    if (!global.node) global.node = native.SdkNode.create(request)
    global.node.initWithNativeExternalSigner(global.signer)
    global.node.attachNativeExternalSigner(global.signer)
  }
  if (mode === 'multiple-signers') {
    global.secondSigner = native.NativeExternalSigner.createWithStorage('37'.repeat(32), 'regtest', directory + '/signer2', false)
    report.secondBootstrap = global.secondSigner.bootstrap()
  }
  if (mode === 'host-free') {
    global.signer.destroy()
    global.signer = null
  }
  if (mode === 'graceful') {
    global.node.shutdown()
    global.signer.shutdown()
    global.signer.destroy()
  }
  report.status = 'ready'
} catch (error) {
  report.status = 'failed'
  report.error = String(error.stack || error)
}
fs.writeFileSync(directory + '/ready.tmp', JSON.stringify(report))
fs.renameSync(directory + '/ready.tmp', directory + '/ready.json')
// Keep live JS references; parent termination must not depend on GC/dispose.
setInterval(() => {}, 1000)
