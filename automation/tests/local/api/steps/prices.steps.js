import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import {
  OIL_KEY,
  RICE_KEY,
  SUGAR_KEY,
  FLOUR_KEY,
  ALFAMART_PROMO_PAGE,
  catalogSnapshot,
  priceSnapshot,
  promoSnapshot,
  bulkCatalogueSnapshot,
} from '../../../support/price-fixtures.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/prices.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  // jest-cucumber matches step definitions to feature-file steps
  // positionally — each occurrence in the scenario needs its own
  // registration, even when the text repeats. This trio is the one
  // sorted-page block, registered once per occurrence.
  function registerSortedPageSteps({ when, then, and }) {
    when(/I request the price list sorted by "(\w+)"/, async (sort) => {
      await ctx.sendRequest('GET', `/api/prices?sort=${sort}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and(/the product names should appear in order "(.+)"/, (expected) => {
      // The feature file names products by first word ("Minyak", "Gula", …);
      // rows repeat per source, so dedupe and compare the first-word
      // sequence of the ordered page.
      const names = [...new Set(ctx.responseBody.items.map((i) => i.name))]
      expect(names.map((name) => name.split(' ')[0])).toEqual(expected.split(','))
      expect(ctx.responseBody.truncated).toBe(false)
    })
  }

  async function pushSnapshot(bearer = INGEST_SECRET) {
    ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(priceSnapshot()),
    })
    try {
      ctx.responseBody = await ctx.response.json()
    } catch {
      ctx.responseBody = null
    }
  }

  async function requestStatus(bearer = INGEST_SECRET) {
    ctx.response = await fetch(`${ctx.baseUrl}/api/internal/prices/status`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    try {
      ctx.responseBody = await ctx.response.json()
    } catch {
      ctx.responseBody = null
    }
  }

  function runReport() {
    return {
      schemaVersion: 1,
      runStartedAt: '2026-10-24T23:00:05Z',
      finishedAt: '2026-10-24T23:04:11Z',
      exitCode: 0,
      status: 'success',
      stage: 'done',
      perStore: {
        superindo: {
          pagesFound: 2,
          newImages: 1,
          existingImages: 1,
          skipped: 0,
          itemsExtracted: 7,
          itemsRejected: 0,
        },
      },
      match: { exact: 5, embedding: 1, ai: 0, solo: 1, reviewItems: 0, embeddingsDegraded: false },
      publish: { mode: 'published', accepted: 3, skipped: 0 },
      error: null,
    }
  }

  async function pushRunReport(bearer = INGEST_SECRET) {
    ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(runReport()),
    })
    try {
      ctx.responseBody = await ctx.response.json()
    } catch {
      ctx.responseBody = null
    }
  }

  test('Ingest rejects pushes without a valid bearer token', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the scraper pushes a price snapshot with a wrong bearer token', async () => {
      await pushSnapshot('wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Ingest accepts a valid daily snapshot', ({ given, when, then, and }) => {
    given('the API is running', () => {})

    when('the scraper pushes a valid price snapshot', async () => {
      await pushSnapshot()
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the ingest should report accepted items', () => {
      expect(ctx.responseBody).toMatchObject({
        accepted: 4,
        productsCreated: 3,
        observationsUpserted: 4,
        skipped: 0,
      })
    })
  })

  test('Re-pushing the same snapshot is idempotent', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    when('the scraper pushes the same price snapshot again', async () => {
      await pushSnapshot()
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the price explorer should still list one observation per product and store', async () => {
      await ctx.authenticate()
      await ctx.sendRequest('GET', '/api/prices')
      ctx.expectStatus(200)
      const oilRows = ctx.responseBody.items.filter((i) => i.product_key === OIL_KEY)
      expect(oilRows).toHaveLength(2)
      expect(ctx.responseBody.total).toBe(4)
    })
  })

  test('Price explorer requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Price explorer lists latest observations with confidence flags', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have prices array', () => {
      expect(Array.isArray(ctx.responseBody?.items)).toBe(true)
      expect(ctx.responseBody.items.length).toBeGreaterThan(0)
    })

    and('the prices should include the ingested products with confidence flags', () => {
      const oilRows = ctx.responseBody.items.filter((i) => i.product_key === OIL_KEY)
      expect(oilRows).toHaveLength(2)
      for (const row of oilRows) {
        expect(row).toHaveProperty('low_confidence')
        expect(row.low_confidence).toBe(false)
      }
      const rice = ctx.responseBody.items.find((i) => i.product_key === RICE_KEY)
      expect(rice).toBeDefined()
      expect(rice.low_confidence).toBe(true)
    })
  })

  test('Price detail returns current prices and history', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the price detail for the ingested product', async () => {
      await ctx.sendRequest('GET', `/api/prices/${OIL_KEY}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the product should have current prices from both stores', () => {
      expect(ctx.responseBody.product.product_key).toBe(OIL_KEY)
      expect(ctx.responseBody.current).toHaveLength(2)
      // cheapest store first
      expect(ctx.responseBody.current[0].price).toBe(21500)
      expect(ctx.responseBody.current[0].source_slug).toBe('lotte-mart')
    })

    and('the product should have history entries', () => {
      expect(Array.isArray(ctx.responseBody.history)).toBe(true)
      expect(ctx.responseBody.history.length).toBeGreaterThanOrEqual(2)
    })
  })

  test("A catalog store's promos land without the OCR flow (issue #322)", ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a catalog snapshot has been pushed', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/prices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INGEST_SECRET}`,
        },
        body: JSON.stringify(catalogSnapshot()),
      })
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the price detail for the alfamart promo', async () => {
      await ctx.sendRequest('GET', '/api/prices/minyak-goreng--filma--2-l')
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the alfamart discount should claim discount_pct at the promo price', () => {
      // The rendered-DOM price IS the customer price: promo_type discount_pct
      // with the effective unit price equal to the listed price (astro
      // convention), label parsed by the shared parsePromo pattern.
      expect(ctx.responseBody.product.product_key).toBe('minyak-goreng--filma--2-l')
      const row = ctx.responseBody.current[0]
      expect(row.source_slug).toBe('alfamart')
      expect(row.price).toBe(43700)
      expect(row.promo_type).toBe('discount_pct')
      expect(row.promo_label).toBe('Diskon 5%')
    })

    and('the alfamart campaign page should appear in no brochure group', async () => {
      // Catalog items carry the campaign URL — not a servable
      // /api/brochures/ object — so the brochures view (the OCR-flow surface)
      // must have no group for the store at all.
      await ctx.sendRequest('GET', '/api/prices/brochures')
      ctx.expectStatus(200)
      for (const group of ctx.responseBody.groups) {
        expect(group.source_slug).not.toBe('alfamart')
        expect(group.brochure_url).not.toBe(ALFAMART_PROMO_PAGE)
      }
    })
  })

  test('Freshness status requires the ingest bearer secret', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the scraper requests the price freshness status with a wrong bearer token', async () => {
      await requestStatus('wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Freshness status reports the latest observation', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    when('the scraper requests the price freshness status', async () => {
      await requestStatus()
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the status should report the latest observation date and count', () => {
      expect(ctx.responseBody).toMatchObject({
        latestObservedDate: '2026-10-24',
        observationCount: 4,
      })
    })
  })

  test('Run report requires the ingest bearer secret', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the scraper pushes a run report with a wrong bearer token', async () => {
      await pushRunReport('wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Run report is recorded and visible to an admin', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    when('the scraper pushes a run report', async () => {
      await pushRunReport()
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the admin sees the run in the monitor feed', async () => {
      await ctx.authenticate()
      await ctx.sendRequest('GET', '/api/admin/price-runs')
      ctx.expectStatus(200)
      expect(ctx.responseBody.runs).toHaveLength(1)
      expect(ctx.responseBody.runs[0].status).toBe('success')
      expect(ctx.responseBody.runs[0].stage).toBe('done')
      expect(ctx.responseBody.runs[0].perStore.superindo.itemsExtracted).toBe(7)
      expect(ctx.responseBody.lastSuccessAt).toBe('2026-10-24T23:00:05Z')
    })
  })

  async function pushJsonSnapshot(snapshot, bearer = INGEST_SECRET) {
    ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(snapshot),
    })
    try {
      ctx.responseBody = await ctx.response.json()
    } catch {
      ctx.responseBody = null
    }
  }

  test('Price explorer sorts by cheapest, savings, expiry, and name', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushJsonSnapshot(priceSnapshot())
      ctx.expectStatus(200)
    })

    and('a promo snapshot has been pushed', async () => {
      await pushJsonSnapshot(promoSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    registerSortedPageSteps({ when, then, and })

    and('the gula item should carry effective-price aggregates', () => {
      const gula = ctx.responseBody.items.find((i) => i.product_key === SUGAR_KEY)
      expect(gula).toBeDefined()
      // Effective-price basis: Superindo wins on 36000 payable despite the
      // higher 41000 tag (Lotte's tag 40000 beats it on raw price only).
      expect(gula.price_min).toBe(36000)
      expect(gula.price_max).toBe(38000)
      expect(gula.savings_pct).toBe(5.3)
      expect(gula.cheapest_source_slug).toBe('superindo')
      expect(gula.cheapest_valid_until).toBe('2026-10-30')
    })

    registerSortedPageSteps({ when, then, and })

    registerSortedPageSteps({ when, then, and })

    registerSortedPageSteps({ when, then, and })
  })

  test('Price explorer applies LIMIT after aggregation', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a bulk catalogue of 205 single-source products has been pushed', async () => {
      await pushJsonSnapshot(bulkCatalogueSnapshot(205))
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I request the price list sorted by "(\w+)"/, async (sort) => {
      await ctx.sendRequest('GET', `/api/prices?sort=${sort}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the page should hold the 201st product and flag truncation', () => {
      const body = ctx.responseBody
      // LIMIT 201 after aggregation: every returned product is complete and
      // the 201st product's existence is what makes truncated precise.
      expect(body.truncated).toBe(true)
      expect(body.total).toBe(201)
      const keys = new Set(body.items.map((i) => i.product_key))
      expect(keys.size).toBe(201)
      for (const item of body.items) {
        expect(item.product_key).toMatch(/^bulk-item-/)
      }
    })

    when(/I search the sorted price list for "(.+)"/, async (term) => {
      await ctx.sendRequest('GET', `/api/prices?sort=savings&q=${encodeURIComponent(term)}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the page should hold 11 complete products without truncation', () => {
      const body = ctx.responseBody
      expect(body.truncated).toBe(false)
      // "Item 3" matches Bulk Item 3 and Bulk Item 30–39 → 11 products, all
      // complete (one row each), no truncation under the cap.
      expect(body.total).toBe(11)
      const keys = new Set(body.items.map((i) => i.product_key))
      expect(keys.size).toBe(11)
    })
  })

  test('Price detail orders current offers by the effective price', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushJsonSnapshot(priceSnapshot())
      ctx.expectStatus(200)
    })

    and('a promo snapshot has been pushed', async () => {
      await pushJsonSnapshot(promoSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the price detail for the promo product', async () => {
      await ctx.sendRequest('GET', `/api/prices/${SUGAR_KEY}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the first current offer should be the effective-price cheapest store', () => {
      const current = ctx.responseBody.current
      expect(current).toHaveLength(2)
      // Effective-price ordering with a raw-price disagreement: Superindo
      // (payable 36000) first even though Lotte's tag price is lower.
      expect(current[0].source_slug).toBe('superindo')
      expect(current[0].price).toBe(41000)
      expect(current[0].effective_unit_price).toBe(36000)
      expect(current[1].source_slug).toBe('lotte-mart')
      expect(current[1].price).toBe(40000)
      expect(current[1].effective_unit_price).toBe(38000)
    })
  })

  test('Price freshness meta requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushJsonSnapshot(priceSnapshot())
      ctx.expectStatus(200)
    })

    when(/I send an unauthenticated GET request to (\S+)/, async (path) => {
      const saved = ctx.headers
      ctx.headers = { ...ctx.headers } // no Cookie → unauthenticated
      delete ctx.headers.Cookie
      await ctx.sendRequest('GET', path)
      ctx.headers = saved
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Price freshness meta reports the latest scrape', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushJsonSnapshot(priceSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the price freshness meta', async () => {
      await ctx.sendRequest('GET', '/api/prices/meta')
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the meta should report the latest scrape time and count', () => {
      expect(ctx.responseBody).toEqual({
        latestObservedDate: '2026-10-24',
        latestScrapedAt: '2026-10-24T23:00:05Z',
        observationCount: 4,
      })
    })

    and('the meta response should be private and no-cache', () => {
      expect(ctx.response.headers.get('Cache-Control')).toBe('private, no-cache')
    })
  })

  // --- Promos catalog (issue #292) ---

  // Mirrors the SQL CASE in getPromoCatalog: the closed 5-value enum keeps its
  // group; anything else (unknown future enum values, NULL type with a label)
  // lands in 'other'.
  const KNOWN_PROMO_TYPES = [
    'discount_pct',
    'discount_fixed',
    'get_free',
    'bundle_buy',
    'multi_price',
  ]

  function promoGroupOf(item) {
    if (KNOWN_PROMO_TYPES.includes(item.promo_type)) return item.promo_type
    return 'other'
  }

  function hasPromoEvidence(item) {
    return item.promo_type != null || (item.promo_label != null && item.promo_label !== '')
  }

  test('Promos catalog requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    when(/I send an unauthenticated GET request to (\S+)/, async (path) => {
      const saved = ctx.headers
      ctx.headers = { ...ctx.headers } // no Cookie → unauthenticated
      delete ctx.headers.Cookie
      await ctx.sendRequest('GET', path)
      ctx.headers = saved
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Promos catalog groups current observations with explorer count parity', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a valid price snapshot has been pushed', async () => {
      await pushSnapshot()
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the promo catalog', async () => {
      await ctx.sendRequest('GET', '/api/prices/promos')
      // Stash the catalog body: the parity step later fires an explorer
      // request that overwrites ctx.responseBody.
      ctx.promoBody = ctx.responseBody
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the promo catalog response should be private and no-cache', () => {
      expect(ctx.response.headers.get('Cache-Control')).toBe('private, no-cache')
    })

    and(/the promo groups should appear in order "(.+)"/, (expected) => {
      // Empty groups are omitted; 'other' sorts last by construction.
      expect(ctx.promoBody.types.map((g) => g.promo_type)).toEqual(expected.split(','))
    })

    and('the promo counts should match the explorer per type', async () => {
      const promos = ctx.promoBody
      await ctx.sendRequest('GET', '/api/prices')
      const explorerRows = ctx.responseBody.items

      // The explorer's promo-evidence rows grouped exactly like the SQL CASE.
      const explorerGroups = new Map()
      for (const row of explorerRows) {
        if (!hasPromoEvidence(row)) continue
        const key = promoGroupOf(row)
        if (!explorerGroups.has(key)) explorerGroups.set(key, new Set())
        explorerGroups.get(key).add(row.product_key)
      }

      // Layer 1: each catalog group's product_count equals the distinct
      // products the explorer shows for that type.
      for (const group of promos.types) {
        expect(group.product_count).toBe(explorerGroups.get(group.promo_type)?.size ?? 0)
      }
      // Layer 2: no explorer group is missing from the catalog.
      expect(promos.types.map((g) => g.promo_type).sort()).toEqual(
        [...explorerGroups.keys()].sort()
      )
      // Layer 3: group×store cells reconcile 1:1 with the evidence rows
      // (latest observation per (product, source) ⇒ one row per cell).
      const perStoreSum = promos.types.reduce(
        (sum, g) => sum + Object.values(g.stores).reduce((a, b) => a + b, 0),
        0
      )
      const evidenceRows = explorerRows.filter(hasPromoEvidence).length
      expect(perStoreSum).toBe(evidenceRows)
      // Layer 4: the view total is the distinct evidence products.
      expect(promos.total).toBe(
        new Set(explorerRows.filter(hasPromoEvidence).map((r) => r.product_key)).size
      )
    })

    and('the Other group should hold the label-only product', () => {
      const other = ctx.promoBody.types.find((g) => g.promo_type === 'other')
      expect(other).toBeDefined()
      expect(other.example_products.map((p) => p.product_key)).toContain(FLOUR_KEY)
      // The rice row (get_free) never leaks into Other.
      const getFree = ctx.promoBody.types.find((g) => g.promo_type === 'get_free')
      expect(getFree.example_products.map((p) => p.product_key)).toContain(RICE_KEY)
    })

    and('the promo catalog should not double-count products across stores', () => {
      const discountPct = ctx.promoBody.types.find((g) => g.promo_type === 'discount_pct')
      // Oil sits on promo at two stores: 2 per-source cells but 1 distinct
      // product — product_count must come from the totals statement.
      expect(discountPct.product_count).toBe(1)
      expect(discountPct.stores).toEqual({ 'lotte-mart': 1, superindo: 1 })
      // The example row is the cheapest offer (Lotte 21500 < Superindo 23000).
      expect(discountPct.example_products).toHaveLength(1)
      expect(discountPct.example_products[0]).toMatchObject({
        product_key: OIL_KEY,
        source_slug: 'lotte-mart',
        price: 21500,
      })
    })
  })

  test('Promos catalog is empty without promo observations', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a bulk catalogue of 3 single-source products has been pushed', async () => {
      await pushJsonSnapshot(bulkCatalogueSnapshot(3))
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the promo catalog', async () => {
      await ctx.sendRequest('GET', '/api/prices/promos')
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the promo catalog should have no groups', () => {
      expect(ctx.responseBody).toEqual({ types: [], total: 0 })
    })
  })
})
