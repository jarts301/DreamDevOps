import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const kernel = (path: string) => fileURLToPath(new URL(`../../packages/shared-kernel/src/${path}`, import.meta.url));

const resolve = {
  alias: [
    { find: '@dreamdevops/shared-kernel/postgres', replacement: kernel('postgres/index.ts') },
    { find: '@dreamdevops/shared-kernel/testing', replacement: kernel('testing/index.ts') },
    { find: '@dreamdevops/shared-kernel', replacement: kernel('index.ts') },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts', 'test/**/*.scaffold.test.ts'],
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve,
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
