'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  ARTIFACT_MANIFEST,
  JS_ONLY_INSTALL_ENV,
  LIBRARY_SYMBOLS,
  PREBUILD_SYMBOLS,
  assertSupportedBuildHost,
  artifactPaths,
  nativeArtifactInstallMode,
  normalizedSymbols,
  readOverlayConfig,
  resolveAndroidNdk,
  resolveInstallTargets,
  validatedNmOutput,
  writeArtifactManifest,
  verifyArtifacts
} = require('./native-overlay')

function fixtureRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'utexo-native-overlay-test-'))
}

test('package overlay metadata is exact and checksum-pinned', () => {
  const packageRoot = path.resolve(__dirname, '..')
  const config = readOverlayConfig(packageRoot)

  assert.equal(config.commit, '0bfa66fa256a6c36f3737d5b6402eacea40c68fc')
  assert.equal(config.patchSha256, 'b024039de512358fecbb64773b587b11bb626364bd41a165cd797641a0e999e2')
  assert.equal(config.rustToolchain, '1.88.0')
  assert.equal(config.iosDeploymentTarget, '16.0')
  assert.equal(config.androidNdkVersion, '27.1.12297006')
  assert.equal(config.androidApiLevel, 29)
  assert.equal(config.cargoNdkVersion, '4.1.2')
  assert.equal(config.bindgenCliVersion, '0.72.1')
  assert.deepEqual(config.targets, [
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator',
    'android-arm64',
    'android-arm',
    'android-x64'
  ])
})

test('overlay contains the complete native operation registry source', () => {
  const packageRoot = path.resolve(__dirname, '..')
  const config = readOverlayConfig(packageRoot)
  const patch = fs.readFileSync(config.patchPath, 'utf8')

  assert.match(
    patch,
    /diff --git a\/bindings\/c-ffi\/src\/native_operations\.rs b\/bindings\/c-ffi\/src\/native_operations\.rs/
  )
  assert.match(patch, /new file mode 100644/)
  assert.match(patch, /pub\(crate\) fn start_unlock\(/)
  assert.match(patch, /pub\(crate\) fn status\(/)
  assert.match(patch, /pub\(crate\) fn adopt\(/)
  assert.match(patch, /pub\(crate\) fn cancel\(/)
})

test('JS-only installation requires an explicit exact opt-out', () => {
  assert.equal(nativeArtifactInstallMode({}), 'native')
  assert.equal(nativeArtifactInstallMode({ [JS_ONLY_INSTALL_ENV]: '1' }), 'js-only')
  assert.throws(
    () => nativeArtifactInstallMode({ [JS_ONLY_INSTALL_ENV]: 'true' }),
    /accepts only the explicit value 1/
  )
})

test('Apple source builds fail clearly on unsupported hosts', () => {
  assert.doesNotThrow(() => assertSupportedBuildHost({ targets: ['ios-arm64'] }, 'darwin'))
  assert.throws(
    () => assertSupportedBuildHost({ targets: ['ios-arm64'] }, 'linux'),
    /requires macOS/
  )
  assert.throws(
    () => assertSupportedBuildHost({ targets: ['darwin-arm64'] }, 'linux'),
    /requires macOS/
  )
  assert.doesNotThrow(() => assertSupportedBuildHost(
    { targets: ['android-arm64'] },
    'linux'
  ))
})

test('install target selection is platform scoped and explicit', () => {
  const config = readOverlayConfig(path.resolve(__dirname, '..'))

  assert.deepEqual(resolveInstallTargets(config, {}, 'darwin'), [
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator'
  ])
  assert.deepEqual(resolveInstallTargets(config, {}, 'darwin', 'android'), [
    'android-arm64',
    'android-arm',
    'android-x64'
  ])
  assert.deepEqual(resolveInstallTargets(
    config,
    { EAS_BUILD_PLATFORM: 'android' },
    'darwin'
  ), [
    'android-arm64',
    'android-arm',
    'android-x64'
  ])
  assert.deepEqual(resolveInstallTargets(
    config,
    { RLN_BARE_TARGETS: 'android-arm64,android-x64' },
    'darwin',
    'ios'
  ), [
    'android-arm64',
    'android-x64'
  ])
  assert.throws(
    () => resolveInstallTargets(
      config,
      { RLN_BARE_TARGETS: 'android-ia32' },
      'darwin'
    ),
    /unconfigured target/
  )
})

test('symbol normalization makes Mach-O and ELF contracts equivalent', () => {
  assert.equal(
    normalizedSymbols('_rln_wallet_snapshot\nbare_register_module_v0\n'),
    'rln_wallet_snapshot\nbare_register_module_v0'
  )
})

test('artifact verification requires every contract symbol in every output', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const targets = ['ios-arm64-simulator']
  const artifacts = artifactPaths(root, targets[0])
  for (const filePath of Object.values(artifacts)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fixture')
  }

  assert.doesNotThrow(() => verifyArtifacts(root, targets, (filePath) => (
    filePath.endsWith('.a') ? LIBRARY_SYMBOLS : PREBUILD_SYMBOLS
  ).join('\n')))
  assert.throws(
    () => verifyArtifacts(root, targets, () => '_bare_register_module_v0'),
    new RegExp(LIBRARY_SYMBOLS[0])
  )
})

test('artifact verification rejects missing or empty outputs', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))

  assert.throws(
    () => verifyArtifacts(root, ['ios-arm64'], () => PREBUILD_SYMBOLS.join('\n')),
    /missing library artifact/
  )
})

