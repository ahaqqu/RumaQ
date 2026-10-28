import { describe, it, expect } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import {
  BROCHURE_MAX_BYTES,
  BROCHURE_URL_PREFIX,
  getBrochureCatalog,
  parseBrochureKey,
  sweepUnreferencedBrochures,
} from '../lib/brochures.js'
import { LATEST_OBSERVATION_PREDICATE } from '../lib/prices.js'
import { createBrochuresStub } from './support/env.js'

type FakeRow = Record<string, unknown>
type FakeStatement = { sql: string; params: unknown[] }
type FakeSelect = { match: RegExp; rows: FakeRow[] }

// Compact fake DB (ingest.test.ts pattern) — resolves matched SELECTs from
// canned rows, records every statement for SQL assertions.
function createFakeDb(selects: FakeSelect[] = []) {
  const prepareCalls: Array<{ sql: string; params: unknown[] }> = []
  const resolve = (sql: string): FakeRow[] => {
    const hit = selects.find((s) => s.match.test(sql))
    return hit ? hit.rows : []
  }
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params
          return stmt
        },
        async all() {
          prepareCalls.push({ sql, params: stmt.params })
          return { results: resolve(sql) }
        },
        async first() {
          prepareCalls.push({ sql, params: stmt.params })
          const rows = resolve(sql)
          return rows.length > 0 ? rows[0] : null
        },
        async run() {
          prepareCalls.push({ sql, params: stmt.params })
          return { success: true }
        },
      }
      return stmt
    },
    async batch(statements: FakeStatement[]) {
      for (const stmt of statements) prepareCalls.push({ sql: stmt.sql, params: stmt.params ?? [] })
      return statements.map((stmt) => {
        if (stmt.sql.includes('-- brochures: groups')) {
          return { results: resolves.brochureGroups, success: true }
        }
        if (stmt.sql.includes('-- brochures: examples')) {
          return { results: resolves.brochureExamples, success: true }
        }
        return { success: true }
      })
    },
  }
  const resolves: { brochureGroups: FakeRow[]; brochureExamples: FakeRow[] } = {
    brochureGroups: [],
    brochureExamples: [],
  }
  return { db: db as unknown as D1Database, prepareCalls, resolves }
}

function createEnv(
  db: D1Database,
  opts: {
    authenticated?: boolean
    secret?: string | null
    // Unknown: the in-memory stub is structurally close enough for the fake
    // routes; real R2 semantics live in the Miniflare automation harness.
    brochures?: unknown | null
  } = {}
) {
  return {
    DB: db,
    RECEIPTS: {},
    BROCHURES: (opts.brochures === undefined
      ? createBrochuresStub()
      : opts.brochures) as unknown as R2Bucket,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: opts.authenticated === false ? undefined : { userId: 'u1', householdId: 'h1' },
    TEST_MODE: 'true',
    HAQITA_INGEST_SECRET: opts.secret === undefined ? 'test-ingest-secret' : opts.secret,
  }
}

const AUTH = { Authorization: 'Bearer test-ingest-secret' }

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])

// --- Key validation (shared by PUT and the GET proxy) ---

describe('parseBrochureKey', () => {
  it('accepts a known store, calendar date, and safe filename', () => {
    expect(parseBrochureKey('lotte-mart', '20261029', 'page_1_2ad1c95b.jpg')).toBe(
      'lotte-mart/20261029/page_1_2ad1c95b.jpg'
    )
  })

  it('accepts the parentheses the real store fixtures carry in filenames', () => {
    expect(
      parseBrochureKey('superindo', '20261029', 'HEMAT_E_20_(1)_DKI_2ad1c95b.jpg')
    ).not.toBeNull()
  })

  it('rejects unknown store slugs, bad dates, and unsafe filenames', () => {
    expect(parseBrochureKey('unknown-store', '20261029', 'page.jpg')).toBeNull()
    expect(parseBrochureKey('lotte-mart', '2026-10-29', 'page.jpg')).toBeNull()
    expect(parseBrochureKey('lotte-mart', '20261029', 'page.jpg')).not.toBeNull()
    expect(parseBrochureKey('lotte-mart', '20261399', 'page.jpg')).toBeNull() // month 13
    expect(parseBrochureKey('lotte-mart', '202610299', 'page.jpg')).toBeNull() // 9 digits
    expect(parseBrochureKey('lotte-mart', '20261029', '../state.json')).toBeNull()
    expect(parseBrochureKey('lotte-mart', '20261029', 'a/b.jpg')).toBeNull()
    expect(parseBrochureKey('lotte-mart', '20261029', '..')).toBeNull()
    expect(parseBrochureKey('lotte-mart', '20261029', `${'x'.repeat(201)}.jpg`)).toBeNull()
  })
})

