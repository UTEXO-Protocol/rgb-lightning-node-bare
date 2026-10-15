'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { artifactPaths, readOverlayConfig, verifyPackedPrebuilds } = require('./native-overlay')
const { verifyReleaseArtifacts } = require('./verify-release-artifacts')

const OWNER_NAME = '@utexo/rgb-lightning-node-bare'
const MANIFEST = '.utexo-native-overlay.json'
const PAYLOADS = Object.freeze([
  Object.freeze({ name: OWNER_NAME + '-ios', directory: 'native/ios', targets: Object.freeze(['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']) }),
  Object.freeze({ name: OWNER_NAME + '-android-arm', directory: 'native/android-arm', targets: Object.freeze(['android-arm', 'android-arm64']) }),
  Object.freeze({ name: OWNER_NAME + '-android-x64', directory: 'native/android-x64', targets: Object.freeze(['android-x64']) })
])
const PAYLOAD_NAME = PAYLOADS[0].name
const IOS_TARGETS = PAYLOADS[0].targets
const PAYLOAD_TARGETS = Object.freeze(PAYLOADS.flatMap(payload => payload.targets))
const WRAPPER_TARGETS = Object.freeze(['darwin-arm64'])

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
  regularFile(path.join(root, 'package.json'))
  const owner = readJson(path.join(root, 'package.json'))
  if (owner.name !== OWNER_NAME || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(owner.version) ||
      PAYLOADS.some(payload => owner.dependencies?.[payload.name] !== owner.version ||
        ['optionalDependencies', 'peerDependencies', 'devDependencies'].some(field => Object.hasOwn(owner[field] ?? {}, payload.name)))) {
    throw new Error('Native payloads must be required exact-version dependencies')
  }
  return owner
}

function payloadMetadata (root, payloadRoot, descriptor) {
  const owner = ownerMetadata(root)
  regularFile(path.join(payloadRoot, 'package.json'))
  const payload = readJson(path.join(payloadRoot, 'package.json'))
  const forbidden = ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'bin', 'addon', 'main', 'os', 'cpu', 'libc', 'workspaces']
  if (payload.name !== descriptor.name || payload.version !== owner.version ||
      !isDeepStrictEqual(payload.utexoNativePayload, { schemaVersion: 1, owner: OWNER_NAME, targets: [...descriptor.targets] }) ||
      forbidden.some(field => Object.hasOwn(payload, field)) ||
      !isDeepStrictEqual(payload.exports, { './package.json': './package.json' })) {
    throw new Error('Unexpected native payload package identity or execution policy: ' + descriptor.name)
  }
  if (!isDeepStrictEqual(payload.utexoNativeOverlay, owner.utexoNativeOverlay)) {
    throw new Error('Native payload release graph does not match the owner: ' + descriptor.name)
  }
}

function validatePayload (root, payloadRoot, config = readOverlayConfig(root), descriptor = PAYLOADS[0]) {
  payloadMetadata(root, payloadRoot, descriptor)
  for (const file of [MANIFEST, 'runtime-contract.json']) {
    regularFile(path.join(root, file))
    regularFile(path.join(payloadRoot, file))
    if (!fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(payloadRoot, file)))) {
      throw new Error('Native payload ' + (file === MANIFEST ? 'provenance' : 'runtime contract') + ' does not match the owner: ' + descriptor.name)
    }
  }
  for (const target of descriptor.targets) prebuildPath(payloadRoot, target)
  verifyPackedPrebuilds(payloadRoot, config, descriptor.targets)
  return config
}

function resolvePayload (root, descriptor) {
  try { return path.dirname(require.resolve(descriptor.name + '/package.json', { paths: [root] })) } catch {
    throw new Error('Required native prebuild package is missing: ' + descriptor.name + '; reinstall dependencies and run npm run hydrate-native')
  }
}

function copyFile (source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  // Clone where supported, with the normal byte-copy fallback on other hosts.
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE)
}

