import { describe, it, expect, vi } from 'vite-plus/test'
import { safeParse } from 'valibot'
import { apiApp } from '../apps/api.js'
import { reviewItemPairSchema, runReportSchema } from '@rumaq/contract'
import { ingestPayloadSchema, getPricesStatus } from '../lib/ingest.js'

type FakeRow = Record<string, unknown>
type FakeStatement = { sql: string; params: unknown[] }
type FakeSelect = {
  match: RegExp
  rows: FakeRow[] | ((params: unknown[]) => FakeRow[])
}

/** D1 rejects any query binding more parameters than this (per statement). */
const D1_MAX_BOUND_PARAMS = 100

function createFakeDb(selects: FakeSelect[] = []) {
  const executedBatches: FakeStatement[][] = []
  const resolve = (sql: string, params: unknown[]): FakeRow[] => {
    // Mirror the real D1 ceiling — without it a 150-key IN-list looks fine
    // here and only fails on the box ("too many SQL variables").
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error('D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR')
    }
    const hit = selects.find((s) => s.match.test(sql))
    if (!hit) return []
    return typeof hit.rows === 'function' ? hit.rows(params) : hit.rows
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
          return { results: resolve(sql, stmt.params) }
        },
        async first() {
          const rows = resolve(sql, stmt.params)
          return rows.length > 0 ? rows[0] : null
        },
        async run() {
          resolve(sql, stmt.params)
          return { success: true }
        },
      }
      return stmt
    },
    async batch(statements: FakeStatement[]) {
      for (const statement of statements) resolve(statement.sql, statement.params)
      executedBatches.push(statements.map((s) => ({ sql: s.sql, params: s.params })))
      return statements.map(() => ({ success: true }))
    },
  }
  return { db: db as unknown as D1Database, executedBatches }
}

function samplePayload() {
  return safeParse(ingestPayloadSchema, {
    schemaVersion: 1,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
    items: [
      {
        productKey: 'minyak-goreng--bimoli--1-l',
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        category: null,
        storeSlug: 'lotte-mart',
        price: 21500,
        // Issue #627: the member price is written beside the shelf `price`.
        memberPrice: 19900,
        effectiveUnitPrice: 21500,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 15%',
        validFrom: '2026-10-22',
        validUntil: '2026-10-28',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: 'https://www.lottemart.co.id/brosur',
      },
      {
        productKey: 'beras--pandan-wangi--5-kg',
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'lotte-mart',
        price: 72000,
        matchConfidence: 0.9,
      },
    ],
  })
}

function createEnv(db: D1Database, secret?: string, nextSecret?: string) {
  return {
    DB: db,
    RECEIPTS: { put: vi.fn(), get: vi.fn() },
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: undefined,
    TEST_MODE: 'true',
    HAQITA_INGEST_SECRET: secret,
    HAQITA_INGEST_SECRET_NEXT: nextSecret,
  }
}

