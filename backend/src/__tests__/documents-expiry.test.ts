import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp } from '../apps/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { daysUntil, householdIsoDate } from '../lib/document-expiry.js'
import {
  createDocumentsHarness,
  createEnv,
  DOC_ROW,
  DOC_ROW_ROUTE,
  JOIN_ROUTE,
  type Row,
  type WithFiles,
} from './support/documents-harness.js'

// The #426 expiry surface: PATCH /api/documents/:id (validation + audit +
// household scoping) and the expiring_within list filter. Same idiom as the
// sibling files — the fake D1 routes on SQL fragments — with the exact-value
// date math (boundaries, the computed days_until_expiry) pinned against real
// SQLite in documents-sql.test.ts, where `now` is an argument rather than
// the wall clock.

// One joined row per the lib's raw projection shape (no files).
function joinDocRows(doc: Row): Row[] {
  return [
    {
      document_id: doc.id,
      household_id: doc.household_id,
      member_id: doc.member_id ?? null,
      name: doc.name,
      uploaded_by: doc.uploaded_by,
      created_at: doc.created_at,
      expires_on: doc.expires_on ?? null,
      remind_days_before: doc.remind_days_before ?? null,
      file_id: null,
    },
  ]
}

// The read-back after PATCH derives the expiry columns from the UPDATE log —
// the test sees what actually persisted, not a parallel fixture. The route
// closure reads the db through a holder set right after setup returns (routes
// only fire once the request runs).
function joinRouteReadingUpdateLog(doc: Row): {
  route: [RegExp, (params: unknown[]) => Row[]]
  attach: (db: { log: Array<{ sql: string; params: unknown[] }> }) => void
} {
  let db: { log: Array<{ sql: string; params: unknown[] }> } | undefined
  return {
    route: [
      JOIN_ROUTE,
      () => {
        const update = [...(db?.log ?? [])].filter((e) => /UPDATE documents/.test(e.sql)).pop()
        const expires_on = (update?.params[0] as string | null) ?? null
        const remind_days_before = (update?.params[1] as number | null) ?? null
        return joinDocRows({ ...doc, expires_on, remind_days_before })
      },
    ],
    attach: (ref) => {
      db = ref
    },
  }
}

