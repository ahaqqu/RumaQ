import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { Given, When, Then } = createBdd()

// The Worker's PATCH /api/settings encrypts any provided key; in TEST_MODE
// the generate endpoint never calls the real AI provider, so the key value
// does not matter. page.request shares the browser session cookie.
Given('the test user has an AI key configured', async ({ page }) => {
  const res = await page.request.patch('/api/settings', {
    data: { ai_provider: 'gemini', ai_key: 'sk-test-key-12345' },
  })
  expect(res.status()).toBe(200)
  // The app persists its query cache in IndexedDB (idb-keyval) and settings
  // have a 5-minute staleTime, so a page (re)load would otherwise restore the
  // stale pre-PATCH "no key" state. Dropping the persisted cache forces a
  // fresh settings fetch on the next load.
  await page.evaluate(() => {
    indexedDB.deleteDatabase('keyval-store')
  })
})

Given('the test user has no AI key configured', async () => {
  // The seeded user has no AI key; the Before hook resets the database, so
  // nothing to do. The step exists to make the scenario intent explicit.
})

When('I generate a plan', async ({ page }) => {
  await page.getByRole('button', { name: 'Generate plan' }).click()
  // Generation is mocked but async; the draft view adds the Save plan button.
  await expect(page.getByRole('button', { name: 'Save plan' })).toBeVisible({
    timeout: 15_000,
  })
})

When('I save the draft plan', async ({ page }) => {
  await page.getByRole('button', { name: 'Save plan' }).click()
  // The active-plan view renders one checkbox per saved item.
  await expect(page.getByRole('checkbox').first()).toBeVisible({ timeout: 15_000 })
})

// 'xpath=..' resolves to the wrapping <label> of the checkbox; filtering by
// item name targets the right row when several plan items are listed.
const activePlanItem = (page, name) =>
  page.getByRole('checkbox').locator('xpath=..').filter({ hasText: name })

// Plain click: check() verifies the state synchronously after the click and
// races React's optimistic re-render (the checkbox flips a moment later),
// which reads as "clicking did not change its state". The bought-state
// assertions below retry with expect().
When('I check off the item {string}', async ({ page }, name) => {
  await activePlanItem(page, name).locator('input[type=checkbox]').click()
})

Then('the plan page should ask to connect an API key', async ({ page }) => {
  await expect(page.getByText('Connect API key')).toBeVisible()
})

Then('the generated draft should list {string}', async ({ page }, name) => {
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible()
})

Then('the active plan should list {string}', async ({ page }, name) => {
  await expect(activePlanItem(page, name).locator('input[type=checkbox]')).toBeVisible()
})

Then('the item {string} should be marked bought', async ({ page }, name) => {
  await expect(activePlanItem(page, name).locator('input[type=checkbox]')).toBeChecked()
})

Then('the item {string} should still be marked bought', async ({ page }, name) => {
  await expect(activePlanItem(page, name).locator('input[type=checkbox]')).toBeChecked()
})

When('I reload the page', async ({ page }) => {
  await page.reload()
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
})