describe('ingestPayloadSchema', () => {
  it('accepts the canonical payload from the integration plan', () => {
    const result = samplePayload()
    expect(result.success).toBe(true)
  })

  it('rejects an unknown schemaVersion', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 2,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [],
      items: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields (contract drift must be explicit)', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 1,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [],
      items: [],
      surprise: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects malformed dates, negative prices, and confidence above 1', () => {
    const base = samplePayload()
    expect(base.success).toBe(true)
    if (!base.success) return

    for (const override of [
      { validUntil: '28-10-2026' },
      { price: -1 },
      { matchConfidence: 1.5 },
    ] as const) {
      const result = safeParse(ingestPayloadSchema, {
        ...base.output,
        items: [{ ...base.output.items[0]!, ...override }],
      })
      expect(result.success).toBe(false)
    }
  })

  // Issue #368 phase A: the canonical unit fields are additive-nullish — an
  // old scraper's payload (fields absent) validates, a new scraper's derived
  // values validate, and out-of-domain values fail loudly.
  it('accepts payloads without the unit fields (old scraper, additive)', () => {
    // samplePayload items carry no unitQty/unitQtyUnit/unitPrice at all.
    expect(samplePayload().success).toBe(true)
  })

  it('accepts derived unit fields and rejects out-of-domain ones', () => {
    const base = samplePayload()
    expect(base.success).toBe(true)
    if (!base.success) return

    const derived = safeParse(ingestPayloadSchema, {
      ...base.output,
      items: [
        ...base.output.items,
        {
          ...base.output.items[1]!,
          productKey: 'beras--pandan-wangi--5-kg-normalized',
          unitQty: 5000,
          unitQtyUnit: 'g',
          unitPrice: 110000,
        },
      ],
    })
    expect(derived.success).toBe(true)

    for (const override of [
      { unitQty: 0 },
      { unitQty: -5 },
      { unitQtyUnit: 'kg' },
      { unitPrice: -1 },
      { unitPrice: 110000.5 },
    ]) {
      const result = safeParse(ingestPayloadSchema, {
        ...base.output,
        items: [{ ...base.output.items[0]!, ...override }],
      })
      expect(result.success).toBe(false)
    }
  })

  // Issue #373: the taxonomy stamp rides the item additively — old payloads
  // (field absent) validate; the classified shape validates; junk shapes
  // fail loudly at the strict ingest.
  it('accepts payloads without taxoVersion (old scraper, additive) and with it', () => {
    expect(samplePayload().success).toBe(true)

    const base = samplePayload()
    expect(base.success).toBe(true)
    if (!base.success) return

    const stamped = safeParse(ingestPayloadSchema, {
      ...base.output,
      items: [{ ...base.output.items[0]!, taxoVersion: 'v0.2' }],
    })
    expect(stamped.success).toBe(true)
    if (!stamped.success) return
    expect(stamped.output.items[0]!.taxoVersion).toBe('v0.2')

    // The cap rejects an over-cap version string ('' stays valid — the
    // schema's other additive string fields treat empty the same way).
    for (const override of [{ taxoVersion: 'x'.repeat(51) }]) {
      const result = safeParse(ingestPayloadSchema, {
        ...base.output,
        items: [{ ...base.output.items[0]!, ...override }],
      })
      expect(result.success).toBe(false)
    }
  })

  it('accepts the reason "taxonomy" on review pairs (issue #373) and junk reasons still fail', () => {
    const pair = {
      itemProductKey: 'a--b--c',
      itemName: 'A B C',
      itemBrand: null,
      itemUnit: null,
      itemPrice: 10000,
      itemEffectiveUnitPrice: null,
      itemStore: 'lotte-mart',
      entryProductKey: 'a--b--c',
      entryName: 'A B C',
      entryBrand: null,
      entryUnit: null,
      entryPrice: 10000,
      entryEffectiveUnitPrice: null,
      entryStore: 'lotte-mart',
      matchMethod: 'ai',
      confidence: 0.42,
      reason: 'taxonomy',
    } as const
    expect(safeParse(reviewItemPairSchema, pair).success).toBe(true)
    expect(safeParse(reviewItemPairSchema, { ...pair, reason: 'not-a-reason' }).success).toBe(false)
  })

  // Issue #626 part 2: the flag kind + the rules classifier's answer ride the
  // pair additively — old pairs (fields absent) validate; both emitted shapes
  // validate; junk shapes fail loudly at the strict schema.
  it('accepts kind/rulesCategory on review pairs (#626 part 2) and junk kinds still fail', () => {
    const pair = {
      itemProductKey: 'a--b--c',
      itemName: 'A B C',
      itemBrand: null,
      itemUnit: null,
      itemPrice: 10000,
      itemEffectiveUnitPrice: null,
      itemStore: 'lotte-mart',
      entryProductKey: 'a--b--c',
      entryName: 'A B C',
      entryBrand: null,
      entryUnit: null,
      entryPrice: 10000,
      entryEffectiveUnitPrice: null,
      entryStore: 'lotte-mart',
      matchMethod: 'ai',
      confidence: 0.42,
      reason: 'taxonomy',
    } as const
    // rulesCategory present with 'disagreement' — the rules answer differs.
    expect(
      safeParse(reviewItemPairSchema, {
        ...pair,
        kind: 'disagreement',
        rulesCategory: 'makanan-minuman',
      }).success
    ).toBe(true)
    // rulesCategory present with 'low_confidence' — the rules AGREED but the
    // model was unsure; the combination is legal (classify.ts can emit it).
    expect(
      safeParse(reviewItemPairSchema, { ...pair, kind: 'low_confidence', rulesCategory: 'snack' })
        .success
    ).toBe(true)
    // Both nullish: old pairs (no backfill) and pairs without a rules answer.
    expect(safeParse(reviewItemPairSchema, pair).success).toBe(true)
    expect(
      safeParse(reviewItemPairSchema, { ...pair, kind: null, rulesCategory: null }).success
    ).toBe(true)
    // Out-of-domain kind, and rulesCategory only ever a bounded string|null
    // (producer-controlled slug — capped like `family`, thermos B1).
    expect(
      safeParse(reviewItemPairSchema, { ...pair, kind: 'yolo', rulesCategory: 'snack' }).success
    ).toBe(false)
    expect(safeParse(reviewItemPairSchema, { ...pair, rulesCategory: 42 }).success).toBe(false)
    expect(safeParse(reviewItemPairSchema, { ...pair, rulesCategory: '' }).success).toBe(false)
    expect(
      safeParse(reviewItemPairSchema, { ...pair, rulesCategory: 'x'.repeat(65) }).success
    ).toBe(false)
  })

  it('accepts a store family on the payload (#626 part 2) and rejects junk', () => {
    const base = samplePayload()
    expect(base.success).toBe(true)
    if (!base.success) return

    const withFamily = safeParse(ingestPayloadSchema, {
      ...base.output,
      stores: [{ ...base.output.stores[0]!, family: 'lotte' }],
    })
    expect(withFamily.success).toBe(true)
    if (!withFamily.success) return
    expect(withFamily.output.stores[0]!.family).toBe('lotte')

    // Old payloads (field absent) and explicit nulls both validate.
    expect(samplePayload().success).toBe(true)
    expect(
      safeParse(ingestPayloadSchema, {
        ...base.output,
        stores: [{ ...base.output.stores[0]!, family: null }],
      }).success
    ).toBe(true)

    for (const family of ['', 'x'.repeat(65), 42]) {
      const result = safeParse(ingestPayloadSchema, {
        ...base.output,
        stores: [{ ...base.output.stores[0]!, family }],
      })
      expect(result.success).toBe(false)
    }
  })
})

