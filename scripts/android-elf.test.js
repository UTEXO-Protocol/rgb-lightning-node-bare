'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateAndroidElf, validateAndroidLifetime, validateAndroidProtection } = require('./android-elf')

function fixture (arch = 'aarch64') {
  return [{
    FileSummary: { Arch: arch, AddressSize: '64bit' },
    ProgramHeaders: [
      { ProgramHeader: { Type: { Name: 'PT_LOAD' }, Alignment: 16384, Offset: 0, VirtualAddress: 0 } },
      { ProgramHeader: { Type: { Name: 'PT_GNU_RELRO' }, VirtualAddress: 49152, MemSize: 16384 } }
    ]
  }]
}

test('Android 64-bit artifacts require aligned LOAD and RELRO segments', () => {
  assert.doesNotThrow(() => validateAndroidElf(JSON.stringify(fixture()), 'android-arm64'))
  assert.doesNotThrow(() => validateAndroidElf(JSON.stringify(fixture('x86_64')), 'android-x64'))
  const load = fixture()
  load[0].ProgramHeaders[0].ProgramHeader.Alignment = 4096
  assert.throws(() => validateAndroidElf(JSON.stringify(load), 'android-arm64'), /LOAD.*16 KiB/)
  const relro = fixture()
  relro[0].ProgramHeaders[1].ProgramHeader.MemSize = 4096
  assert.throws(() => validateAndroidElf(JSON.stringify(relro), 'android-arm64'), /RELRO.*16 KiB/)
  const offset = fixture()
  offset[0].ProgramHeaders[0].ProgramHeader.Offset = 1
  assert.throws(() => validateAndroidElf(JSON.stringify(offset), 'android-arm64'), /LOAD/)
})

test('Android ELF validation rejects absent, malformed and wrong-target metadata', () => {
  for (const value of [null, [], [{}], [{ FileSummary: { Arch: 'aarch64', AddressSize: '64bit' } }]]) {
    assert.throws(() => validateAndroidElf(JSON.stringify(value), 'android-arm64'))
  }
  assert.throws(() => validateAndroidElf(JSON.stringify(fixture()), 'android-x64'), /identity/)
  const missing = fixture()
  missing[0].ProgramHeaders.pop()
  assert.throws(() => validateAndroidElf(JSON.stringify(missing), 'android-arm64'), /RELRO/)
  const unsafe = fixture()
  unsafe[0].ProgramHeaders[1].ProgramHeader.VirtualAddress = 2 ** 64
  assert.throws(() => validateAndroidElf(JSON.stringify(unsafe), 'android-arm64'), /RELRO/)
})

test('post-link 4 KiB relocation is rejected even when LOAD alignment remains 16 KiB', () => {
  // Observed bare-link 3.3.0 / bare-lief 0.2.5 and 0.2.8 relocation.
  const linked = fixture()
  linked[0].ProgramHeaders[0].ProgramHeader = {
    Type: { Name: 'PT_LOAD' }, Alignment: 16384, Offset: 0x6d350c0, VirtualAddress: 0x6d390c0
  }
  linked[0].ProgramHeaders[1].ProgramHeader = {
    Type: { Name: 'PT_GNU_RELRO' }, VirtualAddress: 0x6d390c0, MemSize: 0x2eff40
  }
  assert.throws(() => validateAndroidElf(JSON.stringify(linked), 'android-arm64'), /RELRO.*16 KiB/)
  linked[0].ProgramHeaders[1].ProgramHeader.VirtualAddress -= 4096
  assert.doesNotThrow(() => validateAndroidElf(JSON.stringify(linked), 'android-arm64'))
})

test('linked validator rejects invalid targets and missing files before launching LLVM', () => {
  const { checkLinked } = require('./check-android-linked')
  assert.throws(() => checkLinked('android-arm', 'unused', '/nonexistent'), /Usage/)
  assert.throws(() => checkLinked('android-arm64', '', '/nonexistent'), /Usage/)
  assert.throws(() => checkLinked('android-arm64', '/nonexistent', '/nonexistent'), /ENOENT/)
})

