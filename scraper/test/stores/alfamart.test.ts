// Alfamart plugin tests (issue #322, design-arch §1.3) — parses trimmed
// structural snapshots of the real /promo listing and a /promo/{slug}
// campaign page (rendered-DOM fixtures saved 2026-10-31): the /promo/{slug}
// campaign grammar (freshest-first listing, pinned once), the /p/{slug}-{id}
// card grammar with the bounded ancestor climb, price/discount/name
// normalization, the zero-campaign and zero-cards sentinels, and the
// Chromium visit budget (maxPages slices the campaign list before any
// detail visit).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  CAMPAIGN_ANCHOR_SELECTOR,
  createAlfamartPlugin,
  isAllowedAlfagiftUrl,
  parseProductCards,
  parsePromoCampaigns,
  PROMO_LISTING_URL,
  PRODUCT_ANCHOR_SELECTOR,
  toCatalogItem,
} from '../../src/stores/alfamart.js'
import { ScrapeStructureError, type FetchError } from '../../src/fetch/errors.js'
import { exitError, fullFetchContext } from '../helpers.js'
import { loadConfig, storeBySlug } from '../../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, '../fixtures/alfamart', name), 'utf8')
}

describe('parsePromoCampaigns — real /promo listing', () => {
  const html = loadFixture('promo.html')

  it('harvests 149 /promo/{slug} campaign URLs in DOM listing order', () => {
    const campaigns = parsePromoCampaigns(html)
    expect(campaigns.length).toBe(149)
    expect(campaigns[0]).toBe('https://alfagift.id/promo/Nestle-Super-Brand-Day-29-31-Oktober-2026')
  })

  it('pins the freshness contract: the listing leads with the currently-active campaigns', () => {
    // One-time bring-up verification (design-arch §1.3): the first entries
    // are the campaigns running today (saved 2026-10-31 — the Nestle Super
    // Brand Day runs 29-31 Oktober). The code commits to DOM listing order;
    // this test pins the verified property so a churned ordering fails loud.
    const campaigns = parsePromoCampaigns(html)
    expect(campaigns[0]).toContain('29-31-Oktober-2026')
    expect(campaigns[3]).toContain('30-Oktober---5-November-2026')
  })

  it('never follows product, nav, or off-host anchors', () => {
    const campaigns = parsePromoCampaigns(html)
    expect(campaigns.every((url) => url.startsWith('https://alfagift.id/promo/'))).toBe(true)
    expect(campaigns.some((url) => url.includes('/p/'))).toBe(false)
    expect(campaigns.some((url) => url.includes('alfamart.co.id'))).toBe(false)
    expect(campaigns).not.toContain('https://alfagift.id/promo')
  })

  it('returns [] for empty and structure-less HTML (the caller sentinels)', () => {
    expect(parsePromoCampaigns('')).toEqual([])
    expect(parsePromoCampaigns('<html><body><p>No promos</p></body></html>')).toEqual([])
  })
})

