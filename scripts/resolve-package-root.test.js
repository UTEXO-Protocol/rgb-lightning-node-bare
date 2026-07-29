'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { resolvePackageRoot } = require('./resolve-package-root')

test('resolves a dependency hoisted above the installed package', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'utexo-package-root-'))
  t.after(() => fs.rmSync(workspace, { force: true, recursive: true }))

  const dependencyRoot = path.join(
    workspace,
    'node_modules',
    'example-dependency'
  )
  const installedPackageRoot = path.join(
    workspace,
    'node_modules',
    '@utexo',
    'rgb-lightning-node-bare'
  )
  fs.mkdirSync(dependencyRoot, { recursive: true })
  fs.mkdirSync(installedPackageRoot, { recursive: true })
  fs.writeFileSync(
    path.join(dependencyRoot, 'package.json'),
    JSON.stringify({ name: 'example-dependency', version: '1.0.0' })
  )

  assert.equal(
    fs.realpathSync(
      resolvePackageRoot('example-dependency', installedPackageRoot)
    ),
    fs.realpathSync(dependencyRoot)
  )
})

test('rejects invalid resolver inputs', () => {
  assert.throws(() => resolvePackageRoot('', process.cwd()), TypeError)
  assert.throws(() => resolvePackageRoot('cmake-bare', ''), TypeError)
})