describe('POST /api/internal/ingest/prices', () => {
  const validPayload = () => {
    const parsed = samplePayload()
    if (!parsed.success) throw new Error('fixture payload must be valid')
    return parsed.output
  }

  it('returns 503 when the ingest secret is not configured', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
        body: JSON.stringify(validPayload()),
      },
      createEnv(db)
    )
    expect(res.status).toBe(503)
  })

  it('returns 401 for a wrong or missing bearer token', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db, 'secret-123')

    const noHeader = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload()),
      },
      env
    )
    expect(noHeader.status).toBe(401)

    const wrongToken = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify(validPayload()),
      },
      env
    )
    expect(wrongToken.status).toBe(401)
  })

  it('returns 400 for a payload that fails the contract', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: JSON.stringify({ schemaVersion: 1, stores: [], items: 'nope' }),
      },
      createEnv(db, 'secret-123')
    )
    expect(res.status).toBe(400)
  })
})

describe('getPricesStatus', () => {
  it('summarises the observation table', async () => {
    const { db } = createFakeDb([
      {
        match: /FROM price_observations/,
        rows: [
          {
            latest_observed_date: '2026-10-25',
            latest_scraped_at: '2026-10-25T23:00:05Z',
            observation_count: 42,
          },
        ],
      },
    ])

    expect(await getPricesStatus(db)).toEqual({
      latestObservedDate: '2026-10-25',
      latestScrapedAt: '2026-10-25T23:00:05Z',
      observationCount: 42,
    })
  })

  it('reports an empty table as nulls and zero, not an error', async () => {
    const { db } = createFakeDb()

    expect(await getPricesStatus(db)).toEqual({
      latestObservedDate: null,
      latestScrapedAt: null,
      observationCount: 0,
    })
  })
})

