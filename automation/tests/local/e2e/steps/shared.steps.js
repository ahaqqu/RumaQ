import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'
import { resetDb, seedDb } from '../../../support/db.js'

const { createBdd, test } = pkg

const { Given, When, Before } = createBdd(test)

// Seeded by automation/tests/fixtures/seed.sql; the local test stack runs
// with EMAIL_AUTH_ENABLED=true.
export const TEST_EMAIL = 'test@rumaq.dev'
export const TEST_PASSWORD = 'password123'

// Every scenario mutates shared backend state (one seeded household in the
// Docker stack), so reset to the deterministic seed before each scenario.
// Scenarios run sequentially (workers: 1 in playwright.config.js).
Before(async () => {
  await resetDb()
  await seedDb()
})

// Log in through the UI from wherever the browser currently is. Kept as a
// helper so smoke.steps.js and the page features share one login path.
export async function loginViaUi(page) {
  await page.goto('/')
  await page.waitForSelector('input#email', { timeout: 15_000 })
  await page.fill('input#email', TEST_EMAIL)
  await page.fill('input#password', TEST_PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 })
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
}

Given('I am logged in as the seeded test user', async ({ page }) => {
  await loginViaUi(page)
})

When('I navigate to {string}', async ({ page }, path) => {
  // Direct URL navigation is deterministic and viewport-independent (the
  // desktop rail is CSS-hidden on small viewports, so link clicks are not).
  await page.goto(path)
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
})
