/** @type {import('jest').Config} */
export default {
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      jsx: 'react-jsx',
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  projects: [
    {
      displayName: 'api',
      testMatch: ['<rootDir>/tests/api-*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      moduleFileExtensions: ['ts', 'js', 'json'],
      testTimeout: 10000,
    },
    {
      displayName: 'components',
      testMatch: ['<rootDir>/tests/components/*.test.tsx'],
      testEnvironment: 'jsdom',
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', jsx: 'react-jsx' }],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
      testTimeout: 10000,
    },
  ],
};
