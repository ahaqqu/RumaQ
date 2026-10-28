import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { bulkCatalogueSnapshot, SUGAR_KEY } from '../../../support/price-fixtures.js'

const { Given, When, Then } = createBdd()

// Fixtures shared with the API feature suite (tests/support/price-fixtures.js),
// pushed through the internal ingest endpoint like prices-explorer.steps.js.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'

async function pushSnapshot(payload) {
  const res = await fetch(`${BASE_URL}/api/internal/ingest/prices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`price snapshot push failed: ${res.status} ${await res.text()}`)
  }
}

Given('a promo-free price snapshot has been pushed', async () => {
  // Bulk catalogue items carry no promo_type/promo_label — the catalog's
  // empty-state fixture.
  await pushSnapshot(bulkCatalogueSnapshot(3))
})

// Promo card headers are the only buttons carrying the "Example products"
// affordance; the label sits in the first .font-medium div inside.
const promoCards = (page) => page.locator('button').filter({ hasText: 'Example products' })

Then('the promos segment row should be visible', async ({ page }) => {
  await expect(page.getByText('Promos', { exact: true })).toBeVisible()
  await expect(page.getByText('Products', { exact: true })).toBeVisible()
})

Then(/the promo cards should appear in order "(.+)"/, async ({ page }, expected) => {
  const labels = await promoCards(page).locator('div.font-medium').allTextContents()
  expect(labels).toEqual(expected.split(','))
})

Then(/the "(.+)" card should show the "(.+)" store badge/, async ({ page }, label, badge) => {
  const card = promoCards(page).filter({ hasText: label }).first()
  await expect(card.locator('span').filter({ hasText: badge })).toBeVisible()
})

When('I expand the {string} promo card', async ({ page }, label) => {
  await promoCards(page).filter({ hasText: label }).first().click()
})

When('I click the {string} promo example', async ({ page }, name) => {
  // Example rows exist only inside an expanded card, so the name is
  // unambiguous here (the explorer's row buttons are not rendered).
  await page.locator('button').filter({ hasText: name }).first().click()
})

Then(/I should land on the products view with "(.+)" expanded/, async ({ page }, name) => {
  // The jump/deep link wrote the #productKey hash and the hash-apply effect
  // expanded the product (apply, no click).
  await expect(page).toHaveURL(new RegExp(`#${SUGAR_KEY}`))
  await expect(page.getByText('Current prices')).toBeVisible()
  await expect(page.locator('button').filter({ hasText: name }).first()).toContainText(
    'Price history'
  )
})

Then('the view param should be gone from the URL', async ({ page }) => {
  // The jump navigates with search: {} — the hash deep link replaces the
  // promos view instead of stacking on top of it.
  await expect(page).not.toHaveURL(/view=promos/)
})

Then('the promos empty state should render with the segment visible', async ({ page }) => {
  await expect(page.getByText('No promos yet')).toBeVisible()
  await expect(page.getByText('Promos', { exact: true })).toBeVisible()
  await expect(page.getByText('Products', { exact: true })).toBeVisible()
})
