import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { SUGAR_KEY } from '../../../support/price-fixtures.js'
import { INGEST_SECRET, pushPriceSnapshot, TEST_BASE_URL } from '../../../support/ingest.js'
import { assertNoCriticalOrSerious, scanPage } from './axe.js'

const { Given, When, Then } = createBdd()

// Fixtures pushed through the internal ingest endpoint like the promos suite;
// the brochure object rides the internal PUT endpoint (issue #293). Since
// #673 the user gallery lives on /prices?view=brochures — a lean browse-only
// grid — while the #630 QA browser stays admin-side on
// /admin/catalog?tab=brochures-qa. Since #716 both surfaces select through
// the chrome-less viewer in a NEW tab: prices' View link composes the plain
// deep link (items-only table), the admin QA card composes ?admin=true (the
// QA table whose rows expand their ingestion metadata).
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
  const put = await fetch(`${TEST_BASE_URL}/api/internal/brochures/${key}`, {
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
  await pushPriceSnapshot(e2eSnapshot(key, e2eScrapedDate()), 'brochure snapshot push failed')
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

// ——— #716: both surfaces select through the viewer's items panel ———

// The admin QA card is itself the link: it composes ?admin=true and the
// admin session (the seeded user) satisfies the viewer's identity gate, so
// the new tab renders the QA items table. The click opens a top-level blank
// navigation — the SameSite=Lax session cookie rides along, so the new tab
// authenticates itself (the gallery View-link precedent).
When('I open the {string} brochure viewer from its QA card', async ({ page }, store) => {
  const card = page.locator('[data-testid="brochure-card"]').filter({ hasText: store }).first()
  const [opened] = await Promise.all([page.context().waitForEvent('page'), card.click()])
  viewerPage = opened
  await viewerPage.getByTestId('viewer-topbar').waitFor({ state: 'visible', timeout: 15_000 })
  // The admin flag is on the deep link the card composed — with the seeded
  // admin session it turns the items panel into the QA variant.
  await expect(viewerPage).toHaveURL(/\/brochures\/view\?.*&admin=true$/)
})

// eslint-disable-next-line no-empty-pattern
Then('the viewer tab should render the QA items table with {string}', async ({}, name) => {
  const review = viewerPage.locator('#brochure-review')
  await expect(review).toBeVisible()
  await expect(review.getByText(name, { exact: false }).first()).toBeVisible()
  await expect(review.locator('[data-testid="brochure-product-row"]')).toHaveCount(1)
  // The QA columns are back on this variant — they are absent in the lean one.
  await expect(review.getByText('Effective unit price')).toBeVisible()
  await expect(review.getByText('Match', { exact: true })).toBeVisible()
  await expect(viewerPage.locator('[data-testid="brochure-product-metadata"]')).toHaveCount(0)
})

// eslint-disable-next-line no-empty-pattern
When('I expand the {string} product row in the viewer', async ({}, name) => {
  const row = viewerPage
    .locator('[data-testid="brochure-product-row"]')
    .filter({ hasText: name })
    .first()
  await row.click()
  await expect(viewerPage.locator('[data-testid="brochure-product-metadata"]')).toBeVisible()
})

Then(
  'the ingestion metadata should show the product key, store, and brochure URL',
  // eslint-disable-next-line no-empty-pattern
  async () => {
    const panel = viewerPage.locator('[data-testid="brochure-product-metadata"]')
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

Then('the viewer tab should have no critical or serious axe violations', async () => {
  // Scans the state no static page path reaches: the full product table and
  // the expanded metadata panel in the viewer tab (issue #630 through #716).
  await expect(viewerPage.locator('[data-testid="brochure-product-metadata"]')).toBeVisible()
  assertNoCriticalOrSerious((await scanPage(viewerPage).analyze()).violations)
})

Then(
  'I should stay on the admin catalog brochures QA tab without an in-place review',
  async ({ page }) => {
    // The original tab never navigates; the review now lives in the new tab,
    // so nothing in-place renders below the grid.
    await expect(page).toHaveURL(/\/admin\/catalog\?tab=brochures-qa$/)
    await expect(page.getByText('Brochures QA', { exact: true })).toBeVisible()
    await expect(page.locator('#brochure-review')).toHaveCount(0)
  }
)

Then(
  'the viewer tab should show the items list with {string} and no QA affordances',
  // eslint-disable-next-line no-empty-pattern
  async ({}, name) => {
    const review = viewerPage.locator('#brochure-review')
    await expect(review).toBeVisible()
    await expect(review.getByText(name, { exact: false }).first()).toBeVisible()
    // Lean variant: the shopper columns only — no QA headers, no expand, no
    // metadata panel (#673's rule applied to the viewer's items panel).
    await expect(review.getByText('Effective unit price')).toHaveCount(0)
    await expect(review.getByText('Match', { exact: true })).toHaveCount(0)
    await expect(
      review.locator('[data-testid="brochure-product-row"] button[aria-expanded]')
    ).toHaveCount(0)
    await expect(viewerPage.locator('[data-testid="brochure-product-metadata"]')).toHaveCount(0)
  }
)

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

// playwright-bdd requires the first (fixtures) argument to be an object
// destructuring pattern and treats its keys as required fixtures; this step
// asserts on the separate viewer tab carried in module state, so it declares
// no fixtures — the empty pattern is the framework's way to skip the arg and
// reach the {string} positional parameter.
// eslint-disable-next-line no-empty-pattern
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
  // This scenario is specifically the clipboard FALLBACK, so guarantee its
  // premise: navigator.share is overridden with an own undefined property
  // (some builds expose it with no sheet UI behind it). The harness also
  // serves the app over plain http (TEST_BASE_URL=http://proxy:3000) — a
  // NON-secure context, where the async Clipboard API does not exist at all
  // (navigator.clipboard is undefined) — so a capturing stub stands in for
  // it: the scenario pins that Share, with no native sheet, writes the deep
  // link and shows the copied confirmation. The real-API behaviors — write
  // success, and staying silent when no clipboard exists — are pinned in
  // BrochureViewerPage.test.jsx.
  await viewerPage.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__sharedLink = text
        },
      },
    })
  })
  await viewerPage.getByRole('button', { name: 'Share' }).click()
})

Then(
  'the clipboard should hold the viewer link and the copied status should confirm it',
  async () => {
    // The share confirmation is pinned by test id: the page's items panel
    // (#718) also renders an aria-live role="status" ("Showing N of M"), so
    // an unscoped role query is ambiguous under Playwright strict mode.
    await expect(viewerPage.getByTestId('viewer-share-status')).toHaveText('Link copied')
    // The capturing clipboard stub (see the When step — the harness's plain-
    // http origin has no real async clipboard) holds the written link.
    const shared = await viewerPage.evaluate(() => window.__sharedLink)
    const [, ymd, file] = e2eBrochureKey().split('/')
    expect(shared).toContain('/brochures/view?store=lotte-mart')
    expect(shared).toContain(`date=${ymd}`)
    expect(shared).toContain(`file=${file}`)
  }
)
