import { createBdd } from 'playwright-bdd'
import { expect } from '@playwright/test'

const { Given, When, Then } = createBdd()

// Read-only duplicate-name report E2E (issue #485). The API suite pins the
// grouping and bounds (products-duplicates.feature + real SQLite); this
// scenario pins the surface itself: the panel is on the prices page, admin
// only, collapsed until opened, and its one lazy fetch reaches the real
// endpoint through the real query hook. Seeding goes through the internal
// ingest the scraper uses, so the group is formed by two real canonical
// products — one store spelling each, differing only in case.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const INGEST_SECRET = 'test-ingest-secret'

const DUPLICATE_A = { key: 'duplikat--beras--a', name: 'Beras Ramos 5 kg' }
const DUPLICATE_B = { key: 'duplikat--beras--b', name: 'beras ramos 5 kg' }
const UNIQUE = { key: 'duplikat--gula--1-kg', name: 'Gula Pasir Gulaku 1 kg' }

function duplicateSnapshot() {
  return {
    schemaVersion: 2,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta' }],
    items: [DUPLICATE_A, DUPLICATE_B, UNIQUE].map((product) => ({
      productKey: product.key,
      rawName: product.name,
      storeSlug: 'superindo',
      price: 23000,
      matchMethod: 'exact',
      matchConfidence: 1,
    })),
  }
}

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

const panel = (page) => page.getByTestId('duplicate-names-panel')

Given(
  'the catalog holds two products sharing a name in different cases and one unique product',
  async () => {
    await pushSnapshot(duplicateSnapshot())
  }
)

Then('the duplicate-name report is collapsed', async ({ page }) => {
  await expect(panel(page)).toBeVisible()
  const toggle = panel(page).getByRole('button', { name: 'Show report' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // Collapsed means no report body: the fetch only starts when it is opened.
  await expect(page.getByTestId('duplicate-names-groups')).toHaveCount(0)
  await expect(page.getByTestId('duplicate-names-empty')).toHaveCount(0)
})

When('I open the duplicate-name report', async ({ page }) => {
  await panel(page).getByRole('button', { name: 'Show report' }).click()
  await expect(page.getByTestId('duplicate-names-groups')).toBeVisible()
})

Then('the report lists the duplicate group with both product keys', async ({ page }) => {
  // One group, two product rows, newest wording as the group's display name.
  await expect(page.getByTestId('duplicate-name-product')).toHaveCount(2)
  await expect(panel(page)).toContainText(DUPLICATE_A.name)
  await expect(panel(page)).toContainText(DUPLICATE_B.name)
  await expect(panel(page)).toContainText(DUPLICATE_A.key)
  await expect(panel(page)).toContainText(DUPLICATE_B.key)
  await expect(panel(page)).toContainText('2 products')
  // Both products were observed at one store, so the row names it.
  await expect(panel(page)).toContainText('superindo')
  // A complete report says nothing about truncation.
  await expect(page.getByTestId('duplicate-names-truncated')).toHaveCount(0)
})

Then('the report leaves the unique product out', async ({ page }) => {
  await expect(panel(page)).not.toContainText(UNIQUE.name)
  await expect(panel(page)).not.toContainText(UNIQUE.key)
})
