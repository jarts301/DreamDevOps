import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './e2e-results',
  use: {
    baseURL: 'http://localhost:4200',
    // Uses the Chrome already installed, so no browser has to be downloaded.
    channel: 'chrome',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run start:api',
      cwd: '../..',
      url: 'http://localhost:4000/api/v1/health/ready',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run start:dashboard',
      cwd: '../..',
      url: 'http://localhost:4200',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
