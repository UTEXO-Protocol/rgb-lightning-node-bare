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
  cloneSource,
  nativeArtifactInstallMode,
  normalizedSymbols,
  readOverlayConfig,
  resolveAndroidNdk,
  resolveInstallTargets,
  validatedNmOutput,
  writeArtifactManifest,
  verifyArtifacts,
  verifyPackedPrebuilds
} = require('./native-overlay')

function fixtureRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'utexo-native-overlay-test-'))
}

test('source checkout fetches the exact commit without requiring a tag', context => {
  const calls = []
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const checkout = cloneSource(config, (...args) => calls.push(args))
  context.after(() => fs.rmSync(checkout.temporaryRoot, { recursive: true, force: true }))
  const at = ['-C', checkout.sourceRoot]
  assert.deepEqual(calls, [
    ['git', ['init', checkout.sourceRoot]],
    ['git', [...at, 'remote', 'add', 'origin', config.repository]],
    ['git', [...at, 'fetch', '--no-recurse-submodules', '--depth', '1', 'origin', config.commit]],
    ['git', [...at, 'checkout', '--detach', config.commit]],
    ['git', [...at, 'submodule', 'update', '--init', '--recursive', '--depth', '1']]
  ])
})

test('failed source checkout removes its temporary directory', () => {
  let temporaryRoot
  assert.throws(() => cloneSource({}, (_command, args) => {
    temporaryRoot = path.dirname(args[1])
    throw new Error('fetch failed')
  }), /fetch failed/)
  assert.equal(fs.existsSync(temporaryRoot), false)
})

test('packed prebuild verification needs no archives or platform toolchain', context => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const target = config.targets[0]
  const artifacts = artifactPaths(root, target)
  for (const file of Object.values(artifacts)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fixture')
  }
  writeArtifactManifest(root, config, [target])
  fs.unlinkSync(artifacts.library)
  assert.doesNotThrow(() => verifyPackedPrebuilds(root, config, [target]))
  assert.throws(() => verifyPackedPrebuilds(root, config, config.targets), /prebuild hash/)
  assert.throws(() => verifyPackedPrebuilds(root, { ...config, patchSha256: 'bad' }, [target]), /identity/)
  fs.appendFileSync(artifacts.prebuild, 'modified')
  assert.throws(() => verifyPackedPrebuilds(root, config, [target]), /prebuild hash/)
})

test('adapter preserves native blinded receive reservation counts', () => {
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const patch = fs.readFileSync(config.patchPath, 'utf8')
  assert.match(patch, /\+\s+pub pending_blinded: u32/)
  assert.match(patch, /\+\s+pending_blinded: u\.pending_blinded/)
  assert.match(patch, /pending-blinded-v1/)
  assert.match(patch, /preserves_pending_blinded_reservations/)
})

test('package overlay metadata is exact and checksum-pinned', () => {
  const packageRoot = path.resolve(__dirname, '..')
  const config = readOverlayConfig(packageRoot)

  assert.equal(config.commit, 'a17b685615750536f0320db1cd3f3ba68a8f1c57')
  assert.equal(config.patchSha256, '93d62bb91c0ab90a7ccc4a1382a9da84498e38506170ce74d3863292f0c9f2f4')
  assert.equal(config.rustToolchain, '1.94.0')
  assert.equal(config.iosDeploymentTarget, '16.0')
  assert.equal(config.androidNdkVersion, '27.1.12297006')
  assert.equal(config.androidApiLevel, 29)
  assert.equal(config.cargoNdkVersion, '4.1.2')
  assert.equal(config.bindgenCliVersion, '0.72.1')
  assert.deepEqual(config.targets, [
    'darwin-arm64',
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator',
    'android-arm64',
    'android-arm',
    'android-x64'
  ])
})

