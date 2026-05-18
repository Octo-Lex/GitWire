/** @type {import('jest').Config} */
export default {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  testTimeout: 10000,
  // ESM support (type:module in package.json handles this)
};
