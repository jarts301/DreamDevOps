import { defineConfig } from 'vitest/config';

/**
 * Added to what `ng test` sets up: the contracts the API publishes are read as source, as
 * the build reads them, so tests need no build of them first. The rest are Vite's defaults.
 */
const SOURCE = '@dreamdevops/source';

export default defineConfig({
  resolve: { conditions: [SOURCE, 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: [SOURCE, 'module', 'node', 'development|production'] } },
});
