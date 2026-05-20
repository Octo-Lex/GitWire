/** @type {import('jest').Config} */
export default {
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/tests/stress/**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  testTimeout: 60000,
  // ESM support (type:module in package.json handles this)
};
