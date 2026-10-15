'use strict'

const path = require('node:path')
const { verifyDistribution } = require('./native-distribution')

verifyDistribution(path.resolve(__dirname, '..'))
console.log('Verified all seven owner prebuilds and all three exact matching data-only payloads.')
