/** @type {import('jest').Config} */
export default {
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/tests/stress/**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  testTimeout: 60000,
  // forceExit is a documented temporary exception. Handle leaks from Redis/DB
  // client imports in unit-test modules prevent Jest from exiting cleanly.
  // Do NOT combine with --detectOpenHandles (unclear semantics).
  // Remove when handle leaks are fixed. See TEST_CLASSIFICATION.md.
  forceExit: true,
  moduleNameMapper: {
    "^@gitwire/runtime/compat/(.*)$": "<rootDir>/../../packages/runtime/compat/$1",
    "^@gitwire/runtime$": "<rootDir>/../../packages/runtime/src/index.js",
  },
};
