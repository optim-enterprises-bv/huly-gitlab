/** @type {import('ts-jest').JestConfigWithTsJest} */
const base = require('./jest.config.js')

module.exports = {
  ...base,
  testMatch: ['**/tests/e2e/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/fakes/'],
  testTimeout: 600000
}
