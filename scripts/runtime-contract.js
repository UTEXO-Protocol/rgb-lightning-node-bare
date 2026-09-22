'use strict'

const fs = require('node:fs')
const path = require('node:path')
const contract = require('./release-contract')

const WRAPPER_FILES = ['index.js', 'index.d.ts', 'json-boundary.js', 'binding.js', 'binding.cc', 'rln.h', 'CMakeLists.txt']

function runtimeIdentity (root, config) {
  return {
    abi_version: 1,
    rln_version: config.ref.slice(1),
    rln_commit: config.commit,
    lightning_commit: config.lightningCommit,
    adapter_sha256: config.patchSha256,
    wrapper_sha256: contract.wrapperSha256(root, WRAPPER_FILES),
    lock_sha256: config.cffiLockSha256
  }
}

function verifyRuntimeContract (root, config) {
  const expected = runtimeIdentity(root, config)
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'runtime-contract.json'), 'utf8'))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Runtime contract is stale; regenerate with node scripts/runtime-contract.js and review before building')
  }
  return expected
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const config = require(path.join(root, 'package.json')).utexoNativeOverlay
  fs.writeFileSync(path.join(root, 'runtime-contract.json'), JSON.stringify(runtimeIdentity(root, config), null, 2) + '\n')
}
module.exports = { runtimeIdentity, verifyRuntimeContract, WRAPPER_FILES }
