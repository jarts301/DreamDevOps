import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    // Unit tests sit next to the code, and end-to-end tests of the HTTP API in test/.
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
  },
});
