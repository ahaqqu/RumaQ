import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/review.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

const pair = (itemKey, entryKey, name) => ({
  itemProductKey: itemKey,
  itemName: name,
  itemBrand: null,
  itemUnit: '5 kg',
  itemPrice: 89000,
  itemEffectiveUnitPrice: 89000,
  itemStore: 'lotte-mart',
  entryProductKey: entryKey,
  entryName: 'Beras Ramos 5kg',
  entryBrand: 'Ramos',
  entryUnit: '5 kg',
  entryPrice: 27000,
  entryEffectiveUnitPrice: 27000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 1,
  reason: 'price_ratio',
})

function runReport(runStartedAt, pairs) {
  return {
    schemaVersion: 1,
    runStartedAt,
    finishedAt: `${runStartedAt.slice(0, 11)}23:04:11Z`,
    exitCode: 0,
    status: 'success',
    stage: 'done',
    perStore: {},
    match: {
      exact: 0,
      embedding: 0,
      ai: 0,
      solo: pairs.length,
      reviewItems: pairs.length,
      embeddingsDegraded: false,
      reviewItemPairs: pairs,
      reviewItemsTotal: pairs.length,
      reviewItemsTruncated: false,
    },
    publish: null,
    error: null,
  }
}

const TWO_PAIRS = [
  pair('beras-ramos-5kg----5-kg', 'beras-ramos-5kg--ramos--5-kg', 'Beras Ramos 5 kg'),
  pair('gula-pasir-1kg----1-kg', 'gula-pasir-1kg--gulaku--1-kg', 'Gula Pasir Gulaku 1 kg'),
]

