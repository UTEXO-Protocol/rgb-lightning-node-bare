'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { NAME, REPORT, parseAbis, sha256, planCopies, ownedOutput, stageCopies, argumentsFor } = require('./stage-android-addons')
const { readDynamic, validateImports } = require('./android-staging-elf')
const { validateAndroidProtection } = require('./android-elf')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-staging-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const linked = path.join(root, 'linked')
  fs.mkdirSync(path.join(linked, 'arm64-v8a'), { recursive: true })
  const source = path.join(root, 'original.bare')
  fs.writeFileSync(source, 'verified native bytes')
  const filename = `lib${NAME}.0.2.0-beta.3.so`
  fs.writeFileSync(path.join(linked, 'arm64-v8a', filename), 'damaged linker bytes')
  const other = path.join(linked, 'arm64-v8a/libother.so')
  fs.writeFileSync(other, 'other addon')
  return {
    root, linked, source, other,
    verified: {
      filename, tools: {}, originals: [{ abi: 'arm64-v8a', source, sha256: sha256(source) }]
    },
    inspect: () => ({
      FileSummary: { Arch: 'aarch64', AddressSize: '64bit', LoadName: 'libother.so' },
      ElfHeader: { Type: 'SharedObject (0x3)', Ident: { DataEncoding: { Name: 'LittleEndian' } } },
      NeededLibraries: []
    })
  }
}

test('Android staging arguments reject unsupported ABIs, duplicate flags and missing values', () => {
  assert.deepEqual(parseAbis('arm64-v8a, armeabi-v7a,x86_64'), ['arm64-v8a', 'armeabi-v7a', 'x86_64'])
  for (const value of ['', 'x86', '__proto__', 'arm64-v8a,arm64-v8a']) assert.throws(() => parseAbis(value))
  for (const args of [['--out'], ['--unknown', 'x'], ['--abis', 'arm64-v8a', '--abis', 'x86_64']]) assert.throws(() => argumentsFor(args))
  assert.deepEqual(argumentsFor(['--abis', 'x86_64']).abis, ['x86_64'])
  assert.throws(() => validateAndroidProtection('[]', 8192), /page size/)
})

test('staging replaces only RLN, preserves other addons and never edits linker output', t => {
  const f = fixture(t)
  const copies = planCopies(f.verified, f.linked, f.inspect)
  assert.equal(copies.length, 2)
  assert.equal(copies.find(copy => copy.relative.endsWith(f.verified.filename)).source, f.source)
  const output = ownedOutput(path.join(f.root, 'generated', 'staged'), [f.linked])
  const report = { schemaVersion: 1, package: '@utexo/rgb-lightning-node-bare' }
  stageCopies(output, copies, report)
  assert.equal(sha256(path.join(output, 'arm64-v8a', f.verified.filename)), sha256(f.source))
  assert.equal(sha256(path.join(output, 'arm64-v8a/libother.so')), sha256(f.other))
  assert.equal(fs.readFileSync(path.join(f.linked, 'arm64-v8a', f.verified.filename), 'utf8'), 'damaged linker bytes')
  assert.equal(ownedOutput(output, [f.linked]), fs.realpathSync(output))
  stageCopies(output, copies, report)
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, REPORT))).files.length, 2)
})

test('staging rejects stale, absent and symlinked RLN outputs', t => {
  const f = fixture(t)
  const file = path.join(f.linked, 'arm64-v8a', f.verified.filename)
  fs.renameSync(file, file.replace('beta.3', 'beta.2'))
  assert.throws(() => planCopies(f.verified, f.linked, f.inspect), /stale\/duplicate/)
  fs.unlinkSync(file.replace('beta.3', 'beta.2'))
  assert.throws(() => planCopies(f.verified, f.linked, f.inspect), /did not produce/)
  fs.symlinkSync(f.source, file)
  assert.throws(() => planCopies(f.verified, f.linked, f.inspect), /unexpected linked artifact/)
})

test('staging rejects ABI mismatch, SONAME collisions and incoming RLN native dependencies', t => {
  const f = fixture(t)
  for (const change of [
    elf => { elf.FileSummary.Arch = 'x86_64' },
    elf => { elf.FileSummary.LoadName = `${NAME}@0.bare` },
    elf => { elf.NeededLibraries.push(f.verified.filename) },
    elf => { elf.NeededLibraries.push(`${NAME}@0.bare`) }
  ]) {
    assert.throws(() => planCopies(f.verified, f.linked, () => { const elf = f.inspect(); change(elf); return elf }))
  }
})

