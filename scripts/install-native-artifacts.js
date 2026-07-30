'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  ensureOverlayArtifacts,
  nativeArtifactInstallMode,
  readOverlayConfig,
  resolveInstallTargets
} = require('./native-overlay')

const packageRoot = path.resolve(__dirname, '..')

function requestedPlatform (args) {
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--platform') {
    throw new Error(
      'usage: node scripts/install-native-artifacts.js [--platform android|ios|darwin|apple|all]'
    )
  }
  return args[1]
}

try {
  const installMode = nativeArtifactInstallMode(process.env)
  if (installMode === 'js-only') {
    console.log(
      '[rgb-lightning-node-bare] Native artifact installation explicitly skipped for JS-only tooling.'
    )
  } else {
    const overlay = readOverlayConfig(packageRoot)
    if (overlay) {
      const targets = resolveInstallTargets(
        overlay,
        process.env,
        process.platform,
        requestedPlatform(process.argv.slice(2))
      )
      ensureOverlayArtifacts(packageRoot, overlay, targets, process.env)
    } else {
      const result = spawnSync('bash', [path.join(__dirname, 'download-libs.sh')], {
        cwd: packageRoot,
        env: process.env,
        stdio: 'inherit'
      })
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(`release asset installer exited with status ${result.status}`)
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