test('aligned RELRO cannot hide relocated DYNAMIC/GOT or protect mutable data', () => {
  const make = () => [{
    ProgramHeaders: [
      { ProgramHeader: { Type: { Name: 'PT_LOAD' }, VirtualAddress: 16384, MemSize: 16384 } },
      { ProgramHeader: { Type: { Name: 'PT_GNU_RELRO' }, VirtualAddress: 16384, MemSize: 16384 } },
      { ProgramHeader: { Type: { Name: 'PT_DYNAMIC' }, VirtualAddress: 16384, MemSize: 128 } }
    ],
    Sections: [
      { Section: { Name: { Name: '.dynamic' }, Address: 16384, Size: 128, Flags: { Value: 3 } } },
      { Section: { Name: { Name: '.got' }, Address: 16512, Size: 128, Flags: { Value: 3 } } },
      { Section: { Name: { Name: '.data' }, Address: 32768, Size: 128, Flags: { Value: 3 } } }
    ]
  }]
  const verify = value => validateAndroidProtection(JSON.stringify(value))
  assert.doesNotThrow(() => verify(make()))
  const dynamic = make()
  dynamic[0].ProgramHeaders[2].ProgramHeader.VirtualAddress = 49152
  assert.throws(() => verify(dynamic), /DYNAMIC escaped/)
  const got = make()
  got[0].Sections[1].Section.Address = 49152
  assert.throws(() => verify(got), /got escaped/)
  const mutable = make()
  mutable[0].Sections[2].Section.Address = 32760
  assert.throws(() => verify(mutable), /protects mutable/)
  const outside = make()
  outside[0].ProgramHeaders[0].ProgramHeader.MemSize = 128
  assert.throws(() => verify(outside), /outside LOAD/)
  for (const invalid of [null, [], [{}]]) assert.throws(() => verify(invalid))
  const overflow = make()
  overflow[0].Sections[1].Section.Size = 2 ** 64
  assert.throws(() => verify(overflow), /bounds/)
})

test('Android addons retain Rust TLS destructor code for 32-bit and 64-bit worklets', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-elf-lifetime-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const bits of [32, 64]) {
    const width = bits === 64 ? 16 : 8
    const file = path.join(root, `${bits}.so`)
    const metadata = [{
      FileSummary: { AddressSize: `${bits}bit` },
      ProgramHeaders: [{ ProgramHeader: { Type: { Name: 'PT_DYNAMIC' }, Offset: 64, FileSize: width * 3 } }]
    }]
    const bytes = Buffer.alloc(64 + width * 3)
    bytes.writeUInt32BE(0x7f454c46)
    bytes[4] = bits === 64 ? 2 : 1
    bytes[5] = 1
    function write (offset, tag, value) {
      if (bits === 64) {
        bytes.writeBigUInt64LE(tag, offset)
        bytes.writeBigUInt64LE(value, offset + 8)
      } else {
        bytes.writeUInt32LE(Number(tag), offset)
        bytes.writeUInt32LE(Number(value), offset + 4)
      }
    }
    function validate () {
      fs.writeFileSync(file, bytes)
      validateAndroidLifetime(JSON.stringify(metadata), file)
    }
    write(64, 0x6ffffffbn, 9n)
    assert.doesNotThrow(validate)
    write(64, 0x6ffffffbn, 1n)
    assert.throws(validate, /NODELETE/)
    write(64, 0n, 0n)
    assert.throws(validate, /NODELETE/)
    write(64, 0x6ffffffbn, 9n)
    write(64 + width, 0x6ffffffbn, 9n)
    assert.throws(validate, /Duplicate/)
    write(64 + width, 1n, 1n)
    write(64 + width * 2, 1n, 1n)
    assert.throws(validate, /DT_NULL/)
    write(64 + width, 0n, 0n)
    bytes[5] = 2
    assert.throws(validate, /encoding/)
    bytes[5] = 1
    metadata[0].ProgramHeaders[0].ProgramHeader.FileSize += width
    assert.throws(validate, /Truncated/)
    metadata[0].ProgramHeaders[0].ProgramHeader.FileSize = 1024 * 1024 + width
    assert.throws(validate, /bounds/)
  }
})
