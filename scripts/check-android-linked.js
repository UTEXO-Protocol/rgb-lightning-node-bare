#!/usr/bin/env node
'use strict'

const { execFileSync } = require('node:child_process')
const { validateAndroidElf } = require('./android-elf')

// bare-link rewrites ELF metadata. Validate its output, not just the input .bare.
function checkLinked (target, file, readobj = process.env.LLVM_READOBJ || 'llvm-readobj') {
  if (!['android-arm64', 'android-x64'].includes(target) || !file) {
    throw new Error('Usage: check-android-linked.js android-arm64|android-x64 /absolute/path/to/linked.so')
  }
  const output = execFileSync(readobj, ['--elf-output-style=JSON', '--program-headers', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  validateAndroidElf(output, target)
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected target and linked .so path')
    checkLinked(process.argv[2], process.argv[3])
    console.log(`PASS: linked ${process.argv[2]} ELF LOAD and RELRO are 16 KiB aligned`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { checkLinked }
