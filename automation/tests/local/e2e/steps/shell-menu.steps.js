import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { bulkCatalogueSnapshot } from '../../../support/price-fixtures.js'
import { pushPriceSnapshot } from '../../../support/ingest.js'

const { Given, When, Then } = createBdd()

// Fixtures shared with the API feature suite (tests/support/price-fixtures.js),
// pushed through the internal ingest endpoint like price-promos.steps.js.

// A 12-item catalogue makes /prices overflow even a short desktop viewport.
Given('a tall price snapshot has been pushed', async () => {
  await pushPriceSnapshot(bulkCatalogueSnapshot(12))
})

// #675 pre-fix: the sidebar was a sticky box whose grid-item min-height:auto
// let it grow past the viewport, so items below the fold could never be
// clicked. Post-fix the page scrolls while the sidebar keeps its own scroll
// region — these steps fail on the old layout.
When('I scroll the page to the bottom', async ({ page }) => {
  // A short desktop viewport keeps the page overflowing regardless of the
  // pushed data volume; the width stays desktop (the lg breakpoint is
  // width-based, so the sidebar rail stays visible).
  await page.setViewportSize({ width: 1280, height: 600 })
  // The overflow exists once the catalog query has rendered its rows.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBeGreaterThan(0)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})

Then('the sidebar {string} item navigates to {string}', async ({ page }, name, path) => {
  const item = page.locator('aside[aria-label="Main navigation"]').getByRole('link', { name })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL((url) => url.pathname === path)
})
