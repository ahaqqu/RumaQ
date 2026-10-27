import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { When, Then } = createBdd()

// hasText is a substring match on purpose: the row renders the item name
// concatenated with a location chip, so exact text matching never hits.
const rowFor = (page, name) => page.getByTestId('stock-row').filter({ hasText: name })

When('I search for {string}', async ({ page }, query) => {
  // The search input debounces 300ms before refetching; the default expect
  // timeout on the following assertions absorbs that.
  await page.getByLabel('Search items').fill(query)
})

When('I filter by the location {string}', async ({ page }, label) => {
  await page.getByRole('button', { name: label, exact: true }).click()
})

When('I increase the quantity of {string}', async ({ page }, name) => {
  await rowFor(page, name).getByRole('button', { name: 'Increase quantity' }).click()
})

When('I decrease the quantity of {string}', async ({ page }, name) => {
  await rowFor(page, name).getByRole('button', { name: 'Decrease quantity' }).click()
})

Then('I should see the stock item {string}', async ({ page }, name) => {
  await expect(rowFor(page, name)).toBeVisible()
})

Then('I should not see the stock item {string}', async ({ page }, name) => {
  await expect(rowFor(page, name)).toHaveCount(0)
})

Then('the inventory should show the empty state', async ({ page }) => {
  await expect(page.getByText('No matching items')).toBeVisible()
})

Then('the stock item {string} should show quantity {string}', async ({ page }, name, qtyText) => {
  await expect(rowFor(page, name).getByTestId('stock-qty')).toHaveText(qtyText)
})
