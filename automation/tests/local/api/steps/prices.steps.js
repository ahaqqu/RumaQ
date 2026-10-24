import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/prices.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const RICE_KEY = 'beras--pandan-wangi--5-kg'

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
})
