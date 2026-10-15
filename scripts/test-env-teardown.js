'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const pack = require('bare-pack')
const packFs = require('bare-pack/fs')
const { resolve } = require('bare-module-traverse')

async function main () {
  const root = path.resolve(__dirname, '..')
  const nativeRoot = process.argv[2] ? path.resolve(process.argv[2]) : root
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-env-worker-bundle-'))
  try {
    const entry = path.join(directory, 'worker.cjs')
    const worker = fs.readFileSync(path.join(root, 'tests/environment/worker.cjs'), 'utf8')
      .replace("'__BARE_FS__'", JSON.stringify(require.resolve('bare-fs')))
      .replace("'__NATIVE_PACKAGE__'", JSON.stringify(nativeRoot))
    fs.writeFileSync(entry, worker)
    const bundle = await pack(pathToFileURL(entry), {
      resolve: resolve.bare, hosts: [process.platform + '-' + process.arch]
    }, packFs.readModule, packFs.listPrefix)
    const source = path.join(directory, 'worker.bundle')
    fs.writeFileSync(source, bundle.toBuffer())
    execFileSync(process.execPath, [
      path.join(path.dirname(require.resolve('bare-runtime/package')), 'bin/bare'),
      path.join(root, 'tests/environment/main.cjs'), source, nativeRoot
    ], { stdio: 'inherit', timeout: 120000 })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
