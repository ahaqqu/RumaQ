import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'
import { OIL_KEY, priceSnapshot } from '../../../support/price-fixtures.js'

const { Given, When, Then } = createBdd()

// Admin canonical rename E2E (issue #488, feature #423). Both admin surfaces
// mount the same ProductRenameForm, so the two write scenarios share one
// submit helper: it reads the identity first (the optimistic
// expectedMetadataVersion the form must echo back), captures the actual POST,
// and asserts the server accepted exactly that version. The fixtures are
// deterministic — a v2 price snapshot through the internal ingest endpoint and
// a run report carrying one frozen review pair, the channel the real scraper
// uses.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'

// The shared v2 fixture seeds this product ("Minyak Goreng Bimoli") at two
// stores; its row is what the catalog rename scenario opens.
const EXPLORER_PRODUCT_KEY = OIL_KEY

// The review fixture: one canonical product the scraper reported, plus the
// flagged pair whose entryProductKey points at it. The pair's labels are the
// canonical wording at flag time — a rename must leave pair_data untouched
// (the frozen-pair guarantee the review row's note explains).
const REVIEW_PRODUCT_KEY = 'beras-ramos--ramos--5-kg'
const REVIEW_PRODUCT_NAME = 'Beras Ramos 5kg'
const REVIEW_ITEM_NAME = 'Beras Ramos 5 kg'

// Explored rows are the only buttons carrying the detail affordance.
const productRows = (page) => page.locator('button').filter({ hasText: 'Price history' })

// ReviewRow renders each side as a group named by the shared list header
// (#480), which is the only stable way into one side of the pair.
const matchedSide = (page) => page.getByRole('group', { name: 'Matched item' })
const catalogSide = (page) => page.getByRole('group', { name: 'Catalog entry (last seen)' })

// The rename a scenario opened: the product, the name/version the server had
// before it, and what the browser actually posted. Scenarios run one at a time
// (workers: 1), so one slot is enough — the same pattern admin-review.steps.js
// uses for its export download.
let renameSubject = null

