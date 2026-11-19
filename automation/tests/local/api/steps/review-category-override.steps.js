import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

// Admin category override + revert (ahaqqu/RumaQ#728) against the real
// endpoints. The unit + real-SQLite suites pin the write semantics; these
// scenarios pin the shipped HTTP contract end-to-end: the auth chain (the
// override is session-admin only by owner decision — no script-token path),
// the sealed-vocabulary and category-unchanged 400s, the from-value CAS 409
// that writes NOTHING, the one-batch happy path (receipt + index bump + flag
// settle), and the compensating revert with its stale_revert mapping.
//
// Seeding is scenario-local through the test-only /api/__test/direct-sql
// endpoint (the products-rename.steps.js idiom). `reset` runs first (inside
// the auth givens), so every scenario starts from the same catalog.

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/review-category-override.feature')

const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const PRODUCT_KEY = 'beras--ramos--5-kg'
const PRODUCT_ID = 'prod-cat-1'
const PRODUCT_PATH = `/api/admin/products/${PRODUCT_KEY}`
const REVIEW_ID = 'rev-cat-1'
const REVIEW_PATH = `/api/admin/review/${REVIEW_ID}/category`
const BUCKETS_PATH = '/api/admin/review/taxonomy/buckets'

// A taxonomy flag is a SELF-pair: both sides name the same catalog product.
// The pair blob is what the card renders and what the override route parses
// (an unrenderable blob is a 404), so it carries the #626-part-2 context too.
const PAIR_DATA = {
  itemProductKey: PRODUCT_KEY,
  itemName: 'Beras Ramos 5 kg',
  itemPrice: 15000,
  itemStore: 'superindo',
  entryProductKey: PRODUCT_KEY,
  entryName: 'Beras Ramos 5 kg',
  entryPrice: 15000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 0.42,
  reason: 'taxonomy',
  kind: 'disagreement',
  rulesCategory: 'beras',
}

