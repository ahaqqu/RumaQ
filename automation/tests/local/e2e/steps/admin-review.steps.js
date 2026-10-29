import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { TEST_PASSWORD } from './shared.steps.js'

const { Given, When, Then } = createBdd()

// Review items are born in the scraper — the e2e seeds them through the same
// bearer channel the real nightly reports on (issue #294).
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'
// Mirrors the seed's pbkdf2 hash for password123 — same password, but the
// seed grants it no is_admin flag, so the account exercises the 403 surface.
const NON_ADMIN_EMAIL = 'second@rumaq.dev'

const reviewPair = {
  itemProductKey: 'beras-ramos-5kg----5-kg',
  itemName: 'Beras Ramos 5 kg',
  itemBrand: null,
  itemUnit: '5 kg',
  itemPrice: 89000,
  itemEffectiveUnitPrice: 89000,
  itemStore: 'lotte-mart',
  entryProductKey: 'beras-ramos-5kg--ramos--5-kg',
  entryName: 'Beras Ramos 5kg',
  entryBrand: 'Ramos',
  entryUnit: '5 kg',
  entryPrice: 27000,
  entryEffectiveUnitPrice: 27000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 1,
  reason: 'price_ratio',
}

async function seedReviewPair() {
  const report = {
    schemaVersion: 1,
    // A fresh run id per scenario keeps the flag timestamps plausible and
    // the price_runs join non-empty.
    runStartedAt: new Date().toISOString().slice(0, 19) + 'Z',
    finishedAt: new Date().toISOString().slice(0, 19) + 'Z',
    exitCode: 0,
    status: 'success',
    stage: 'done',
    perStore: {},
    match: {
      exact: 0,
      embedding: 0,
      ai: 0,
      solo: 1,
      reviewItems: 1,
      embeddingsDegraded: false,
      reviewItemPairs: [reviewPair],
      reviewItemsTotal: 1,
      reviewItemsTruncated: false,
    },
    publish: null,
    error: null,
  }
  const res = await fetch(`${BASE_URL}/api/internal/ingest/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify(report),
  })
  expect(res.status).toBe(200)
}

let reviewDownload = null

Given('the queue holds one flagged pair', async () => {
  await seedReviewPair()
})

// The seed's second user (second@rumaq.dev, no is_admin grant) is born
// passwordless — give it the same password123 hash as the seeded admin so it
// can log in through the UI and exercise the 403 surface. The shared Before
// hook's reset+seed always recreates the row, so UPDATE, never INSERT.
Given('I am logged in as a non-admin user', async ({ page }) => {
  const seedHash =
    'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s'
  const sql = `UPDATE users SET password_hash = '${seedHash}' WHERE email = '${NON_ADMIN_EMAIL}';`
  const res = await fetch(`${BASE_URL}/api/__test/direct-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
  expect(res.status).toBe(200)

  // Same UI login path as the seeded admin — only the identity differs.
  await page.goto('/')
  await page.waitForSelector('input#email', { timeout: 15_000 })
  await page.fill('input#email', NON_ADMIN_EMAIL)
  await page.fill('input#password', TEST_PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 })
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
})

Then('the queue shows the flagged pair side by side', async ({ page }) => {
  // Honest asymmetry labels (PM §2), both sides of the pair, and the
  // price-ratio reason — the UI default locale is English.
  await expect(page.getByText('Matched item')).toBeVisible()
  await expect(page.getByText('Catalog entry (last seen)')).toBeVisible()
  await expect(page.getByText('Beras Ramos 5 kg')).toBeVisible()
  await expect(page.getByText('Beras Ramos 5kg')).toBeVisible()
  await expect(page.getByText('Price ratio')).toBeVisible()
})

When('I approve the flagged pair', async ({ page }) => {
  await page.getByRole('button', { name: 'Approve Match' }).click()
})

Then('the pair shows the approved verdict', async ({ page }) => {
  await expect(page.getByText('Approved').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
})

When('I reload the review page', async ({ page }) => {
  await page.reload()
  // The queue's default filter is pending (a triage work queue), and the
  // decided row left it — switch to its verdict's filter to see it again.
  // The filter chips are the app's span-based Chip convention (no button
  // role), so match the chip's exact text — the count chip reads "Approved N".
  await page.getByText('Approved', { exact: true }).click()
  await expect(page.getByText('Matched item')).toBeVisible()
})

Then('the verdict is still approved', async ({ page }) => {
  // D1-backed, not localStorage: the verdict survives a full reload.
  await expect(page.getByText('Approved').first()).toBeVisible()
})

When('I undo the verdict', async ({ page }) => {
  await page.getByRole('button', { name: 'Undo' }).click()
})

Then('the pair is pending again', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Approve Match' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reject Match' })).toBeVisible()
})

When('I export the decisions', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export decisions' }).click()
  reviewDownload = await downloadPromise
})

Then('the download is named review_decisions.json', async () => {
  expect(reviewDownload.suggestedFilename()).toBe('review_decisions.json')
})

Then('the export body contains the decided row with schema 1', async ({ page }) => {
  // The same-origin session fetch the button performs, replayed through the
  // browser context's cookie jar — page.request shares it, while the
  // isolated `request` fixture does not and 401s. Asserts the file's
  // CONTENT end to end.
  const res = await page.request.get(`${BASE_URL}/api/admin/review/export`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.schema).toBe(1)
  expect(body.decisions).toHaveLength(1)
  expect(body.decisions[0]).toMatchObject({
    itemProductKey: reviewPair.itemProductKey,
    entryProductKey: reviewPair.entryProductKey,
    decision: 'approved',
    reason: 'price_ratio',
  })
})

When('I expand the first run', async ({ page }) => {
  await page.locator('button.w-full').first().click()
})

Then('the flagged count links to the review queue', async ({ page }) => {
  await expect(page.locator('a[href="/admin/review"]')).toBeVisible()
})

Then('the review page shows the forbidden state', async ({ page }) => {
  // The review page gates on the same isAdmin flag as the monitor, reusing
  // its forbidden copy.
  await expect(page.getByText('Admins only')).toBeVisible()
  await expect(
    page.getByText('The scraping monitor is restricted to operator accounts.')
  ).toBeVisible()
})
