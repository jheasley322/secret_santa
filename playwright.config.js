// Playwright config for the Secret Santa e2e suite (tests/e2e/).
//
// SAFETY (CLAUDE.md rule 9, spec "Texting -> HARD LIMITS"):
//   * TEXTS_DRY_RUN is forced to 'true' for this process and everything it starts.
//   * Every page intercepts **/functions/v1/send-texts with a local stub that
//     writes dry-run rows; the deployed function is never called (tests/e2e/support/fixtures.mjs).
//   * textbelt.com is blocked on every page.
//   * This config never loads .env; global setup reads only SUPABASE_DB_URL
//     and SUPABASE_PUBLISHABLE_KEY by name (tests/tools/env.mjs).

import { defineConfig, devices } from '@playwright/test'

process.env.TEXTS_DRY_RUN = 'true'

const PORT = 8787

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.js$/,
  // Writes are real (project hnnzoiuibnikrucncphu), so run one file at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  globalSetup: './tests/e2e/global-setup.mjs',
  globalTeardown: './tests/e2e/global-teardown.mjs',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Pixel 7']
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node tests/e2e/support/static-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    env: { TEXTS_DRY_RUN: 'true' }
  }
})
