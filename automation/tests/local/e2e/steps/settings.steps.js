import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { When, Then } = createBdd()

const section = (page, heading) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) })

const listedRow = (page, heading, label) =>
  section(page, heading).getByText(label, { exact: true }).first()

When('I add the location {string}', async ({ page }, label) => {
  await page.getByLabel('New location name').fill(label)
  await section(page, 'Storage Locations').getByRole('button', { name: 'Add' }).click()
})

When('I delete the location {string}', async ({ page }, label) => {
  await page.getByRole('button', { name: `Delete ${label}` }).click()
})

When('I add the store {string}', async ({ page }, label) => {
  await page.getByLabel('New store name').fill(label)
  await section(page, 'Recorded Stores').getByRole('button', { name: 'Add' }).click()
})

When('I delete the store {string}', async ({ page }, label) => {
  await page.getByRole('button', { name: `Delete ${label}` }).click()
})

Then('the location {string} should be listed', async ({ page }, label) => {
  await expect(listedRow(page, 'Storage Locations', label)).toBeVisible()
})

Then('the location {string} should not be listed', async ({ page }, label) => {
  await expect(listedRow(page, 'Storage Locations', label)).toHaveCount(0)
})

Then('the store {string} should be listed', async ({ page }, label) => {
  await expect(listedRow(page, 'Recorded Stores', label)).toBeVisible()
})

Then('the store {string} should not be listed', async ({ page }, label) => {
  await expect(listedRow(page, 'Recorded Stores', label)).toHaveCount(0)
})
