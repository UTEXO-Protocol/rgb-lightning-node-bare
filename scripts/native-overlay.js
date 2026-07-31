'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LIBRARY_SYMBOLS = Object.freeze([
  'rln_cancel_btc_send_plan',
  'rln_cancel_create_utxos_plan',
  'rln_cancel_rgb_send_plan',
  'rln_commit_prepared_btc_send',
  'rln_commit_prepared_create_utxos',
  'rln_commit_prepared_rgb_send',
  'rln_list_address_receipts',
  'rln_list_pending_rgb_send_plans',
  'rln_list_pending_vanilla_transactions',
  'rln_native_external_signer_new_with_storage',
  'rln_prepare_btc_send',
  'rln_prepare_create_utxos',
  'rln_prepare_rgb_send',
  'rln_send_payment',
  'rln_sdk_node_adopt_native_operation',
  'rln_sdk_node_cancel_native_operation',
  'rln_sdk_node_native_operation_status',
  'rln_sdk_node_start_unlock_with_native_external_signer',
  'rln_sdk_node_vss_delete_all',
  'rln_sync_wallet',
  'rln_wallet_snapshot'
])

const PREBUILD_SYMBOLS = Object.freeze([
  'bare_register_module_v0',
  ...LIBRARY_SYMBOLS
])

const TARGET_GROUPS = Object.freeze({
  darwin: Object.freeze(['darwin-arm64', 'darwin-x64']),
  ios: Object.freeze([
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator'
  ]),
  android: Object.freeze([
    'android-arm64',
    'android-arm',
    'android-x64'
  ])
})

const RUST_TARGETS = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'ios-arm64': 'aarch64-apple-ios',
  'ios-arm64-simulator': 'aarch64-apple-ios-sim',
  'ios-x64-simulator': 'x86_64-apple-ios',
  'android-arm64': 'aarch64-linux-android',
  'android-arm': 'armv7-linux-androideabi',
  'android-x64': 'x86_64-linux-android'
})

const SUPPORTED_TARGETS = Object.freeze(Object.values(TARGET_GROUPS).flat())
const ARTIFACT_MANIFEST = '.utexo-native-overlay.json'
const ARTIFACT_MANIFEST_SCHEMA = 2
const JS_ONLY_INSTALL_ENV = 'RLN_BARE_JS_ONLY_INSTALL'
const TARGETS_ENV = 'RLN_BARE_TARGETS'

function fail (message) {
  throw new Error(`[rgb-lightning-node-bare] ${message}`)
}

function nativeArtifactInstallMode (environment = process.env) {
  const requested = environment[JS_ONLY_INSTALL_ENV]
  if (requested === undefined) return 'native'
  if (requested !== '1') {
    fail(`${JS_ONLY_INSTALL_ENV} accepts only the explicit value 1`)
  }
  return 'js-only'
}

function targetsForGroup (config, group) {
  const prefixes = group === 'apple' ? ['darwin-', 'ios-'] : [`${group}-`]
  return config.targets.filter((target) => (
    prefixes.some((prefix) => target.startsWith(prefix))
  ))
}

function validateRequestedTargets (config, targets) {
  if (targets.length === 0) {
    fail('native target selection did not match any configured targets')
  }
  const unique = [...new Set(targets)]
  if (
    unique.length !== targets.length ||
    unique.some((target) => !config.targets.includes(target))
  ) {
    fail('native target selection contains a duplicate or unconfigured target')
  }
  return Object.freeze(unique)
}

function resolveInstallTargets (
  config,
  environment = process.env,
  hostPlatform = process.platform,
  requestedPlatform
) {
  if (environment[TARGETS_ENV] !== undefined) {
    const rawTargets = environment[TARGETS_ENV]
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean)
    return validateRequestedTargets(config, rawTargets)
  }

  const platform = requestedPlatform || environment.EAS_BUILD_PLATFORM
  if (platform) {
    if (platform === 'all') return Object.freeze([...config.targets])
    if (!['android', 'ios', 'darwin', 'apple'].includes(platform)) {
      fail(`unsupported native platform selection: ${platform}`)
    }
    return validateRequestedTargets(config, targetsForGroup(config, platform))
  }

  if (hostPlatform === 'darwin') {
    return validateRequestedTargets(config, targetsForGroup(config, 'apple'))
  }
  if (hostPlatform === 'linux' || hostPlatform === 'win32') {
    return validateRequestedTargets(config, targetsForGroup(config, 'android'))
  }
  fail(`unsupported native build host: ${hostPlatform}`)
}

