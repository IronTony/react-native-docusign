// Flat config. ESLint 9 ignores .eslintrc.*, which is why the previous
// .eslintrc.js never actually ran in this repo.
const universeNative = require('eslint-config-universe/flat/native');
const universeWeb = require('eslint-config-universe/flat/web');

module.exports = [
  {
    ignores: ['build/**', 'plugin/build/**', 'coverage/**', 'node_modules/**'],
  },
  ...universeNative,
  ...universeWeb,
];
