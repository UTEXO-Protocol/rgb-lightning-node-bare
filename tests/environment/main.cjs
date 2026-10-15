'use strict'
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const args = Bare.argv.slice(2)
const native = require(args[1])
const source = fs.readFileSync(args[0])
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-environment-test-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (value, message) => { if (!value) throw new Error(message) }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function main () {
  // A different live environment must stay usable through every worker exit.
  const guard = native.NativeExternalSigner.createWithStorage('36'.repeat(32), 'regtest', path.join(root, 'guard'), false)
  const identity = guard.bootstrap()
  const rows = []
  try {
    for (const mode of ['signer-only', 'node-first', 'signer-first', 'host-free', 'graceful', 'multiple-signers']) {
      for (let cycle = 1; cycle <= 3; cycle++) {
        const directory = path.join(root, mode + '-' + cycle)
        fs.mkdirSync(directory)
        const thread = new Bare.Thread('bare:/rln-env-worker.bundle', { source, data: { directory, mode } })
        try {
          const ready = path.join(directory, 'ready.json')
          const deadline = Date.now() + 15000
          while (!fs.existsSync(ready)) {
            assert(Date.now() < deadline, 'Worker startup timed out: ' + mode)
            await sleep(10)
          }
          const result = JSON.parse(fs.readFileSync(ready, 'utf8'))
          assert(result.status === 'ready', result.error || 'Worker not ready')
          assert(equal(result.runtimeInfo, native.getRuntimeInfo()), 'Worker native identity differs')
          thread.terminate()
          thread.join()
          const signer = native.NativeExternalSigner.createWithStorage('35'.repeat(32), 'regtest', path.join(directory, 'signer'), false)
          assert(equal(signer.bootstrap(), result.bootstrap), 'Persistent signer identity changed')
          signer.shutdown()
          signer.destroy()
          if (result.secondBootstrap) {
            const second = native.NativeExternalSigner.createWithStorage('37'.repeat(32), 'regtest', path.join(directory, 'signer2'), false)
            assert(equal(second.bootstrap(), result.secondBootstrap), 'Second signer identity changed')
            second.shutdown()
            second.destroy()
          }
          assert(equal(guard.bootstrap(), identity), 'Worker teardown revoked another environment')
          rows.push({ mode, cycle, immediateReopen: true, otherEnvironmentAlive: true })
        } finally {
          if (!thread.joined) { thread.terminate(); thread.join() }
        }
      }
    }
  } finally {
    guard.shutdown()
    guard.destroy()
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ status: 'passed', environmentTerminations: rows.length, financialCalls: 0, rows }))
}
main().catch(error => { console.error(error.stack || error); Bare.exitCode = 1 })
