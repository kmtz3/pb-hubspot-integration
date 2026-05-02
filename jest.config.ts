import type { Config } from 'jest';

const config: Config = {
  collectCoverage: false,
  collectCoverageFrom: [
    'src/sync/mapper.ts',
    'src/sync/dedup.ts',
    'src/sync/rateLimit.ts',
    'src/sync/engine.ts',
  ],
  coverageThreshold: {
    global: {},
    './src/sync/mapper.ts':    { lines: 95 },
    './src/sync/dedup.ts':     { lines: 90 },
    './src/sync/rateLimit.ts': { lines: 90 },
    './src/sync/engine.ts':    { lines: 85 },
  },
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      testEnvironment: 'node',
      transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
      setupFilesAfterEnv: [],
    },
    {
      displayName: 'firestore',
      testMatch: ['<rootDir>/tests/firestore/**/*.test.ts'],
      testEnvironment: 'node',
      transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      testEnvironment: 'node',
      transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
    },
  ],
};

export default config;
