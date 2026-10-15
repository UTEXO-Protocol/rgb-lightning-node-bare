'use strict'

const path = require('node:path')
const { stageIosPayload } = require('./native-distribution')

try {
  console.log('Verified original iOS payload staged at ' + stageIosPayload(path.resolve(__dirname, '..')))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
