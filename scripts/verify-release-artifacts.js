'use strict'

const path = require('node:path')
const { readOverlayConfig, verifyPackedPrebuilds } = require('./native-overlay')

function verifyReleaseArtifacts (root = path.resolve(__dirname, '..')) {
  const config = readOverlayConfig(root)
  if (config.buildProfile !== 'release') throw new Error('Debug prebuilds cannot be published')
  verifyPackedPrebuilds(root, config, config.targets)
}

if (require.main === module) {
  verifyReleaseArtifacts()
  console.log('Verified release prebuilds for all seven Bare targets; publication is a separate action.')
}
module.exports = { verifyReleaseArtifacts }
