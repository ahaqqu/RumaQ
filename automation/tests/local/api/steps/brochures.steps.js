import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import {
  BROCHURE_PAGE_LOTTE,
  BROCHURE_PALINGMURAH_INDOMARET,
  brochureSnapshot,
  priceSnapshot,
} from '../../../support/price-fixtures.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/brochures.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
const UPLOAD_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3])

// The sweep's grace is 14 days from the key date — a 2025 key is past it at
// any realistic test clock; a 2099 key never is. No clock mocking needed.
const OLD_UNREFERENCED_KEY = 'lotte-mart/20250101/old-unreferenced_1a2b3c4d.jpg'
const OLD_REFERENCED_KEY = 'lotte-mart/20250101/old-referenced_2b3c4d5e.jpg'
const FRESH_UNREFERENCED_KEY = 'superindo/20990101/fresh_3c4d5e6f.jpg'

// Issue #630: more rows than the old ≤5 example cap. One page, seven
// products, all current.
const SEVEN_PAGE_KEY = 'lotte-mart/20261026/page_1_seven_5f6a7b8c.jpg'
const SEVEN_PAGE_URL = `/api/brochures/${SEVEN_PAGE_KEY}`

function sevenProductSnapshot() {
  return {
    schemaVersion: 2,
    scrapedAt: '2026-10-26T23:00:05Z',
    stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
    items: Array.from({ length: 7 }, (_, index) => ({
      productKey: `bulk-${index}--merek--1-pcs`,
      rawName: `Bulk ${index} 1 pcs`,
      rawBrand: 'Merek',
      rawUnit: '1 pcs',
      storeSlug: 'lotte-mart',
      price: 10000 + index,
      matchMethod: 'exact',
      matchConfidence: 1.0,
      brochureUrl: SEVEN_PAGE_URL,
    })),
  }
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  async function putBrochure(key, bearer = INGEST_SECRET) {
    return fetch(`${ctx.baseUrl}/api/internal/brochures/${key}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        Authorization: `Bearer ${bearer}`,
      },
      body: UPLOAD_BYTES,
    })
  }

  async function pushSnapshot(snapshot) {
    ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INGEST_SECRET}`,
      },
      body: JSON.stringify(snapshot),
    })
    try {
      ctx.responseBody = await ctx.response.json()
    } catch {
      ctx.responseBody = null
    }
  }

  test('Brochure upload requires the ingest bearer secret', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the scraper uploads a brochure image with a wrong bearer token', async () => {
      ctx.response = await putBrochure('lotte-mart/20261024/page_1_2ad1c95b.jpg', 'wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Uploaded brochure bytes round-trip through the authenticated proxy', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a brochure image has been uploaded for the fixture key', async () => {
      const res = await putBrochure('lotte-mart/20261024/page_1_2ad1c95b.jpg')
      expect(res.status).toBe(200)
    })

    and('a brochure snapshot has been pushed', async () => {
      await pushSnapshot(brochureSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the brochure image for the fixture key', async () => {
      // Raw fetch — the proxy body is bytes, and sendRequest's json() read
      // would consume it before the round-trip assertion.
      ctx.response = await fetch(
        `${ctx.baseUrl}/api/brochures/lotte-mart/20261024/page_1_2ad1c95b.jpg`,
        { headers: ctx.headers }
      )
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and(
      'the image body should round-trip with the stored content type and private day caching',
      async () => {
        expect(ctx.response.headers.get('Content-Type')).toBe('image/png')
        expect(ctx.response.headers.get('Cache-Control')).toBe('private, max-age=86400')
        const body = new Uint8Array(await ctx.response.arrayBuffer())
        expect(Buffer.from(body).equals(Buffer.from(UPLOAD_BYTES))).toBe(true)
      }
    )
  })

  test('Serving a brochure requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a brochure image has been uploaded for the fixture key', async () => {
      const res = await putBrochure('lotte-mart/20261024/page_1_2ad1c95b.jpg')
      expect(res.status).toBe(200)
    })

    when('I request the brochure image without a session', async () => {
      const saved = ctx.headers
      ctx.headers = { ...ctx.headers }
      delete ctx.headers.Cookie
      await ctx.sendRequest('GET', '/api/brochures/lotte-mart/20261024/page_1_2ad1c95b.jpg')
      ctx.headers = saved
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('An unknown brochure key answers 404', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request a brochure image that was never uploaded', async () => {
      await ctx.sendRequest('GET', '/api/brochures/lotte-mart/20261024/never_uploaded.jpg')
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('Brochures listing requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a brochure snapshot has been pushed', async () => {
      await pushSnapshot(brochureSnapshot())
      ctx.expectStatus(200)
    })

    when('I request the brochures catalog without a session', async () => {
      const saved = ctx.headers
      ctx.headers = { ...ctx.headers }
      delete ctx.headers.Cookie
      await ctx.sendRequest('GET', '/api/prices/brochures')
      ctx.headers = saved
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Brochures catalog groups current observations with explorer count parity', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a brochure snapshot has been pushed', async () => {
      await pushSnapshot(brochureSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I request the brochures catalog', async () => {
      await ctx.sendRequest('GET', '/api/prices/brochures')
      // Stash the catalog body: the parity step later fires an explorer
      // request that overwrites ctx.responseBody.
      ctx.brochureBody = ctx.responseBody
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the brochure groups should appear in store-then-date order', () => {
      const groups = ctx.brochureBody.groups
      // Store name asc, then date desc: Indomaret's rendered-PDF page
      // (issue #322) groups exactly like the OCR stores', Lotte's page
      // before Superindo's.
      expect(groups.map((g) => g.source_slug)).toEqual(['indomaret', 'lotte-mart', 'superindo'])
      for (const group of groups) {
        expect(group.brochure_url).toMatch(/^\/api\/brochures\//)
        expect(group.observed_date).toBe('2026-10-26')
      }
      // OCR-flow parity: the indomaret group's URL is the rendered PNG page
      // object key, same servable shape the OCR stores emit.
      const indomaret = groups.find((g) => g.source_slug === 'indomaret')
      expect(indomaret.brochure_url).toBe(BROCHURE_PALINGMURAH_INDOMARET)
      expect(indomaret.brochure_url.endsWith('.png')).toBe(true)
    })

    and('the brochure counts should match the explorer per brochure page', async () => {
      // The explorer's unfiltered rows grouped by (source, brochure_url) is
      // the parity base: the snapshot carries one row per cell, so the card
      // count equals the explorer's per-page product count (PM AC 4).
      await ctx.sendRequest('GET', '/api/prices')
      const explorerRows = ctx.responseBody.items
      const perPage = new Map()
      for (const row of explorerRows) {
        if (!row.brochure_url) continue
        const key = `${row.source_slug}|${row.brochure_url}`
        if (!perPage.has(key)) perPage.set(key, new Set())
        perPage.get(key).add(row.product_key)
      }
      for (const group of ctx.brochureBody.groups) {
        const key = `${group.source_slug}|${group.brochure_url}`
        expect(group.product_count).toBe(perPage.get(key)?.size ?? 0)
        // The card's products are exactly the explorer's rows for the page.
        expect(group.example_products.length).toBeGreaterThan(0)
        for (const example of group.example_products) {
          expect(perPage.get(key)?.has(example.product_key)).toBe(true)
        }
      }
      // Lotte's shared page holds two distinct products (susu + roti), and
      // the roti row's LEGACY url is excluded — see the next step.
      const lotte = ctx.brochureBody.groups.find((g) => g.source_slug === 'lotte-mart')
      expect(lotte.product_count).toBe(1)
    })

    and('the legacy retailer-page URL should appear in no group', () => {
      // The roti item's brochure_url is the retailer listing page — the
      // servable-shape predicate excludes it from every group, so no group
      // may carry a non-/api/brochures/ url and the roti product must appear
      // in no example row.
      for (const group of ctx.brochureBody.groups) {
        expect(group.brochure_url.startsWith('/api/brochures/')).toBe(true)
        for (const example of group.example_products) {
          expect(example.product_key).not.toBe('roti-tawar--sari-roti--1-bungkus')
        }
      }
    })
  })

  test('Brochure product list requires authentication', ({ given, and, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a brochure snapshot has been pushed', async () => {
      await pushSnapshot(brochureSnapshot())
      ctx.expectStatus(200)
    })

    when('I request the brochure products list without a session', async () => {
      const saved = ctx.headers
      ctx.headers = { ...ctx.headers }
      delete ctx.headers.Cookie
      await ctx.sendRequest(
        'GET',
        `/api/prices/brochures/products?url=${encodeURIComponent(BROCHURE_PAGE_LOTTE)}`
      )
      ctx.headers = saved
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Brochure product list returns every current product with an exact total', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('a seven-product brochure snapshot has been pushed', async () => {
      await pushSnapshot(sevenProductSnapshot())
      ctx.expectStatus(200)
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(
      'I request the brochure products list for the pushed page with limit 5 and offset 0',
      async () => {
        await ctx.sendRequest(
          'GET',
          `/api/prices/brochures/products?url=${encodeURIComponent(SEVEN_PAGE_URL)}&limit=5&offset=0`
        )
        // Stash before the offset-5 request overwrites the body.
        ctx.brochureProductsBody = ctx.responseBody
      }
    )

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the brochure products page should carry 5 items with an exact total of 7', () => {
      expect(ctx.brochureProductsBody.total).toBe(7)
      expect(ctx.brochureProductsBody.items).toHaveLength(5)
      expect(ctx.brochureProductsBody.items.map((item) => item.name)).toEqual([
        'Bulk 0 1 pcs',
        'Bulk 1 1 pcs',
        'Bulk 2 1 pcs',
        'Bulk 3 1 pcs',
        'Bulk 4 1 pcs',
      ])
      // The QA payload carries the full provenance, not just the example
      // fields the catalog ships.
      expect(ctx.brochureProductsBody.items[0]).toMatchObject({
        product_key: 'bulk-0--merek--1-pcs',
        source_slug: 'lotte-mart',
        source_name: 'Lotte Mart',
        brochure_url: SEVEN_PAGE_URL,
        observed_date: '2026-10-26',
        match_method: 'exact',
        match_confidence: 1,
      })
    })

    when(
      'I request the brochure products list for the pushed page with limit 5 and offset 5',
      async () => {
        await ctx.sendRequest(
          'GET',
          `/api/prices/brochures/products?url=${encodeURIComponent(SEVEN_PAGE_URL)}&limit=5&offset=5`
        )
      }
    )

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the second brochure products page should carry the remaining 2 items', () => {
      expect(ctx.responseBody.total).toBe(7)
      expect(ctx.responseBody.items.map((item) => item.name)).toEqual([
        'Bulk 5 1 pcs',
        'Bulk 6 1 pcs',
      ])
    })
  })

  test('Retention sweep deletes unreferenced past-grace objects and keeps the rest', ({
    given,
    and,
    when,
    then,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and(
      'brochure images exist with an old referenced key, an old unreferenced key, and a fresh unreferenced key',
      async () => {
        for (const key of [OLD_REFERENCED_KEY, OLD_UNREFERENCED_KEY, FRESH_UNREFERENCED_KEY]) {
          const res = await putBrochure(key)
          expect(res.status).toBe(200)
        }
      }
    )

    when('a brochure snapshot referencing the old referenced key has been pushed', async () => {
      // The ingest POST the snapshot rides triggers the sweep with the real
      // clock: the referenced old key survives at any age, the unreferenced
      // old key is past the 14-day grace, and the fresh key is not.
      const snapshot = priceSnapshot()
      snapshot.items = snapshot.items.map((item) => ({
        ...item,
        brochureUrl:
          item.storeSlug === 'lotte-mart'
            ? `/api/brochures/${OLD_REFERENCED_KEY}`
            : item.brochureUrl,
      }))
      await pushSnapshot(snapshot)
    })

    then(
      'the ingest should succeed and the sweep should keep the referenced and fresh objects and delete the old unreferenced one',
      async () => {
        ctx.expectStatus(200)
        await ctx.authenticate()
        const head = async (key) => {
          const res = await fetch(`${ctx.baseUrl}/api/brochures/${key}`, {
            headers: { Cookie: ctx.headers.Cookie },
          })
          // Drain the body so the connection is reusable across checks.
          await res.arrayBuffer().catch(() => {})
          return res.status
        }
        expect(await head(OLD_REFERENCED_KEY)).toBe(200)
        expect(await head(FRESH_UNREFERENCED_KEY)).toBe(200)
        expect(await head(OLD_UNREFERENCED_KEY)).toBe(404)
      }
    )
  })
})
