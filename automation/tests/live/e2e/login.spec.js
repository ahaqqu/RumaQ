import { test, expect } from '@playwright/test'

const APP = 'https://rumaq.ahaqqu.com'
const API = 'https://rumaq.ahaqqu.com'
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

// The second sanctioned account (docs/QA.md §5): test@rumaq.dev is the
// ADMIN, sandbox-capable write account for live QA runs. Its password is
// owner-known — set QA_ADMIN_PASSWORD in the environment when running the
// live suite (or check it in here alongside alice's, same pattern), and the
// test activates; until then it self-skips so local runs stay green.
const ADMIN_EMAIL = 'test@rumaq.dev'
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? ''

test('login and logout with test@rumaq.dev (admin, sandbox)', async ({ page }) => {
  test.skip(
    !ADMIN_PASSWORD,
    'QA_ADMIN_PASSWORD not set — test@rumaq.dev credential pending check-in'
  )

  await page.goto(APP, { waitUntil: 'networkidle' })
  await page.waitForSelector('input#email', { timeout: 15_000 })
  await page.waitForSelector('input#password', { timeout: 5_000 })

  await page.fill('input#email', ADMIN_EMAIL)
  await page.fill('input#password', ADMIN_PASSWORD)
  await page.click('button[type="submit"]')

  await page.waitForURL(`${APP}/`, { timeout: 15_000 })

  // Logged in — the admin session reached the app shell
  await expect(page.locator('input#email')).toHaveCount(0, { timeout: 10_000 })

  await page.goto(`${API}/api/auth/logout`, { waitUntil: 'networkidle' })
  await expect(page).toHaveURL(new RegExp(APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
    timeout: 10_000,
  })
  await page.waitForSelector('input#email', { timeout: 10_000 })
})