// --- PUT /api/internal/brochures/:storeSlug/:date/:file ---

describe('PUT /api/internal/brochures', () => {
  it('requires the ingest bearer secret', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db, { authenticated: false })
    const noHeader = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page.jpg',
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: pngBytes },
      env
    )
    expect(noHeader.status).toBe(401)
    const wrongToken = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page.jpg',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer wrong' },
        body: pngBytes,
      },
      env
    )
    expect(wrongToken.status).toBe(401)
  })

  it('stores the bytes at the exact key with content-type and upload metadata', async () => {
    const { db } = createFakeDb()
    const brochures = createBrochuresStub()
    const res = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg', ...AUTH },
        body: pngBytes,
      },
      createEnv(db, { brochures })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const stored = brochures.objects.get('lotte-mart/20261029/page_1_2ad1c95b.jpg')
    expect(stored).toBeDefined()
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(pngBytes))).toBe(true)
    expect(stored!.httpMetadata).toEqual({ contentType: 'image/jpeg' })
    expect(stored!.customMetadata?.uploadedAt).toBeDefined()
  })

  it('answers 404 for a malformed key (bad slug, date, or filename)', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db)
    for (const path of [
      '/api/internal/brochures/unknown-store/20261029/page.jpg',
      '/api/internal/brochures/lotte-mart/2026-10-29/page.jpg',
      '/api/internal/brochures/lotte-mart/20261029/../secret',
    ]) {
      const res = await apiApp.request(
        path,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg', ...AUTH },
          body: pngBytes,
        },
        env
      )
      expect(res.status, path).toBe(404)
    }
  })

  it('answers 415 for a non-image content type', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page.jpg',
      { method: 'PUT', headers: { 'Content-Type': 'text/html', ...AUTH }, body: '<html>' },
      createEnv(db)
    )
    expect(res.status).toBe(415)
  })

  it('answers 413 over the size cap and for an empty body', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db)
    const empty = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page.jpg',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg', ...AUTH },
        body: new Uint8Array(0),
      },
      env
    )
    expect(empty.status).toBe(413)

    const oversized = new Uint8Array(BROCHURE_MAX_BYTES + 1)
    const tooBig = await apiApp.request(
      '/api/internal/brochures/lotte-mart/20261029/page.jpg',
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', ...AUTH }, body: oversized },
      env
    )
    expect(tooBig.status).toBe(413)
  })
})

// --- GET /api/brochures/:storeSlug/:date/:file ---

