'use strict'

module.exports = {
  extends: ['love'],
  plugins: ['import', 'promise', 'n', '@typescript-eslint'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json', './tsconfig.test.json'],
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/strict-boolean-expressions': 'off',
    'no-console': 'off'
  },
  ignorePatterns: ['lib/', 'coverage/', 'node_modules/', '*.cjs']
}
