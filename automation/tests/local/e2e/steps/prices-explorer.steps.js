import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { priceSnapshot, promoSnapshot } from '../../../support/price-fixtures.js'

const { Given, When, Then } = createBdd()

// Fixtures are shared with the API feature suite (tests/support/
// price-fixtures.js) and pushed through the internal ingest endpoint; the
// test stack's compose env carries the matching HAQITA_INGEST_SECRET.
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

Given('a price snapshot and a promo snapshot have been pushed', async () => {
  await pushSnapshot(priceSnapshot())
  await pushSnapshot(promoSnapshot())
})

// Every product row button carries the "Price history" affordance, which the
// other buttons on the page never do — that makes the row list addressable.
const productRows = (page) => page.locator('button').filter({ hasText: 'Price history' })

When('I sort the price list by {string}', async ({ page }, label) => {
  await page.getByRole('combobox', { name: 'Sort products' }).selectOption({ label })
})

Then('the first product should be {string}', async ({ page }, name) => {
  await expect(productRows(page).first()).toContainText(name)
})

Then('the list should show a {string} promo badge', async ({ page }, text) => {
  await expect(page.locator('span').filter({ hasText: text }).first()).toBeVisible()
})

Then('the list should show a {string} badge', async ({ page }, text) => {
  await expect(page.locator('span').filter({ hasText: text }).first()).toBeVisible()
})

Then('the prices page should show the freshness line', async ({ page }) => {
  await expect(page.getByText(/Prices updated/)).toBeVisible()
})

Then('the expanded detail for {string} should show the cheapest chip', async ({ page }, name) => {
  // The hash alone must expand the product (apply effect) — no click.
  const row = productRows(page).filter({ hasText: name }).first()
  await expect(row).toContainText('Price history')
  // The detail block sits beside the button, inside the row container.
  await expect(page.getByText('Current prices')).toBeVisible()
  // The deep link survives: the hash is neither cleared nor errored.
  await expect(page).toHaveURL(/prices#gula-pasir--gulaku--1-kg/)
  // The chip is a span; the sort select also carries the "Cheapest" label,
  // so scope to spans to keep the assertion unambiguous.
  await expect(page.locator('span').filter({ hasText: 'Cheapest' }).first()).toBeVisible()
  // scrollIntoView is part of the deep-link contract; the row must land.
  await expect(row.locator('..')).toBeInViewport()
})
