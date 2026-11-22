import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

// The observation registry merge (ahaqqu/RumaQ#744) against the real
// endpoints, end to end: the ingest creates both products and their
// observations, the run report flags the cross-key pair, and the human decide
// route merges the registry in the same transaction as the verdict. The
// backend unit + real-SQLite suites pin the SQL's semantics; these scenarios
// pin the shipped HTTP contract: the decide response's registry block, the
// re-pointed sighting visible under the survivor's explorer read, and the
// absorbed key's 404.

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/review-registry-merge.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'

const SURVIVOR_KEY = 'beras-ramos--ramos--5-kg'
const ABSORBED_KEY = 'beras-ramos--ramos--5kg'
const SURVIVOR_PRICE = 15000
const ABSORBED_PRICE = 15500

function ingestItem(productKey, rawName, price) {
  return {
    productKey,
    rawName,
    rawBrand: 'Ramos',
    rawUnit: '5 kg',
    storeSlug: 'superindo',
    price,
    matchMethod: 'exact',
    matchConfidence: 1.0,
  }
}

// Two duplicate identities, each sighted once at the same store on a
// DIFFERENT date (one ingest per scrapedAt): the merge re-points the absorbed
// sighting to the survivor with no (source, date) collision to drop.
function survivorSnapshot() {
  return {
    schemaVersion: 2,
    scrapedAt: '2026-11-19T23:00:05Z',
    stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta' }],
    items: [ingestItem(SURVIVOR_KEY, 'Beras Ramos 5 kg', SURVIVOR_PRICE)],
  }
}

function absorbedSnapshot() {
  return {
    schemaVersion: 2,
    scrapedAt: '2026-11-20T23:00:05Z',
    stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta' }],
    items: [ingestItem(ABSORBED_KEY, 'Beras Ramos 5kg', ABSORBED_PRICE)],
  }
}

function runReport() {
  return {
    schemaVersion: 1,
    runStartedAt: '2026-11-20T23:04:00Z',
    finishedAt: '2026-11-20T23:04:11Z',
    exitCode: 0,
    status: 'success',
    stage: 'done',
    perStore: {},
    match: {
      exact: 0,
      embedding: 0,
      ai: 0,
      solo: 1,
      reviewItems: 1,
      embeddingsDegraded: false,
      reviewItemPairs: [
        {
          itemProductKey: SURVIVOR_KEY,
          itemName: 'Beras Ramos 5 kg',
          itemBrand: 'Ramos',
          itemUnit: '5 kg',
          itemPrice: SURVIVOR_PRICE,
          itemEffectiveUnitPrice: SURVIVOR_PRICE,
          itemStore: 'superindo',
          entryProductKey: ABSORBED_KEY,
          entryName: 'Beras Ramos 5kg',
          entryBrand: 'Ramos',
          entryUnit: '5 kg',
          entryPrice: ABSORBED_PRICE,
          entryEffectiveUnitPrice: ABSORBED_PRICE,
          entryStore: 'superindo',
          matchMethod: 'exact',
          confidence: 0.9,
          reason: 'price_ratio',
        },
      ],
      reviewItemsTotal: 1,
      reviewItemsTruncated: false,
    },
    publish: null,
    error: null,
  }
}

async function ingest(ctx, snapshot) {
  ctx.response = await fetch(`${ctx.baseUrl}/api/internal/ingest/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify(snapshot),
  })
  expect(ctx.response.status).toBe(200)
}

async function postJson(ctx, path, body, headers = {}) {
  ctx.response = await fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...ctx.headers, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

async function flagPair(ctx) {
  await postJson(ctx, '/api/internal/ingest/runs', runReport(), {
    Authorization: `Bearer ${INGEST_SECRET}`,
  })
  expect(ctx.response.status).toBe(200)
  await ctx.sendRequest('GET', '/api/admin/review')
  ctx.queue = ctx.responseBody
  expect(ctx.queue.items).toHaveLength(1)
  ctx.reviewId = ctx.queue.items[0].id
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
    ctx.queue = null
  })

  test("An approval re-points the entry's sighting under the survivor", ({
    given,
    when,
    then,
    and,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent ingested sightings for two duplicate product keys', async () => {
      await ingest(ctx, survivorSnapshot())
      await ingest(ctx, absorbedSnapshot())
    })

    and('the agent posted a run report flagging the two keys as one product', async () => {
      await flagPair(ctx)
    })

    when('I approve the flagged pair', async () => {
      await postJson(ctx, `/api/admin/review/${ctx.reviewId}/decision`, { decision: 'approved' })
      expect(ctx.response.status).toBe(200)
    })

    then('the decision response should report the registry merge', () => {
      // One observation re-pointed, no (source, date) collisions, and the
      // absorbed spelling rides along (ingest seeded one candidate alias per
      // payload — different names, so no collision to drop).
      expect(ctx.responseBody.registry).toEqual({ repointed: 1, dropped: 0, movedAliases: 1 })
      expect(ctx.responseBody.item).toMatchObject({ status: 'approved' })
    })

    and("the survivor's explorer page should list both sightings", async () => {
      await ctx.sendRequest('GET', `/api/prices/${SURVIVOR_KEY}`)
      expect(ctx.response.status).toBe(200)
      // The re-pointed sighting rides the survivor's history next to its own,
      // and the per-store current read now resolves to the survivor too.
      expect(ctx.responseBody.history.map((row) => row.price).sort((a, b) => a - b)).toEqual([
        SURVIVOR_PRICE,
        ABSORBED_PRICE,
      ])
      expect(ctx.responseBody.current).toHaveLength(1)
      expect(ctx.responseBody.current[0]).toMatchObject({
        source_slug: 'superindo',
        price: ABSORBED_PRICE, // the later observed_date is the store's current price
      })
    })

    and('the absorbed key should be gone from the catalog', async () => {
      await ctx.sendRequest('GET', `/api/prices/${ABSORBED_KEY}`)
      expect(ctx.response.status).toBe(404)
    })
  })

  test('A reject records the verdict and touches no catalog row', ({ given, when, then, and }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the agent ingested sightings for two duplicate product keys', async () => {
      await ingest(ctx, survivorSnapshot())
      await ingest(ctx, absorbedSnapshot())
    })

    and('the agent posted a run report flagging the two keys as one product', async () => {
      await flagPair(ctx)
    })

    when('I reject the flagged pair', async () => {
      await postJson(ctx, `/api/admin/review/${ctx.reviewId}/decision`, { decision: 'rejected' })
      expect(ctx.response.status).toBe(200)
    })

    then('the decision response should report no registry merge', () => {
      expect(ctx.responseBody.registry).toBeNull()
      expect(ctx.responseBody.item).toMatchObject({ status: 'rejected' })
    })

    and('both keys should still be in the catalog', async () => {
      await ctx.sendRequest('GET', `/api/prices/${SURVIVOR_KEY}`)
      expect(ctx.response.status).toBe(200)
      await ctx.sendRequest('GET', `/api/prices/${ABSORBED_KEY}`)
      expect(ctx.response.status).toBe(200)
    })
  })
})
