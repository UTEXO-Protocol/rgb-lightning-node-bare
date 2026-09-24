'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { validateAndroidElf } = require('./android-elf')

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
