'use strict'

const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { validateAndroidProtection, validateAndroidLifetime } = require('./android-elf')

const ABIS = Object.freeze({
  'arm64-v8a': { target: 'android-arm64', arch: 'aarch64', bits: 64, page: 16384, triple: 'aarch64-linux-android' },
  'armeabi-v7a': { target: 'android-arm', arch: 'arm', bits: 32, page: 4096, triple: 'arm-linux-androideabi' },
  x86_64: { target: 'android-x64', arch: 'x86_64', bits: 64, page: 16384, triple: 'x86_64-linux-android' }
})
const SYSTEM_LIBRARIES = ['libc.so', 'libdl.so', 'liblog.so', 'libm.so', 'libz.so']
const JS_IMPORTS = new Set([
  'js_add_teardown_callback', 'js_create_external', 'js_create_function',
  'js_create_string_utf8', 'js_get_callback_info', 'js_get_null', 'js_get_undefined',
  'js_get_value_bool', 'js_get_value_double', 'js_get_value_external',
  'js_get_value_string_utf8', 'js_remove_teardown_callback', 'js_set_named_property',
  'js_throw_error', 'js_throw_type_error', 'js_typeof'
])
const OPTIONAL_IMPORTS = new Set([
  'OPENSSL_memory_alloc', 'OPENSSL_memory_free', 'OPENSSL_memory_get_size',
  'OPENSSL_memory_realloc', 'ZSTD_trace_compress_begin', 'ZSTD_trace_compress_end',
  'ZSTD_trace_decompress_begin', 'ZSTD_trace_decompress_end', 'copy_file_range',
  'memfd_create', 'sdallocx'
])
const ensure = (condition, message) => { if (!condition) throw new Error(`Android staging: ${message}`) }
const integer = value => Number.isSafeInteger(value) && value >= 0

