import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'

const { Given, When, Then } = createBdd()

// Same fixtures as the API feature suite (tests/local/api/steps/prices.steps.js)
// pushed through the internal ingest endpoint; the test stack's compose env
// carries the matching HAQITA_INGEST_SECRET.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'
const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const RICE_KEY = 'beras--pandan-wangi--5-kg'
const SUGAR_KEY = 'gula-pasir--gulaku--1-kg'
const COFFEE_KEY = 'kopi--kapal-api--165-g'

function priceSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'lotte-mart',
        price: 21500,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'superindo',
        price: 23000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: RICE_KEY,
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'superindo',
        price: 72000,
        matchMethod: 'embedding',
        matchConfidence: 0.7,
      },
    ],
  }
}

// One day later: adds two products where raw-price order and effective-price
// order disagree, so the explorer's effective-price basis is visible in the UI.
function promoSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-25T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'lotte-mart',
        price: 40000,
        effectiveUnitPrice: 38000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 5%',
        validFrom: '2026-10-25',
        validUntil: '2026-11-05',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'superindo',
        price: 41000,
        effectiveUnitPrice: 36000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 12%',
        validFrom: '2026-10-25',
        validUntil: '2026-10-30',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: COFFEE_KEY,
        name: 'Kopi Kapal Api 165 g',
        brand: 'Kapal Api',
        unit: '165 g',
        storeSlug: 'lotte-mart',
        price: 30000,
        validUntil: '2026-10-29',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
    ],
  }
}

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
