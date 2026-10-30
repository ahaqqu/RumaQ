// Port of haqita tests/scrapers/test_superindo_html.py — parses real saved
// pages from superindo.co.id (fixtures copied verbatim from haqita data/test).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createSuperindoPlugin,
  dedupeUrls,
  isAllowedImageUrl,
  parseSwiperImages,
} from '../../src/stores/superindo.js'
import { loadConfig, storeBySlug } from '../../src/config.js'
import { fullFetchContext } from '../helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, '../fixtures/superindo', name), 'utf8')
}

const VALID_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

describe('parseSwiperImages — katalog page', () => {
  const html = loadFixture('katalog-super-hemat.html')

  it('extracts http image URLs from the jabodetabek gallery', () => {
    const images = parseSwiperImages(html, 'jabodetabek-palembang')
    expect(images.length).toBeGreaterThanOrEqual(1)
    for (const url of images) {
      expect(url.startsWith('http')).toBe(true)
    }
  })

  it('extracts only image extensions', () => {
    for (const url of parseSwiperImages(html, 'jabodetabek-palembang')) {
      expect(
        VALID_EXTENSIONS.some((ext) => url.toLowerCase().endsWith(ext)),
        `Bad extension: ${url}`
      ).toBe(true)
    }
  })

  it('returns no duplicate URLs', () => {
    const urls = parseSwiperImages(html, 'jabodetabek-palembang')
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('parseSwiperImages — promo koran page', () => {
  const html = loadFixture('promo-koran.html')

  it('extracts http image URLs from the promo-koran gallery', () => {
    const images = parseSwiperImages(html, 'promo-koran')
    expect(images.length).toBeGreaterThanOrEqual(1)
    for (const url of images) {
      expect(url.startsWith('http')).toBe(true)
    }
  })

  it('extracts only image extensions', () => {
    for (const url of parseSwiperImages(html, 'promo-koran')) {
      expect(
        VALID_EXTENSIONS.some((ext) => url.toLowerCase().endsWith(ext)),
        `Bad extension: ${url}`
      ).toBe(true)
    }
  })

  it('returns no duplicate URLs', () => {
    const urls = parseSwiperImages(html, 'promo-koran')
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('parseSwiperImages — malformed input', () => {
  it('returns [] for empty HTML', () => {
    expect(parseSwiperImages('', 'jabodetabek-palembang')).toEqual([])
  })

  it('returns [] for HTML without swiper slides', () => {
    expect(
      parseSwiperImages('<html><body><p>No promos here</p></body></html>', 'jabodetabek-palembang')
    ).toEqual([])
  })

  it('returns [] when the fancybox gallery is a different region', () => {
    const html = `
      <div class="swiper-slide">
        <a class="fancybox" data-fancybox="other-region" href="https://example.com/img.jpg">
          <img src="https://example.com/img.jpg">
        </a>
      </div>
    `
    expect(parseSwiperImages(html, 'jabodetabek-palembang')).toEqual([])
  })

  it('returns [] when the slide has no fancybox link', () => {
    const html = `
      <div class="swiper-slide">
        <a href="https://example.com/img.jpg">Link</a>
      </div>
    `
    expect(parseSwiperImages(html, 'jabodetabek-palembang')).toEqual([])
  })

  it('drops fancybox hrefs pointing off the superindo domain', () => {
    const html = `
      <div class="swiper-slide">
        <a class="fancybox" data-fancybox="jabodetabek-palembang" href="https://evil.com/img.jpg">
          <img src="https://evil.com/img.jpg">
        </a>
        <a class="fancybox" data-fancybox="jabodetabek-palembang" href="https://superindo.co.id.evil.com/img.jpg">
          <img src="https://superindo.co.id.evil.com/img.jpg">
        </a>
      </div>
    `
    expect(parseSwiperImages(html, 'jabodetabek-palembang')).toEqual([])
  })
})

describe('isAllowedImageUrl', () => {
  it('allows superindo.co.id and its subdomains', () => {
    expect(isAllowedImageUrl('https://superindo.co.id/img.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://www.superindo.co.id/img.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://cdn.assets.superindo.co.id/img.jpg')).toBe(true)
  })

  it('rejects other hosts, lookalike suffixes, and non-URLs', () => {
    expect(isAllowedImageUrl('https://evil.com/img.jpg')).toBe(false)
    expect(isAllowedImageUrl('https://notsuperindo.co.id/img.jpg')).toBe(false)
    expect(isAllowedImageUrl('https://superindo.co.id.evil.com/img.jpg')).toBe(false)
    expect(isAllowedImageUrl('/relative/img.jpg')).toBe(false)
  })
})

describe('dedupeUrls', () => {
  it('preserves order and removes duplicates', () => {
    expect(dedupeUrls(['http://a/2.jpg', 'http://a/1.jpg', 'http://a/1.jpg'])).toEqual([
      'http://a/2.jpg',
      'http://a/1.jpg',
    ])
  })

  it('returns [] for []', () => {
    expect(dedupeUrls([])).toEqual([])
  })
})

describe('superindo plugin', () => {
  it('collects pages from both listing URLs via the injected fetcher', async () => {
    const config = storeBySlug(loadConfig(), 'superindo')!
    const plugin = createSuperindoPlugin(config)
    const htmls: Record<string, string> = {
      'https://www.superindo.co.id/promosi/katalog-super-hemat/': loadFixture(
        'katalog-super-hemat.html'
      ),
      'https://www.superindo.co.id/promosi/promo-koran/': loadFixture('promo-koran.html'),
    }
    const pages = await Effect.runPromise(
      plugin.listBrochurePages(
        fullFetchContext({
          fetchHtml: (url) => Effect.succeed(htmls[url] ?? ''),
          runStartedAt: '2026-10-25T00:00:00Z',
        })
      )
    )
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const brochureUrls = new Set(pages.map((page) => page.brochureUrl))
    expect(brochureUrls).toEqual(
      new Set([
        'https://www.superindo.co.id/promosi/katalog-super-hemat/',
        'https://www.superindo.co.id/promosi/promo-koran/',
      ])
    )
  })

  it('caps pages at maxPages', async () => {
    const config = { ...storeBySlug(loadConfig(), 'superindo')!, maxPages: 1 }
    const plugin = createSuperindoPlugin(config)
    const pages = await Effect.runPromise(
      plugin.listBrochurePages(
        fullFetchContext({
          fetchHtml: () => Effect.succeed(loadFixture('katalog-super-hemat.html')),
          runStartedAt: '2026-10-25T00:00:00Z',
        })
      )
    )
    expect(pages.length).toBe(1)
  })
})
