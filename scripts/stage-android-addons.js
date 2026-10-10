#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const overlay = require('./native-overlay')
const { ABIS, SYSTEM_LIBRARIES, ensure, readElf, validateIdentity, validateLayout, validateImports } = require('./android-staging-elf')

const NAME = 'utexo__rgb-lightning-node-bare'
const PACKAGE = '@utexo/rgb-lightning-node-bare'
const REPORT = 'utexo-android-staging.json'
const BARE_KIT = Object.freeze({
  version: '0.15.5', embeddedBare: '1.33.4',
  runtimeSha256: Object.freeze({
    'arm64-v8a': '39509a4aa0c3e8a3867480726aa38b88c5d770bdff18cb1c1cc3d02ea65d5ac5',
    'armeabi-v7a': '08e31dc99f1e1231c9586e3863c1f09be19466512f1279e359effd07739937c8',
    x86_64: '4a2973706aebaa0a1155888c98389b7902c374f981ef6e5d752a12a2574b2f14'
  })
})
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function regular (file) {
  ensure(fs.lstatSync(file).isFile(), `expected regular non-symlink file: ${file}`)
  return file
}
function directory (dir) {
  ensure(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), `expected non-symlink directory: ${dir}`)
  return dir
}
function sha256 (file) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const fd = fs.openSync(regular(file), 'r')
  try {
    let length
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length))
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function parseAbis (value) {
  const abis = value.split(',').map(abi => abi.trim())
  ensure(abis.length > 0 && new Set(abis).size === abis.length && abis.every(abi => Object.hasOwn(ABIS, abi)), 'unsupported/duplicate ABI; supported: arm64-v8a,armeabi-v7a,x86_64')
  return abis
}
function llvmTools (config) {
  const hosts = path.join(overlay.resolveAndroidNdk(config), 'toolchains/llvm/prebuilt')
  const candidates = fs.readdirSync(hosts).filter(name => fs.statSync(path.join(hosts, name)).isDirectory())
  ensure(candidates.length === 1, 'ambiguous NDK host toolchain')
  const root = path.join(hosts, candidates[0])
  return { root, readobj: regular(path.join(root, 'bin', process.platform === 'win32' ? 'llvm-readobj.exe' : 'llvm-readobj')) }
}

function verifyInputs (root, bareKit, abis) {
  const pkg = readJson(path.join(root, 'package.json'))
  const kit = readJson(path.join(bareKit, 'package.json'))
  ensure(pkg.name === PACKAGE && pkg.addon === true && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version), 'invalid package identity')
  ensure(kit.name === 'react-native-bare-kit' && kit.version === BARE_KIT.version, `reviewed BareKit ${BARE_KIT.version} required`)
  const config = overlay.readOverlayConfig(root)
  ensure(config.buildProfile === 'release', 'release prebuilds required')
  overlay.verifyPackedPrebuilds(root, config, abis.map(abi => ABIS[abi].target))
  const manifest = readJson(path.join(root, '.utexo-native-overlay.json'))
  const tools = llvmTools(config)
  const originals = []
  const soname = `${NAME}@${pkg.version.split('.')[0]}.bare`
  for (const abi of abis) {
    const { target, triple } = ABIS[abi]
    const source = regular(path.join(root, 'prebuilds', target, `${NAME}.bare`))
    const digest = sha256(source)
    ensure(digest === manifest.artifacts[target].prebuildSha256, `prebuild changed for ${abi}`)
    const elf = readElf(source, tools.readobj)
    validateLayout(elf, abi, source)
    ensure(elf.FileSummary.LoadName === soname, `unexpected prebuild SONAME for ${abi}`)
    const runtimeFile = regular(path.join(bareKit, 'android/libs/bare-kit/jni', abi, 'libbare-kit.so'))
    const runtimeSha256 = sha256(runtimeFile)
    ensure(runtimeSha256 === BARE_KIT.runtimeSha256[abi], `unreviewed BareKit runtime for ${abi}`)
    const runtime = readElf(runtimeFile, tools.readobj)
    validateIdentity(runtime, abi)
    const system = SYSTEM_LIBRARIES.map(name => {
      const elf = readElf(regular(path.join(tools.root, 'sysroot/usr/lib', triple, String(config.androidApiLevel), name)), tools.readobj)
      validateIdentity(elf, abi)
      return elf
    })
    validateImports(elf, runtime, system, overlay.PREBUILD_SYMBOLS)
    originals.push({ abi, source, sha256: digest, runtimeSha256 })
  }
  return { pkg, config, originals, tools, soname, filename: `lib${NAME}.${pkg.version}.so` }
}

