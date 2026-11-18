import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // npm run test:coverage measures the unit tests. The thresholds are today's levels, so
    // coverage can only go up. Branches were lowered once, when the payload reader, fully
    // covered, gave way to the contracts package's event contracts.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 65, branches: 56, functions: 63, statements: 65 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
