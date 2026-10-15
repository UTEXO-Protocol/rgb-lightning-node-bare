'use strict'

const path = require('node:path')
const { nativeArtifactInstallMode } = require('./native-overlay')
const { hydrateDistribution } = require('./native-distribution')

try {
  if (nativeArtifactInstallMode(process.env) === 'js-only') {
    console.log('[rgb-lightning-node-bare] Native installation skipped for JS-only tooling; no wallet runtime is available.')
  } else {
    const targets = hydrateDistribution(path.resolve(__dirname, '..'))
    console.log('[rgb-lightning-node-bare] Verified packed prebuilds: ' + targets.join(', '))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
