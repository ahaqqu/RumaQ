import pkg from 'playwright-bdd'
import { expect } from '@playwright/test'
import { assertNoCriticalOrSerious, scanPage } from './axe.js'
import { e2eBrochureKey } from './price-brochures.steps.js'

const { createBdd } = pkg
const { Then } = createBdd()

// The brochure viewer's URL is fixture-backed: the uploaded object is keyed
// to TODAY by the shared brochure-snapshot step, so the deep link is
// computed at run time, not a static string (#674).
const viewerPath = () => {
  const [, ymd, file] = e2eBrochureKey().split('/')
  return `/brochures/view?store=lotte-mart&date=${ymd}&file=${file}`
}

const PATHS = {
  Home: '/',
  Inventory: '/inventory',
  Plan: '/plan',
  History: '/history',
  Settings: '/settings',
  Prices: '/prices',
  'Prices brochures': '/prices?view=brochures',
  'Prices promos': '/admin/catalog?tab=promos',
  'Admin catalog': '/admin/catalog',
  'Brochure viewer': viewerPath,
}

// Per-page signals that the async data has rendered, so axe scans real
// content instead of skeletons. Inventory/History expose a search control
// ('Search items' is an input aria-label; History's input is type=search so
// its role is searchbox); Settings exposes the storage section heading.
// The Prices explorer's search input carries the 'Search prices' aria-label;
// the promos view has no search input and no stable ready signal, so it gets
// a networkidle settle like Home/Plan.
const READY = {
  Home: null,
  Inventory: (page) => page.getByLabel('Search items'),
  Plan: null,
  History: (page) => page.getByLabel('Search items'),
  Settings: (page) => page.getByRole('heading', { name: 'Storage Locations' }),
  Prices: (page) => page.getByLabel('Search prices'),
  'Prices brochures': null,
  'Prices promos': null,
  'Admin catalog': (page) => page.getByLabel('Search prices'),
  'Brochure viewer': (page) => page.getByTestId('viewer-topbar'),
}

// Chrome-less routes (#674) render no app header — their READY signal is the
// only load gate.
const HEADERLESS = new Set(['Brochure viewer'])

Then('the login page should have no critical or serious axe violations', async ({ page }) => {
  // "I visit the app" (smoke.steps.js) already navigated to the app root.
  await page.waitForSelector('input#email', { timeout: 15_000 })
  assertNoCriticalOrSerious((await scanPage(page).analyze()).violations)
})

Then(
  'the {string} page should have no critical or serious axe violations',
  async ({ page }, name) => {
    const path = PATHS[name]
    await page.goto(typeof path === 'function' ? path() : path)
    if (HEADERLESS.has(name)) {
      await expect(READY[name](page)).toBeVisible({ timeout: 15_000 })
    } else {
      await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 })
      const ready = READY[name]
      if (ready) {
        await expect(ready(page)).toBeVisible({ timeout: 15_000 })
      } else {
        // Give queries one settle cycle on pages without a stable ready signal.
        await page.waitForLoadState('networkidle')
      }
    }
    assertNoCriticalOrSerious((await scanPage(page).analyze()).violations)
  }
)
