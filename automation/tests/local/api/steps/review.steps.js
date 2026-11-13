import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/review.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
// Mirrors REVIEW_SCRIPT_TOKEN in automation/tests/support/worker-server.mjs
// (#656): the scoped bearer for the two scripted review surfaces.
const REVIEW_SCRIPT_TOKEN = 'test-review-script-token'
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
  ctx.lastReport = report
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

  test('The review-script token reaches the queue report without a session', ({
    given,
    when,
    then,
    and,
  }) => {
    given('the API is running', () => {})

    when('I read the queue report with the review-script token', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}/api/admin/review/queue-report`, {
        headers: { Authorization: `Bearer ${REVIEW_SCRIPT_TOKEN}` },
      })
      try {
        ctx.responseBody = await ctx.response.json()
      } catch {
        ctx.responseBody = null
      }
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the queue report should carry the aggregate shape', () => {
      // The sections the switch checklist (docs/REVIEW-AUTO-MODE.md) reads.
      // Aggregate values only — the suite shares one worker, so exact counts
      // depend on scenario order.
      expect(ctx.responseBody.counts).toMatchObject({
        pendingByReason: expect.any(Object),
      })
      expect(ctx.responseBody.ai).toMatchObject({
        pendingWithVerdict: expect.any(Number),
        pendingWithoutVerdict: expect.any(Number),
        confidenceBands: expect.any(Array),
        autoEligible: expect.any(Number),
      })
      expect(ctx.responseBody.ai.confidenceBands).toHaveLength(3)
      expect(Array.isArray(ctx.responseBody.agreement)).toBe(true)
    })
  })

  test('A wrong review-script token falls back to the cookie path', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('I read the queue report with a wrong review-script token', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}/api/admin/review/queue-report`, {
        headers: { Authorization: `Bearer wrong-review-token` },
      })
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

  test('The AI review mode is a persisted admin switch that degrades without a provider', ({
    given,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I read the AI review mode', async () => {
      await ctx.sendRequest('GET', '/api/admin/review/mode')
      ctx.modeBody = ctx.responseBody
    })

    then('the mode should be assist and AI should not be configured', () => {
      ctx.expectStatus(200)
      ctx.expectAuthenticatedCacheHeaders()
      // The automation worker carries no provider key: the default (assist)
      // mode is stored by the migration, and the admin UI is told the AI is
      // not configured so it can degrade instead of silently failing. The
      // auto floor rides the same payload (#493).
      expect(ctx.modeBody).toEqual({
        mode: 'assist',
        aiConfigured: false,
        autoMinConfidence: 0.8,
      })
    })

    when('I evaluate the review queue with AI', async () => {
      await sendJson(ctx, 'POST', '/api/admin/review/evaluate', { limit: 5 })
      ctx.evaluationBody = ctx.responseBody
    })

    then('the evaluation should report zero evaluated and no AI configured', () => {
      // An unconfigured provider is 200 with aiConfigured:false — NEVER an
      // error (the documented degrade-to-manual posture, #484).
      ctx.expectStatus(200)
      expect(ctx.evaluationBody).toEqual({
        evaluated: 0,
        applied: 0,
        mode: 'assist',
        aiConfigured: false,
      })
    })

    when('I switch the AI review mode to manual', async () => {
      await sendJson(ctx, 'PUT', '/api/admin/review/mode', { mode: 'manual' })
    })

    then('the AI review mode should be manual', () => {
      ctx.expectStatus(200)
      expect(ctx.responseBody).toEqual({
        mode: 'manual',
        aiConfigured: false,
        autoMinConfidence: 0.8,
      })
    })

    when('I switch the AI review mode to auto', async () => {
      await sendJson(ctx, 'PUT', '/api/admin/review/mode', { mode: 'auto' })
      expect(ctx.response.status).toBe(200)
    })

    then('reading the AI review mode again should report auto', async () => {
      // Server-authoritative: the mode survives a fresh read (the device
      // switch parity rule), so the setting is D1, not client state.
      await ctx.sendRequest('GET', '/api/admin/review/mode')
      ctx.expectStatus(200)
      expect(ctx.responseBody).toEqual({
        mode: 'auto',
        aiConfigured: false,
        autoMinConfidence: 0.8,
      })
    })

    when('I try to switch the AI review mode to an unknown value', async () => {
      await sendJson(ctx, 'PUT', '/api/admin/review/mode', { mode: 'yolo' })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
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
      // Issue #628: the pending total carries its exact per-reason split; both
      // fixture pairs are price_ratio flags.
      expect(ctx.queue.counts).toEqual({
        pending: 2,
        approved: 0,
        rejected: 0,
        pendingByReason: { price_ratio: 2, verifier_unresolved: 0, taxonomy: 0 },
      })
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
      // Same-run pairs share last_flagged_at — carry the pair we actually
      // approved instead of assuming which one sorts first.
      ctx.approvedPair = ctx.queue.items[0]
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
      expect(ctx.queue.counts).toEqual({
        pending: 1,
        approved: 1,
        rejected: 0,
        // Only PENDING rows split by reason; the approved pair is not counted.
        pendingByReason: { price_ratio: 1, verifier_unresolved: 0, taxonomy: 0 },
      })
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
        itemProductKey: ctx.approvedPair.itemProductKey,
        entryProductKey: ctx.approvedPair.entryProductKey,
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

  test("A replayed report is a no-op (the scraper's report retry is safe)", ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent posted a run report carrying two flagged pairs', async () => {
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', TWO_PAIRS))
      expect(ctx.response.status).toBe(200)
    })

    when('the agent replays the exact same report (same runStartedAt)', async () => {
      // postRunReport retries once on any non-OK response, so a transient
      // failure after a committed chunk re-runs the whole pair set. The
      // same-run guard must keep flag_count at 1 — per-run flag semantics.
      await postRunReport(ctx, ctx.lastReport)
      expect(ctx.response.status).toBe(200)
    })

    and('I read the review queue', async () => {
      await readQueue(ctx)
    })

    then('the pairs should still show one flag each with unchanged counts', () => {
      ctx.expectStatus(200)
      expect(ctx.queue.items).toHaveLength(2)
      // Issue #628: the pending total carries its exact per-reason split; both
      // fixture pairs are price_ratio flags.
      expect(ctx.queue.counts).toEqual({
        pending: 2,
        approved: 0,
        rejected: 0,
        pendingByReason: { price_ratio: 2, verifier_unresolved: 0, taxonomy: 0 },
      })
      for (const item of ctx.queue.items) {
        expect(item.flagCount).toBe(1)
      }
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
      expect(ctx.queue.counts).toEqual({
        pending: 0,
        approved: 0,
        rejected: 0,
        pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
      })
    })
  })
})

