import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { When, Then } = createBdd()

// Item names are rendered as "<name> · <qty> <unit>" inside table cells, so
// substring matching is the right granularity here. Scoping to the table
// keeps the Patterns section (which lists item names too) out of assertions.
const itemCell = (page, name) => page.getByRole('table').getByText(name, { exact: false }).first()

When('I search history for {string}', async ({ page }, query) => {
  await page.getByLabel('Search items').fill(query)
})

When('I filter history by the store {string}', async ({ page }, label) => {
  await page.getByLabel('Store', { exact: true }).selectOption({ label })
})

Then('the month group {string} should be visible', async ({ page }, month) => {
  await expect(page.getByText(month, { exact: false }).first()).toBeVisible()
})

Then('the history total should show {string}', async ({ page }, amount) => {
  // The totals panel renders "<strong>total</strong> <formatted amount>".
  // The currency symbol differs between ICU builds ("Rp" vs "IDR") and the
  // thousands separator between locales, so match on both shapes.
  const formatted = amount.replace(/(\d{3})$/, '[.,]$1')
  const totalsPanel = page.locator('strong', { hasText: 'total' }).locator('xpath=..')
  await expect(totalsPanel).toContainText(new RegExp(`(?:Rp|IDR)\\s?${formatted}`))
})

Then('the purchase item {string} should be visible', async ({ page }, name) => {
  await expect(itemCell(page, name)).toBeVisible()
})

Then('the purchase item {string} should not be visible', async ({ page }, name) => {
  await expect(itemCell(page, name)).toHaveCount(0)
})