test('unsupported operation symbols are absent from this release adapter', () => {
  const patch = fs.readFileSync(readOverlayConfig(path.resolve(__dirname, '..')).patchPath, 'utf8')
  assert.doesNotMatch(patch, /native_operations\.rs|rln_wallet_snapshot|rln_prepare_btc_send/)
  assert.ok(!LIBRARY_SYMBOLS.includes('rln_wallet_snapshot'))
  assert.ok(LIBRARY_SYMBOLS.includes('rln_binding_build_info'))
})

test('overlay exposes address-attested APay through the C ABI', () => {
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  const patch = fs.readFileSync(config.patchPath, 'utf8')

  assert.match(patch, /pub\(crate\) fn sdk_node_apay_new_with_address\(/)
  assert.match(patch, /pub extern "C" fn rln_sdk_node_apay_new_with_address\(/)
  assert.ok(LIBRARY_SYMBOLS.includes('rln_sdk_node_apay_new_with_address'))
})

test('imports are released upstream, not a core implementation backport', () => {
  const patch = fs.readFileSync(readOverlayConfig(path.resolve(__dirname, '..')).patchPath, 'utf8')
  const header = fs.readFileSync(path.join(__dirname, '..', 'rln.h'), 'utf8')
  assert.match(header, /rln_import_rgb_contract/)
  assert.match(header, /rln_import_rgb_transfer_consignment/)
  assert.doesNotMatch(patch, /diff --git a\/src\//)
  assert.doesNotMatch(patch, /95332c41|rln_prepare_btc_send|vss_delete_all/)
})

test('adapter allowlist excludes unrelated upstream runtime changes', () => {
  const { validateAdapter, ALLOWED_FILES } = require('./release-contract')
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  validateAdapter(config)
  const patch = fs.readFileSync(config.patchPath, 'utf8')
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
  assert.equal(files.length, ALLOWED_FILES.length)
  assert.ok(files.every(([, a, b]) => a === b && ALLOWED_FILES.includes(a)))
})

test('generated runtime contract is tied to the wrapper source', () => {
  const { runtimeIdentity, verifyRuntimeContract } = require('./runtime-contract')
  const root = path.resolve(__dirname, '..')
  const config = readOverlayConfig(root)
  assert.deepEqual(verifyRuntimeContract(root, config), runtimeIdentity(root, config))
  assert.throws(() => verifyRuntimeContract(root, { ...config, commit: 'wrong' }), /stale/)
})

test('native artifact provenance changes when the prebuild recipe changes', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const config = readOverlayConfig(path.resolve(__dirname, '..'))
  assert.match(config.prebuildRecipeSha256, /^[a-f0-9]{64}$/)
  const target = config.targets[0]
  const artifacts = artifactPaths(root, target)
  for (const file of Object.values(artifacts)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fixture')
  }
  writeArtifactManifest(root, config, [target])
  const symbols = file => (file.endsWith('.a') ? LIBRARY_SYMBOLS : PREBUILD_SYMBOLS).join('\n')
  assert.throws(() => verifyArtifacts(root, [target], symbols, {
    ...config, prebuildRecipeSha256: '0'.repeat(64)
  }), /prebuildRecipeSha256/)
})

test('Bare node handles shut down exactly once and are destroyed during teardown', () => {
  const packageRoot = path.resolve(__dirname, '..')
  const binding = fs.readFileSync(path.join(packageRoot, 'binding.cc'), 'utf8')

  assert.match(binding, /js_add_teardown_callback\(env, sdk_node_teardown, ref\)/)
  assert.match(binding, /js_remove_teardown_callback\(env, sdk_node_teardown, ref\)/)
  assert.match(binding, /shutdown_and_free_sdk_node\(ref\)/)
  assert.match(binding, /bool shutdown_attempted;/)
  assert.match(binding, /if \(!ref->shutdown_attempted\)/)
  assert.match(binding, /ref->shutdown_attempted = true;/)
  assert.match(binding, /ERR_RLN_NODE_CLOSED/)
  assert.match(binding, /if \(node == NULL\) return make_undefined\(env\)/)
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
    'darwin-arm64',
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
