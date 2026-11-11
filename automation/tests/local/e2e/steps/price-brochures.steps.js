import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { SUGAR_KEY } from '../../../support/price-fixtures.js'

const { Given, When, Then } = createBdd()

// Fixtures pushed through the internal ingest endpoint like the promos suite;
// the brochure object rides the internal PUT endpoint (issue #293). The jump
// assertions reuse price-promos.steps.js's globally-registered steps (they
// match this suite's feature text verbatim). Since #631 the surface lives on
// /admin/catalog?tab=brochures — /prices?view=brochures only redirects here.
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

Then('the old brochures view param should be gone from the URL', async ({ page }) => {
  // The jump navigates to /admin/catalog with search {} and the product hash:
  // the moved view never comes back on /prices.
  await expect(page).toHaveURL(/\/admin\/catalog/)
  await expect(page).not.toHaveURL(/view=brochures/)
  await expect(page).not.toHaveURL(/tab=brochures/)
})

Then(/the store sections should appear in order "(.+)"/, async ({ page }, expected) => {
  const headings = await page.locator('h3').allTextContents()
  expect(headings).toEqual(expected.split(','))
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

When('I expand the {string} brochure card', async ({ page }, store) => {
  await page.locator('button[aria-expanded]').filter({ hasText: store }).first().click()
})

When('I click the {string} brochure example', async ({ page }, name) => {
  // Example rows exist only inside an expanded card, so the name is
  // unambiguous here.
  await page.locator('button').filter({ hasText: name }).first().click()
})

Then(
  'the {string} card should render the fallback block instead of a broken image',
  async ({ page }, store) => {
    // The object was never uploaded → the img is gone; the same 3:4 frame
    // shows the store name and product count instead of a broken-image glyph.
    const frame = page
      .locator('button[aria-expanded]')
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
