'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { ensureOverlayArtifacts, nativeArtifactInstallMode, readOverlayConfig, resolveInstallTargets } = require('./native-overlay')
const { hydrateDistribution } = require('./native-distribution')
const packageRoot = path.resolve(__dirname, '..')

function requestedPlatform (args) {
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--platform') throw new Error('usage: prepare-native [--platform android|ios|darwin|apple|all]')
  return args[1]
}

try {
  if (nativeArtifactInstallMode(process.env) === 'js-only') {
    console.log('[rgb-lightning-node-bare] Native installation skipped for JS-only tooling; no wallet runtime is available.')
  } else {
    const config = readOverlayConfig(packageRoot)
    if (!config) throw new Error('Missing approved native source manifest; no fallback download is permitted')
    const targets = resolveInstallTargets(config, process.env, process.platform, requestedPlatform(process.argv.slice(2)))
    // Installed consumers may skip lifecycle scripts before invoking this
    // existing preparation entry point. Assemble the required data dependency
    // first; a bad payload must never fall through to a private source build.
    // Explicit source checkouts/imports retain their original preparation path.
    if (!fs.existsSync(path.join(packageRoot, '.git')) &&
        !process.env.RLN_BARE_ARTIFACTS_DIR && !process.env.RLN_BARE_SOURCE_DIR) {
      const prepared = hydrateDistribution(packageRoot)
      console.log('[rgb-lightning-node-bare] Verified packed prebuilds: ' + prepared.join(', '))
    }
    ensureOverlayArtifacts(packageRoot, config, targets, process.env)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
