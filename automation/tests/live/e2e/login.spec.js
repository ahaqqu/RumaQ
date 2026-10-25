import { test, expect } from '@playwright/test'

const APP = 'https://api.rumaq.workers.dev'
const API = 'https://api.rumaq.workers.dev'
const EMAIL = 'alice@rumaq.dev'
const PASSWORD = 'password123'

test('login and logout with alice@rumaq.dev', async ({ page }) => {
  // 1. Navigate to the app
  await page.goto(APP, { waitUntil: 'networkidle' })

  // 2. Wait for email auth to load (email form renders after emailAuthStatus check)
  await page.waitForSelector('input#email', { timeout: 15_000 })
  await page.waitForSelector('input#password', { timeout: 5_000 })

  // 3. Fill in credentials and click the email sign-in button
  await page.fill('input#email', EMAIL)
  await page.fill('input#password', PASSWORD)
  await page.click('button[type="submit"]')

  // 4. After successful login the app navigates to / — wait for it
  await page.waitForURL(`${APP}/`, { timeout: 15_000 })

  // 5. Verify Alice is shown (logged in)
  await expect(page.locator('body')).toContainText(/Alice|alice/, {
    timeout: 10_000,
  })

  // 6. Logout — navigate to logout URL
  await page.goto(`${API}/api/auth/logout`, {
    waitUntil: 'networkidle',
  })

  // 7. Should redirect back to the app
  await expect(page).toHaveURL(new RegExp(APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
    timeout: 10_000,
  })

  // 8. Should see login page (email form) — no longer logged in
  await page.waitForSelector('input#email', { timeout: 10_000 })
})
