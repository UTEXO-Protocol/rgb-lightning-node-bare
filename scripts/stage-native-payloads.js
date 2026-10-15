'use strict'

const path = require('node:path')
const { stagePayloads } = require('./native-distribution')

try {
  console.log('Verified original native payloads staged at ' + stagePayloads(path.resolve(__dirname, '..')).join(', '))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