describe('GET /api/internal/prices/status', () => {
  it('returns 503 when the ingest secret is not configured', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/prices/status',
      { headers: { Authorization: 'Bearer anything' } },
      createEnv(db)
    )
    expect(res.status).toBe(503)
  })

  it('returns 401 for a wrong or missing bearer token', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db, 'secret-123')

    const noHeader = await apiApp.request('/api/internal/prices/status', {}, env)
    expect(noHeader.status).toBe(401)

    const wrongToken = await apiApp.request(
      '/api/internal/prices/status',
      { headers: { Authorization: 'Bearer wrong' } },
      env
    )
    expect(wrongToken.status).toBe(401)
  })

  it('returns the freshness summary for a valid token', async () => {
    const { db } = createFakeDb([
      {
        match: /FROM price_observations/,
        rows: [
          {
            latest_observed_date: '2026-10-25',
            latest_scraped_at: '2026-10-25T23:00:05Z',
            observation_count: 42,
          },
        ],
      },
    ])

    const res = await apiApp.request(
      '/api/internal/prices/status',
      { headers: { Authorization: 'Bearer secret-123' } },
      createEnv(db, 'secret-123')
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(await res.json()).toEqual({
      latestObservedDate: '2026-10-25',
      latestScrapedAt: '2026-10-25T23:00:05Z',
      observationCount: 42,
      // Issue #536: the probe also carries the consecutive failed-run read —
      // no price_runs rows in this fixture, so nothing is failing.
      failedStreak: { count: 0, threshold: 3, since: null, code: null },
    })
  })

  // Issue #536: the failed-run branch of the freshness probe must work with
  // ZERO observations (a pipeline that never publishes is exactly the case the
  // observation-anchored branches cannot see). The read is the admin feed's
  // derivation, so this pins the wiring, not the derivation.
  it('carries the consecutive failed-run streak next to the zero-observation summary (#536)', async () => {
    const failedRow = (startedAt: string) => ({
      id: `run-${startedAt}`,
      run_started_at: startedAt,
      finished_at: startedAt,
      exit_code: 2,
      status: 'failed',
      stage: 'match',
      per_store: '{}',
      match_stats: null,
      publish_result: null,
      index_version: null,
      products_summary: null,
      ai_usage: null,
      ai_prompt_identity: null,
      failures: JSON.stringify([
        {
          store: null,
          code: 'embedding_unavailable',
          message: 'embedding_quota: daily quota exhausted',
        },
      ]),
      error: 'embedding_quota: daily quota exhausted',
    })
    const { db } = createFakeDb([
      {
        match: /FROM price_runs/,
        rows: [
          failedRow('2026-10-28T23:00:05Z'),
          failedRow('2026-10-27T23:00:05Z'),
          failedRow('2026-10-26T23:00:05Z'),
        ],
      },
    ])

    const res = await apiApp.request(
      '/api/internal/prices/status',
      { headers: { Authorization: 'Bearer secret-123' } },
      createEnv(db, 'secret-123')
    )

    expect(res.status).toBe(200)
    // No observations at all — the branch the script must reach anyway.
    expect(await res.json()).toMatchObject({
      observationCount: 0,
      latestObservedDate: null,
      failedStreak: {
        count: 3,
        threshold: 3,
        since: '2026-10-26T23:00:05Z',
        code: 'embedding_unavailable',
      },
    })
  })
})

