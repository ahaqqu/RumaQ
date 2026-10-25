// Port of haqita lotte.py behavior — keyword extraction against the real
// saved "All Promo Mart" page plus synthetic edge cases.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createLottePlugin,
  isAllowedLotteImageUrl,
  normalizeLotteSrc,
  parseLotteImages,
} from '../../src/stores/lotte.js'
import { fakeBrowserLauncher } from '../helpers.js'
import type { StoreConfig } from '../../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const lotteStore: StoreConfig = {
  slug: 'lotte-mart',
  name: 'Lotte Mart',
  kind: 'brochure',
  strategy: 'browser',
  region: 'jakarta',
  website: 'https://www.lottemart.co.id/',
  maxPages: 40,
  proxyEnv: 'LOTTE_PROXY_URL',
}

describe('parseLotteImages', () => {
  it('extracts promo images from the real saved listing page', async () => {
    // The page was saved from a browser, so asset srcs point at the local
    // save folder — rewrite them to the site-absolute form the live page
    // serves before parsing.
    const html = (
      await readFile(path.join(__dirname, '../fixtures/lotte/all-promo-mart.html'), 'utf8')
    ).replaceAll('./All Promo Mart_files/', 'https://www.lottemart.co.id/assets/')
    const urls = parseLotteImages(html)
    expect(urls.length).toBeGreaterThan(0)
    // The saved page's promo assets are site-relative or //cdn — after the
    // plugin's scheme fix every URL is absolute and host-allowlisted.
    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true)
      expect(isAllowedLotteImageUrl(url)).toBe(true)
    }
  })

  it('keyword-filters, excludes .gif, scheme-fixes and dedupes', () => {
    const html = [
      '<html><body>',
      '<img src="/media/promo/page-1.jpg">', // keyword + site-relative → absolute
      '<img src="/media/promo/page-1.jpg">', // duplicate → dropped
      '<img src="https://cdn.lottemart.co.id/flyer/page-2.jpg">', // keyword + cdn host
      '<img src="/media/katalog/page-3.webp">', // keyword "katalog"
      '<img src="/media/promo/spinner.gif">', // gif → excluded
      '<img src="/media/hero/banner.jpg">', // no keyword → excluded
      '<img data-src="/media/ht/page-4.jpg">', // data-src + keyword "ht"
      '<img>', // no src at all
      '</body></html>',
    ].join('')
    expect(parseLotteImages(html)).toEqual([
      'https://www.lottemart.co.id/media/promo/page-1.jpg',
      'https://cdn.lottemart.co.id/flyer/page-2.jpg',
      'https://www.lottemart.co.id/media/katalog/page-3.webp',
      'https://www.lottemart.co.id/media/ht/page-4.jpg',
    ])
  })

  it('drops off-site hosts entirely', () => {
    const html = '<img src="https://evil.example.com/promo/x.jpg">'
    expect(parseLotteImages(html)).toEqual([])
  })
})

describe('normalizeLotteSrc / isAllowedLotteImageUrl', () => {
  it('prefixes protocol-relative and site-relative URLs', () => {
    expect(normalizeLotteSrc('//cdn.lottemart.co.id/a.jpg')).toBe(
      'https://cdn.lottemart.co.id/a.jpg'
    )
    expect(normalizeLotteSrc('/media/a.jpg')).toBe('https://www.lottemart.co.id/media/a.jpg')
    expect(normalizeLotteSrc('https://www.lottemart.co.id/a.jpg')).toBe(
      'https://www.lottemart.co.id/a.jpg'
    )
  })

  it('allowlists only lottemart.co.id and its subdomains', () => {
    expect(isAllowedLotteImageUrl('https://www.lottemart.co.id/a.jpg')).toBe(true)
    expect(isAllowedLotteImageUrl('https://cdn.lottemart.co.id/a.jpg')).toBe(true)
    expect(isAllowedLotteImageUrl('https://notlottemart.co.id/a.jpg')).toBe(false)
    expect(isAllowedLotteImageUrl('https://lottemart.co.id.evil.io/a.jpg')).toBe(false)
    expect(isAllowedLotteImageUrl('not a url')).toBe(false)
  })
})

describe('createLottePlugin', () => {
  it('lists brochure pages through the Tier-2 fetcher and caps at maxPages', async () => {
    const html = [
      '<html><body>',
      ...Array.from({ length: 5 }, (_, i) => `<img src="/media/promo/p-${i}.jpg">`),
      '</body></html>',
    ].join('')
    const plugin = createLottePlugin({ ...lotteStore, maxPages: 3 })
    const pages = await Effect.runPromise(
      plugin.listBrochurePages({
        fetchHtml: () => Effect.succeed(html),
        runStartedAt: '2026-10-25T23:00:00Z',
      })
    )
    expect(pages).toHaveLength(3)
    expect(pages[0]).toEqual({
      imageUrl: 'https://www.lottemart.co.id/media/promo/p-0.jpg',
      brochureUrl: 'https://www.lottemart.co.id/all-promo-mart',
    })
  })

  it('returns zero pages when the listing yields nothing', async () => {
    const plugin = createLottePlugin(lotteStore)
    const pages = await Effect.runPromise(
      plugin.listBrochurePages({
        fetchHtml: () => Effect.succeed('<html><body></body></html>'),
        runStartedAt: '2026-10-25T23:00:00Z',
      })
    )
    expect(pages).toEqual([])
  })
})

// fakeBrowserLauncher is exercised in the pipeline e2e; imported here only
// to keep the helper's lotte usage honest.
it('fake launcher helper shape', async () => {
  const { launcher, state } = fakeBrowserLauncher('<html>x</html>')
  const session = await launcher.launch()
  const page = await session.newPage()
  await page.goto('https://www.lottemart.co.id/', 30_000)
  expect(await page.content()).toBe('<html>x</html>')
  await session.close()
  expect(state.closed).toBe(true)
})
