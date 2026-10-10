'use strict'

const fs = require('node:fs')

// Consume llvm-readobj's structured output, not localized command-line tables.
function validateAndroidElf (output, target) {
  const files = JSON.parse(output)
  const expectedArch = target === 'android-arm64' ? 'aarch64' : target === 'android-x64' ? 'x86_64' : null
  if (!expectedArch || !Array.isArray(files) || files.length !== 1 ||
      files[0]?.FileSummary?.Arch !== expectedArch || files[0]?.FileSummary?.AddressSize !== '64bit') {
    throw new Error(`Invalid Android ELF identity for ${target}`)
  }
  const headers = files[0].ProgramHeaders?.map(entry => entry.ProgramHeader)
  if (!Array.isArray(headers)) throw new Error('Missing Android ELF program headers')
  const loads = headers.filter(header => header?.Type?.Name === 'PT_LOAD')
  const relros = headers.filter(header => header?.Type?.Name === 'PT_GNU_RELRO')
  if (!loads.length || !relros.length) throw new Error('Android ELF requires LOAD and RELRO segments')
  const integer = value => Number.isSafeInteger(value) && value >= 0
  for (const header of loads) {
    if (!integer(header.Alignment) || header.Alignment < 16384 ||
        !integer(header.VirtualAddress) || !integer(header.Offset) ||
        (header.VirtualAddress - header.Offset) % 16384 !== 0) {
      throw new Error('Android ELF LOAD segment is not 16 KiB aligned')
    }
  }
  for (const header of relros) {
    const end = header.VirtualAddress + header.MemSize
    if (!integer(header.VirtualAddress) || !integer(header.MemSize) || !integer(end) || end % 16384 !== 0) {
      throw new Error('Android ELF RELRO end is not 16 KiB aligned')
    }
  }
}

// NDK r27 emits text inside JSON for --dynamic-table. Read only the bounded
// PT_DYNAMIC bytes described by its structured program-header output instead.
function validateAndroidLifetime (output, file) {
  const files = JSON.parse(output)
  if (!Array.isArray(files) || files.length !== 1) throw new Error('Invalid Android ELF metadata')
  const size64 = files[0]?.FileSummary?.AddressSize === '64bit'
  const size32 = files[0]?.FileSummary?.AddressSize === '32bit'
  const headers = files[0]?.ProgramHeaders?.map(entry => entry.ProgramHeader)
  const dynamic = headers?.filter(header => header?.Type?.Name === 'PT_DYNAMIC')
  if ((!size64 && !size32) || dynamic?.length !== 1) throw new Error('Missing Android ELF dynamic segment')
  const { Offset: offset, FileSize: size } = dynamic[0]
  const width = size64 ? 16 : 8
  if (!Number.isSafeInteger(offset) || offset < 16 ||
      !Number.isSafeInteger(size) || size < width || size > 1024 * 1024 || size % width !== 0 ||
      !Number.isSafeInteger(offset + size)) throw new Error('Invalid Android ELF dynamic bounds')
  const fd = fs.openSync(file, 'r')
  let bytes
  try {
    if (offset + size > fs.fstatSync(fd).size) throw new Error('Truncated Android ELF dynamic segment')
    const ident = Buffer.alloc(16)
    if (fs.readSync(fd, ident, 0, 16, 0) !== 16 || ident.readUInt32BE(0) !== 0x7f454c46 ||
        ident[4] !== (size64 ? 2 : 1) || ident[5] !== 1) throw new Error('Invalid Android ELF encoding')
    bytes = Buffer.alloc(size)
    if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error('Truncated Android ELF dynamic segment')
  } finally {
    fs.closeSync(fd)
  }
  let flags
  for (let offset = 0; offset < bytes.length; offset += width) {
    const tag = size64 ? bytes.readBigUInt64LE(offset) : BigInt(bytes.readUInt32LE(offset))
    const value = size64 ? bytes.readBigUInt64LE(offset + 8) : BigInt(bytes.readUInt32LE(offset + 4))
    if (tag === 0n) {
      if (flags === undefined || (flags & 8n) === 0n) throw new Error('Android Rust addon requires DF_1_NODELETE')
      return
    }
    if (tag === 0x6ffffffbn) {
      if (flags !== undefined) throw new Error('Duplicate Android ELF DT_FLAGS_1')
      flags = value
    }
  }
  throw new Error('Android ELF dynamic segment lacks DT_NULL')
}

function validateAndroidProtection (output, pageSize = 16384) {
  if (![4096, 16384].includes(pageSize)) throw new Error('Unsupported Android page size')
  const files = JSON.parse(output)
  if (!Array.isArray(files) || files.length !== 1) throw new Error('Invalid Android ELF metadata')
  const headers = files[0]?.ProgramHeaders?.map(entry => entry.ProgramHeader)
  const sections = files[0]?.Sections?.map(entry => entry.Section)
  if (!Array.isArray(headers) || !Array.isArray(sections)) throw new Error('Missing Android ELF sections or headers')
  const relros = headers.filter(header => header?.Type?.Name === 'PT_GNU_RELRO')
  const dynamics = headers.filter(header => header?.Type?.Name === 'PT_DYNAMIC')
  const loads = headers.filter(header => header?.Type?.Name === 'PT_LOAD')
  const integer = value => Number.isSafeInteger(value) && value >= 0
  const valid = (address, size) => integer(address) && integer(size) && size > 0 && integer(address + size)
  if (relros.length !== 1 || dynamics.length !== 1) throw new Error('Expected one Android RELRO and DYNAMIC segment')
  const r = relros[0]
  if (!valid(r.VirtualAddress, r.MemSize)) throw new Error('Invalid Android RELRO bounds')
  const contains = (address, size) => valid(address, size) && address >= r.VirtualAddress && address + size <= r.VirtualAddress + r.MemSize
  if (!loads.some(load => valid(load.VirtualAddress, load.MemSize) &&
      r.VirtualAddress >= load.VirtualAddress && r.VirtualAddress + r.MemSize <= load.VirtualAddress + load.MemSize)) {
    throw new Error('Android RELRO is outside LOAD')
  }
  if (!contains(dynamics[0].VirtualAddress, dynamics[0].MemSize)) throw new Error('Android DYNAMIC escaped RELRO')
  if (!sections.some(section => section?.Name?.Name === '.dynamic') ||
      !sections.some(section => section?.Name?.Name === '.got')) throw new Error('Missing protected Android ELF sections')
  const start = Math.floor(r.VirtualAddress / pageSize) * pageSize
  const end = r.VirtualAddress + r.MemSize
  for (const section of sections) {
    if (!integer(section?.Address) || !integer(section?.Size) || !integer(section.Address + section.Size) ||
        !integer(section?.Flags?.Value)) throw new Error('Invalid Android ELF section bounds')
    if (!section.Size || !(section.Flags.Value & 2)) continue
    const protectedSection = /^(\.dynamic|\.got(?:\.plt)?|\.data\.rel\.ro(?:\..*)?|\.init_array|\.fini_array|\.relro_padding)$/.test(section.Name?.Name)
    if (protectedSection && !contains(section.Address, section.Size)) throw new Error(`${section.Name.Name} escaped RELRO`)
    if (!protectedSection && (section.Flags.Value & 1) && section.Address < end && section.Address + section.Size > start) {
      throw new Error(`Android RELRO protects mutable ${section.Name?.Name}`)
    }
  }
}

module.exports = { validateAndroidElf, validateAndroidLifetime, validateAndroidProtection }
