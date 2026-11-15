import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { SUGAR_KEY } from '../../../support/price-fixtures.js'
import { assertNoCriticalOrSerious, scanPage } from './axe.js'

const { Given, When, Then } = createBdd()

// Fixtures pushed through the internal ingest endpoint like the promos suite;
// the brochure object rides the internal PUT endpoint (issue #293). Since
// #673 the user gallery lives on /prices?view=brochures — a lean browse-only
// grid — while the #630 QA browser stays admin-side on
// /admin/catalog?tab=brochures-qa: selecting a card opens the full product
// table and a row expands its metadata in place.
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
// a later scenario's ingest fires. Exported for the accessibility suite's
// fixture-backed viewer scan (#674).
export const e2eBrochureKey = () => {
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

Then('the prices segment row should be visible', async ({ page }) => {
  await expect(page.getByText('Brochures', { exact: true })).toBeVisible()
  await expect(page.getByText('Products', { exact: true })).toBeVisible()
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

Then('the gallery should show no ingestion-QA metadata', async ({ page }) => {
  // The lean user surface (#673): no review table, no metadata panel, and no
  // QA labels — the payload still carries them; the gallery must not render
  // any of it.
  await expect(page.locator('#brochure-review')).toHaveCount(0)
  await expect(page.locator('[data-testid="brochure-product-metadata"]')).toHaveCount(0)
  await expect(page.getByText('Match confidence')).toHaveCount(0)
  await expect(page.getByText('Observed date')).toHaveCount(0)
  await expect(page.getByText('Scraped at')).toHaveCount(0)
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

Then('I should stay on the admin catalog brochures QA tab', async ({ page }) => {
  await expect(page).toHaveURL(/\/admin\/catalog\?tab=brochures-qa$/)
  await expect(page.getByText('Brochures QA', { exact: true })).toBeVisible()
  await expect(page.locator('#brochure-review')).toBeVisible()
})

Then('the brochure QA view should have no critical or serious axe violations', async ({ page }) => {
  // Scans the state no static page path reaches: the grid, the full product
  // table, and the expanded metadata panel (issue #630).
  await expect(page.locator('[data-testid="brochure-card"]').first()).toBeVisible()
  await expect(page.locator('#brochure-review')).toBeVisible()
  await expect(page.locator('[data-testid="brochure-product-metadata"]')).toBeVisible()
  // The promo cell is what caught the danger-token contrast regression: pin
  // it so a future fixture change cannot silently scan an empty badge.
  const promo = page.locator('[data-testid="brochure-product-row"]').getByText('Diskon 5%').first()
  await expect(promo).toBeVisible()
  await promo.scrollIntoViewIfNeeded()
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

Then('the brochures empty state should render with the segments visible', async ({ page }) => {
  await expect(page.getByText('No brochures yet')).toBeVisible()
  await expect(page.getByText('Brochures', { exact: true })).toBeVisible()
  await expect(page.getByText('Products', { exact: true })).toBeVisible()
})

// ——— #674: the chrome-less full-mode viewer ———

// The viewer tab is opened either as a real target=_blank popup from the
// card's View link or via a direct deep-link goto. Scenarios run with
// workers: 1 and each viewer scenario sets this through its When step
// before any Then reads it.
let viewerPage = null

const e2eViewerPath = () => {
  const [, ymd, file] = e2eBrochureKey().split('/')
  return `/brochures/view?store=lotte-mart&date=${ymd}&file=${file}`
}

When('I open the {string} brochure viewer from its card', async ({ page }, store) => {
  const card = page.locator('[data-testid="brochure-card"]').filter({ hasText: store }).first()
  const [opened] = await Promise.all([
    // target="_blank" opens a top-level blank navigation — the SameSite=Lax
    // session cookie rides along, so the new tab authenticates itself.
    page.context().waitForEvent('page'),
    card.getByRole('link', { name: /View/ }).click(),
  ])
  viewerPage = opened
  await viewerPage.getByTestId('viewer-topbar').waitFor({ state: 'visible', timeout: 15_000 })
})

When('I open the brochure viewer deep link directly', async ({ page }) => {
  // A fresh page in the same (authenticated) context = the fresh-load path:
  // the SPA boots straight into the deep link with no in-app navigation.
  viewerPage = await page.context().newPage()
  await viewerPage.goto(e2eViewerPath())
  await viewerPage.getByTestId('viewer-topbar').waitFor({ state: 'visible', timeout: 15_000 })
})

Then('the viewer tab should render the full mode for {string}', async ({}, store) => {
  const viewer = viewerPage
  const topbar = viewer.getByTestId('viewer-topbar')
  await expect(topbar).toBeVisible()
  // Title "{store} · {observed date}" — the catalog-resolved source name and
  // the shared date label (computed with the same ICU the browser uses).
  const now = new Date()
  const label = now.toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' })
  await expect(topbar.locator('h1')).toContainText(store)
  await expect(topbar.locator('h1')).toContainText(label)
  // The page image decodes through the authenticated proxy in the new tab.
  const img = viewer.locator(`img[src="/api/brochures/${e2eBrochureKey()}"]`)
  await expect(img).toHaveCount(1)
  await expect
    .poll(() => img.evaluate((el) => (el.complete && el.naturalWidth > 0 ? 'loaded' : 'pending')))
    .toBe('loaded')
})

Then('the viewer tab should render no app shell chrome', async () => {
  // Full mode = no left menu, no site header, no mobile tab bar — the route
  // lives outside the _app layout, and nothing else may render them.
  await expect(viewerPage.locator('aside')).toHaveCount(0)
  await expect(viewerPage.locator('header')).toHaveCount(0)
  await expect(viewerPage.locator('nav')).toHaveCount(0)
  await expect(viewerPage.locator('[data-testid="household-card"]')).toHaveCount(0)
})

When('I share the brochure without a native share sheet', async () => {
  // Headless Linux Chromium has no navigator.share — the click exercises the
  // clipboard fallback; the grant makes writeText/readText actually work.
  await viewerPage.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await viewerPage.getByRole('button', { name: 'Share' }).click()
})

Then(
  'the clipboard should hold the viewer link and the copied status should confirm it',
  async () => {
    await expect(viewerPage.getByRole('status')).toHaveText('Link copied')
    const clipboard = await viewerPage.evaluate(() => navigator.clipboard.readText())
    const [, ymd, file] = e2eBrochureKey().split('/')
    expect(clipboard).toContain('/brochures/view?store=lotte-mart')
    expect(clipboard).toContain(`date=${ymd}`)
    expect(clipboard).toContain(`file=${file}`)
  }
)