describe('GET /api/brochures', () => {
  const seededKey = 'lotte-mart/20261029/page_1_2ad1c95b.jpg'

  async function seededEnv() {
    const { db } = createFakeDb()
    const brochures = createBrochuresStub()
    await brochures.put(seededKey, pngBytes, { httpMetadata: { contentType: 'image/png' } })
    return { env: createEnv(db, { brochures }), brochures }
  }

  it('requires authentication (explicit in-chain propsAuthMiddleware)', async () => {
    const { env } = await seededEnv()
    const res = await apiApp.request(
      '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
      {},
      createEnv((env as { DB: D1Database }).DB, {
        authenticated: false,
        brochures: env.BROCHURES as R2Bucket,
      })
    )
    expect(res.status).toBe(401)
  })

  it('streams the stored bytes with the stored content type and a private day of caching', async () => {
    const { env } = await seededEnv()
    const res = await apiApp.request(
      '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
      {},
      env
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(body).equals(Buffer.from(pngBytes))).toBe(true)
  })

  it('answers 404 JSON for an unknown object and for a malformed segment', async () => {
    const { env } = await seededEnv()
    const missing = await apiApp.request(
      '/api/brochures/lotte-mart/20261029/other_page.jpg',
      {},
      env
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Brochure not found' })

    const malformed = await apiApp.request('/api/brochures/lotte-mart/bad-date/x.jpg', {}, env)
    expect(malformed.status).toBe(404)
  })
})

// --- GET /api/prices/brochures ---

describe('GET /api/prices/brochures', () => {
  const groupRow = (overrides: FakeRow = {}): FakeRow => ({
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
    observed_date: '2026-10-29',
    product_count: 2,
    ...overrides,
  })
  const exampleRow = (overrides: FakeRow = {}): FakeRow => ({
    brochure_url: '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
    product_key: 'beras--pandan-wangi--5-kg',
    name: 'Beras Pandan Wangi 5 kg',
    brand: 'Pandan Wangi',
    unit: '5 kg',
    price: 72000,
    effective_unit_price: null,
    ...overrides,
  })

  it('requires authentication', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/prices/brochures',
      {},
      createEnv(db, { authenticated: false })
    )
    expect(res.status).toBe(401)
  })

  it('answers the catalog instead of falling through to the detail route', async () => {
    const { db, prepareCalls, resolves } = createFakeDb()
    resolves.brochureGroups = [
      groupRow(),
      groupRow({
        source_slug: 'superindo',
        source_name: 'Superindo',
        brochure_url: '/api/brochures/superindo/20261029/koran_a.jpg',
        observed_date: '2026-10-28',
        product_count: 1,
      }),
    ]
    resolves.brochureExamples = [
      exampleRow(),
      exampleRow({
        product_key: 'beras--setramen--1-kg',
        name: 'Beras Setramen 1 kg',
        brochure_url: '/api/brochures/superindo/20261029/koran_a.jpg',
      }),
    ]
    const res = await apiApp.request('/api/prices/brochures', {}, createEnv(db))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')

    const body = (await res.json()) as {
      groups: Array<{
        source_slug: string
        brochure_url: string
        observed_date: string
        product_count: number
        example_products: Array<Record<string, unknown>>
      }>
    }
    // Fake rows arrive in API order — the handler preserves it (store asc,
    // date desc); examples zip by brochure_url.
    expect(body.groups.map((g) => g.source_slug)).toEqual(['lotte-mart', 'superindo'])
    expect(body.groups[0]!.product_count).toBe(2)
    expect(body.groups[0]!.example_products).toHaveLength(1)
    expect(body.groups[1]!.example_products[0]!.product_key).toBe('beras--setramen--1-kg')
    // "brochures" must never be treated as a productKey by the detail handler.
    expect(
      prepareCalls.some((call) => call.sql.includes('FROM price_products WHERE product_key'))
    ).toBe(false)
  })

  it('returns an empty catalog before any servable brochure rows', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request('/api/prices/brochures', {}, createEnv(db))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [] })
  })

  it('pins the shared predicate: explorer and brochure groups carry the identical base', async () => {
    // Layer-1 count-parity guarantee (#292's pattern): the identical
    // LATEST_OBSERVATION_PREDICATE string rides in both, plus the servable
    // LIKE clause excluding legacy retailer-page rows from every group.
    const { db, prepareCalls } = createFakeDb()
    await apiApp.request('/api/prices', {}, createEnv(db))
    await apiApp.request('/api/prices/brochures', {}, createEnv(db))

    const listCall = prepareCalls.find(
      (call) => call.sql.includes('FROM price_observations') && !call.sql.includes('-- brochures:')
    )
    const groupsCall = prepareCalls.find((call) => call.sql.includes('-- brochures: groups'))
    expect(listCall).toBeDefined()
    expect(groupsCall).toBeDefined()
    expect(listCall!.sql).toContain(LATEST_OBSERVATION_PREDICATE)
    expect(groupsCall!.sql).toContain(LATEST_OBSERVATION_PREDICATE)
    expect(groupsCall!.sql).toContain(`LIKE '${BROCHURE_URL_PREFIX}%'`)
    expect(groupsCall!.sql).toContain('GROUP BY s.id, o.brochure_url')
    expect(groupsCall!.sql).toContain(
      'ORDER BY s.name COLLATE NOCASE ASC, observed_date DESC, o.brochure_url ASC'
    )
  })

  it('structures the examples SQL: ≤5 per group, name-ordered, cheapest-offer basis', async () => {
    const { db, prepareCalls } = createFakeDb()
    await apiApp.request('/api/prices/brochures', {}, createEnv(db))

    const examplesCall = prepareCalls.find((call) => call.sql.includes('-- brochures: examples'))!
    expect(examplesCall.sql).toContain('WHERE group_rn <= 5')
    expect(examplesCall.sql).toContain('ORDER BY name COLLATE NOCASE ASC, product_key ASC')
    expect(examplesCall.sql).toContain('ORDER BY COALESCE(effective_unit_price, price) ASC')
    expect(examplesCall.sql).toContain('PARTITION BY brochure_url, product_key')
  })
})

