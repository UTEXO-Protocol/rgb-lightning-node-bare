'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { artifactPaths, readOverlayConfig, verifyPackedPrebuilds } = require('./native-overlay')
const { verifyReleaseArtifacts } = require('./verify-release-artifacts')

const PAYLOAD_NAME = '@utexo/rgb-lightning-node-bare-ios'
const IOS_TARGETS = Object.freeze(['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'])
const OWNER_NAME = '@utexo/rgb-lightning-node-bare'
const MANIFEST = '.utexo-native-overlay.json'

function readJson (file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

function regularFile (file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Native distribution contains a non-regular file: ' + file)
}

function directory (file, allowMissing = false) {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false })
  if (allowMissing && entry === undefined) return
  if (!entry?.isDirectory()) throw new Error('Native distribution contains a non-directory path: ' + file)
}

function prebuildPath (root, target, allowMissing = false) {
  directory(path.join(root, 'prebuilds'), allowMissing)
  directory(path.join(root, 'prebuilds', target), allowMissing)
  const file = artifactPaths(root, target).prebuild
  if (!allowMissing || fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) regularFile(file)
  return file
}

function ownerMetadata (root) {
  const owner = readJson(path.join(root, 'package.json'))
  if (owner.name !== OWNER_NAME || owner.dependencies?.[PAYLOAD_NAME] !== owner.version ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(owner.version)) {
    throw new Error('The iOS payload must be a required exact-version dependency')
  }
  return owner
}

function payloadMetadata (root, payloadRoot) {
  const owner = ownerMetadata(root)
  regularFile(path.join(payloadRoot, 'package.json'))
  const payload = readJson(path.join(payloadRoot, 'package.json'))
  if (payload.name !== PAYLOAD_NAME || payload.version !== owner.version ||
      !isDeepStrictEqual(payload.utexoNativePayload, { schemaVersion: 1, owner: OWNER_NAME, targets: [...IOS_TARGETS] }) ||
      payload.os !== undefined || payload.cpu !== undefined || payload.libc !== undefined ||
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'bin', 'addon', 'main'].some(field => payload[field] !== undefined) ||
      !isDeepStrictEqual(payload.exports, { './package.json': './package.json' }) ||
      (payload.scripts !== undefined && Object.keys(payload.scripts).length !== 0)) {
    throw new Error('Unexpected iOS payload package identity or execution policy')
  }
  if (!isDeepStrictEqual(payload.utexoNativeOverlay, owner.utexoNativeOverlay)) {
    throw new Error('iOS payload native release graph does not match the owner')
  }
}

function validatePayload (root, payloadRoot, config = readOverlayConfig(root)) {
  payloadMetadata(root, payloadRoot)
  regularFile(path.join(root, MANIFEST))
  regularFile(path.join(payloadRoot, MANIFEST))
  regularFile(path.join(payloadRoot, 'runtime-contract.json'))
  if (!fs.readFileSync(path.join(root, 'runtime-contract.json')).equals(fs.readFileSync(path.join(payloadRoot, 'runtime-contract.json')))) {
    throw new Error('iOS payload runtime contract does not match the owner')
  }
  if (!isDeepStrictEqual(readJson(path.join(root, MANIFEST)), readJson(path.join(payloadRoot, MANIFEST)))) {
    throw new Error('iOS payload provenance does not match the owner manifest')
  }
  for (const target of IOS_TARGETS) prebuildPath(payloadRoot, target)
  verifyPackedPrebuilds(payloadRoot, config, IOS_TARGETS)
  return config
}

function resolvePayload (root) {
  try { return path.dirname(require.resolve(PAYLOAD_NAME + '/package.json', { paths: [root] })) } catch {
    throw new Error('Required iOS prebuild package is missing; reinstall dependencies and run npm run hydrate-native')
  }
}

function hydrateDistribution (root) {
  const config = readOverlayConfig(root)
  const payloadRoot = resolvePayload(root)
  validatePayload(root, payloadRoot, config)
  const wrapperTargets = config.targets.filter(target => !IOS_TARGETS.includes(target))
  for (const target of wrapperTargets) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, wrapperTargets)
  // Validate every source and destination before creating or copying anything.
  for (const target of IOS_TARGETS) prebuildPath(root, target, true)
  const staging = fs.mkdtempSync(path.join(root, 'prebuilds', '.ios-install-'))
  try {
    fs.copyFileSync(path.join(root, MANIFEST), path.join(staging, MANIFEST))
    for (const target of IOS_TARGETS) {
      const destination = artifactPaths(staging, target).prebuild
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(artifactPaths(payloadRoot, target).prebuild, destination)
    }
    // Catch source changes or interrupted writes before installing any new file.
    verifyPackedPrebuilds(staging, config, IOS_TARGETS)
    for (const target of IOS_TARGETS) {
      const destination = artifactPaths(root, target).prebuild
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(artifactPaths(staging, target).prebuild, destination)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  verifyPackedPrebuilds(root, config, config.targets)
  return config.targets
}

function stageIosPayload (root) {
  const config = readOverlayConfig(root)
  ownerMetadata(root)
  for (const target of config.targets) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, config.targets)
  const payloadRoot = path.join(root, 'native', 'ios')
  directory(path.join(root, 'native'))
  directory(payloadRoot)
  payloadMetadata(root, payloadRoot)
  const manifest = path.join(payloadRoot, MANIFEST)
  if (fs.lstatSync(manifest, { throwIfNoEntry: false }) !== undefined) regularFile(manifest)
  const runtime = path.join(payloadRoot, 'runtime-contract.json')
  if (fs.lstatSync(runtime, { throwIfNoEntry: false }) !== undefined) regularFile(runtime)
  for (const target of IOS_TARGETS) {
    prebuildPath(payloadRoot, target, true)
  }
  for (const target of IOS_TARGETS) {
    const destination = artifactPaths(payloadRoot, target).prebuild
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(artifactPaths(root, target).prebuild, destination)
  }
  fs.copyFileSync(path.join(root, MANIFEST), manifest)
  fs.copyFileSync(path.join(root, 'runtime-contract.json'), runtime)
  validatePayload(root, payloadRoot, config)
  return payloadRoot
}

function verifyDistribution (root) {
  const config = readOverlayConfig(root)
  verifyReleaseArtifacts(root)
  for (const target of config.targets) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, config.targets)
  validatePayload(root, path.join(root, 'native', 'ios'), config)
}

module.exports = { PAYLOAD_NAME, IOS_TARGETS, hydrateDistribution, stageIosPayload, validatePayload, verifyDistribution }