function assertSupportedBuildHost (config, platform = process.platform, targets = config.targets) {
  if (
    platform !== 'darwin' &&
    targets.some((target) => (
      target.startsWith('ios-') || target.startsWith('darwin-')
    ))
  ) {
    fail(
      'building the selected Apple artifacts requires macOS; ' +
      `use ${JS_ONLY_INSTALL_ENV}=1 only for tooling that will not load the native addon`
    )
  }
}

function sha256 (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function overlayIdentity (config) {
  return Object.freeze({
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA,
    repository: config.repository,
    ref: config.ref,
    commit: config.commit,
    patchSha256: config.patchSha256,
    rustToolchain: config.rustToolchain,
    iosDeploymentTarget: config.iosDeploymentTarget,
    androidNdkVersion: config.androidNdkVersion,
    androidApiLevel: config.androidApiLevel,
    cargoNdkVersion: config.cargoNdkVersion,
    bindgenCliVersion: config.bindgenCliVersion,
    targets: [...config.targets]
  })
}

function run (command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : ''
    fail(`${command} exited with status ${result.status}${detail}`)
  }
  return result.stdout
}

function runProbe (command, args, cwd, environment = process.env) {
  return spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: 'pipe'
  })
}

function readOverlayConfig (packageRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const config = packageJson.utexoNativeOverlay
  if (config === undefined) return null
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('utexoNativeOverlay must be an object')
  }

  const fields = [
    'repository',
    'ref',
    'commit',
    'patch',
    'patchSha256',
    'rustToolchain',
    'iosDeploymentTarget',
    'androidNdkVersion',
    'androidApiLevel',
    'cargoNdkVersion',
    'bindgenCliVersion',
    'targets'
  ]
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(config, field)) {
      fail(`utexoNativeOverlay.${field} is required`)
    }
  }
  if (!/^https:\/\/github\.com\/UTEXO-Protocol\/rgb-lightning-node\.git$/.test(config.repository)) {
    fail('utexoNativeOverlay.repository is not approved')
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$/.test(config.ref)) {
    fail('utexoNativeOverlay.ref must be an exact beta tag')
  }
  if (!/^[0-9a-f]{40}$/.test(config.commit)) {
    fail('utexoNativeOverlay.commit must be a full Git commit')
  }
  if (!/^patches\/[0-9A-Za-z._-]+\.patch$/.test(config.patch)) {
    fail('utexoNativeOverlay.patch must be a package-local patch')
  }
  if (!/^[0-9a-f]{64}$/.test(config.patchSha256)) {
    fail('utexoNativeOverlay.patchSha256 must be a SHA-256 digest')
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.rustToolchain)) {
    fail('utexoNativeOverlay.rustToolchain must be an exact toolchain version')
  }
  if (!/^[0-9]+\.[0-9]+$/.test(config.iosDeploymentTarget)) {
    fail('utexoNativeOverlay.iosDeploymentTarget must be an exact iOS version')
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.androidNdkVersion)) {
    fail('utexoNativeOverlay.androidNdkVersion must be an exact SDK NDK revision')
  }
  if (!Number.isInteger(config.androidApiLevel) || config.androidApiLevel < 21) {
    fail('utexoNativeOverlay.androidApiLevel must be an Android API integer of at least 21')
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.cargoNdkVersion)) {
    fail('utexoNativeOverlay.cargoNdkVersion must be an exact version')
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.bindgenCliVersion)) {
    fail('utexoNativeOverlay.bindgenCliVersion must be an exact version')
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    fail('utexoNativeOverlay.targets must be a non-empty array')
  }
  const targets = [...new Set(config.targets)]
  if (
    targets.length !== config.targets.length ||
    targets.some((target) => !SUPPORTED_TARGETS.includes(target))
  ) {
    fail('utexoNativeOverlay.targets contains a duplicate or unsupported target')
  }

  const patchPath = path.resolve(packageRoot, config.patch)
  const patchRoot = `${path.resolve(packageRoot, 'patches')}${path.sep}`
  if (!patchPath.startsWith(patchRoot) || !fs.existsSync(patchPath)) {
    fail('utexoNativeOverlay.patch does not resolve to a package patch')
  }
  if (sha256(patchPath) !== config.patchSha256) {
    fail('native overlay patch checksum does not match package metadata')
  }

  return Object.freeze({ ...config, patchPath, targets: Object.freeze(targets) })
}