describe('parseProductCards — real campaign page', () => {
  const html = loadFixture('promo-detail.html')

  it('parses the three fixture cards via the /p/{slug}-{id} grammar', () => {
    const cards = parseProductCards(html)
    expect(cards.map((card) => card.productHref)).toEqual([
      '/p/filma-minyak-goreng-pouch-2-l-15798',
      '/p/tropical-minyak-goreng-kelapa-sawit-botol-2-l-712925',
      '/p/oatside-susu-oat-cair-barista-blend-kotak-1-l-773793',
    ])
  })

  it('takes the post-discount price, the badge discount, and the clean name', () => {
    const cards = parseProductCards(html)
    // The strikethrough original (46.200) renders BEFORE the promo price
    // (43.700) — the LAST Rp in card order is what the customer pays.
    expect(cards[0]).toMatchObject({
      name: 'FILMA Minyak Goreng Pouch 2 L',
      price: 43700,
      discountPct: 5,
    })
    expect(cards[1]).toMatchObject({
      name: 'Tropical Minyak Goreng Kelapa Sawit Botol 2 L',
      price: 41900,
      discountPct: 11,
    })
    expect(cards[2]).toMatchObject({
      name: 'OATSIDE Susu Oat Cair Barista Blend Kotak 1 L',
      price: 26900,
      discountPct: 22,
    })
  })

  it('extracts the product image URL (host-allowlisted)', () => {
    const cards = parseProductCards(html)
    expect(cards[0]!.imageUrl).toBe(
      'https://c.alfagift.id/product/1/1_A09350004612_20261030084321745_small.jpg'
    )
  })

  it('never picks up the campaign anchor as a card', () => {
    // The detail fixture carries a /promo/… back-link — off the /p/ grammar.
    expect(parseProductCards(html)).toHaveLength(3)
  })

  it('returns [] with no product anchors (the caller sentinels)', () => {
    expect(parseProductCards('<html><body></body></html>')).toEqual([])
    expect(parseProductCards('<html><body><a href="/promo/x">campaign</a></body></html>')).toEqual(
      []
    )
  })
})

describe('toCatalogItem', () => {
  it('normalizes to the astro shape: promo label, null unit/brand, campaign deep link', () => {
    const card = {
      productHref: '/p/filma-minyak-goreng-pouch-2-l-15798',
      name: 'FILMA Minyak Goreng Pouch 2 L',
      price: 43700,
      discountPct: 5,
      imageUrl: 'https://c.alfagift.id/product/1/x.jpg',
    }
    const campaignUrl = 'https://alfagift.id/promo/Murah-Banget-30-Oktober---5-November-2026'
    expect(toCatalogItem(card, campaignUrl)).toEqual({
      name: 'FILMA Minyak Goreng Pouch 2 L',
      brand: null,
      unit: null,
      price: 43700,
      promoLabels: ['Diskon 5%'],
      validFrom: null,
      validUntil: null,
      pageUrl: campaignUrl,
    })
  })

  it('carries no promo label when the card shows no discount', () => {
    const card = {
      productHref: '/p/xyz-1',
      name: 'Ordinary Product',
      price: 12000,
      discountPct: null,
      imageUrl: null,
    }
    expect(toCatalogItem(card, 'https://alfagift.id/promo/x').promoLabels).toBeNull()
  })
})

describe('isAllowedAlfagiftUrl', () => {
  it('allows alfagift.id and subdomains, rejects lookalikes', () => {
    expect(isAllowedAlfagiftUrl('https://alfagift.id/p/x-1')).toBe(true)
    expect(isAllowedAlfagiftUrl('https://c.alfagift.id/product/1/x.jpg')).toBe(true)
    expect(isAllowedAlfagiftUrl('https://alfagift.id.evil.com/p/x-1')).toBe(false)
    expect(isAllowedAlfagiftUrl('/p/x-1')).toBe(false)
  })
})

function makeCtx(options: {
  fetchRendered: (url: string) => Effect.Effect<string, FetchError>
  maxPages?: number
}) {
  const store = storeBySlug(loadConfig(), 'alfamart')!
  const config = options.maxPages !== undefined ? { ...store, maxPages: options.maxPages } : store
  const fetched: string[] = []
  const plugin = createAlfamartPlugin(config)
  const ctx = fullFetchContext({
    runStartedAt: '2026-10-31T00:00:00Z',
    fetchRendered: (url) => {
      fetched.push(url)
      return options.fetchRendered(url)
    },
  })
  return { plugin, ctx, fetched, warnings: ctx.warnings }
}