// Dual-accept rotation window (ahaqqu/RumaQ#376): while the owner rotates the
// ingest secret, the Worker holds both the current (HAQITA_INGEST_SECRET) and
// the successor (HAQITA_INGEST_SECRET_NEXT); either authenticates. The
// middleware compares every non-empty candidate on every request — no
// precedence, no early exit — and 503s only when BOTH slots are empty.
describe('requireIngestSecret — dual accept (#376)', () => {
  const statusRows = [
    {
      match: /FROM price_observations/,
      rows: [
        {
          latest_observed_date: '2026-11-02',
          latest_scraped_at: '2026-11-02T23:00:05Z',
          observation_count: 7,
        },
      ],
    },
  ]

  const requestStatus = async (env: ReturnType<typeof createEnv>, token?: string) => {
    return apiApp.request(
      '/api/internal/prices/status',
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      env
    )
  }

  it('accepts the primary secret while both are set (rotation window start)', async () => {
    const { db } = createFakeDb(statusRows)
    const res = await requestStatus(createEnv(db, 'old-secret', 'new-secret'), 'old-secret')
    expect(res.status).toBe(200)
  })

  it('accepts the _NEXT secret while both are set (rotation window end)', async () => {
    const { db } = createFakeDb(statusRows)
    const res = await requestStatus(createEnv(db, 'old-secret', 'new-secret'), 'new-secret')
    expect(res.status).toBe(200)
  })

  it("keeps today's behavior when _NEXT is unset: primary accepts, unknown rejects", async () => {
    const { db } = createFakeDb(statusRows)
    const ok = await requestStatus(createEnv(db, 'old-secret'), 'old-secret')
    expect(ok.status).toBe(200)

    const unknown = await requestStatus(createEnv(db, 'old-secret'), 'not-the-secret')
    expect(unknown.status).toBe(401)
    expect(unknown.headers.get('WWW-Authenticate')).toBe('Bearer realm="rumaq-ingest"')
  })

  it('returns 503 only when both slots are unset', async () => {
    const { db } = createFakeDb()
    const res = await requestStatus(createEnv(db), 'anything')
    expect(res.status).toBe(503)
  })

  it('returns 503 when both slots are empty strings (filtered as unset)', async () => {
    const { db } = createFakeDb()
    const res = await requestStatus(createEnv(db, '', ''), 'anything')
    expect(res.status).toBe(503)
  })

  it('returns 401 when only one secret is set and the token is the other, unset one', async () => {
    const { db } = createFakeDb()
    const res = await requestStatus(createEnv(db, 'old-secret'), 'new-secret')
    expect(res.status).toBe(401)
  })

  it('returns 401 when both secrets are set and the token matches neither', async () => {
    // The reject twin of "both compared on every request": the two-iteration
    // loop runs both compares and still lands on the identical 401 shape.
    const { db } = createFakeDb()
    const res = await requestStatus(createEnv(db, 'old-secret', 'new-secret'), 'neither-secret')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="rumaq-ingest"')
  })

  it('returns 401 for a non-Bearer Authorization header while both secrets are set', async () => {
    // Malformed scheme: no token is extracted, so no candidate is compared
    // and the response is the same 401 as a missing header.
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/prices/status',
      { headers: { Authorization: 'Basic dXNlcjpwYXNz' } },
      createEnv(db, 'old-secret', 'new-secret')
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="rumaq-ingest"')
  })

  it('accepts when the primary slot is unset but _NEXT is set (no 503)', async () => {
    const { db } = createFakeDb(statusRows)
    const res = await requestStatus(createEnv(db, undefined, 'new-secret'), 'new-secret')
    expect(res.status).toBe(200)
  })

  it('accepts an empty-string primary filtered out while _NEXT is set', async () => {
    const { db } = createFakeDb(statusRows)
    const res = await requestStatus(createEnv(db, '', 'new-secret'), 'new-secret')
    expect(res.status).toBe(200)
  })

  it('compares both candidates on the same request (the guarded surface is shared)', async () => {
    // The ingest POST rides the same middleware: the successor secret must
    // carry a full snapshot through, not just the cheap status probe.
    const { db, executedBatches } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      {
        match: /^SELECT id, product_key, category, category_version FROM price_products/,
        rows: [],
      },
      { match: /^SELECT version FROM canonical_index_state/, rows: [{ version: 1 }] },
    ])
    const payload = {
      schemaVersion: 2,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
      items: [
        {
          productKey: 'beras--pandan-wangi--5-kg',
          rawName: 'Beras Pandan Wangi 5 kg',
          rawBrand: 'Pandan Wangi',
          rawUnit: '5 kg',
          storeSlug: 'lotte-mart',
          price: 72000,
          matchConfidence: 1,
        },
      ],
    }

    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer new-secret' },
        body: JSON.stringify(payload),
      },
      createEnv(db, 'old-secret', 'new-secret')
    )
    expect(res.status).toBe(200)
    expect(executedBatches.length).toBeGreaterThan(0)
  })
})

