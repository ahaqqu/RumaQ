import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

// Bulk exact-name alias approval (ahaqqu/RumaQ#515) against the real endpoints.
// The write semantics (selection, receipts, chunking, single gated bump,
// idempotency) are pinned on real SQLite in canonical-products.test.ts; these
// scenarios pin the shipped HTTP contract end-to-end: the auth chain, the read
// endpoint's cache header, the run receipt, and the fact that variants and
// another product's spelling survive the bulk action.
//
// Seeding is scenario-local through the test-only /api/__test/direct-sql
// endpoint (the products-rename.steps.js idiom): the shared seed has no price
// catalog. Miniflare's D1 `exec` runs ONE statement per line, so every
// statement below stays on one line; the index counter is reset so "bumped
// exactly once" is an exact assertion instead of a difference from an unknown
// baseline.

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature(
  'automation/tests/local/api/features/products-alias-bulk-approve.feature'
)

const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const FIRST_PRODUCT_PATH = '/api/admin/products/beras--ramos--5-kg'
const SECOND_PRODUCT_PATH = '/api/admin/products/gula--gulaku--1-kg'
const COUNTS_PATH = '/api/admin/products/aliases/candidates'
const BULK_PATH = '/api/admin/products/aliases/bulk-approve'

// Candidates: three exact-name matches (two for the first product, one for the
// second) and two that must stay manual — a size spelling for product 1, and
// product 1's spelling recorded under product 2. 5 candidates, 3 exact.
const CATALOG_STATEMENTS = [
  'UPDATE canonical_index_state SET version = 0 WHERE id = 1;',
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('prod-bulk-1', 'beras--ramos--5-kg', 'Beras Ramos 5 kg', 'Ramos', '5 kg', 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('prod-bulk-2', 'gula--gulaku--1-kg', 'Gula Pasir Gulaku 1 kg', 'Gulaku', '1 kg', 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
  `INSERT INTO price_product_aliases (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at) VALUES ('alias-exact-lower', 'prod-bulk-1', 'superindo', 'beras ramos 5 kg', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z'), ('alias-exact-upper', 'prod-bulk-1', 'lotte-mart', 'BERAS RAMOS 5 KG', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z'), ('alias-variant-size', 'prod-bulk-1', 'alfamart', 'Beras Ramos 5kg', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z'), ('alias-gula-exact', 'prod-bulk-2', 'superindo', 'gula pasir gulaku 1 kg', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z'), ('alias-cross-product', 'prod-bulk-2', 'indomaret', 'Beras Ramos 5 kg', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z');`,
]

async function directSql(ctx, sql) {
  await ctx.sendRequestWithBody('POST', '/api/__test/direct-sql', { sql })
  expect(ctx.response.status, 'test-only direct-sql seed failed').toBe(200)
}

function aliasStatus(identity, aliasId) {
  return (identity?.aliases ?? []).find((alias) => alias.id === aliasId)?.status
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('The bulk endpoints require an authenticated session', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('I read the alias candidate counts without a session', async () => {
      await ctx.sendRequest('GET', COUNTS_PATH)
    })

    then('the counts read answers 401', () => {
      ctx.expectStatus(401)
    })

    when('I bulk-approve aliases without a session', async () => {
      await ctx.sendRequestDirect('POST', BULK_PATH)
    })

    then('the bulk approve answers 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('The bulk endpoints require an admin', ({ given, and, when, then }) => {
    given('the API is running', () => {})

    and('I am authenticated as a non-admin user', async () => {
      await ctx.resetAndSeed()
      ctx.headers = {
        ...ctx.headers,
        Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }),
      }
    })

    when('I bulk-approve aliases', async () => {
      await ctx.sendRequestDirect('POST', BULK_PATH)
    })

    then('the bulk approve answers 403', () => {
      ctx.expectStatus(403)
    })
  })

  test('One run approves only the exact-name candidates and bumps once', ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has exact-name and variant candidate aliases', async () => {
      await directSql(ctx, CATALOG_STATEMENTS.join('\n'))
    })

    when('I read the alias candidate counts', async () => {
      await ctx.sendRequest('GET', COUNTS_PATH)
    })

    then('the counts read answers 200', () => {
      ctx.expectStatus(200)
    })

    and('the counts report 5 candidate aliases with 3 exact-name matches', () => {
      expect(ctx.responseBody).toEqual({ candidates: 5, exactCandidates: 3 })
    })

    and('the counts response is private and uncached', () => {
      ctx.expectAuthenticatedCacheHeaders()
    })

    when('I bulk-approve the exact-name candidate aliases', async () => {
      await ctx.sendRequestDirect('POST', BULK_PATH)
      ctx.firstRun = ctx.responseBody
    })

    then('the bulk run answers 200', () => {
      ctx.expectStatus(200)
    })

    and('the run reports 3 exact-name matches and 3 approvals with 2 candidates left', () => {
      expect(ctx.firstRun).toEqual({
        exactCandidates: 3,
        approved: 3,
        remainingCandidates: 2,
        indexVersion: 1,
      })
    })

    and('the canonical index version should be 1', () => {
      expect(ctx.firstRun?.indexVersion).toBe(1)
    })

    when("I read the first product's identity", async () => {
      await ctx.sendRequest('GET', FIRST_PRODUCT_PATH)
      ctx.firstIdentity = ctx.responseBody
    })

    then('its exact-name aliases should be approved and its variant still a candidate', () => {
      expect(aliasStatus(ctx.firstIdentity, 'alias-exact-lower')).toBe('approved')
      expect(aliasStatus(ctx.firstIdentity, 'alias-exact-upper')).toBe('approved')
      expect(aliasStatus(ctx.firstIdentity, 'alias-variant-size')).toBe('candidate')
    })

    when("I read the second product's identity", async () => {
      await ctx.sendRequest('GET', SECOND_PRODUCT_PATH)
      ctx.secondIdentity = ctx.responseBody
    })

    then(
      "its own exact-name alias should be approved and the other product's spelling still a candidate",
      () => {
        expect(aliasStatus(ctx.secondIdentity, 'alias-gula-exact')).toBe('approved')
        expect(aliasStatus(ctx.secondIdentity, 'alias-cross-product')).toBe('candidate')
      }
    )

    when('I bulk-approve the exact-name candidate aliases again', async () => {
      await ctx.sendRequestDirect('POST', BULK_PATH)
      ctx.secondRun = ctx.responseBody
    })

    then('the second bulk run answers 200', () => {
      ctx.expectStatus(200)
    })

    and('the second run reports nothing to approve', () => {
      expect(ctx.secondRun).toEqual({
        exactCandidates: 0,
        approved: 0,
        remainingCandidates: 2,
        indexVersion: 1,
      })
    })

    and('the canonical index version should still be 1', () => {
      expect(ctx.secondRun?.indexVersion).toBe(1)
    })
  })
})