// --- Retention sweep ---

describe('sweepUnreferencedBrochures', () => {
  const NOW = new Date('2026-10-29T00:00:00Z')

  function dbWithReferenced(urls: Array<string | null>) {
    return createFakeDb([
      {
        match: /SELECT DISTINCT o\.brochure_url/,
        rows: urls.map((brochure_url) => ({ brochure_url })),
      },
    ])
  }

  async function sweep(db: D1Database, brochures: ReturnType<typeof createBrochuresStub>) {
    return sweepUnreferencedBrochures(db, brochures as unknown as R2Bucket, { now: NOW })
  }

  it('deletes unreferenced objects past the grace period and keeps fresh ones', async () => {
    const { db } = dbWithReferenced([])
    const brochures = createBrochuresStub()
    await brochures.put('lotte-mart/20250101/old.jpg', pngBytes)
    await brochures.put('lotte-mart/20261020/recent.jpg', pngBytes) // 9 days old
    await brochures.put('lotte-mart/20261001/stale.jpg', pngBytes) // 28 days old

    const { deleted } = await sweep(db, brochures)
    expect(deleted).toBe(2)
    expect(brochures.objects.has('lotte-mart/20250101/old.jpg')).toBe(false)
    expect(brochures.objects.has('lotte-mart/20261020/recent.jpg')).toBe(true)
    expect(brochures.objects.has('lotte-mart/20261001/stale.jpg')).toBe(false)
  })

  it('keeps a referenced object at any age', async () => {
    const url = `${BROCHURE_URL_PREFIX}lotte-mart/20250101/old-but-live.jpg`
    const { db } = dbWithReferenced([url])
    const brochures = createBrochuresStub()
    await brochures.put('lotte-mart/20250101/old-but-live.jpg', pngBytes)

    const { deleted } = await sweep(db, brochures)
    expect(deleted).toBe(0)
    expect(brochures.objects.has('lotte-mart/20250101/old-but-live.jpg')).toBe(true)
  })

  it('never deletes an object whose key is unparseable', async () => {
    const { db } = dbWithReferenced([])
    const brochures = createBrochuresStub()
    await brochures.put('loose-object.jpg', pngBytes)
    await brochures.put('lotte-mart/not-a-date/x.jpg', pngBytes)

    const { deleted } = await sweep(db, brochures)
    expect(deleted).toBe(0)
    expect(brochures.objects.has('loose-object.jpg')).toBe(true)
    expect(brochures.objects.has('lotte-mart/not-a-date/x.jpg')).toBe(true)
  })

  it('follows the list cursor so a multi-page catalog is fully swept', async () => {
    const { db } = dbWithReferenced([])
    const brochures = createBrochuresStub()
    await brochures.put('lotte-mart/20250101/a.jpg', pngBytes)
    await brochures.put('lotte-mart/20250101/b.jpg', pngBytes)
    await brochures.put('lotte-mart/20250101/c.jpg', pngBytes)
    // Force one object per page: the sweep must keep following the cursor.
    const baseList = brochures.list.bind(brochures)
    ;(brochures as unknown as { list: typeof baseList }).list = ((
      options: { prefix?: string; cursor?: string; limit?: number } = {}
    ) => baseList({ ...options, limit: 1 })) as typeof baseList

    const { deleted } = await sweep(db, brochures)
    expect(deleted).toBe(3)
    expect(brochures.objects.size).toBe(0)
  })

  it('ignores legacy non-servable URLs in the referenced set', async () => {
    const { db } = dbWithReferenced(['https://www.lottemart.co.id/brosur', null])
    const brochures = createBrochuresStub()
    await brochures.put('lotte-mart/20250101/legacy-era.jpg', pngBytes)

    const { deleted } = await sweep(db, brochures)
    expect(deleted).toBe(1)
  })

  it('piggybacks on the ingest POST: fires with the real clock and never fails the response', async () => {
    // Old key-date fixture — no clock mocking: 20250101 is always past the
    // 14-day grace relative to any realistic now.
    const payload = {
      schemaVersion: 1,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
      items: [
        {
          productKey: 'beras--pandan-wangi--5-kg',
          name: 'Beras Pandan Wangi 5 kg',
          brand: 'Pandan Wangi',
          unit: '5 kg',
          storeSlug: 'lotte-mart',
          price: 72000,
          brochureUrl: '/api/brochures/lotte-mart/20250101/swept.jpg',
          matchMethod: 'exact',
          matchConfidence: 1.0,
        },
      ],
    }
    const { db } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      { match: /^SELECT id, product_key FROM price_products/, rows: [] },
    ])
    const brochures = createBrochuresStub()
    await brochures.put('lotte-mart/20250101/swept.jpg', pngBytes)
    await brochures.put('lotte-mart/20990101/fresh.jpg', pngBytes)

    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(payload),
      },
      createEnv(db, { brochures })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accepted: 1,
      productsCreated: 1,
      observationsUpserted: 1,
      skipped: 0,
    })
    // The sweep ran: the old unreferenced object is gone, the fresh one stays.
    expect(brochures.objects.has('lotte-mart/20250101/swept.jpg')).toBe(false)
    expect(brochures.objects.has('lotte-mart/20990101/fresh.jpg')).toBe(true)
  })

  it('a sweep failure is a logged no-op — the ingest response keeps its shape', async () => {
    const payload = {
      schemaVersion: 1,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
      items: [
        {
          productKey: 'beras--pandan-wangi--5-kg',
          name: 'Beras Pandan Wangi 5 kg',
          brand: 'Pandan Wangi',
          unit: '5 kg',
          storeSlug: 'lotte-mart',
          price: 72000,
          matchMethod: 'exact',
          matchConfidence: 1.0,
        },
      ],
    }
    const { db } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      { match: /^SELECT id, product_key FROM price_products/, rows: [] },
    ])
    const broken = createBrochuresStub()
    ;(broken as unknown as { list: () => Promise<never> }).list = () =>
      Promise.reject(new Error('r2 list exploded'))

    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(payload),
      },
      createEnv(db, { brochures: broken })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accepted: 1,
      productsCreated: 1,
      observationsUpserted: 1,
      skipped: 0,
    })
  })
})

