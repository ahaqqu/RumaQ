// Hypermart plugin tests — parses a trimmed structural snapshot of the real
// /promo-koran/ hub page (fixture saved 2026-10-30): the JAWA media-carousel
// (lightbox anchor hrefs + WP Fastest Cache lazy divs), the 2020 JAWA-8.pdf
// decoy download buttons, the bank-promo carousel the JAWA-* glob must
// exclude, and the 24-option region picker the scraper ignores.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  cleanWpfcValue,
  createHypermartPlugin,
  isAllowedKoranImageUrl,
  KORAN_HUB_URL,
  parseKoranImages,
} from '../../src/stores/hypermart.js'
import { loadConfig, storeBySlug } from '../../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, '../fixtures/hypermart', name), 'utf8')
}

/** The 11 live koran URLs, page order 1..11 (2026-10-30 carousel). */
function expectedKoranUrls(): string[] {
  return Array.from(
    { length: 11 },
    (_, i) => `https://www.hypermart.co.id/wp-content/uploads/2026/10/JAWA-${i + 1}.jpg`
  )
}

describe('parseKoranImages — real hub page', () => {
  const html = loadFixture('promo-koran.html')

  it('harvests the 11 JAWA koran pages in DOM order from both carriers', () => {
    expect(parseKoranImages(html)).toEqual(expectedKoranUrls())
  })

  it('excludes the stale-2020 JAWA-8.pdf decoy by construction', () => {
    const urls = parseKoranImages(html)
    expect(urls.some((url) => url.endsWith('.pdf'))).toBe(false)
    expect(urls.some((url) => url.includes('2020/02'))).toBe(false)
  })

  it('excludes the bank-promo carousel (no JAWA basename)', () => {
    const urls = parseKoranImages(html)
    expect(urls.some((url) => url.includes('PROMO-BANK'))).toBe(false)
  })

  it('returns no duplicate URLs despite two carriers per slide', () => {
    const urls = parseKoranImages(html)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('returns [] for empty and structure-less HTML', () => {
    expect(parseKoranImages('')).toEqual([])
    expect(parseKoranImages('<html><body><p>No promos here</p></body></html>')).toEqual([])
  })
})

describe('isAllowedKoranImageUrl — the four harvest filters', () => {
  it('allows hypermart.co.id and subdomain upload URLs', () => {
    expect(
      isAllowedKoranImageUrl('https://www.hypermart.co.id/wp-content/uploads/2026/10/JAWA-1.jpg')
    ).toBe(true)
    expect(
      isAllowedKoranImageUrl('https://cdn.hypermart.co.id/wp-content/uploads/JAWA-2.jpg')
    ).toBe(true)
  })

  it('rejects off-host URLs including lookalike suffixes', () => {
    expect(isAllowedKoranImageUrl('https://evil.com/wp-content/uploads/JAWA-1.jpg')).toBe(false)
    expect(
      isAllowedKoranImageUrl('https://hypermart.co.id.evil.com/wp-content/uploads/JAWA-1.jpg')
    ).toBe(false)
    expect(isAllowedKoranImageUrl('/wp-content/uploads/JAWA-1.jpg')).toBe(false)
  })

  it('requires the uploads path', () => {
    expect(isAllowedKoranImageUrl('https://www.hypermart.co.id/promo-koran/JAWA-1.jpg')).toBe(false)
  })

  it('requires the .jpg extension (the pdf decoy never passes)', () => {
    expect(
      isAllowedKoranImageUrl('https://www.hypermart.co.id/wp-content/uploads/2020/02/JAWA-8.pdf')
    ).toBe(false)
  })

  it('requires the JAWA-* basename (other hub carousels never pass)', () => {
    expect(
      isAllowedKoranImageUrl(
        'https://www.hypermart.co.id/wp-content/uploads/2026/10/PROMO-BANK-OKTOBER-2026-TVC-15-SUPERBANK-scaled.jpg'
      )
    ).toBe(false)
  })
})

describe('cleanWpfcValue', () => {
  it('strips the quote wrapping the WP Fastest Cache lazy value', () => {
    expect(cleanWpfcValue("'https://www.hypermart.co.id/wp-content/uploads/JAWA-1.jpg'")).toBe(
      'https://www.hypermart.co.id/wp-content/uploads/JAWA-1.jpg'
    )
    expect(cleanWpfcValue('"https://www.hypermart.co.id/a.jpg"')).toBe(
      'https://www.hypermart.co.id/a.jpg'
    )
    expect(cleanWpfcValue('https://www.hypermart.co.id/a.jpg')).toBe(
      'https://www.hypermart.co.id/a.jpg'
    )
  })
})

describe('hypermart plugin', () => {
  it('maps the harvested URLs to brochure pages deep-linking the hub', async () => {
    const config = storeBySlug(loadConfig(), 'hypermart')!
    const plugin = createHypermartPlugin(config)
    const pages = await Effect.runPromise(
      plugin.listBrochurePages({
        fetchHtml: (url) => {
          expect(url).toBe(KORAN_HUB_URL)
          return Effect.succeed(loadFixture('promo-koran.html'))
        },
        runStartedAt: '2026-10-30T00:00:00Z',
      })
    )
    expect(pages).toHaveLength(11)
    expect(pages.map((page) => page.imageUrl)).toEqual(expectedKoranUrls())
    for (const page of pages) {
      expect(page.brochureUrl).toBe(KORAN_HUB_URL)
    }
  })

  it('caps pages at maxPages', async () => {
    const config = { ...storeBySlug(loadConfig(), 'hypermart')!, maxPages: 3 }
    const plugin = createHypermartPlugin(config)
    const pages = await Effect.runPromise(
      plugin.listBrochurePages({
        fetchHtml: () => Effect.succeed(loadFixture('promo-koran.html')),
        runStartedAt: '2026-10-30T00:00:00Z',
      })
    )
    expect(pages.map((page) => page.imageUrl)).toEqual(expectedKoranUrls().slice(0, 3))
  })
})

describe('hypermart config entry', () => {
  it('registers the brochure/plain shape with its proxy slot', () => {
    const config = storeBySlug(loadConfig(), 'hypermart')!
    expect(config).toMatchObject({
      slug: 'hypermart',
      name: 'Hypermart',
      kind: 'brochure',
      strategy: 'plain',
      region: 'jakarta',
      website: 'https://www.hypermart.co.id/',
      maxPages: 40,
      proxyEnv: 'HYPERMART_PROXY_URL',
    })
  })
})
