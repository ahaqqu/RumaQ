import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { Given, When, Then } = createBdd()

import { configureAi } from './ai-setup.js'
import { clearPersistedQueryCache } from './shared.steps.js'

// #523 P3: a household turns AI on by creating a provider and assigning
// capabilities through the public endpoints (see ai-setup.js) — the legacy
// settings ai_key write is retired. page.request shares the session cookie.
Given('the test user has AI configured', async ({ page }) => {
  await configureAi(page)
})

Given('the test user has no AI configured', async () => {
  // The seeded household starts with no provider and no assignment — there is
  // no server default to fall back to (D7/D8) — and the Before hook resets the
  // database. The step exists to make the scenario intent explicit.
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

// locator('..') resolves to the wrapping <label> of the checkbox; filtering
// by item name targets the right row when several plan items are listed.
const activePlanItem = (page, name) =>
  page.getByRole('checkbox').locator('..').filter({ hasText: name })

// Plain click: check() verifies the state synchronously after the click and
// races React's optimistic re-render (the checkbox flips a moment later),
// which reads as "clicking did not change its state". The bought-state
// assertions below retry with expect().
When('I check off the item {string}', async ({ page }, name) => {
  await activePlanItem(page, name).locator('input[type=checkbox]').click()
})

Then('the plan page should ask to set up AI', async ({ page }) => {
  await expect(page.getByText('Set up AI first')).toBeVisible()
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
  // Server persistence is what this asserts (see clearPersistedQueryCache).
  await clearPersistedQueryCache(page)
  await page.reload()
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
})
