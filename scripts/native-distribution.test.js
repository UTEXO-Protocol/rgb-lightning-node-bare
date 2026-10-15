'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { artifactPaths, readOverlayConfig, writeArtifactManifest } = require('./native-overlay')
const { IOS_TARGETS, PAYLOAD_NAME, hydrateDistribution, stageIosPayload, verifyDistribution } = require('./native-distribution')
const source = path.resolve(__dirname, '..')
let priorDebug
test.beforeEach(() => { priorDebug = process.env.RLN_BARE_DEBUG; delete process.env.RLN_BARE_DEBUG })
test.afterEach(() => {
  if (priorDebug === undefined) delete process.env.RLN_BARE_DEBUG
  else process.env.RLN_BARE_DEBUG = priorDebug
})

function fixture (context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-distribution-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of ['package.json', 'runtime-contract.json', 'index.js', 'index.d.ts', 'json-boundary.js', 'binding.js', 'binding.cc', 'rln.h', 'CMakeLists.txt']) fs.copyFileSync(path.join(source, file), path.join(root, file))
  fs.cpSync(path.join(source, 'patches'), path.join(root, 'patches'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'))
  for (const file of ['native-overlay.js', 'build-cffi.sh', 'build-prebuilds.sh', 'release-contract.js', 'runtime-contract.js', 'android-elf.js', 'native-distribution.js', 'verify-release-artifacts.js', 'install-native-artifacts.js']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(root, 'scripts', file))
  const payload = path.join(root, 'native', 'ios')
  fs.mkdirSync(payload, { recursive: true })
  fs.copyFileSync(path.join(source, 'native', 'ios', 'package.json'), path.join(payload, 'package.json'))
  const config = readOverlayConfig(root)
  for (const target of config.targets) {
    for (const [kind, file] of Object.entries(artifactPaths(root, target))) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'Public test fixture ' + target + '/' + kind)
    }
  }
  writeArtifactManifest(root, config, config.targets)
  stageIosPayload(root)
  const scope = path.join(root, 'node_modules', '@utexo')
  fs.mkdirSync(scope, { recursive: true })
  fs.symlinkSync(payload, path.join(scope, 'rgb-lightning-node-bare-ios'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const target of IOS_TARGETS) fs.rmSync(path.join(root, 'prebuilds', target), { recursive: true })
  return { root, payload, config }
}

function noIosInstalled (root) {
  for (const target of IOS_TARGETS) assert.equal(fs.existsSync(artifactPaths(root, target).prebuild), false)
  assert.equal(fs.readdirSync(path.join(root, 'prebuilds')).some(name => name.startsWith('.ios-install-')), false)
}

function mutateJson (file, change) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  change(value)
  fs.writeFileSync(file, JSON.stringify(value))
}

test('distribution hydrates every iOS slice and verifies all seven without build tools or target selection', context => {
  const { root, config } = fixture(context)
  const sourceHash = fs.readFileSync(path.join(root, '.utexo-native-overlay.json'))
  assert.deepEqual(hydrateDistribution(root), config.targets)
  assert.doesNotThrow(() => verifyDistribution(root))
  assert.deepEqual(fs.readFileSync(path.join(root, '.utexo-native-overlay.json')), sourceHash)
  assert.deepEqual(hydrateDistribution(root), config.targets)
})

test('missing required payload fails before any iOS copy', context => {
  const { root, payload } = fixture(context)
  fs.rmSync(payload, { recursive: true })
  assert.throws(() => hydrateDistribution(root), /Required iOS prebuild package is missing/)
  noIosInstalled(root)
})

for (const [name, change] of [
  ['wrong version', metadata => { metadata.version = '0.2.0-beta.3' }],
  ['unexpected lifecycle', metadata => { metadata.scripts = { postinstall: 'unreviewed' } }],
  ['transitive dependency', metadata => { metadata.dependencies = { unreviewed: '1.0.0' } }],
  ['executable export', metadata => { metadata.exports['.'] = './index.js' }],
  ['platform filter', metadata => { metadata.os = ['darwin'] }],
  ['wrong target set', metadata => { metadata.utexoNativePayload.targets.pop() }],
  ['wrong release graph', metadata => { metadata.utexoNativeOverlay.commit = '0'.repeat(40) }]
]) {
  test('rejects ' + name + ' before copying', context => {
    const { root, payload } = fixture(context)
    mutateJson(path.join(payload, 'package.json'), change)
    assert.throws(() => hydrateDistribution(root), /Unexpected iOS payload|native release graph/)
    noIosInstalled(root)
  })
}

test('an optional payload declaration cannot substitute for the required dependency', context => {
  const { root } = fixture(context)
  mutateJson(path.join(root, 'package.json'), metadata => {
    delete metadata.dependencies[PAYLOAD_NAME]
    metadata.optionalDependencies = { [PAYLOAD_NAME]: metadata.version }
  })
  assert.throws(() => hydrateDistribution(root), /required exact-version dependency/)
  noIosInstalled(root)
})

