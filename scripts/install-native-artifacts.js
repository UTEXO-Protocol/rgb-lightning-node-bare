'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  ensureOverlayArtifacts,
  nativeArtifactInstallMode,
  readOverlayConfig
} = require('./native-overlay')

const packageRoot = path.resolve(__dirname, '..')

try {
  const installMode = nativeArtifactInstallMode(process.env)
  if (installMode === 'js-only') {
    console.log(
      '[rgb-lightning-node-bare] Native artifact installation explicitly skipped for JS-only tooling.'
    )
  } else {
    const overlay = readOverlayConfig(packageRoot)
    if (overlay) {
      ensureOverlayArtifacts(packageRoot, overlay)
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