// Miniflare's D1 `exec` runs ONE statement per line — a statement folded over
// several lines fails with "incomplete input" (the products-rename note). The
// canonical index counter is reset to 0 so "bumped exactly once per write" is
// an exact assertion instead of a difference from an unknown baseline.
const OVERRIDE_STATEMENTS = [
  'UPDATE canonical_index_state SET version = 0 WHERE id = 1;',
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, category, category_version, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('${PRODUCT_ID}', '${PRODUCT_KEY}', 'Beras Ramos 5 kg', 'Ramos', '5 kg', 'provisional', 'snack', 'v0.3', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
  `INSERT INTO price_sources (id, slug, name) VALUES ('src-superindo', 'superindo', 'Superindo');`,
  `INSERT INTO match_review_items (id, item_product_key, entry_product_key, pair_data, reason, match_method, confidence, run_started_at, first_flagged_at, last_flagged_at, flag_count, status) VALUES ('${REVIEW_ID}', '${PRODUCT_KEY}', '${PRODUCT_KEY}', '${JSON.stringify(PAIR_DATA).replace(/'/g, "''")}', 'taxonomy', 'exact', 0.42, '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', 1, 'pending');`,
]

async function directSql(ctx, sql) {
  await ctx.sendRequestWithBody('POST', '/api/__test/direct-sql', { sql })
  expect(ctx.response.status, 'test-only direct-sql seed failed').toBe(200)
}

async function seedFlag(ctx, status = 'pending') {
  const statements = [...OVERRIDE_STATEMENTS]
  if (status !== 'pending') {
    statements.push(
      `UPDATE match_review_items SET status = '${status}', decided_at = '2026-11-18T07:00:00.000Z', decided_by = 'admin-early', decided_source = 'human' WHERE id = '${REVIEW_ID}';`
    )
  }
  await directSql(ctx, statements.join('\n'))
}

async function readIdentity(ctx) {
  await ctx.sendRequest('GET', PRODUCT_PATH)
  expect(ctx.response.status).toBe(200)
  return ctx.responseBody
}

async function setCategory(ctx, body) {
  await ctx.sendRequestWithBody('POST', REVIEW_PATH, body)
  return ctx.responseBody
}

async function readMetadataVersion(ctx) {
  const identity = await readIdentity(ctx)
  return identity.product.metadataVersion
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('The override and vocabulary routes require an authenticated session', ({
    given,
    when,
    then,
  }) => {
    given('the API is running', () => {})

    when('I read the taxonomy buckets without a session', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}${BUCKETS_PATH}`)
      try {
        ctx.responseBody = await ctx.response.json()
      } catch {
        ctx.responseBody = null
      }
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })

    when('I set a category on a review item without a session', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}${REVIEW_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'beras' }),
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

  test('The override and vocabulary routes require an admin', ({ given, and, when, then }) => {
    given('the API is running', () => {})

    and('I am authenticated as a non-admin user', async () => {
      await ctx.resetAndSeed()
      ctx.headers = {
        ...ctx.headers,
        Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }),
      }
    })

    when('I read the taxonomy buckets', async () => {
      await ctx.sendRequest('GET', BUCKETS_PATH)
    })

    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })

    when('I set a category on a review item', async () => {
      await ctx.sendRequestWithBody('POST', REVIEW_PATH, { category: 'beras' })
    })

    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
  })

  test('The vocabulary route serves the sealed 49-bucket list', ({ given, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    let buckets = null

    when('I read the taxonomy buckets', async () => {
      await ctx.sendRequest('GET', BUCKETS_PATH)
      if (ctx.response.status === 200) buckets = ctx.responseBody
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    then('the buckets should be the sealed v0.4 list with 49 slugs', () => {
      expect(buckets.version).toBe('v0.4')
      expect(buckets.buckets).toHaveLength(49)
      expect(new Set(buckets.buckets).size).toBe(49)
      // A sealed slug and no stray: the filter domain's pollution guard.
      expect(buckets.buckets).toContain('beras')
      expect(buckets.buckets).toContain('alat-tulis-kantor')
      expect(buckets.buckets).toContain('lainnya')
    })
  })

  test('A slug outside the sealed vocabulary is refused', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    when('I set the category to "beras-ramos"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras-ramos' })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })

    then('the error code should be category_unknown', () => {
      expect(ctx.responseBody.error).toBe('category_unknown')
    })

    then('the product category should be untouched', async () => {
      const identity = await readIdentity(ctx)
      expect(identity.product.category).toBe('snack')
      expect(identity.product.categorySource).toBeNull()
      expect(identity.categoryAudit).toHaveLength(0)
    })
  })

  test("Confirming the assigned category is refused — that is the ack's job", ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    when('I set the category to its current value', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'snack' })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })

    then('the error code should be category_unchanged', () => {
      expect(ctx.responseBody.error).toBe('category_unchanged')
    })
  })

  test('An unknown review item cannot be overridden', ({ given, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I set a category on an unknown review item', async () => {
      await ctx.sendRequestWithBody('POST', '/api/admin/review/rev-unknown/category', {
        category: 'beras',
      })
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('The override re-reads the product fresh, so a moved category is not stale', ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    and("the product's category moved after the flag was raised", async () => {
      // The route carries no client-supplied expected category: the from-value
      // CAS plays against what the lib reads INSIDE the request. A category
      // that moved before the request is simply the new from-value — the true
      // CAS race (a write between the lib's read and its batch) writes
      // nothing and is pinned by the real-SQLite unit suite.
      await directSql(
        ctx,
        `UPDATE price_products SET category = 'buah', category_version = 'v0.4', metadata_version = 2, updated_at = '2026-11-19T05:00:00.000Z' WHERE id = '${PRODUCT_ID}';`
      )
    })

    when('I set the category to "beras"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras' })
    })

    then('the response should settle the flag approved with decided_source human', () => {
      ctx.expectStatus(200)
      const item = ctx.responseBody.item
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
      expect(item.itemCategory).toBe('beras')
    })

    then("the moved-from category should be the receipt's old value", async () => {
      const identity = await readIdentity(ctx)
      expect(identity.categoryAudit).toHaveLength(1)
      expect(identity.categoryAudit[0]).toMatchObject({
        action: 'set',
        oldCategory: 'buah',
        oldCategoryVersion: 'v0.4',
        newCategory: 'beras',
        metadataVersionAfter: 3,
      })
    })
  })

  test('An admin overrides the category from a taxonomy flag', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    when('I read the product identity', async () => {
      ctx.identity = await readIdentity(ctx)
    })

    then('the identity should carry the pipeline category and an empty category audit', () => {
      expect(ctx.identity.product.category).toBe('snack')
      expect(ctx.identity.product.categoryVersion).toBe('v0.3')
      expect(ctx.identity.product.categorySource).toBeNull()
      expect(ctx.identity.categoryAudit).toHaveLength(0)
      expect(ctx.identity.product.metadataVersion).toBe(1)
    })

    when('I set the category to "beras"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras' })
    })

    then('the response should settle the flag approved with decided_source human', () => {
      ctx.expectStatus(200)
      const item = ctx.responseBody.item
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
      expect(item.decidedBy).toBe(ctx.testUserId)
      expect(item.itemCategory).toBe('beras')
      expect(item.itemCategoryVersion).toBe('v0.4')
      expect(item.itemCategorySource).toBe('human')
    })

    then(
      'the identity should carry the human category, one set receipt, and a bumped index version',
      async () => {
        const identity = await readIdentity(ctx)
        expect(identity.product.category).toBe('beras')
        expect(identity.product.categoryVersion).toBe('v0.4')
        expect(identity.product.categorySource).toBe('human')
        expect(identity.product.metadataVersion).toBe(2)
        expect(identity.categoryAudit).toHaveLength(1)
        const receipt = identity.categoryAudit[0]
        expect(receipt).toMatchObject({
          action: 'set',
          oldCategory: 'snack',
          oldCategoryVersion: 'v0.3',
          newCategory: 'beras',
          newCategoryVersion: 'v0.4',
          reviewItemId: REVIEW_ID,
          metadataVersionBefore: 1,
          metadataVersionAfter: 2,
          revertsAuditId: null,
        })
        expect(receipt.actorUserId).toBe(ctx.testUserId)
        // The index version itself is the revert response's field; the
        // one-bump-per-write contract is pinned by the real-SQLite unit suite.
      }
    )

    then('the product status and name should be untouched', async () => {
      const identity = await readIdentity(ctx)
      expect(identity.product.name).toBe('Beras Ramos 5 kg')
      expect(identity.product.status).toBe('provisional')
    })
  })

  test('Re-overriding the same product is legal — a new receipt, not a stale error', ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    when('I set the category to "beras"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras' })
    })

    then('the response should settle the flag approved with decided_source human', () => {
      ctx.expectStatus(200)
      const item = ctx.responseBody.item
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
    })

    when('I set the category to "snack" on the same flag again', async () => {
      // A sequential re-override (X → Y) is a new audited set, not a CAS
      // loss — the from-value the lib plays against is the one it just read.
      // The flag is already approved: the settle's pending guard no-ops and
      // the decision stands.
      ctx.responseBody = await setCategory(ctx, { category: 'snack' })
    })

    then('the re-override should commit a second receipt while the decision stands', async () => {
      ctx.expectStatus(200)
      const item = ctx.responseBody.item
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
      expect(item.itemCategory).toBe('snack')
      expect(item.itemCategorySource).toBe('human')

      const identity = await readIdentity(ctx)
      expect(identity.product.category).toBe('snack')
      expect(identity.product.metadataVersion).toBe(3)
      expect(identity.categoryAudit).toHaveLength(2)
      const [latest, first] = identity.categoryAudit
      expect(latest).toMatchObject({
        action: 'set',
        oldCategory: 'beras',
        newCategory: 'snack',
        metadataVersionAfter: 3,
        reviewItemId: REVIEW_ID,
      })
      expect(first).toMatchObject({
        action: 'set',
        oldCategory: 'snack',
        newCategory: 'beras',
        metadataVersionAfter: 2,
      })
    })
  })

  test('An override on an already-decided flag moves the category and keeps the decision', ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a decided taxonomy flag', async () => {
      await seedFlag(ctx, 'approved')
    })

    when('I set the category to "beras"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras' })
    })

    then("the response should keep the decided flag's decision while the category moves", () => {
      ctx.expectStatus(200)
      const item = ctx.responseBody.item
      // The catalog fix is legitimate on a decided row; the earlier human
      // decision is not overwritten by the settle's pending guard.
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
      expect(item.decidedBy).toBe('admin-early')
      expect(item.itemCategory).toBe('beras')
      expect(item.itemCategorySource).toBe('human')
    })
  })

  test('The admin reverts the latest override, and only once', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has a product with a pending taxonomy flag', async () => {
      await seedFlag(ctx)
    })

    when('I set the category to "beras"', async () => {
      ctx.responseBody = await setCategory(ctx, { category: 'beras' })
      ctx.expectStatus(200)
    })

    then('the response should settle the flag approved with decided_source human', () => {
      const item = ctx.responseBody.item
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
    })

    when('I revert the category with the current metadata version', async () => {
      const version = await readMetadataVersion(ctx)
      await ctx.sendRequestWithBody('DELETE', `${PRODUCT_PATH}/category`, {
        expectedMetadataVersion: version,
      })
    })

    then(
      'the revert should restore the pipeline category and append a compensating revert receipt',
      () => {
        ctx.expectStatus(200)
        expect(ctx.responseBody.product.category).toBe('snack')
        expect(ctx.responseBody.product.categoryVersion).toBe('v0.3')
        expect(ctx.responseBody.product.categorySource).toBeNull()
        expect(ctx.responseBody.product.metadataVersion).toBe(3)
        expect(ctx.responseBody.categoryAudit).toHaveLength(2)
        const revert = ctx.responseBody.categoryAudit[0]
        expect(revert).toMatchObject({
          action: 'revert',
          oldCategory: 'beras',
          oldCategoryVersion: 'v0.4',
          newCategory: 'snack',
          newCategoryVersion: 'v0.3',
          reviewItemId: null,
          revertsAuditId: ctx.responseBody.categoryAudit[1].id,
        })
        // Exactly one more index bump for the revert.
        expect(ctx.responseBody.indexVersion).toBe(2)
      }
    )

    then('the flag decision should be untouched by the revert', async () => {
      // The queue's approved page still carries the settled row — the revert
      // never touches flag rows.
      await ctx.sendRequest('GET', '/api/admin/review?status=approved&reason=taxonomy')
      ctx.expectStatus(200)
      const item = (ctx.responseBody.items ?? []).find((row) => row.id === REVIEW_ID)
      expect(item).toBeTruthy()
      expect(item.status).toBe('approved')
      expect(item.decidedSource).toBe('human')
    })

    when('I try to revert the category again', async () => {
      const version = await readMetadataVersion(ctx)
      await ctx.sendRequestWithBody('DELETE', `${PRODUCT_PATH}/category`, {
        expectedMetadataVersion: version,
      })
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    then('the error code should be stale_revert', () => {
      expect(ctx.responseBody.error).toBe('stale_revert')
    })

    when('I revert the category with an outdated metadata version', async () => {
      await ctx.sendRequestWithBody('DELETE', `${PRODUCT_PATH}/category`, {
        expectedMetadataVersion: 1,
      })
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    then('the error code should be stale_product', () => {
      // The expectedMetadataVersion CAS is the PRIMARY guard: an outdated
      // version answers stale_product (re-read the identity) before the
      // linear-history rule is even consulted.
      expect(ctx.responseBody.error).toBe('stale_product')
    })
  })
})
