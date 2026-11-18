import { defineConfig } from 'vitest/config';

/**
 * Tests read the shared kernel's sources, through the same export condition as the type
 * checker, so they need no build of it and can't test a stale one. The others are Vite's
 * defaults for code that runs in Node.
 */
const resolve = {
  conditions: ['@dreamdevops/source', 'module', 'node', 'development|production'],
};

export default defineConfig({
  test: {
    // npm run test:coverage measures the unit tests. The thresholds are today's levels, so
    // coverage can only go up.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 39, branches: 35, functions: 36, statements: 39 },
    },
    projects: [
      {
        resolve,
        ssr: { resolve },
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts', 'test/**/*.scaffold.test.ts'],
        },
      },
      {
        resolve,
        ssr: { resolve },
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve,
        ssr: { resolve },
        test: {
          // Slow, and needs Docker and the internet, so it runs only on request.
          name: 'scaffolds',
          include: ['test/**/*.scaffold.test.ts'],
          // Compiled services, such as in Rust, build twice: in their pipeline and in their image.
          testTimeout: 1_800_000,
          // Cleaning up removes every project's node_modules, and stops the metrics sink.
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
