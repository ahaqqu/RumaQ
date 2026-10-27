import { fileURLToPath } from 'node:url'
import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { When, Then } = createBdd()

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
const RECEIPT_PNG = `${FIXTURES_DIR}receipt.png`
const REJECT_TXT = `${FIXTURES_DIR}reject.txt`

When('I upload the receipt fixture image', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles(RECEIPT_PNG)
  // Upload → mock scan → review phase renders the parsed items.
  await expect(page.getByText('Review AI reading')).toBeVisible({ timeout: 15_000 })
})

When('I upload a non-image file', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles(REJECT_TXT)
})

When('I confirm the scanned purchase', async ({ page }) => {
  await page.getByRole('button', { name: 'Confirm & add stock' }).click()
  await expect(page.getByText('Stock increased by', { exact: false })).toBeVisible({
    timeout: 15_000,
  })
})

Then('the review should show the scanned item {string}', async ({ page }, name) => {
  // Review rows render editable inputs; the item name lives in the value of
  // the input aria-labelled "Item" (t('history.item')), not in text content.
  await expect
    .poll(async () =>
      page
        .getByRole('textbox', { name: 'Item', exact: true })
        .evaluateAll((els) => els.map((e) => e.value))
    )
    .toContain(name)
})

Then('the confirmation should say {int} items were added', async ({ page }, count) => {
  await expect(page.getByText(`Stock increased by ${count} items`)).toBeVisible()
})

Then('the inventory should list the new stock item {string}', async ({ page }, name) => {
  // Fresh full-page navigation guarantees a refetch of /api/stock.
  await page.goto('/inventory')
  await expect(page.getByTestId('stock-row').filter({ hasText: name })).toBeVisible({
    timeout: 15_000,
  })
})

Then('the unsupported file type error should be shown', async ({ page }) => {
  await expect(page.getByText('Unsupported file type', { exact: false })).toBeVisible()
})