function planCopies (verified, linked, inspect = readElf) {
  const copies = []
  for (const original of verified.originals) {
    const dir = directory(path.join(linked, original.abi))
    let found = false
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      ensure(entry.isFile() && /^lib[^/\\]+\.so(?:\.\d+)*$/.test(entry.name), `unexpected linked artifact: ${entry.name}`)
      const source = regular(path.join(dir, entry.name))
      const relative = path.join(original.abi, entry.name)
      if (entry.name.startsWith(`lib${NAME}`)) {
        ensure(!found && entry.name === verified.filename, `stale/duplicate RLN addon: ${entry.name}`)
        found = true
        copies.push({ source: original.source, relative, sha256: original.sha256 })
      } else {
        const elf = inspect(source, verified.tools.readobj, false)
        validateIdentity(elf, original.abi)
        ensure(!elf.FileSummary.LoadName?.includes(NAME), `duplicate RLN SONAME: ${entry.name}`)
        // Retaining the original major-version SONAME is only qualified for
        // JS-loaded RLN, not native addons linked against its rewritten name.
        ensure(!elf.NeededLibraries.some(name => name.includes(NAME)), `incoming native RLN dependency: ${entry.name}`)
        copies.push({ source, relative, sha256: sha256(source) })
      }
    }
    ensure(found, `bare-link did not produce ${verified.filename} for ${original.abi}`)
  }
  return copies
}

function ownedOutput (output, protectedRoots) {
  let current = path.resolve(output)
  const missing = []
  while (true) {
    try { fs.lstatSync(current); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missing.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
  directory(current)
  output = path.join(fs.realpathSync(current), ...missing)
  for (const root of protectedRoots) {
    const canonical = fs.realpathSync(root)
    ensure(output !== canonical && !output.startsWith(canonical + path.sep) && !canonical.startsWith(output + path.sep), 'output overlaps an input/package directory')
  }
  if (fs.existsSync(output)) {
    const report = readJson(regular(path.join(output, REPORT)))
    ensure(report.schemaVersion === 1 && report.package === PACKAGE && Array.isArray(report.files), 'refusing to replace an unowned output directory')
    const expected = new Set([REPORT, ...report.files.map(item => item.path), ...report.files.map(item => path.dirname(item.path))])
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        ensure(expected.has(path.relative(output, file)) && !entry.isSymbolicLink(), 'unowned file in staging output')
        if (entry.isDirectory()) walk(file)
        else regular(file)
      }
    }
    walk(output)
  }
  return output
}

function stageCopies (output, copies, report) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.utexo-android-'))
  const backup = `${temporary}.previous`
  try {
    for (const copy of copies) {
      ensure(!path.isAbsolute(copy.relative) && !copy.relative.split(/[\\/]/).includes('..'), 'unsafe output filename')
      const target = path.join(temporary, copy.relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(regular(copy.source), target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
      ensure(sha256(target) === copy.sha256 && sha256(copy.source) === copy.sha256, `source changed or copy corrupted: ${copy.relative}`)
    }
    fs.writeFileSync(path.join(temporary, REPORT), JSON.stringify({ ...report, files: copies.map(({ relative, sha256 }) => ({ path: relative, sha256 })) }, null, 2) + '\n')
    if (fs.existsSync(output)) fs.renameSync(output, backup)
    try { fs.renameSync(temporary, output) } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, output)
      throw error
    }
    fs.rmSync(backup, { recursive: true, force: true })
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

function run ({ root = path.resolve(__dirname, '..'), bareKit, linked, out, abis = Object.keys(ABIS) }) {
  ensure(bareKit && linked && out, '--bare-kit, --linked-dir and --out are required')
  root = fs.realpathSync(root)
  bareKit = fs.realpathSync(bareKit)
  linked = fs.realpathSync(linked)
  abis = parseAbis(abis.join(','))
  const output = ownedOutput(out, [root, bareKit, linked])
  const verified = verifyInputs(root, bareKit, abis)
  const copies = planCopies(verified, linked)
  const report = {
    schemaVersion: 1, package: PACKAGE, version: verified.pkg.version, bareKit: BARE_KIT.version,
    embeddedBare: BARE_KIT.embeddedBare, rlnCommit: verified.config.commit,
    adapterSha256: verified.config.patchSha256, wrapperSha256: verified.config.wrapperSha256,
    originals: verified.originals.map(({ source, ...item }) => item),
    scope: 'Byte-preserving packaging verification; application runtime qualification is separate.'
  }
  stageCopies(output, copies, report)
  return { ...report, output, fileCount: copies.length }
}

function argumentsFor (argv) {
  const options = {}
  const names = { '--bare-kit': 'bareKit', '--linked-dir': 'linked', '--out': 'out', '--abis': 'abis' }
  for (let at = 0; at < argv.length; at++) {
    const key = Object.hasOwn(names, argv[at]) ? names[argv[at]] : null
    ensure(key && !Object.hasOwn(options, key), `unknown/duplicate argument: ${argv[at]}`)
    const value = argv[++at]
    ensure(value && !value.startsWith('--'), 'missing argument value')
    options[key] = key === 'abis' ? parseAbis(value) : path.resolve(value)
  }
  return options
}

module.exports = { NAME, REPORT, BARE_KIT, parseAbis, sha256, verifyInputs, planCopies, ownedOutput, stageCopies, argumentsFor, run }
if (require.main === module) {
  try { console.log(JSON.stringify(run(argumentsFor(process.argv.slice(2))), null, 2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