// --- Catalog library (direct call shape check) ---

describe('getBrochureCatalog', () => {
  it('assembles groups with zipped examples in one batch', async () => {
    const { db, prepareCalls, resolves } = createFakeDb()
    resolves.brochureGroups = [
      {
        source_slug: 'lotte-mart',
        source_name: 'Lotte Mart',
        brochure_url: '/api/brochures/lotte-mart/20261029/page_1.jpg',
        observed_date: '2026-10-29',
        product_count: 3,
      },
    ]
    resolves.brochureExamples = [
      {
        brochure_url: '/api/brochures/lotte-mart/20261029/page_1.jpg',
        product_key: 'a--b--c',
        name: 'A B',
        brand: null,
        unit: null,
        price: 1000,
        effective_unit_price: 900,
      },
    ]
    const catalog = await getBrochureCatalog(db)
    expect(catalog.groups).toHaveLength(1)
    expect(catalog.groups[0]!.product_count).toBe(3)
    expect(catalog.groups[0]!.example_products[0]).toEqual({
      product_key: 'a--b--c',
      name: 'A B',
      brand: null,
      unit: null,
      price: 1000,
      effective_unit_price: 900,
    })
    // Exactly one batch of the two statements.
    const batchCall = prepareCalls.filter((call) => call.sql.includes('-- brochures:'))
    expect(batchCall).toHaveLength(2)
  })
})
