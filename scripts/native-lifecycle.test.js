const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

test('native environment cleanup preserves ownership, shutdown order and failure safety', () => {
  const root = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rln-native-lifecycle-unit-'))
  try {
    const executable = path.join(directory, 'native-lifecycle')
    execFileSync(process.env.CXX || 'c++', [
      '-std=c++17', '-O1', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
      '-ffunction-sections', '-fdata-sections',
      process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections',
      '-I', path.join(root, 'node_modules/bare-headers/include'),
      path.join(__dirname, 'fixtures/native-lifecycle.cc'), '-o', executable
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(output, /native lifecycle fault\/order controls passed/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