async function postRunReport(ctx, report, bearer = INGEST_SECRET) {
  ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(report),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

// sendRequest is GET-shaped in this suite; bodies ride raw fetch with the
// context headers (brochures.steps.js convention).
async function sendJson(ctx, method, path, body) {
  ctx.response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { ...ctx.headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

async function readQueue(ctx, query = '') {
  await ctx.sendRequest('GET', `/api/admin/review${query}`)
  ctx.queue = ctx.responseBody
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
    ctx.queue = null
  })

  test('The review queue requires an authenticated session', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('I read the review queue without a session', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}/api/admin/review`)
      try {
        ctx.responseBody = await ctx.response.json()
      } catch {
        ctx.responseBody = null
      }
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('The review queue requires an admin', ({ given, and, when, then }) => {
    given('the API is running', () => {})

    and('I am authenticated as a non-admin user', async () => {
      ctx.headers = {
        ...ctx.headers,
        Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }),
      }
    })

    when('I read the review queue', async () => {
      await ctx.sendRequest('GET', '/api/admin/review')
    })

    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
  })

  test('The agent needs the bearer secret to post run reports', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the agent posts a run report with a wrong bearer token', async () => {
      await ctx.resetAndSeed()
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', TWO_PAIRS), 'wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('An invalid verdict is rejected', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent posted a run report carrying two flagged pairs', async () => {
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', TWO_PAIRS))
      expect(ctx.response.status).toBe(200)
    })

    when('I try to decide with an invalid verdict', async () => {
      await readQueue(ctx)
      const id = ctx.queue.items[0].id
      await sendJson(ctx, 'POST', `/api/admin/review/${id}/decision`, { decision: 'maybe' })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('An unknown review item refuses decisions', ({ given, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I decide on an unknown review item', async () => {
      await sendJson(ctx, 'POST', '/api/admin/review/nope/decision', { decision: 'approved' })
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('Flagged pairs flow from the run report through decide, undo, and export', ({
    given,
    when,
    then,
    and,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent posted a run report carrying two flagged pairs', async () => {
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', TWO_PAIRS))
      expect(ctx.response.status).toBe(200)
    })

    when('I read the review queue', async () => {
      await readQueue(ctx)
    })

    then('the queue should list two pending pairs with exact counts', () => {
      ctx.expectStatus(200)
      ctx.expectAuthenticatedCacheHeaders()
      expect(ctx.queue.items).toHaveLength(2)
      expect(ctx.queue.counts).toEqual({ pending: 2, approved: 0, rejected: 0 })
      expect(ctx.queue.filteredTotal).toBe(2)
      for (const item of ctx.queue.items) {
        expect(item.status).toBe('pending')
        expect(item.decidedAt).toBeNull()
      }
      // Both productKeys ride the row for deep links and the future
      // matcher-feedback loop. Same-run pairs share last_flagged_at, so
      // assert membership, not order.
      expect(ctx.queue.items.map((item) => item.itemProductKey).sort()).toEqual(
        TWO_PAIRS.map((p) => p.itemProductKey).sort()
      )
      for (const item of ctx.queue.items) {
        expect(item.entryProductKey).toBeTruthy()
      }
    })

    when('I approve the first pair', async () => {
      ctx.pairId = ctx.queue.items[0].id
      await sendJson(ctx, 'POST', `/api/admin/review/${ctx.pairId}/decision`, {
        decision: 'approved',
      })
    })

    then('the pair should carry the approved verdict and the admin id', () => {
      ctx.expectStatus(200)
      expect(ctx.responseBody.item).toMatchObject({
        id: ctx.pairId,
        status: 'approved',
        decidedBy: ctx.testUserId,
      })
      expect(ctx.responseBody.item.decidedAt).toBeTruthy()
    })

    and('the counts should show one approved and one pending', async () => {
      await readQueue(ctx)
      expect(ctx.queue.counts).toEqual({ pending: 1, approved: 1, rejected: 0 })
    })

    when('I read the review queue again', async () => {
      // The decided row left the pending filter — read the full queue.
      await readQueue(ctx, '?status=all')
    })

    then('the verdict should still be approved', () => {
      // Server-authoritative: the verdict survives a fresh read (device
      // switch parity — D1, not localStorage).
      const row = ctx.queue.items.find((item) => item.id === ctx.pairId)
      expect(row.status).toBe('approved')
      expect(row.decidedBy).toBe(ctx.testUserId)
    })

    when('I undo the verdict', async () => {
      await sendJson(ctx, 'DELETE', `/api/admin/review/${ctx.pairId}/decision`)
    })

    then('the pair should be pending again with the decision cleared', () => {
      ctx.expectStatus(200)
      expect(ctx.responseBody.item).toMatchObject({
        id: ctx.pairId,
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
      })
    })

    when('I export the decisions', async () => {
      // The versioned JSON envelope arrives as one document; sendRequest's
      // json() read consumes it.
      await ctx.sendRequest('GET', '/api/admin/review/export')
      ctx.exportBody = ctx.responseBody
    })

    then('the export should contain no decided rows', () => {
      ctx.expectStatus(200)
      expect(ctx.exportBody.schema).toBe(1)
      expect(ctx.exportBody.decisions).toEqual([])
    })

    when('I approve the first pair again', async () => {
      await sendJson(ctx, 'POST', `/api/admin/review/${ctx.pairId}/decision`, {
        decision: 'approved',
      })
      expect(ctx.response.status).toBe(200)
    })

    when('I export the decisions again', async () => {
      await ctx.sendRequest('GET', '/api/admin/review/export')
      ctx.exportBody = ctx.responseBody
    })

    then('the export should contain the decided row with schema 1', () => {
      ctx.expectStatus(200)
      expect(ctx.exportBody.schema).toBe(1)
      expect(ctx.exportBody.decisions).toHaveLength(1)
      expect(ctx.exportBody.decisions[0]).toMatchObject({
        itemProductKey: TWO_PAIRS[1].itemProductKey,
        entryProductKey: TWO_PAIRS[1].entryProductKey,
        decision: 'approved',
        decidedBy: ctx.testUserId,
        reason: 'price_ratio',
        flagCount: 1,
      })
    })
  })

  test('A decided pair is never reopened by a re-flag', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent posted a run report carrying two flagged pairs', async () => {
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', TWO_PAIRS))
      expect(ctx.response.status).toBe(200)
      await readQueue(ctx)
    })

    and('I approved the first pair', async () => {
      ctx.pairId = ctx.queue.items[0].id
      await sendJson(ctx, 'POST', `/api/admin/review/${ctx.pairId}/decision`, {
        decision: 'approved',
      })
      expect(ctx.response.status).toBe(200)
    })

    when('the agent posts a later run report re-flagging the same pair', async () => {
      // Tomorrow's run flags the SAME natural key with refreshed evidence —
      // the evidence moves, the verdict stands.
      const reflagged = TWO_PAIRS.map((p) =>
        p.itemProductKey === TWO_PAIRS[1].itemProductKey
          ? { ...p, itemPrice: 99000, confidence: 1 }
          : p
      )
      await postRunReport(ctx, runReport('2026-10-30T23:00:05Z', reflagged))
      expect(ctx.response.status).toBe(200)
    })

    and('I read the review queue', async () => {
      await readQueue(ctx, '?status=all')
    })

    then('the pair should still be approved with a higher flag count', () => {
      ctx.expectStatus(200)
      const row = ctx.queue.items.find((item) => item.id === ctx.pairId)
      expect(row.status).toBe('approved')
      expect(row.decidedBy).toBe(ctx.testUserId)
      expect(row.flagCount).toBe(2)
      expect(row.lastFlaggedAt).toBe('2026-10-30T23:00:05Z')
    })
  })

  test('A run report without review pairs still records (old scraper)', ({
    given,
    when,
    then,
    and,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('the agent posts a run report without review pairs', async () => {
      const report = runReport('2026-10-29T23:00:05Z', [])
      // An old scraper predates the review fields entirely.
      delete report.match.reviewItemPairs
      delete report.match.reviewItemsTotal
      delete report.match.reviewItemsTruncated
      await postRunReport(ctx, report)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the review queue should be empty', async () => {
      await readQueue(ctx)
      ctx.expectStatus(200)
      expect(ctx.queue.items).toEqual([])
      expect(ctx.queue.counts).toEqual({ pending: 0, approved: 0, rejected: 0 })
    })
  })
})
