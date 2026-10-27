import { defineConfig } from '@playwright/test'
import { defineBddConfig } from 'playwright-bdd'

const testDir = defineBddConfig({
  features: 'tests/local/e2e/features/*.feature',
  steps: 'tests/local/e2e/steps/*.steps.js',
})

export default defineConfig({
  testDir,
  // One worker: every scenario runs against the same seeded Docker stack, so
  // parallel scenarios would race on shared household data. Each scenario
  // resets + reseeds the database in shared.steps.js's Before hook.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'html',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
})
