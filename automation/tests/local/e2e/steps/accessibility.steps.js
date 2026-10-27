import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const { createBdd } = pkg
const { Then } = createBdd()

const PATHS = {
  Home: '/',
  Inventory: '/inventory',
  Plan: '/plan',
  History: '/history',
  Settings: '/settings',
}

// Per-page signals that the async data has rendered, so axe scans real
// content instead of skeletons. Inventory/History expose a search control
// ('Search items' is an input aria-label; History's input is type=search so
// its role is searchbox); Settings exposes the storage section heading.
const READY = {
  Home: null,
  Inventory: (page) => page.getByLabel('Search items'),
  Plan: null,
  History: (page) => page.getByLabel('Search items'),
  Settings: (page) => page.getByRole('heading', { name: 'Storage Locations' }),
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const scan = (page) => new AxeBuilder({ page }).withTags(AXE_TAGS)

function assertNoCriticalOrSerious(violations) {
  const blocking = violations.filter((v) => ['critical', 'serious'].includes(v.impact))
  const summary = blocking.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`).join('; ')
  expect(blocking, `axe found blocking violations: ${summary}`).toHaveLength(0)
}

Then('the login page should have no critical or serious axe violations', async ({ page }) => {
  // "I visit the app" (smoke.steps.js) already navigated to the app root.
  await page.waitForSelector('input#email', { timeout: 15_000 })
  assertNoCriticalOrSerious((await scan(page).analyze()).violations)
})

Then(
  'the {string} page should have no critical or serious axe violations',
  async ({ page }, name) => {
    await page.goto(PATHS[name])
    await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 })
    const ready = READY[name]
    if (ready) {
      await expect(ready(page)).toBeVisible({ timeout: 15_000 })
    } else {
      // Give queries one settle cycle on pages without a stable ready signal.
      await page.waitForLoadState('networkidle')
    }
    assertNoCriticalOrSerious((await scan(page).analyze()).violations)
  }
)
