'use strict'

const { spawn } = require('node:child_process')
const readline = require('node:readline')

// Stream nm output: Rust archives can emit hundreds of MB of unrelated symbols.
const child = spawn(process.argv[2], JSON.parse(process.argv[3]), { stdio: ['ignore', 'pipe', 'pipe'] })
const symbols = new Set()
let stderr = ''
let error
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const symbol = line.trim()
  if (/^_?(?:rln_[a-z0-9_]+|free_sdk_node|free_native_external_signer|bare_register_module_v0)$/.test(symbol)) symbols.add(symbol)
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
  if (stderr.length > 1024 * 1024) {
    error = 'nm diagnostics exceeded the verification limit'
    child.kill()
  }
})
child.on('error', (cause) => { error = cause.message })
child.on('close', (status) => {
  process.stdout.write(JSON.stringify({ status, stdout: [...symbols].join('\n'), stderr, error }))
})
