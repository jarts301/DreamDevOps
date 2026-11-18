import { defineConfig } from 'vitest/config';

/** Tests read the shared kernel's sources, through the export condition the type checker uses, so it needs no build. */
const resolve = {
  conditions: ['@dreamdevops/source', 'module', 'node', 'development|production'],
};

export default defineConfig({
  resolve,
  ssr: { resolve },
  test: {
    include: ['test/**/*.test.ts'],
    // npm run test:coverage measures these tests alone. The API's tests use the contracts
    // too, but don't count here. The thresholds are today's levels, so coverage can only go up.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 54, branches: 41, functions: 36, statements: 54 },
    },
  },
});