function patchBody(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

describe('documents routes — expiry metadata (#426)', () => {
  const h = createDocumentsHarness()

  beforeEach(() => {
    resetRateLimit()
  })

  it('401s without a session', async () => {
    const { db } = h.setup()
    const unauth = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: '2027-05-20' }),
      createEnv(db, { props: undefined })
    )
    expect(unauth.status).toBe(401)
  })

  it('answers 404 for a foreign household document before the body is read', async () => {
    const { db, env } = h.setup([[DOC_ROW_ROUTE, () => null]])
    const res = await documentsApp.request('/api/documents/doc-foreign', patchBody({}), env)
    expect(res.status).toBe(404)
    // No existence leak, and nothing else ran.
    expect(db.log).toHaveLength(0)
  })

  it('sets expiry + explicit window, writes the update audit record in the same batch, and returns the computed days', async () => {
    const readBack = joinRouteReadingUpdateLog(DOC_ROW({ name: 'Paspor' }))
    const { db, env } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW({ name: 'Paspor' })]],
      [readBack.route]
    )
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: '2027-05-20', remind_days_before: 90 }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document).toMatchObject({ expires_on: '2027-05-20', remind_days_before: 90 })
    // days_until_expiry is computed, never stored: a number for a dated
    // document (exact values pinned against real SQL in documents-sql.test.ts).
    expect(typeof body.document.days_until_expiry).toBe('number')
    expect(JSON.stringify(body.document)).not.toContain('"r2_key"')

    // One batch, GUARDED (V2-A1): the UPDATE first, then the 'update' audit
    // record riding an INSERT..SELECT gated on the row the UPDATE just
    // touched — a concurrent delete can never leave a spurious audit record
    // behind. Both statements carry the household predicate.
    const batched = db.log.filter(
      (e) => /INSERT INTO document_audit/.test(e.sql) || /UPDATE documents/.test(e.sql)
    )
    expect(batched).toHaveLength(2)
    const update = batched[0]
    expect(update?.sql).toContain('WHERE id = ? AND household_id = ?')
    expect(update?.params).toEqual(['2027-05-20', 90, 'doc-1', 'h1'])
    const audit = batched[1]
    expect(audit?.sql).toContain(
      "SELECT ?, ?, ?, ?, 'update', NULL WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND household_id = ?)"
    )
    expect(audit?.params).toEqual([expect.any(String), 'doc-1', 'h1', 'u1', 'doc-1', 'h1'])
  })

  it('applies the 30-day app default when an expiry is set without a window (no stored column default)', async () => {
    const readBack = joinRouteReadingUpdateLog(DOC_ROW())
    const { db, env } = h.setup([[DOC_ROW_ROUTE, () => DOC_ROW()]], [readBack.route])
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: '2027-01-31' }),
      env
    )
    expect(res.status).toBe(200)
    const update = db.log.find((e) => /UPDATE documents/.test(e.sql))
    // The default lives in the lib (migration 0026 header): expiry on,
    // window 30.
    expect(update?.params).toEqual(['2027-01-31', 30, 'doc-1', 'h1'])
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.remind_days_before).toBe(30)
  })

  it('keeps an existing window when only the date changes (a correction must not clobber a chosen window)', async () => {
    const readBack = joinRouteReadingUpdateLog(DOC_ROW({ remind_days_before: 60 }))
    const { db, env } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW({ expires_on: '2027-05-20', remind_days_before: 60 })]],
      [readBack.route]
    )
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: '2028-01-10' }),
      env
    )
    expect(res.status).toBe(200)
    const update = db.log.find((e) => /UPDATE documents/.test(e.sql))
    expect(update?.params).toEqual(['2028-01-10', 60, 'doc-1', 'h1'])
  })

  it('clears expiry (and the window with it) on expires_on: null', async () => {
    const readBack = joinRouteReadingUpdateLog(DOC_ROW({ expires_on: '2027-05-20' }))
    const { db, env } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW({ expires_on: '2027-05-20', remind_days_before: 30 })]],
      [readBack.route]
    )
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: null }),
      env
    )
    expect(res.status).toBe(200)
    const update = db.log.find((e) => /UPDATE documents/.test(e.sql))
    expect(update?.params).toEqual([null, null, 'doc-1', 'h1'])
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document).toMatchObject({
      expires_on: null,
      remind_days_before: null,
      days_until_expiry: null,
    })
  })

  it('updates the window alone when the document already carries an expiry', async () => {
    const readBack = joinRouteReadingUpdateLog(DOC_ROW({ expires_on: '2027-05-20' }))
    const { db, env } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW({ expires_on: '2027-05-20', remind_days_before: 30 })]],
      [readBack.route]
    )
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ remind_days_before: 14 }),
      env
    )
    expect(res.status).toBe(200)
    const update = db.log.find((e) => /UPDATE documents/.test(e.sql))
    expect(update?.params).toEqual(['2027-05-20', 14, 'doc-1', 'h1'])
  })

  it('rejects validation failures with 400 and writes nothing', async () => {
    const cases: Array<[string, RequestInit, Row]> = [
      // Malformed JSON.
      ['malformed body', patchBody('{not json'), DOC_ROW({ expires_on: '2027-05-20' })],
      // Empty body — nothing to update.
      ['empty body', patchBody({}), DOC_ROW({ expires_on: '2027-05-20' })],
      // Not a real calendar date (well-formed, impossible day).
      ['impossible date', patchBody({ expires_on: '2026-02-31' }), DOC_ROW()],
      ['wrong date shape', patchBody({ expires_on: 'May 20th' }), DOC_ROW()],
      // Window bounds and types.
      ['window zero', patchBody({ remind_days_before: 0 }), DOC_ROW({ expires_on: '2027-05-20' })],
      ['window 366', patchBody({ remind_days_before: 366 }), DOC_ROW({ expires_on: '2027-05-20' })],
      [
        'window fractional',
        patchBody({ remind_days_before: 7.5 }),
        DOC_ROW({ expires_on: '2027-05-20' }),
      ],
      [
        'window string',
        patchBody({ remind_days_before: '30' }),
        DOC_ROW({ expires_on: '2027-05-20' }),
      ],
      // A window on an expiry-less document: nothing to remind about.
      ['window without expiry', patchBody({ remind_days_before: 30 }), DOC_ROW()],
      // Clearing the expiry does not take a window alongside.
      ['clear + window', patchBody({ expires_on: null, remind_days_before: 30 }), DOC_ROW()],
    ]

    for (const [label, request, doc] of cases) {
      const { db, env } = h.setup([[DOC_ROW_ROUTE, () => doc]])
      const res = await documentsApp.request('/api/documents/doc-1', request, env)
      expect(res.status, label).toBe(400)
      expect(await res.json(), label).toMatchObject({ error: expect.any(String) })
      expect(db.log, label).toHaveLength(0)
    }
  })

  it('lists with expiring_within: the horizon binds as a parameter after the household scope', async () => {
    let lastParams: unknown[] = []
    const { env } = h.setup(
      [],
      [
        [
          JOIN_ROUTE,
          (params) => {
            lastParams = params
            return joinDocRows(
              DOC_ROW({ id: 'doc-exp', expires_on: '2027-05-20', remind_days_before: 30 })
            )
          },
        ],
      ]
    )

    const res = await documentsApp.request('/api/documents?expiring_within=30', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { documents: Array<WithFiles> }
    // Household scope first, then the horizon (days are added to `now` in the
    // lib — the exact boundary math is pinned in documents-sql.test.ts).
    expect(lastParams[0]).toBe('h1')
    expect(lastParams).toHaveLength(2)
    expect(lastParams[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The summary carries the computed distance.
    expect(typeof body.documents[0]?.days_until_expiry).toBe('number')
  })

  it('rejects invalid expiring_within values with 400', async () => {
    const { env } = h.setup()
    for (const value of ['0', '366', 'abc', '12.5', '', '-5']) {
      const res = await documentsApp.request(
        `/api/documents?expiring_within=${encodeURIComponent(value)}`,
        {},
        env
      )
      expect(res.status, `expiring_within=${value}`).toBe(400)
    }
  })

  it('reports no expiry for undated documents (days_until_expiry null), in the default listing too', async () => {
    const { env } = h.setup([], [[JOIN_ROUTE, () => joinDocRows(DOC_ROW())]])
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { documents: Array<WithFiles> }
    expect(body.documents[0]).toMatchObject({
      expires_on: null,
      remind_days_before: null,
      days_until_expiry: null,
    })
  })

  it('computes days_until_expiry from the same UTC calendar math as the lib', async () => {
    // A far-future date answers a positive distance; the exact number is
    // whatever the shared helper says against today's UTC date — pinned here
    // so the route and the helper cannot drift.
    const readBack = joinRouteReadingUpdateLog(DOC_ROW())
    const { db, env } = h.setup([[DOC_ROW_ROUTE, () => DOC_ROW()]], [readBack.route])
    readBack.attach(db)

    const res = await documentsApp.request(
      '/api/documents/doc-1',
      patchBody({ expires_on: '2030-01-01' }),
      env
    )
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.days_until_expiry).toBe(
      daysUntil('2030-01-01', householdIsoDate(new Date()))
    )
    expect(body.document.days_until_expiry).toBeGreaterThan(0)
  })
})