function artifactPaths (root, target) {
  return Object.freeze({
    library: path.join(root, 'lib', target, 'librlncffi.a'),
    prebuild: path.join(
      root,
      'prebuilds',
      target,
      'utexo__rgb-lightning-node-bare.bare'
    )
  })
}

function validatedNmOutput (result) {
  if (result.error) throw result.error
  const diagnostics = (result.stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const knownArchiveDiagnostics = result.status === 1 &&
    diagnostics.length > 0 &&
    diagnostics.every((line) => (
      line.endsWith(': no symbols') ||
      /\/nm: error: .+: Unknown attribute kind \([0-9]+\) \(Producer: 'LLVM[^']+' Reader: 'LLVM[^']+'\)$/.test(line)
    ))
  if (result.status !== 0 && !knownArchiveDiagnostics) {
    fail(`nm exited with status ${result.status}: ${diagnostics.join('; ')}`)
  }
  return result.stdout || ''
}

function normalizedSymbols (output) {
  return output
    .split('\n')
    .map((symbol) => symbol.trim().replace(/^_/, ''))
    .filter(Boolean)
    .join('\n')
}

function ndkRevision (ndkRoot) {
  const propertiesPath = path.join(ndkRoot, 'source.properties')
  if (!fs.existsSync(propertiesPath)) return null
  const properties = fs.readFileSync(propertiesPath, 'utf8')
  return properties.match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim() ?? null
}

function resolveAndroidNdk (config, environment = process.env) {
  const explicit = environment.ANDROID_NDK_HOME || environment.ANDROID_NDK_ROOT
  if (explicit) {
    const resolved = path.resolve(explicit)
    const revision = ndkRevision(resolved)
    if (revision !== config.androidNdkVersion) {
      fail(
        `Android NDK ${config.androidNdkVersion} is required, but ${resolved} ` +
        `contains ${revision || 'no valid NDK'}`
      )
    }
    return resolved
  }

  const sdkRoots = [
    environment.ANDROID_HOME,
    environment.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk')
  ].filter(Boolean)
  for (const sdkRoot of [...new Set(sdkRoots)]) {
    const candidate = path.resolve(sdkRoot, 'ndk', config.androidNdkVersion)
    if (ndkRevision(candidate) === config.androidNdkVersion) return candidate
  }
  fail(
    `Android NDK ${config.androidNdkVersion} is required; install it with sdkmanager ` +
    `and set ANDROID_NDK_HOME`
  )
}

function androidLlvmTool (ndkRoot, tool) {
  const prebuiltRoot = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt')
  const hosts = fs.existsSync(prebuiltRoot)
    ? fs.readdirSync(prebuiltRoot).filter((entry) => (
        fs.statSync(path.join(prebuiltRoot, entry)).isDirectory()
      ))
    : []
  if (hosts.length !== 1) {
    fail(`expected exactly one Android NDK LLVM host toolchain, found ${hosts.length}`)
  }
  const executable = path.join(prebuiltRoot, hosts[0], 'bin', tool)
  if (!fs.existsSync(executable)) {
    fail(`Android NDK tool is missing: ${executable}`)
  }
  return executable
}

function inspectSymbols (filePath, target, config) {
  const isAndroid = target.startsWith('android-')
  const command = isAndroid
    ? androidLlvmTool(resolveAndroidNdk(config), 'llvm-nm')
    : 'nm'
  const args = isAndroid
    ? ['-g', '--defined-only', '--just-symbol-name', filePath]
    : ['-gjU', filePath]
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe'
  })
  return normalizedSymbols(validatedNmOutput(result))
}

function artifactManifestPath (root) {
  return path.join(root, ARTIFACT_MANIFEST)
}

function readManifest (root) {
  const manifestPath = artifactManifestPath(root)
  if (!fs.existsSync(manifestPath)) return null
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    fail('native artifact overlay provenance is invalid')
  }
}

function manifestMatchesIdentity (manifest, config) {
  if (!manifest) return false
  return Object.entries(overlayIdentity(config)).every(([key, expected]) => (
    JSON.stringify(manifest[key]) === JSON.stringify(expected)
  ))
}

