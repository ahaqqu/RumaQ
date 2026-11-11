import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { SUGAR_KEY } from '../../../support/price-fixtures.js'
import { assertNoCriticalOrSerious, scanPage } from './axe.js'

const { Given, When, Then } = createBdd()

// Fixtures pushed through the internal ingest endpoint like the promos suite;
// the brochure object rides the internal PUT endpoint (issue #293). Since
// #631 the surface lives on /admin/catalog?tab=brochures —
// /prices?view=brochures only redirects here. Since #630 the view is a QA
// browser: selecting a card opens the full product table and a row expands
// its metadata in place (no jump into the products explorer).
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'
// A real 1x1 transparent PNG: the browser must be able to DECODE the served
// bytes — magic bytes alone are not enough for <img> to skip its error event.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// Today's date keys the uploaded object — fresh enough that no retention
// sweep (grace = 14 days from the key date) can delete it mid-run even when
// a later scenario's ingest fires.
const e2eBrochureKey = () => {
  const now = new Date()
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`
  return `lotte-mart/${ymd}/page_1_e2e_1a2b3c4d.jpg`
}
const e2eScrapedDate = () => e2eBrochureKey().split('/')[1]

function e2eSnapshot(brochureKey, scrapedDate) {
  return {
    schemaVersion: 2,
    scrapedAt: `${scrapedDate.slice(0, 4)}-${scrapedDate.slice(4, 6)}-${scrapedDate.slice(6, 8)}T23:00:05Z`,
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: SUGAR_KEY,
        rawName: 'Gula Pasir Gulaku 1 kg',
        rawBrand: 'Gulaku',
        rawUnit: '1 kg',
        storeSlug: 'lotte-mart',
        price: 40000,
        effectiveUnitPrice: 38000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 5%',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: `/api/brochures/${brochureKey}`,
      },
      {
        productKey: 'kopi--kapal-api--165-g',
        rawName: 'Kopi Kapal Api 165 g',
        rawBrand: 'Kapal Api',
        rawUnit: '165 g',
        storeSlug: 'superindo',
        price: 30000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
        // Deliberately never uploaded — the fallback-block fixture.
        brochureUrl: `/api/brochures/superindo/${scrapedDate}/koran_missing_9e8d7c6b.jpg`,
      },
    ],
  }
}

Given('a brochure snapshot has been pushed with one image uploaded', async () => {
  const key = e2eBrochureKey()
  const put = await fetch(`${BASE_URL}/api/internal/brochures/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'image/png',
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: PNG_BYTES,
  })
  if (!put.ok) {
    throw new Error(`brochure upload failed: ${put.status} ${await put.text()}`)
  }
  const res = await fetch(`${BASE_URL}/api/internal/ingest/prices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(e2eSnapshot(key, e2eScrapedDate())),
  })
  if (!res.ok) {
    throw new Error(`brochure snapshot push failed: ${res.status} ${await res.text()}`)
  }
})

Then('I should be on the admin catalog brochures tab', async ({ page }) => {
  // The retired /prices?view=brochures deep link redirects an admin here.
  await expect(page).toHaveURL(/\/admin\/catalog\?tab=brochures$/)
})

Then('the catalog tab row should be visible', async ({ page }) => {
  await expect(page.getByText('Products & identity', { exact: true })).toBeVisible()
  await expect(page.getByText('Brochures', { exact: true })).toBeVisible()
})

Then(/the brochure grid should show cards for "(.+)"/, async ({ page }, expected) => {
  const names = expected.split(',')
  const cards = page.locator('[data-testid="brochure-card"]')
  await expect(cards).toHaveCount(names.length)
  for (const name of names) {
    await expect(cards.filter({ hasText: name }).first()).toBeVisible()
  }
})

Then('the {string} card should show the uploaded brochure image', async ({ page }, _store) => {
  // The uploaded object round-trips through the authenticated proxy: the img
  // element actually decodes (same-origin <img> carries the session cookie).
  const key = e2eBrochureKey()
  const img = page.locator(`img[src="/api/brochures/${key}"]`)
  await expect(img).toHaveCount(1)
  await expect
    .poll(() => img.evaluate((el) => (el.complete && el.naturalWidth > 0 ? 'loaded' : 'pending')))
    .toBe('loaded')
})

When('I select the {string} brochure card', async ({ page }, store) => {
  const card = page.locator('[data-testid="brochure-card"]').filter({ hasText: store }).first()
  await card.click()
  await expect(card).toHaveAttribute('aria-expanded', 'true')
})

Then('the brochure review should show {string}', async ({ page }, name) => {
  const review = page.locator('#brochure-review')
  await expect(review).toBeVisible()
  await expect(review.getByText(name, { exact: false }).first()).toBeVisible()
  await expect(review.locator('[data-testid="brochure-product-row"]')).toHaveCount(1)
})

When('I expand the {string} product row', async ({ page }, name) => {
  const row = page.locator('[data-testid="brochure-product-row"]').filter({ hasText: name }).first()
  await row.click()
  await expect(page.locator('[data-testid="brochure-product-metadata"]')).toBeVisible()
})

Then(
  'the ingestion metadata should show the product key, store, and brochure URL',
  async ({ page }) => {
    const panel = page.locator('[data-testid="brochure-product-metadata"]')
    // The row's full provenance, not a narrow summary: key, store, brochure
    // object URL, and the QA field labels are all present.
    await expect(panel).toContainText(SUGAR_KEY)
    await expect(panel).toContainText('Lotte Mart')
    await expect(panel).toContainText(`/api/brochures/${e2eBrochureKey()}`)
    await expect(panel).toContainText('Observed date')
    await expect(panel).toContainText('Match confidence')
    await expect(panel).toContainText('Scraped at')
  }
)

Then('I should stay on the admin catalog brochures tab', async ({ page }) => {
  await expect(page).toHaveURL(/\/admin\/catalog\?tab=brochures$/)
  await expect(page.locator('#brochure-review')).toBeVisible()
})

Then('the brochure QA view should have no critical or serious axe violations', async ({ page }) => {
  // Scans the state no static page path reaches: the grid, the full product
  // table, and the expanded metadata panel (issue #630).
  await expect(page.locator('[data-testid="brochure-card"]').first()).toBeVisible()
  await expect(page.locator('#brochure-review')).toBeVisible()
  await expect(page.locator('[data-testid="brochure-product-metadata"]')).toBeVisible()
  assertNoCriticalOrSerious((await scanPage(page).analyze()).violations)
})

Then(
  'the {string} card should render the fallback block instead of a broken image',
  async ({ page }, store) => {
    // The object was never uploaded → the img is gone; the same 3:4 frame
    // shows the store name and product count instead of a broken-image glyph.
    const frame = page
      .locator('[data-testid="brochure-card"]')
      .filter({ hasText: store })
      .first()
      .locator('div[style*="3 / 4"]')
    await expect(frame.locator('img')).toHaveCount(0)
    await expect(frame).toContainText(store)
    await expect(frame).toContainText('1 product')
  }
)

Then('the brochures empty state should render with the tabs visible', async ({ page }) => {
  await expect(page.getByText('No brochures yet')).toBeVisible()
  await expect(page.getByText('Brochures', { exact: true })).toBeVisible()
  await expect(page.getByText('Products & identity', { exact: true })).toBeVisible()
})