test('staging refuses overlapping inputs, unowned output and output symlinks', t => {
  const f = fixture(t)
  assert.throws(() => ownedOutput(path.join(f.linked, 'out'), [f.linked]), /overlaps/)
  assert.throws(() => ownedOutput(f.root, [f.linked]), /overlaps/)
  const output = path.join(f.root, 'out')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'user-data'), 'must remain')
  assert.throws(() => ownedOutput(output, [f.linked]))
  fs.symlinkSync(output, path.join(f.root, 'alias'))
  assert.throws(() => ownedOutput(path.join(f.root, 'alias'), [f.linked]), /non-symlink/)
  assert.equal(fs.readFileSync(path.join(output, 'user-data'), 'utf8'), 'must remain')
})

test('copy corruption fails without replacing the previous staged tree', t => {
  const f = fixture(t)
  const output = path.join(f.root, 'out')
  const copies = planCopies(f.verified, f.linked, f.inspect)
  const report = { schemaVersion: 1, package: '@utexo/rgb-lightning-node-bare' }
  stageCopies(output, copies, report)
  const before = fs.readFileSync(path.join(output, REPORT), 'utf8')
  assert.throws(() => stageCopies(output, [{ ...copies[0], sha256: 'invalid' }], report), /changed or copy corrupted/)
  assert.equal(fs.readFileSync(path.join(output, REPORT), 'utf8'), before)
  for (const relative of ['../escape', '/absolute']) assert.throws(() => stageCopies(output, [{ ...copies[0], relative }], report), /unsafe/)
  fs.writeFileSync(path.join(output, 'user-data'), 'preserve')
  assert.throws(() => ownedOutput(output, [f.linked]), /unowned file/)
})

test('failed atomic promotion restores the previous tree', t => {
  const f = fixture(t)
  const output = path.join(f.root, 'out')
  const copies = planCopies(f.verified, f.linked, f.inspect)
  stageCopies(output, copies, { version: 'old' })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === output && !from.endsWith('.previous')) throw new Error('simulated promotion failure')
    rename(from, to)
  })
  assert.throws(() => stageCopies(output, copies, { version: 'new' }), /promotion failure/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, REPORT))).version, 'old')
})

const symbol = (name, defined = true, weak = false) => ({ Symbol: {
  Name: { Name: name }, Section: { Name: defined ? '.text' : 'Undefined' },
  Binding: { Name: weak ? 'Weak' : 'Global' }, Other: { Value: 0 }
} })

test('only actual system and reviewed Bare imports qualify for byte-preserving staging', () => {
  const elf = { NeededLibraries: ['libc.so', 'libdl.so', 'liblog.so', 'libm.so', 'libz.so'],
    DynamicSymbols: [symbol('bare_register_addon_v0'), symbol('js_typeof', false), symbol('malloc@LIBC', false)] }
  const runtime = { dynamic: new Map([[0x6ffffffbn, [2n]]]), DynamicSymbols: [symbol('js_typeof')] }
  const system = [{ DynamicSymbols: [symbol('malloc@@LIBC')] }]
  validateImports(elf, runtime, system, ['bare_register_addon_v0'])
  assert.throws(() => validateImports(elf, { ...runtime, dynamic: new Map() }, system, []), /global loader/)
  assert.throws(() => validateImports(elf, { ...runtime, DynamicSymbols: [] }, system, []), /cannot resolve/)
  assert.throws(() => validateImports(elf, runtime, [], []), /unresolved/)
  assert.throws(() => validateImports(elf, runtime, system, ['missing']), /missing native export/)
  assert.throws(() => validateImports({ ...elf, NeededLibraries: [...elf.NeededLibraries, 'libbare-fs.so'] }, runtime, system, []), /dependency set/)
  assert.throws(() => validateImports({ ...elf, DynamicSymbols: [symbol('unexpected', false, true)] }, runtime, system, []), /unresolved/)
})

test('bounded dynamic decoder supports both ELF widths and rejects malformed segments', t => {
  const f = fixture(t)
  for (const width of [4, 8]) {
    const bytes = Buffer.alloc(16 + width * 4)
    if (width === 8) { bytes.writeBigUInt64LE(0x6ffffffbn, 16); bytes.writeBigUInt64LE(9n, 24) }
    else { bytes.writeUInt32LE(0x6ffffffb, 16); bytes.writeUInt32LE(9, 20) }
    fs.writeFileSync(f.source, bytes)
    const elf = { FileSummary: { AddressSize: `${width * 8}bit` }, ProgramHeaders: [{ ProgramHeader: {
      Type: { Name: 'PT_DYNAMIC' }, Offset: 16, FileSize: width * 4
    } }] }
    assert.deepEqual(readDynamic(f.source, elf).get(0x6ffffffbn), [9n])
    elf.ProgramHeaders[0].ProgramHeader.FileSize += 1
    assert.throws(() => readDynamic(f.source, elf), /bounds/)
    elf.ProgramHeaders[0].ProgramHeader.FileSize = width * 2
    assert.throws(() => readDynamic(f.source, elf), /DT_NULL/)
  }
})
