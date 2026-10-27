import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'
import { TEST_EMAIL as EMAIL, TEST_PASSWORD as PASSWORD } from './shared.steps.js'

const { createBdd, test } = pkg

const { Given, When, Then } = createBdd(test)

// Credentials come from shared.steps.js (seeded by
// automation/tests/fixtures/seed.sql; the local test stack runs with
// EMAIL_AUTH_ENABLED=true).

Given('I visit the app', async ({ page }) => {
  await page.goto('/')
})

Then('the page should have a title', async ({ page }) => {
  const title = await page.title()
  expect(title).toBeTruthy()
})

Then('the root element should be mounted', async ({ page }) => {
  const root = page.locator('#root')
  await expect(root).toBeAttached()
})

Then('the login form should be visible', async ({ page }) => {
  // The email form renders after the email-auth status check resolves.
  await page.waitForSelector('input#email', { timeout: 15_000 })
  await page.waitForSelector('input#password', { timeout: 5_000 })
})

When('I log in with the seeded test user', async ({ page }) => {
  await page.fill('input#email', EMAIL)
  await page.fill('input#password', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 })
})

Then('the topbar should be visible', async ({ page }) => {
  // AppShell renders a sticky <header> without a class hook since the
  // Tailwind migration; the first header on the page is the top bar.
  await expect(page.locator('header').first()).toBeVisible({ timeout: 5_000 })
})

Then('a heading should be visible', async ({ page }) => {
  await expect(page.locator('h1, h2, h3').first()).toBeVisible({
    timeout: 5_000,
  })
})

When('I log out via the logout URL', async ({ page }) => {
  // Wait out the query-cache persister's 1s write throttle so the
  // authenticated cache is guaranteed to be on disk, then log out via a
  // full-page navigation. This mirrors the production smoke test and
  // bypasses the SPA's queryClient.clear() path on purpose: the page after
  // logout must recover to the login form even with a stale persisted cache.
  await page.waitForTimeout(1_500)
  await page.goto('/api/auth/logout', { waitUntil: 'networkidle' })
})

Then('the login form should be visible again', async ({ page }) => {
  await page.waitForSelector('input#email', { timeout: 10_000 })
})