function writeArtifactManifest (root, config, targets = config.targets) {
  const current = readManifest(root)
  const artifacts = manifestMatchesIdentity(current, config)
    ? { ...current.artifacts }
    : {}
  for (const target of targets) {
    const paths = artifactPaths(root, target)
    artifacts[target] = {
      librarySha256: sha256(paths.library),
      prebuildSha256: sha256(paths.prebuild)
    }
  }
  const manifest = {
    ...overlayIdentity(config),
    artifacts
  }
  fs.writeFileSync(
    artifactManifestPath(root),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  )
}

function verifyArtifactManifest (root, config, targets) {
  const manifest = readManifest(root)
  if (!manifest) {
    fail('native artifacts are missing overlay provenance')
  }
  const expectedIdentity = overlayIdentity(config)
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(expected)) {
      fail(`native artifact overlay provenance does not match ${key}`)
    }
  }
  for (const target of targets) {
    const artifacts = artifactPaths(root, target)
    const recorded = manifest.artifacts && manifest.artifacts[target]
    if (
      !recorded ||
      recorded.librarySha256 !== sha256(artifacts.library) ||
      recorded.prebuildSha256 !== sha256(artifacts.prebuild)
    ) {
      fail(`native artifact hashes do not match overlay provenance for ${target}`)
    }
  }
}

function verifyArtifacts (root, targets, symbolReader = inspectSymbols, config) {
  for (const target of targets) {
    const artifacts = artifactPaths(root, target)
    for (const [kind, filePath] of Object.entries(artifacts)) {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        fail(`missing ${kind} artifact for ${target}`)
      }
      const symbols = symbolReader(filePath, target, config)
      const requiredSymbols = kind === 'library' ? LIBRARY_SYMBOLS : PREBUILD_SYMBOLS
      for (const symbol of requiredSymbols) {
        if (!symbols.includes(symbol)) {
          fail(`${kind} artifact for ${target} is missing ${symbol}`)
        }
      }
    }
  }
  if (config) verifyArtifactManifest(root, config, targets)
}

function copyArtifacts (sourceRoot, packageRoot, config, targets) {
  verifyArtifacts(sourceRoot, targets, inspectSymbols, config)
  for (const target of targets) {
    const source = artifactPaths(sourceRoot, target)
    const destination = artifactPaths(packageRoot, target)
    for (const kind of Object.keys(source)) {
      fs.mkdirSync(path.dirname(destination[kind]), { recursive: true })
      fs.copyFileSync(source[kind], destination[kind])
    }
  }
  writeArtifactManifest(packageRoot, config, targets)
}

function exactHead (sourceRoot) {
  return run('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { capture: true }).trim()
}

function applyOverlay (sourceRoot, config) {
  if (exactHead(sourceRoot) !== config.commit) {
    fail(`native source must resolve to ${config.commit}`)
  }

  const forward = runProbe('git', ['-C', sourceRoot, 'apply', '--check', config.patchPath])
  if (forward.status === 0) {
    run('git', ['-C', sourceRoot, 'apply', config.patchPath])
    return
  }

  const reverse = runProbe('git', ['-C', sourceRoot, 'apply', '--reverse', '--check', config.patchPath])
  if (reverse.status !== 0) {
    fail('native source is neither pristine nor an exact application of the configured overlay')
  }
}

function cloneSource (config) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'utexo-rln-source-'))
  const sourceRoot = path.join(temporaryRoot, 'rgb-lightning-node')
  run('git', [
    'clone',
    '--recurse-submodules',
    '--shallow-submodules',
    '--depth', '1',
    '--branch', config.ref,
    config.repository,
    sourceRoot
  ])
  return Object.freeze({ sourceRoot, temporaryRoot })
}

function ensureCargoTool (command, args, packageName, expectedVersion) {
  const probe = runProbe(command, args)
  const installedVersion = probe.status === 0
    ? `${probe.stdout} ${probe.stderr}`.match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0]
    : null
  if (installedVersion === expectedVersion) return
  run('cargo', [
    'install',
    '--force',
    '--locked',
    '--version', expectedVersion,
    packageName
  ])
  const verification = runProbe(command, args)
  const verifiedVersion = verification.status === 0
    ? `${verification.stdout} ${verification.stderr}`.match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0]
    : null
  if (verifiedVersion !== expectedVersion) {
    fail(`${packageName} ${expectedVersion} could not be installed reproducibly`)
  }
}