// --- #626: taxonomy self-pairs leave the identity queue, acknowledge in bulk
// Seeding is scenario-local through the test-only /api/__test/direct-sql
// endpoint (products-rename.steps.js pattern).
test('Taxonomy self-pairs leave the identity queue and acknowledge in bulk (#626)', ({
  given,
  and,
  when,
  then,
}) => {
  given('I am authenticated as an admin', async () => {
    await ctx.resetAndSeed()
    await ctx.authenticate()
  })

  and(
    'the agent posted a run report carrying two identity pairs and two taxonomy self-pairs',
    async () => {
      // One product row so the taxonomy page can prove the #626 category
      // join; the other self-pair stays product-less and must render nulls.
      await ctx.sendRequestWithBody('POST', '/api/__test/direct-sql', {
        sql: `INSERT INTO price_products (id, product_key, name, category, category_version)
                VALUES ('pp-tax', 'tax-self-1----', 'Tax Self 1', 'makanan-minuman', 'v0.4')`,
      })
      expect(ctx.response.status, 'test-only direct-sql seed failed').toBe(200)
      // A taxonomy flag is a SELF-pair: both sides are the same product.
      const taxonomyPair = (key) => ({
        ...pair(key, key, 'Tax Self'),
        entryName: 'Tax Self',
        entryStore: 'lotte-mart',
        confidence: 0.42,
        reason: 'taxonomy',
      })
      const pairs = [...TWO_PAIRS, taxonomyPair('tax-self-1----'), taxonomyPair('tax-self-2----')]
      await postRunReport(ctx, runReport('2026-10-29T23:00:05Z', pairs))
      expect(ctx.response.status).toBe(200)
    }
  )

  when('I read the review queue', async () => {
    await readQueue(ctx)
  })

  then('the identity queue should list only the identity pairs', () => {
    // The default page excludes the self-pairs; the split still names them
    // so the category backlog stays visible.
    expect(ctx.queue.items.map((item) => item.reason)).toEqual(['price_ratio', 'price_ratio'])
    expect(ctx.queue.filteredTotal).toBe(2)
    expect(ctx.queue.counts.pendingByReason).toEqual({
      price_ratio: 2,
      verifier_unresolved: 0,
      taxonomy: 2,
    })
  })

  when('I read the review queue filtered by taxonomy', async () => {
    await readQueue(ctx, '?reason=taxonomy')
  })

  then('the taxonomy page should list the self-pairs with the assigned category', () => {
    const byKey = new Map(ctx.queue.items.map((item) => [item.itemProductKey, item]))
    expect(byKey.size).toBe(2)
    expect(byKey.get('tax-self-1----')).toMatchObject({
      itemCategory: 'makanan-minuman',
      itemCategoryVersion: 'v0.4',
      aiVerdict: null,
    })
    expect(byKey.get('tax-self-2----')).toMatchObject({
      itemCategory: null,
      itemCategoryVersion: null,
    })
  })

  when('I acknowledge all pending taxonomy flags', async () => {
    await sendJson(ctx, 'POST', '/api/admin/review/taxonomy/acknowledge')
  })

  then('the response should say two acknowledged and none remaining', () => {
    ctx.expectStatus(200)
    expect(ctx.responseBody).toEqual({ acknowledged: 2, remaining: 0 })
  })

  when('I read the review queue filtered by taxonomy again', async () => {
    await readQueue(ctx, '?reason=taxonomy')
  })

  then('the taxonomy page should list no pending self-pairs', () => {
    expect(ctx.queue.items).toHaveLength(0)
    expect(ctx.queue.filteredTotal).toBe(0)
    // The whole-queue split moved with the acknowledgement.
    expect(ctx.queue.counts.pendingByReason.taxonomy).toBe(0)
  })
})
