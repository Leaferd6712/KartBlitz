import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const host = process.env.E2E_HOST || '127.0.0.1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://${host}:${port}`,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node scripts/e2e-static-server.mjs',
    url: `http://${host}:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
