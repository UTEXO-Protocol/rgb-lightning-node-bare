'use strict'

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

module.exports = { validateAndroidElf }