function buildArtifacts (packageRoot, sourceRoot, config, targets) {
  assertSupportedBuildHost(config, process.platform, targets)
  const cffiDir = path.join(sourceRoot, 'bindings', 'c-ffi')
  const environment = {
    ...process.env,
    CFFI_DIR: cffiDir,
    IPHONEOS_DEPLOYMENT_TARGET: config.iosDeploymentTarget,
    RUSTUP_TOOLCHAIN: config.rustToolchain
  }
  const scriptsRoot = path.join(packageRoot, 'scripts')
  const hasAndroid = targets.some((target) => target.startsWith('android-'))

  run('rustup', ['toolchain', 'install', config.rustToolchain, '--profile', 'minimal'])
  const rustTargets = targets.map((target) => RUST_TARGETS[target])
  for (const target of [...new Set(rustTargets)]) {
    run('rustup', ['target', 'add', '--toolchain', config.rustToolchain, target])
  }

  if (hasAndroid) {
    const ndkRoot = resolveAndroidNdk(config)
    environment.ANDROID_NDK_HOME = ndkRoot
    environment.ANDROID_NDK_ROOT = ndkRoot
    environment.ANDROID_API_LEVEL = String(config.androidApiLevel)
    environment.AWS_LC_SYS_CMAKE_BUILDER = '1'
    ensureCargoTool(
      'cargo',
      ['ndk', '--version'],
      'cargo-ndk',
      config.cargoNdkVersion
    )
    ensureCargoTool(
      'bindgen',
      ['--version'],
      'bindgen-cli',
      config.bindgenCliVersion
    )
  }

  for (const target of targets) {
    run('bash', [path.join(scriptsRoot, 'build-cffi.sh'), target], {
      cwd: packageRoot,
      env: environment
    })
  }
  for (const target of targets) {
    run('bash', [path.join(scriptsRoot, 'build-prebuilds.sh'), target], {
      cwd: packageRoot,
      env: environment
    })
  }
  writeArtifactManifest(packageRoot, config, targets)
}

function ensureOverlayArtifacts (
  packageRoot,
  config,
  targets = config.targets,
  environment = process.env
) {
  const requestedTargets = validateRequestedTargets(config, [...targets])
  try {
    verifyArtifacts(packageRoot, requestedTargets, inspectSymbols, config)
    console.log(
      `[rgb-lightning-node-bare] Verified native overlay artifacts: ${requestedTargets.join(', ')}`
    )
    return
  } catch (error) {
    console.log(
      '[rgb-lightning-node-bare] Native artifacts require preparation: ' +
      (error instanceof Error ? error.message : String(error))
    )
  }

  const artifactRoot = environment.RLN_BARE_ARTIFACTS_DIR
  if (artifactRoot) {
    copyArtifacts(path.resolve(artifactRoot), packageRoot, config, requestedTargets)
    verifyArtifacts(packageRoot, requestedTargets, inspectSymbols, config)
    console.log('[rgb-lightning-node-bare] Imported verified native overlay artifacts.')
    return
  }

  let temporaryRoot
  let sourceRoot
  if (environment.RLN_BARE_SOURCE_DIR) {
    sourceRoot = path.resolve(environment.RLN_BARE_SOURCE_DIR)
  } else {
    const checkout = cloneSource(config)
    sourceRoot = checkout.sourceRoot
    temporaryRoot = checkout.temporaryRoot
  }

  try {
    applyOverlay(sourceRoot, config)
    buildArtifacts(packageRoot, sourceRoot, config, requestedTargets)
    verifyArtifacts(packageRoot, requestedTargets, inspectSymbols, config)
    console.log('[rgb-lightning-node-bare] Built and verified native overlay artifacts.')
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
}

module.exports = {
  ARTIFACT_MANIFEST,
  JS_ONLY_INSTALL_ENV,
  LIBRARY_SYMBOLS,
  PREBUILD_SYMBOLS,
  SUPPORTED_TARGETS,
  TARGETS_ENV,
  assertSupportedBuildHost,
  artifactPaths,
  ensureOverlayArtifacts,
  nativeArtifactInstallMode,
  normalizedSymbols,
  readOverlayConfig,
  resolveAndroidNdk,
  resolveInstallTargets,
  validatedNmOutput,
  writeArtifactManifest,
  verifyArtifacts
}