// Issue #367 (phase 1): the additive contract fields validate through the
// WORKER's own schema import — a scraper report carrying the shadow-audit
// object and a payload item carrying originalPrice are accepted by the
// unchanged backend logic (the fields are measurement data; phase 2 decides
// about persistence).

describe('additive contract fields (issue #367)', () => {
  it('accepts an ingest payload whose items carry originalPrice', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 1,
      scrapedAt: '2026-11-01T23:00:05Z',
      stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta' }],
      items: [
        {
          productKey: 'teh-kotak--null--250-ml',
          name: 'Teh Kotak 250ml',
          storeSlug: 'superindo',
          price: 5000,
          originalPrice: 6500,
          matchConfidence: 1.0,
        },
        {
          productKey: 'beras--pandan-wangi--5-kg',
          name: 'Beras Pandan Wangi 5 kg',
          storeSlug: 'superindo',
          price: 72000,
          matchConfidence: 0.9,
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a run report whose stores carry the shadow-audit object', () => {
    const result = safeParse(runReportSchema, {
      schemaVersion: 1,
      runStartedAt: '2026-11-01T23:00:05Z',
      finishedAt: '2026-11-01T23:04:11Z',
      exitCode: 0,
      status: 'success',
      stage: 'done',
      perStore: {
        superindo: {
          pagesFound: 2,
          newImages: 2,
          existingImages: 0,
          skipped: 0,
          itemsExtracted: 7,
          itemsRejected: 0,
          audit: {
            sampledPages: 2,
            nameAgreePct: 98,
            priceAgreePct: 100,
            originalAgreePct: 95,
            promoAgreePct: 100,
            disagreements: [
              {
                imageFilename: 'promo-2026-11-01-1.jpg',
                field: 'price',
                primary: '17000',
                shadow: '17500',
              },
            ],
          },
        },
      },
      match: null,
      publish: null,
      error: null,
    })
    expect(result.success).toBe(true)
  })

  // Issue #373: the per-store taxonomy object rides the report additively —
  // absent on old scrapers' reports, present once RUMAQ_CATEGORY classifies.
  it('accepts a run report whose stores carry the taxonomy object', () => {
    const result = safeParse(runReportSchema, {
      schemaVersion: 1,
      runStartedAt: '2026-11-01T23:00:05Z',
      finishedAt: '2026-11-01T23:04:11Z',
      exitCode: 0,
      status: 'success',
      stage: 'done',
      perStore: {
        superindo: {
          pagesFound: 2,
          newImages: 2,
          existingImages: 0,
          skipped: 0,
          itemsExtracted: 7,
          itemsRejected: 0,
          taxonomy: {
            taxoVersion: 'v0.2',
            classified: 7,
            cacheHits: 5,
            fallbackRules: 1,
            lowConfidence: 1,
            disagreements: 0,
          },
        },
      },
      match: null,
      publish: null,
      error: null,
    })
    expect(result.success).toBe(true)
  })
})