function hydrateDistribution (root) {
  const config = readOverlayConfig(root)
  ownerMetadata(root)
  const sources = PAYLOADS.map(descriptor => ({ descriptor, root: resolvePayload(root, descriptor) }))
  // Every package, member and destination is admitted before any write occurs.
  for (const source of sources) validatePayload(root, source.root, config, source.descriptor)
  for (const target of WRAPPER_TARGETS) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, WRAPPER_TARGETS)
  for (const target of PAYLOAD_TARGETS) prebuildPath(root, target, true)
  const staging = fs.mkdtempSync(path.join(root, 'prebuilds', '.native-install-'))
  try {
    copyFile(path.join(root, MANIFEST), path.join(staging, MANIFEST))
    for (const source of sources) {
      for (const target of source.descriptor.targets) copyFile(artifactPaths(source.root, target).prebuild, artifactPaths(staging, target).prebuild)
    }
    // A corrupt late payload or interrupted copy cannot install earlier slices.
    verifyPackedPrebuilds(staging, config, PAYLOAD_TARGETS)
    for (const target of PAYLOAD_TARGETS) {
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

function stagePayloads (root, descriptors = PAYLOADS) {
  const config = readOverlayConfig(root)
  ownerMetadata(root)
  for (const target of config.targets) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, config.targets)
  directory(path.join(root, 'native'))
  // Bootstrap source workspaces only; they are never copied into the wrapper.
  for (const descriptor of descriptors) {
    const destination = path.join(root, descriptor.directory)
    directory(destination)
    payloadMetadata(root, destination, descriptor)
    for (const file of [MANIFEST, 'runtime-contract.json']) {
      if (fs.lstatSync(path.join(destination, file), { throwIfNoEntry: false }) !== undefined) regularFile(path.join(destination, file))
    }
    for (const target of descriptor.targets) prebuildPath(destination, target, true)
  }
  const staging = fs.mkdtempSync(path.join(root, 'native', '.payload-stage-'))
  try {
    for (const descriptor of descriptors) {
      const temporary = path.join(staging, path.basename(descriptor.directory))
      copyFile(path.join(root, descriptor.directory, 'package.json'), path.join(temporary, 'package.json'))
      for (const file of [MANIFEST, 'runtime-contract.json']) copyFile(path.join(root, file), path.join(temporary, file))
      for (const target of descriptor.targets) copyFile(artifactPaths(root, target).prebuild, artifactPaths(temporary, target).prebuild)
      validatePayload(root, temporary, config, descriptor)
    }
    for (const descriptor of descriptors) {
      const temporary = path.join(staging, path.basename(descriptor.directory))
      const destination = path.join(root, descriptor.directory)
      for (const target of descriptor.targets) {
        const file = artifactPaths(destination, target).prebuild
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.renameSync(artifactPaths(temporary, target).prebuild, file)
      }
      for (const file of [MANIFEST, 'runtime-contract.json']) fs.renameSync(path.join(temporary, file), path.join(destination, file))
      validatePayload(root, destination, config, descriptor)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return descriptors.map(descriptor => path.join(root, descriptor.directory))
}

function stageIosPayload (root) { return stagePayloads(root, [PAYLOADS[0]])[0] }

function verifyDistribution (root) {
  const config = readOverlayConfig(root)
  ownerMetadata(root)
  verifyReleaseArtifacts(root)
  for (const target of config.targets) prebuildPath(root, target)
  verifyPackedPrebuilds(root, config, config.targets)
  for (const descriptor of PAYLOADS) validatePayload(root, path.join(root, descriptor.directory), config, descriptor)
}

module.exports = { PAYLOAD_NAME, IOS_TARGETS, PAYLOADS, PAYLOAD_TARGETS, WRAPPER_TARGETS, hydrateDistribution, stageIosPayload, stagePayloads, validatePayload, verifyDistribution }