async function pushSnapshot(payload) {
  const res = await fetch(`${BASE_URL}/api/internal/ingest/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`price snapshot push failed: ${res.status} ${await res.text()}`)
  }
}

// The canonical product behind the review pair, observed at both stores so the
// row's frozen prices line up with real observations (the entry side's
// evidence is enriched from the latest one at read time).
function reviewSnapshot() {
  return {
    schemaVersion: 2,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: REVIEW_PRODUCT_KEY,
        rawName: REVIEW_PRODUCT_NAME,
        rawBrand: 'Ramos',
        rawUnit: '5 kg',
        storeSlug: 'lotte-mart',
        price: 89000,
        matchMethod: 'exact',
        matchConfidence: 1,
      },
      {
        productKey: REVIEW_PRODUCT_KEY,
        rawName: REVIEW_PRODUCT_NAME,
        rawBrand: 'Ramos',
        rawUnit: '5 kg',
        storeSlug: 'superindo',
        price: 27000,
        matchMethod: 'embedding',
        matchConfidence: 0.7,
      },
    ],
  }
}

const reviewPair = {
  itemProductKey: 'beras-ramos-5kg----5-kg',
  itemName: REVIEW_ITEM_NAME,
  itemBrand: null,
  itemUnit: '5 kg',
  itemPrice: 89000,
  itemEffectiveUnitPrice: 89000,
  itemStore: 'lotte-mart',
  entryProductKey: REVIEW_PRODUCT_KEY,
  entryName: REVIEW_PRODUCT_NAME,
  entryBrand: 'Ramos',
  entryUnit: '5 kg',
  entryPrice: 27000,
  entryEffectiveUnitPrice: 27000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 1,
  reason: 'price_ratio',
}

async function pushReviewPair() {
  const stamp = new Date().toISOString().slice(0, 19) + 'Z'
  const report = {
    schemaVersion: 1,
    runStartedAt: stamp,
    finishedAt: stamp,
    exitCode: 0,
    status: 'success',
    stage: 'done',
    perStore: {},
    match: {
      exact: 1,
      embedding: 0,
      ai: 0,
      solo: 0,
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
  if (!res.ok) {
    throw new Error(`run report ingest failed: ${res.status} ${await res.text()}`)
  }
}

// page.request shares the browser context's cookie jar, so this is the same
// admin session the UI writes with — the read the form's optimistic version
// comes from (admin-review.steps.js's export step uses the same channel).
async function readIdentity(request, productKey) {
  const res = await request.get(`${BASE_URL}/api/admin/products/${productKey}`)
  if (res.status() !== 200) {
    throw new Error(`identity read failed: ${res.status()} ${await res.text()}`)
  }
  return res.json()
}

async function submitRename(page, productKey, newName) {
  const identity = await readIdentity(page.request, productKey)
  renameSubject = {
    productKey,
    oldName: identity.product.name,
    newName,
    versionBefore: identity.product.metadataVersion,
  }
  const form = page.getByTestId('product-rename-form')
  await form.getByLabel('New name').fill(newName)
  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes(`/api/admin/products/${productKey}/rename`)
  )
  await form.getByRole('button', { name: 'Save new name' }).click()
  const request = await posted
  const response = await request.response()
  const status = response?.status()
  if (status !== 200) {
    throw new Error(`rename POST failed: ${status} ${response ? await response.text() : ''}`)
  }
  renameSubject.posted = request.postDataJSON()
  renameSubject.result = await response.json()
}

Given('the price explorer holds a seeded product', async () => {
  await pushSnapshot(priceSnapshot())
})

Given('the review queue holds a flagged pair for a seeded product', async () => {
  await pushSnapshot(reviewSnapshot())
  await pushReviewPair()
})

When('I open the product detail for {string}', async ({ page }, name) => {
  await productRows(page).filter({ hasText: name }).first().click()
  // The detail only mounts inside the expanded row; its first heading is the
  // anchor the admin rename action lives under.
  await expect(page.getByText('Current prices')).toBeVisible()
})

When('I open the canonical rename form', async ({ page }) => {
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.getByTestId('product-rename-form')).toBeVisible()
})

When("I open the pair's canonical rename form", async ({ page }) => {
  await catalogSide(page).getByRole('button', { name: 'Rename' }).click()
  await expect(page.getByTestId('product-rename-form')).toBeVisible()
})

When('I rename it to {string}', async ({ page }, newName) => {
  await submitRename(page, EXPLORER_PRODUCT_KEY, newName)
})

When('I rename the pair canonical side to {string}', async ({ page }, newName) => {
  await submitRename(page, REVIEW_PRODUCT_KEY, newName)
})

// The other-session write path: same admin endpoint, no optimistic UI involved
// — the cold explorer load that follows proves the server owns the name.
When('I rename the seeded product through the admin API to {string}', async ({ page }, newName) => {
  const identity = await readIdentity(page.request, EXPLORER_PRODUCT_KEY)
  renameSubject = {
    productKey: EXPLORER_PRODUCT_KEY,
    oldName: identity.product.name,
    newName,
    versionBefore: identity.product.metadataVersion,
  }
  const res = await page.request.post(
    `${BASE_URL}/api/admin/products/${EXPLORER_PRODUCT_KEY}/rename`,
    { data: { canonicalName: newName, expectedMetadataVersion: renameSubject.versionBefore } }
  )
  if (res.status() !== 200) {
    throw new Error(`admin API rename failed: ${res.status()} ${await res.text()}`)
  }
  renameSubject.result = await res.json()
})

When('I reload the catalog', async ({ page }) => {
  await page.reload()
  await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 })
})

When('I reload the review queue', async ({ page }) => {
  await page.reload()
  // The pending filter is the queue's default; a rename never decides the
  // pair, so the row is still listed.
  await expect(page.getByText('Matched item')).toBeVisible()
})

Then("the rename is sent with the product's current metadata version", async () => {
  expect(renameSubject).toBeTruthy()
  expect(renameSubject.posted.canonicalName).toBe(renameSubject.newName)
  expect(renameSubject.posted.expectedMetadataVersion).toBe(renameSubject.versionBefore)
})

Then('the rename succeeds with the success note', async ({ page }) => {
  const note = page.getByTestId('rename-success')
  await expect(note).toBeVisible()
  await expect(note).toContainText('Renamed')
  await expect(note).toContainText(
    `The canonical index is now version ${renameSubject.result.indexVersion}`
  )
  // The seeded names are deliberately far from every other product, so a
  // warning would mean the rename took the similar-name path.
  expect(renameSubject.result.warnings).toEqual([])
})

Then('the rename form still shows the current name {string}', async ({ page }, name) => {
  await expect(page.getByTestId('rename-current-name')).toHaveText(name)
})

Then(
  "the canonical product's identity carries {string} at the next metadata version",
  async ({ page }, name) => {
    expect(renameSubject).toBeTruthy()
    const identity = await readIdentity(page.request, renameSubject.productKey)
    expect(identity.product.name).toBe(name)
    expect(identity.product.metadataVersion).toBe(renameSubject.versionBefore + 1)
    // The audit trail ties the committed name to exactly that version pair.
    expect(identity.audit[0]).toMatchObject({
      action: 'rename',
      oldName: renameSubject.oldName,
      newName: name,
      metadataVersionBefore: renameSubject.versionBefore,
      metadataVersionAfter: renameSubject.versionBefore + 1,
    })
  }
)

Then('the catalog shows {string}', async ({ page }, name) => {
  // The row title renders /api/prices, so this only passes once the canonical
  // write invalidated and refetched the list — the form's optimistic copy
  // never rewrites a row.
  await expect(productRows(page).filter({ hasText: name })).toHaveCount(1)
})

Then('the product detail shows {string} as the current canonical name', async ({ page }, name) => {
  // A reload/cold load collapses the form; opening it re-reads the identity
  // from the server, which is the read after the page refresh this asserts.
  const form = page.getByTestId('product-rename-form')
  if (!(await form.isVisible())) {
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
  }
  await expect(page.getByTestId('rename-current-name')).toHaveText(name)
  const identity = await readIdentity(page.request, renameSubject.productKey)
  expect(identity.product.name).toBe(name)
})

Then('the frozen-pair note explains the labels stay frozen', async ({ page }) => {
  await expect(
    page.getByText(
      'The match above keeps its frozen catalog label; only the canonical product name changes.'
    )
  ).toBeVisible()
})

Then('the pair keeps its frozen pair labels', async ({ page }) => {
  // Both labels are the pair_data the scraper froze at flag time. Scoping each
  // side to its own card keeps a new canonical name from ever passing this.
  await expect(matchedSide(page).getByText(REVIEW_ITEM_NAME, { exact: true })).toBeVisible()
  await expect(catalogSide(page).getByText(REVIEW_PRODUCT_NAME, { exact: true })).toBeVisible()
})