function readElf (file, readobj, symbols = true) {
  const flags = ['--elf-output-style=JSON', '--file-header', '--program-headers', '--sections', '--needed-libs']
  if (symbols) flags.push('--dyn-symbols')
  const files = JSON.parse(execFileSync(readobj, [...flags, file], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
  ensure(Array.isArray(files) && files.length === 1, 'invalid LLVM output')
  const elf = files[0]
  ensure(elf.ElfHeader?.Ident?.DataEncoding?.Name === 'LittleEndian', 'unsupported ELF byte order')
  elf.dynamic = readDynamic(file, elf)
  return elf
}

function readDynamic (file, elf) {
  const dynamic = elf.ProgramHeaders?.map(entry => entry.ProgramHeader).filter(header => header.Type?.Name === 'PT_DYNAMIC')
  ensure(dynamic?.length === 1, 'expected one dynamic segment')
  const { Offset: offset, FileSize: size } = dynamic[0]
  const bits = elf.FileSummary?.AddressSize
  ensure(['32bit', '64bit'].includes(bits), 'unsupported ELF address size')
  const width = bits === '64bit' ? 8 : 4
  ensure(integer(offset) && integer(size) && size > 0 && size <= 1024 * 1024 &&
    size % (width * 2) === 0 && integer(offset + size) && offset + size <= fs.statSync(file).size,
  'invalid dynamic bounds')
  // NDK r27 does not emit valid JSON for --dynamic-table; decode only the
  // bounded segment described by LLVM, not a second implementation of ELF.
  const bytes = Buffer.alloc(size)
  const fd = fs.openSync(file, 'r')
  try { ensure(fs.readSync(fd, bytes, 0, size, offset) === size, 'truncated dynamic segment') } finally { fs.closeSync(fd) }
  const entries = new Map()
  for (let at = 0; at < size; at += width * 2) {
    const tag = width === 8 ? bytes.readBigUInt64LE(at) : BigInt(bytes.readUInt32LE(at))
    const value = width === 8 ? bytes.readBigUInt64LE(at + width) : BigInt(bytes.readUInt32LE(at + width))
    if (tag === 0n) return entries
    if (!entries.has(tag)) entries.set(tag, [])
    entries.get(tag).push(value)
  }
  throw new Error('Android staging: dynamic segment lacks DT_NULL')
}

function dynamicFlag (elf, tag, mask) {
  const values = elf.dynamic.get(tag) || []
  ensure(values.length <= 1, 'duplicate dynamic flags')
  return values.length === 1 && (values[0] & mask) !== 0n
}

function validateIdentity (elf, abi) {
  const expected = ABIS[abi]
  ensure(expected && elf.FileSummary?.Arch === expected.arch &&
    elf.FileSummary?.AddressSize === `${expected.bits}bit` &&
    elf.ElfHeader?.Ident?.DataEncoding?.Name === 'LittleEndian' &&
    elf.ElfHeader?.Type === 'SharedObject (0x3)', `ELF ABI mismatch for ${abi}`)
}

function validateLayout (elf, abi, file) {
  validateIdentity(elf, abi)
  const { page } = ABIS[abi]
  const headers = elf.ProgramHeaders?.map(entry => entry.ProgramHeader) || []
  const loads = headers.filter(header => header.Type?.Name === 'PT_LOAD')
  const relro = headers.filter(header => header.Type?.Name === 'PT_GNU_RELRO')
  const stack = headers.filter(header => header.Type?.Name === 'PT_GNU_STACK')
  ensure(loads.length > 0 && relro.length === 1, 'missing LOAD/RELRO')
  ensure(stack.length === 1 && integer(stack[0].Flags?.Value) && (stack[0].Flags.Value & 1) === 0, 'executable or missing GNU_STACK')
  for (const header of headers) {
    for (const key of ['VirtualAddress', 'MemSize', 'Offset', 'FileSize', 'Alignment']) ensure(integer(header[key]), `invalid program header ${key}`)
    ensure(integer(header.VirtualAddress + header.MemSize) && integer(header.Flags?.Value), 'invalid program header bounds/flags')
  }
  for (const load of loads) {
    ensure(load.Alignment >= page && load.Alignment % page === 0 &&
      (load.VirtualAddress - load.Offset) % page === 0, `LOAD is not ${page}-byte aligned`)
    ensure((load.Flags.Value & 3) !== 3, 'writable executable LOAD')
  }
  ensure(relro[0].MemSize > 0 && (relro[0].VirtualAddress + relro[0].MemSize) % page === 0, 'RELRO end is not page aligned')
  const output = JSON.stringify([elf])
  validateAndroidProtection(output, page)
  validateAndroidLifetime(output, file)
  ensure(dynamicFlag(elf, 30n, 8n) || dynamicFlag(elf, 0x6ffffffbn, 1n) || elf.dynamic.has(24n), 'BIND_NOW is required')
  ensure(!elf.dynamic.has(22n) && !dynamicFlag(elf, 30n, 4n), 'text relocations are forbidden')
  ensure(!elf.dynamic.has(15n) && !elf.dynamic.has(29n), 'unexpected RPATH/RUNPATH')
}

const symbolName = symbol => symbol.Name.Name.replace('@@', '@')
function exportedSymbols (elf) {
  return new Set((elf.DynamicSymbols || []).map(entry => entry.Symbol)
    .filter(symbol => symbol.Section.Name !== 'Undefined' && ['Global', 'Weak'].includes(symbol.Binding.Name) &&
      [0, 3].includes(symbol.Other.Value & 3)).map(symbolName))
}

function validateImports (elf, runtime, systemElfs, requiredExports) {
  ensure(JSON.stringify([...elf.NeededLibraries].sort()) === JSON.stringify(SYSTEM_LIBRARIES), 'unreviewed native dependency set')
  ensure(dynamicFlag(runtime, 0x6ffffffbn, 2n), 'BareKit is not in the global loader group')
  const runtimeSymbols = exportedSymbols(runtime)
  const systemSymbols = new Set(systemElfs.flatMap(item => [...exportedSymbols(item)]))
  const exports = exportedSymbols(elf)
  for (const name of requiredExports) ensure(exports.has(name), `missing native export ${name}`)
  for (const { Symbol: symbol } of elf.DynamicSymbols || []) {
    if (symbol.Section.Name !== 'Undefined' || !symbol.Name.Name) continue
    const name = symbolName(symbol)
    if (symbol.Binding.Name === 'Weak' && OPTIONAL_IMPORTS.has(name)) continue
    if (JS_IMPORTS.has(name)) ensure(runtimeSymbols.has(name), `BareKit cannot resolve ${name}`)
    else ensure(systemSymbols.has(name), `unapproved or unresolved native import ${name}`)
  }
}

module.exports = { ABIS, SYSTEM_LIBRARIES, ensure, readElf, readDynamic, validateIdentity, validateLayout, validateImports, exportedSymbols }
