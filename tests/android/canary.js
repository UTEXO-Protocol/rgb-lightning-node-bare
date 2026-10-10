const { NativeExternalSigner, getRuntimeInfo } = require('../..')
const fs = require('bare-fs')
const os = require('bare-os')

BareKit.on('push', (input, reply) => {
  let signer
  try {
    const { storage } = JSON.parse(input.toString())
    const runtime = getRuntimeInfo()
    // Public deterministic fixture seed. Never fund this wallet.
    signer = NativeExternalSigner.createWithStorage('01'.repeat(32), 'regtest', storage)
    const bootstrap = signer.bootstrap()
    if (!/^(02|03)[a-f0-9]{64}$/.test(bootstrap.node_id)) throw new Error('Invalid signer bootstrap')
    if ((fs.statSync(storage).mode & 0o777) !== 0o700) throw new Error('Signer storage is not private')
    if (os.platform() !== 'android') throw new Error('Wrong runtime platform')
    signer.destroy()
    signer = null
    reply(null, JSON.stringify({ ok: true, runtime, nodeId: bootstrap.node_id, privateStorage: true, platform: os.platform() }))
  } catch (error) {
    if (signer) signer.destroy()
    reply(null, JSON.stringify({ ok: false, error: String(error) }))
  }
})
