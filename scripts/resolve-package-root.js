'use strict'

const path = require('node:path')

function resolvePackageRoot (packageName, fromDirectory) {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new TypeError('packageName must be a non-empty string')
  }
  if (typeof fromDirectory !== 'string' || fromDirectory.length === 0) {
    throw new TypeError('fromDirectory must be a non-empty string')
  }

  const manifest = require.resolve(`${packageName}/package.json`, {
    paths: [fromDirectory]
  })
  return path.dirname(manifest)
}

if (require.main === module) {
  const [, , packageName, fromDirectory = process.cwd()] = process.argv
  process.stdout.write(resolvePackageRoot(packageName, fromDirectory))
}

module.exports = { resolvePackageRoot }
