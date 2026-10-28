import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/prices.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const RICE_KEY = 'beras--pandan-wangi--5-kg'
const SUGAR_KEY = 'gula-pasir--gulaku--1-kg'
const COFFEE_KEY = 'kopi--kapal-api--165-g'

function priceSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'lotte-mart',
        price: 21500,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'superindo',
        price: 23000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: RICE_KEY,
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'superindo',
        price: 72000,
        matchMethod: 'embedding',
        matchConfidence: 0.7,
      },
    ],
  }
}

// Second snapshot one day later: adds two products where raw-price order and
// effective-price order disagree. Gula Pasir: the raw-cheapest store is
// Lotte (40000 < 41000) but the effective-cheapest is Superindo (36000 < 38000)
// — the exact case the sort and grounding fix must get right.
function promoSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-25T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'lotte-mart',
        price: 40000,
        effectiveUnitPrice: 38000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 5%',
        validFrom: '2026-10-25',
        validUntil: '2026-11-05',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'superindo',
        price: 41000,
        effectiveUnitPrice: 36000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 12%',
        validFrom: '2026-10-25',
        validUntil: '2026-10-30',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: COFFEE_KEY,
        name: 'Kopi Kapal Api 165 g',
        brand: 'Kapal Api',
        unit: '165 g',
        storeSlug: 'lotte-mart',
        price: 30000,
        validUntil: '2026-10-29',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
    ],
  }
}

function bulkCatalogueSnapshot(count) {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-26T23:00:05Z',
    stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
    items: Array.from({ length: count }, (_, i) => ({
      productKey: `bulk-item-${i}--acme--1-pcs`,
      name: `Bulk Item ${i}`,
      brand: 'Acme',
      unit: '1 pcs',
      storeSlug: 'lotte-mart',
      price: 1000 + i * 7,
      matchMethod: 'exact',
      matchConfidence: 1.0,
    })),
  }
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

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
        accepted: 3,
        productsCreated: 2,
        observationsUpserted: 3,
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
      expect(ctx.responseBody.total).toBe(3)
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
        observationCount: 3,
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

    // jest-cucumber matches step definitions to feature-file steps
    // positionally — each occurrence in the scenario needs its own
    // registration, even when the text repeats.
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
        observationCount: 3,
      })
    })

    and('the meta response should be private and no-cache', () => {
      expect(ctx.response.headers.get('Cache-Control')).toBe('private, no-cache')
    })
  })
})