test('overlay provenance binds artifacts to the exact patch and hashes', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const target = config.targets[0]
  const artifacts = artifactPaths(root, target)
  for (const filePath of Object.values(artifacts)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fixture')
  }
  const oneTargetConfig = { ...config, targets: [target] }
  writeArtifactManifest(root, oneTargetConfig)
  const symbols = (filePath) => (
    filePath.endsWith('.a') ? LIBRARY_SYMBOLS : PREBUILD_SYMBOLS
  ).join('\n')

  assert.doesNotThrow(() => verifyArtifacts(
    root,
    oneTargetConfig.targets,
    symbols,
    oneTargetConfig
  ))

  fs.appendFileSync(artifacts.library, 'tampered')
  assert.throws(
    () => verifyArtifacts(root, oneTargetConfig.targets, symbols, oneTargetConfig),
    /artifact hashes do not match/
  )
  assert.ok(fs.existsSync(path.join(root, ARTIFACT_MANIFEST)))
})

test('overlay provenance can be extended by a second platform without losing hashes', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const iosTarget = 'ios-arm64'
  const androidTarget = 'android-arm64'
  for (const target of [iosTarget, androidTarget]) {
    const artifacts = artifactPaths(root, target)
    for (const filePath of Object.values(artifacts)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, `${target}-fixture`)
    }
  }
  writeArtifactManifest(root, config, [iosTarget])
  const iosManifest = JSON.parse(fs.readFileSync(path.join(root, ARTIFACT_MANIFEST), 'utf8'))
  writeArtifactManifest(root, config, [androidTarget])
  const combinedManifest = JSON.parse(fs.readFileSync(path.join(root, ARTIFACT_MANIFEST), 'utf8'))

  assert.deepEqual(combinedManifest.artifacts[iosTarget], iosManifest.artifacts[iosTarget])
  assert.ok(combinedManifest.artifacts[androidTarget])
})

test('overlay provenance rejects a stale patch identity', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const target = config.targets[0]
  const oneTargetConfig = { ...config, targets: [target] }
  const artifacts = artifactPaths(root, target)
  for (const filePath of Object.values(artifacts)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fixture')
  }
  writeArtifactManifest(root, oneTargetConfig)

  assert.throws(
    () => verifyArtifacts(
      root,
      oneTargetConfig.targets,
      () => PREBUILD_SYMBOLS.join('\n'),
      { ...oneTargetConfig, patchSha256: '0'.repeat(64) }
    ),
    /provenance does not match patchSha256/
  )
})

test('nm accepts only the archive empty-member diagnostic on status one', () => {
  assert.equal(validatedNmOutput({
    status: 1,
    stdout: '_rln_sync_wallet\n',
    stderr: 'archive.a:member.o: no symbols\n'
  }), '_rln_sync_wallet\n')

  assert.throws(() => validatedNmOutput({
    status: 1,
    stdout: '_rln_sync_wallet\n',
    stderr: 'nm: archive is malformed\n'
  }), /archive is malformed/)
})

test('nm tolerates only the known Rust producer and Apple reader mismatch', () => {
  assert.equal(validatedNmOutput({
    status: 1,
    stdout: '_rln_wallet_snapshot\n',
    stderr: '/usr/bin/nm: error: archive.a(member.o): Unknown attribute kind (105) ' +
      '(Producer: \'LLVM22.1.2-rust-1.95.0-stable\' ' +
      'Reader: \'LLVM APPLE_1_2100.1.1.101_0\')\n'
  }), '_rln_wallet_snapshot\n')

  assert.throws(() => validatedNmOutput({
    status: 1,
    stdout: '_rln_wallet_snapshot\n',
    stderr: '/usr/bin/nm: error: archive.a(member.o): Unknown file format\n'
  }), /Unknown file format/)
})

test('Android NDK resolution requires the exact configured revision', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  fs.writeFileSync(
    path.join(root, 'source.properties'),
    `Pkg.Desc = Android NDK\nPkg.Revision = ${config.androidNdkVersion}\n`
  )

  assert.equal(resolveAndroidNdk(config, { ANDROID_NDK_HOME: root }), root)

  fs.writeFileSync(
    path.join(root, 'source.properties'),
    'Pkg.Desc = Android NDK\nPkg.Revision = 27.0.0\n'
  )
  assert.throws(
    () => resolveAndroidNdk(config, { ANDROID_NDK_HOME: root }),
    /Android NDK 27\.1\.12297006 is required/
  )
})
