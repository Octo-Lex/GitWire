/** @type {import('jest').Config} */
export default {
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/tests/stress/**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  testTimeout: 60000,
  moduleNameMapper: {
    "^@gitwire/runtime/compat/(.*)$": "<rootDir>/../../packages/runtime/compat/$1",
    "^@gitwire/runtime$": "<rootDir>/../../packages/runtime/src/index.js",
  },
};