test('publication gate rejects debug artifacts rather than weakening the original gate', context => {
  const { root } = fixture(context)
  hydrateDistribution(root)
  const prior = process.env.RLN_BARE_DEBUG
  process.env.RLN_BARE_DEBUG = '1'
  try { assert.throws(() => verifyDistribution(root), /Debug prebuilds cannot be published/) } finally {
    if (prior === undefined) delete process.env.RLN_BARE_DEBUG
    else process.env.RLN_BARE_DEBUG = prior
  }
})

test('corrupt final payload slice does not install the earlier valid slices', context => {
  const { root, payload } = fixture(context)
  fs.appendFileSync(artifactPaths(payload, IOS_TARGETS[2]).prebuild, 'tampered')
  assert.throws(() => hydrateDistribution(root), /prebuild hash/)
  noIosInstalled(root)
})

test('payload provenance and runtime-contract mismatches fail closed', context => {
  const { root, payload } = fixture(context)
  const manifest = path.join(payload, '.utexo-native-overlay.json')
  const before = fs.readFileSync(manifest)
  mutateJson(manifest, metadata => { metadata.wrapperSha256 = '0'.repeat(64) })
  assert.throws(() => hydrateDistribution(root), /provenance/)
  fs.writeFileSync(manifest, before)
  fs.appendFileSync(path.join(payload, 'runtime-contract.json'), ' ')
  assert.throws(() => hydrateDistribution(root), /runtime contract/)
  noIosInstalled(root)
})

test('root Android corruption is caught even when the host would use Darwin', context => {
  const { root } = fixture(context)
  fs.appendFileSync(artifactPaths(root, 'android-arm').prebuild, 'tampered')
  assert.throws(() => hydrateDistribution(root), /prebuild hash/)
  noIosInstalled(root)
})

test('source and dangling destination symlinks are rejected without outside writes', context => {
  const { root, payload } = fixture(context)
  const sourceFile = artifactPaths(payload, IOS_TARGETS[0]).prebuild
  const original = fs.readFileSync(sourceFile)
  fs.unlinkSync(sourceFile)
  fs.symlinkSync(path.join(payload, 'runtime-contract.json'), sourceFile)
  assert.throws(() => hydrateDistribution(root), /non-regular file/)
  fs.unlinkSync(sourceFile)
  fs.writeFileSync(sourceFile, original)
  const outside = path.join(root, 'never-create-this')
  fs.symlinkSync(outside, path.join(root, 'prebuilds', IOS_TARGETS[0]), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => hydrateDistribution(root), /non-directory/)
  assert.equal(fs.existsSync(outside), false)
  noIosInstalled(root)
})

test('interrupted file installation fails, cleans staging and recovers on explicit rerun', context => {
  const { root, config } = fixture(context)
  const rename = fs.renameSync
  let count = 0
  fs.renameSync = (...args) => { if (++count === 2) throw new Error('Simulated interrupted rename'); return rename(...args) }
  try { assert.throws(() => hydrateDistribution(root), /Simulated interrupted rename/) } finally { fs.renameSync = rename }
  assert.equal(fs.readdirSync(path.join(root, 'prebuilds')).some(name => name.startsWith('.ios-install-')), false)
  assert.deepEqual(hydrateDistribution(root), config.targets)
  assert.doesNotThrow(() => verifyDistribution(root))
})

test('postinstall preserves only the explicit JS-only opt-out', () => {
  const file = path.join(source, 'scripts', 'install-distribution.js')
  const skipped = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, RLN_BARE_JS_ONLY_INSTALL: '1' } })
  assert.equal(skipped.status, 0)
  assert.match(skipped.stdout, /no wallet runtime/)
  const invalid = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, RLN_BARE_JS_ONLY_INSTALL: 'true' } })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /explicit value 1/)
})

test('the existing installed preparation entry point hydrates all seven after ignored lifecycle scripts', context => {
  const { root, config, payload } = fixture(context)
  const env = { ...process.env, RLN_BARE_TARGETS: 'darwin-arm64' }
  for (const key of ['RLN_BARE_SOURCE_DIR', 'RLN_BARE_ARTIFACTS_DIR', 'RLN_BARE_JS_ONLY_INSTALL']) delete env[key]
  const args = [path.join(root, 'scripts', 'install-native-artifacts.js')]
  const prepared = spawnSync(process.execPath, args, { encoding: 'utf8', env })
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.match(prepared.stdout, /Verified packed prebuilds: darwin-arm64, ios-arm64/)
  assert.doesNotThrow(() => verifyDistribution(root))
  for (const target of IOS_TARGETS) fs.rmSync(path.join(root, 'prebuilds', target), { recursive: true })
  fs.appendFileSync(artifactPaths(payload, config.targets[1]).prebuild, 'tampered')
  const rejected = spawnSync(process.execPath, args, { encoding: 'utf8', env })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /prebuild hash/)
  noIosInstalled(root)
})
