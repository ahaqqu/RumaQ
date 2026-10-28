import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'

const { createBdd } = pkg
const { When, Then } = createBdd()

// The seeded stack runs with ADMIN_EMAILS=test@rumaq.dev, so the seeded user
// sees the operator surfaces. The UI default locale is English.
const scrapeNow = (page) => page.getByRole('button', { name: 'Scrape Now' })

When('I select the {string} store on the scrape page', async ({ page }, slug) => {
  await page.getByRole('checkbox', { name: slug }).check()
})

When('I queue the selected scrape', async ({ page }) => {
  await scrapeNow(page).click()
})

Then('the scrape page lists the stores', async ({ page }) => {
  for (const slug of ['superindo', 'lotte-mart', 'astro']) {
    await expect(page.getByRole('checkbox', { name: slug })).toBeVisible()
  }
})

Then('the scrape now button should be disabled', async ({ page }) => {
  await expect(scrapeNow(page)).toBeDisabled()
})

Then('the scrape now button should be enabled', async ({ page }) => {
  await expect(scrapeNow(page)).toBeEnabled()
})

Then('the queued scrape should show as the active run', async ({ page }) => {
  // Pending in the active-run card — the local stack has no agent to claim it.
  await expect(page.getByText('Waiting for the VPS agent to pick up the command…')).toBeVisible()
  await expect(page.getByText('No output yet')).toBeVisible()
  // One run at a time: the trigger is blocked with an inline reason.
  await expect(
    page.getByText('A scrape is already pending or running — one run at a time.')
  ).toBeVisible()
})