describe('alfamart plugin — real listing and campaign fixtures', () => {
  const listing = loadFixture('promo.html')
  const detail = loadFixture('promo-detail.html')
  const serveAlfamart = (url: string): string => (url === PROMO_LISTING_URL ? listing : detail)

  it('walks listing → campaigns and dedupes shared products by href', async () => {
    const { plugin, ctx, fetched } = makeCtx({
      fetchRendered: (url) => Effect.succeed(serveAlfamart(url)),
    })
    const items = await Effect.runPromise(plugin.listItems(ctx))
    // The fixture's 3 cards repeat on every visited campaign — one item per
    // product href across the whole run.
    expect(items).toHaveLength(3)
    expect(items.every((item) => item.pageUrl?.includes('/promo/'))).toBe(true)
    // 1 listing + 40 campaign visits at the shipped maxPages.
    expect(fetched).toHaveLength(41)
    expect(fetched[0]).toBe(PROMO_LISTING_URL)
  })

  it('caps the Chromium budget: maxPages slices the campaign list before any visit', async () => {
    const { plugin, ctx, fetched } = makeCtx({
      fetchRendered: (url) => Effect.succeed(serveAlfamart(url)),
      maxPages: 2,
    })
    const items = await Effect.runPromise(plugin.listItems(ctx))
    expect(items).toHaveLength(3) // same 3 products on both campaigns, deduped
    expect(fetched).toHaveLength(3) // 1 listing + 2 campaigns — the budget held
  })

  it('sends the waitForSelector anchors from the URL grammar', async () => {
    const waits: (string | undefined)[] = []
    const { plugin } = makeCtx({
      fetchRendered: (url) => Effect.succeed(serveAlfamart(url)),
    })
    const ctx = fullFetchContext({
      runStartedAt: '2026-10-31T00:00:00Z',
      fetchRendered: (url, opts) => {
        waits.push(opts?.waitForSelector)
        return Effect.succeed(serveAlfamart(url))
      },
    })
    await Effect.runPromise(plugin.listItems(ctx))
    expect(waits[0]).toBe(CAMPAIGN_ANCHOR_SELECTOR)
    for (const wait of waits.slice(1)) expect(wait).toBe(PRODUCT_ANCHOR_SELECTOR)
  })

  it('opts the campaign-detail fetch into the optional anchor wait — the listing stays strict (issue #360)', async () => {
    // Teaser/event campaigns (e.g. /promo/UCOllect, gateway call literally
    // `v2/products/promotions/undefined`) hydrate with zero /p/ anchors
    // forever: a strict detail wait would kill the store as FetchTransport
    // before the zero-card warning branch can run. Only the detail calls opt
    // in — zero campaigns on the listing is still structure churn.
    const opts: ({ waitForSelector?: string; waitForSelectorOptional?: boolean } | undefined)[] = []
    const { plugin } = makeCtx({
      fetchRendered: (url) => Effect.succeed(serveAlfamart(url)),
    })
    const ctx = fullFetchContext({
      runStartedAt: '2026-10-31T00:00:00Z',
      fetchRendered: (url, o) => {
        opts.push(o)
        return Effect.succeed(serveAlfamart(url))
      },
    })
    await Effect.runPromise(plugin.listItems(ctx))
    // 1 listing + 40 campaign visits at the shipped maxPages.
    expect(opts).toHaveLength(41)
    expect(opts[0]).toEqual({ waitForSelector: CAMPAIGN_ANCHOR_SELECTOR })
    for (const detailOpts of opts.slice(1)) {
      expect(detailOpts).toEqual({
        waitForSelector: PRODUCT_ANCHOR_SELECTOR,
        waitForSelectorOptional: true,
      })
    }
  })

  it('sentinels a listing with zero campaigns', async () => {
    const { plugin, ctx } = makeCtx({
      fetchRendered: () => Effect.succeed('<html><body>gated shell</body></html>'),
    })
    const exit = await Effect.runPromiseExit(plugin.listItems(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as ScrapeStructureError
    expect(error._tag).toBe('ScrapeStructureError')
    expect(error.message).toContain('0 promo campaigns')
  })

  it('sentinels when every visited campaign rendered zero cards (the gateway-401 churn signature)', async () => {
    const { plugin, ctx } = makeCtx({
      fetchRendered: (url) =>
        Effect.succeed(url === PROMO_LISTING_URL ? listing : '<html><body>empty</body></html>'),
    })
    const exit = await Effect.runPromiseExit(plugin.listItems(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as ScrapeStructureError
    expect(error._tag).toBe('ScrapeStructureError')
    expect(error.message).toContain('40/40 visited campaign pages rendered 0 product cards')
    expect(error.message).toContain('discarding the cycle')
  })

  it('keeps a single zero-card teaser campaign as a warning — the healthy items still publish', async () => {
    // A scheduled/future-dated teaser campaign legitimately renders zero
    // cards today (issue #322, A4): one odd page must not discard the cycle.
    const teaser = parsePromoCampaigns(listing)[0]!
    const { plugin, ctx, warnings, fetched } = makeCtx({
      fetchRendered: (url) =>
        Effect.succeed(
          url === PROMO_LISTING_URL
            ? listing
            : url === teaser
              ? '<html><body>teaser</body></html>'
              : detail
        ),
    })
    const items = await Effect.runPromise(plugin.listItems(ctx))
    // The 39 healthy campaigns still yielded the deduped 3 cards.
    expect(items).toHaveLength(3)
    expect(items.every((item) => item.pageUrl !== teaser)).toBe(true)
    expect(warnings).toEqual([
      expect.stringContaining(
        `Alfamart campaign page rendered 0 product cards — skipped as a possible teaser: ${teaser}`
      ),
    ])
    // The whole budget was walked — no early abort on the teaser.
    expect(fetched).toHaveLength(41)
  })

  it('sentinels at the churn threshold — at least half the visited campaigns empty', async () => {
    // maxPages 4, 2 of the 4 visited campaigns empty: 2 × 2 >= 4 — churn.
    const campaigns = parsePromoCampaigns(listing)
    const empty = new Set(campaigns.slice(1, 3))
    const { plugin, ctx, warnings } = makeCtx({
      fetchRendered: (url) =>
        Effect.succeed(
          url === PROMO_LISTING_URL
            ? listing
            : empty.has(url)
              ? '<html><body>empty</body></html>'
              : detail
        ),
      maxPages: 4,
    })
    const exit = await Effect.runPromiseExit(plugin.listItems(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as ScrapeStructureError
    expect(error._tag).toBe('ScrapeStructureError')
    expect(error.message).toContain('2/4 visited campaign pages rendered 0 product cards')
    expect(warnings).toHaveLength(2)
  })

  it('publishes below the churn threshold — warnings surface, no sentinel', async () => {
    // maxPages 4, 1 of the 4 visited campaigns empty: 1 × 2 < 4 — below the
    // signature, so the healthy campaigns ride through with one warning.
    const campaigns = parsePromoCampaigns(listing)
    const empty = campaigns[2]!
    const { plugin, ctx, warnings } = makeCtx({
      fetchRendered: (url) =>
        Effect.succeed(
          url === PROMO_LISTING_URL
            ? listing
            : url === empty
              ? '<html><body>empty</body></html>'
              : detail
        ),
      maxPages: 4,
    })
    const items = await Effect.runPromise(plugin.listItems(ctx))
    expect(items).toHaveLength(3) // deduped cards from the 3 healthy campaigns
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(empty)
  })
})

describe('alfamart config entry', () => {
  it('registers the catalog/browser shape with its proxy slot', () => {
    const config = storeBySlug(loadConfig(), 'alfamart')!
    expect(config).toMatchObject({
      slug: 'alfamart',
      name: 'Alfamart',
      kind: 'catalog',
      strategy: 'browser',
      region: 'jakarta',
      website: 'https://alfagift.id/',
      maxPages: 40,
      proxyEnv: 'ALFAMART_PROXY_URL',
    })
  })
})
