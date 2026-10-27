// Astro catalog plugin tests — extraction of the inventory JSON embedded in
// the Next.js flight stream of an SSR category page (fixture built to mirror
// the real page structure: push literals, duplicate product, truncated object).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createAstroPlugin,
  extractFlightChunks,
  parseProductObjects,
  toCatalogItem,
  type AstroProduct,
} from '../../src/stores/astro.js'
import { loadConfig, storeBySlug } from '../../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, '../fixtures/astro', name), 'utf8')
}

function fixtureProducts(): AstroProduct[] {
  return parseProductObjects(extractFlightChunks(loadFixture('category.html')))
}

describe('extractFlightChunks', () => {
  it('joins push literals with their escaping undone', () => {
    const html =
      '<script>self.__next_f.push([1,"2:[\\"$\\",\\"div\\",null,{}]"])</script>' +
      '<script>self.__next_f.push([1,"{\\"a\\":1}"])</script>'
    expect(extractFlightChunks(html)).toBe('2:["$","div",null,{}]{"a":1}')
  })

  it('returns "" for pages without a flight stream and skips broken literals', () => {
    expect(extractFlightChunks('<html><body>static</body></html>')).toBe('')
    const broken = '<script>self.__next_f.push([1,"unterminated</script>)])</script>'
    expect(extractFlightChunks(broken)).toBe('')
  })
})

describe('parseProductObjects', () => {
  it('extracts each product object, deduplicating nothing at this layer', () => {
    // The fixture carries 3 distinct products, one duplicate, and one
    // truncated object — parseProductObjects sees all parseable objects.
    expect(fixtureProducts()).toHaveLength(4)
  })

  it('returns [] for flight text without product objects', () => {
    expect(parseProductObjects('2:["$","div",null,{"children":"hi"}]')).toEqual([])
  })
})

describe('toCatalogItem', () => {
  it('maps a discounted product to its post-discount price and promo label', () => {
    const item = toCatalogItem(fixtureProducts()[0]!, 'https://www.astronauts.id/c/x')
    expect(item).toMatchObject({
      name: 'Beras Setra Ramos Astro Goods',
      brand: null,
      unit: '5kg',
      price: 70840,
      promoLabel: 'Diskon 8%',
      validFrom: null,
      validUntil: null,
      pageUrl: 'https://www.astronauts.id/c/x',
    })
  })

  it('maps a tier-discount product to its listed price and the tier label text', () => {
    const item = toCatalogItem(fixtureProducts()[1]!, 'https://www.astronauts.id/c/x')
    expect(item).toMatchObject({
      name: 'Dada Ayam Boneless Astro Farm',
      price: 30800,
      unit: '450-550gram',
      promoLabel: 'Beli 2 Disc.4%',
    })
  })

  it('maps a plain product without any promo text', () => {
    const item = toCatalogItem(fixtureProducts()[2]!, 'https://www.astronauts.id/c/x')
    expect(item).toMatchObject({ name: 'Minyak Goreng Astro Goods 2L', price: 40000 })
    expect(item!.promoLabel).toBeNull()
  })

  it('keeps the base price when the discount field is unusable', () => {
    const item = toCatalogItem(
      { ...fixtureProducts()[0]!, product_discount_price: '', product_discount_percentage: '' },
      'u'
    )
    expect(item!.price).toBe(77000)
    expect(item!.promoLabel).toBeNull()
  })

  it('returns null for products without a usable name or price', () => {
    expect(toCatalogItem({ product_id: 1, product_name: '  ' }, 'u')).toBeNull()
    expect(toCatalogItem({ product_id: 1, product_name: 'Beras' }, 'u')).toBeNull()
    expect(
      toCatalogItem({ product_id: 1, product_name: 'Beras', product_price: 'abc' }, 'u')
    ).toBeNull()
  })
})

describe('astro plugin', () => {
  it('collects items from every category page through the injected fetcher', async () => {
    const config = storeBySlug(loadConfig(), 'astro')!
    const plugin = createAstroPlugin(config)
    const fetched: string[] = []
    const items = await Effect.runPromise(
      plugin.listItems({
        fetchHtml: (url) =>
          Effect.sync(() => {
            fetched.push(url)
            return loadFixture('category.html')
          }),
        runStartedAt: '2026-10-28T00:00:00Z',
      })
    )
    // Every category page is fetched; the fixture's duplicate and truncated
    // object never surface, and the same product seen on several pages (the
    // fixture repeats across URLs) is deduped to one item per product_id —
    // the first sighting's pageUrl wins.
    expect(fetched).toHaveLength(5)
    expect(new Set(items.map((item) => item.pageUrl)).size).toBe(1)
    expect(items).toHaveLength(3)
  })

  it('caps category pages at maxPages', async () => {
    const config = { ...storeBySlug(loadConfig(), 'astro')!, maxPages: 2 }
    const plugin = createAstroPlugin(config)
    const fetched: string[] = []
    await Effect.runPromise(
      plugin.listItems({
        fetchHtml: (url) =>
          Effect.sync(() => {
            fetched.push(url)
            return loadFixture('category.html')
          }),
        runStartedAt: '2026-10-28T00:00:00Z',
      })
    )
    expect(fetched).toHaveLength(2)
  })

  it('yields [] when a page has no embedded inventory', async () => {
    const plugin = createAstroPlugin(storeBySlug(loadConfig(), 'astro')!)
    const items = await Effect.runPromise(
      plugin.listItems({
        fetchHtml: () => Effect.succeed('<html><body>challenge page</body></html>'),
        runStartedAt: '2026-10-28T00:00:00Z',
      })
    )
    expect(items).toEqual([])
  })
})
