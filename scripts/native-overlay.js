'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LIBRARY_SYMBOLS = Object.freeze([
  '_rln_sync_wallet',
  '_rln_wallet_snapshot'
])

const PREBUILD_SYMBOLS = Object.freeze([
  '_bare_register_module_v0',
  ...LIBRARY_SYMBOLS
])

const SUPPORTED_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
])

function fail (message) {
  throw new Error(`[rgb-lightning-node-bare] ${message}`)
}

function sha256 (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
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

function runProbe (command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
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
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    fail('utexoNativeOverlay.targets must be a non-empty array')
  }
  const targets = [...new Set(config.targets)]
  if (targets.length !== config.targets.length || targets.some((target) => !SUPPORTED_TARGETS.includes(target))) {
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

function inspectSymbols (filePath) {
  const result = spawnSync('nm', ['-gjU', filePath], {
    encoding: 'utf8',
    // Rust archives expose enough dependency symbols to exceed the default
    // child-process buffer, and `nm` reports symbol-free archive members with
    // status 1 even when the emitted symbol table is otherwise complete.
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe'
  })
  return validatedNmOutput(result)
}

function verifyArtifacts (root, targets, symbolReader = inspectSymbols) {
  for (const target of targets) {
    const artifacts = artifactPaths(root, target)
    for (const [kind, filePath] of Object.entries(artifacts)) {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        fail(`missing ${kind} artifact for ${target}`)
      }
      const symbols = symbolReader(filePath)
      const requiredSymbols = kind === 'library' ? LIBRARY_SYMBOLS : PREBUILD_SYMBOLS
      for (const symbol of requiredSymbols) {
        if (!symbols.includes(symbol)) {
          fail(`${kind} artifact for ${target} is missing ${symbol}`)
        }
      }
    }
  }
}

function copyArtifacts (sourceRoot, packageRoot, targets) {
  verifyArtifacts(sourceRoot, targets)
  for (const target of targets) {
    const source = artifactPaths(sourceRoot, target)
    const destination = artifactPaths(packageRoot, target)
    for (const kind of Object.keys(source)) {
      fs.mkdirSync(path.dirname(destination[kind]), { recursive: true })
      fs.copyFileSync(source[kind], destination[kind])
    }
  }
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

function buildArtifacts (packageRoot, sourceRoot, config) {
  const cffiDir = path.join(sourceRoot, 'bindings', 'c-ffi')
  const environment = {
    ...process.env,
    CFFI_DIR: cffiDir,
    IPHONEOS_DEPLOYMENT_TARGET: config.iosDeploymentTarget,
    RUSTUP_TOOLCHAIN: config.rustToolchain
  }
  const scriptsRoot = path.join(packageRoot, 'scripts')
  const hasDarwin = config.targets.some((target) => target.startsWith('darwin-'))
  const hasIos = config.targets.some((target) => target.startsWith('ios-'))

  run('rustup', ['toolchain', 'install', config.rustToolchain, '--profile', 'minimal'])
  const rustTargets = config.targets
    .filter((target) => target.startsWith('ios-'))
    .map((target) => ({
      'ios-arm64': 'aarch64-apple-ios',
      'ios-arm64-simulator': 'aarch64-apple-ios-sim',
      'ios-x64-simulator': 'x86_64-apple-ios'
    })[target])
  for (const target of [...new Set(rustTargets)]) {
    run('rustup', ['target', 'add', '--toolchain', config.rustToolchain, target])
  }

  if (hasDarwin) run('bash', [path.join(scriptsRoot, 'build-cffi.sh'), 'darwin'], { cwd: packageRoot, env: environment })
  if (hasIos) run('bash', [path.join(scriptsRoot, 'build-cffi.sh'), 'ios'], { cwd: packageRoot, env: environment })
  for (const target of config.targets) {
    run('bash', [path.join(scriptsRoot, 'build-prebuilds.sh'), target], {
      cwd: packageRoot,
      env: environment
    })
  }
}

function ensureOverlayArtifacts (packageRoot, config, environment = process.env) {
  try {
    verifyArtifacts(packageRoot, config.targets)
    console.log('[rgb-lightning-node-bare] Native overlay artifacts already satisfy the contract.')
    return
  } catch {
    // Build or import the exact overlay below.
  }

  const artifactRoot = environment.RLN_BARE_ARTIFACTS_DIR
  if (artifactRoot) {
    copyArtifacts(path.resolve(artifactRoot), packageRoot, config.targets)
    verifyArtifacts(packageRoot, config.targets)
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
    buildArtifacts(packageRoot, sourceRoot, config)
    verifyArtifacts(packageRoot, config.targets)
    console.log('[rgb-lightning-node-bare] Built and verified native overlay artifacts.')
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { force: true, recursive: true })
  }
}

module.exports = {
  LIBRARY_SYMBOLS,
  PREBUILD_SYMBOLS,
  SUPPORTED_TARGETS,
  artifactPaths,
  ensureOverlayArtifacts,
  readOverlayConfig,
  validatedNmOutput,
  verifyArtifacts
}
