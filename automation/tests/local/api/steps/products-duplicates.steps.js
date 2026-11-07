import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

// Read-only duplicate-name report (ahaqqu/RumaQ#485) against the real endpoint.
// The grouping, bounds, and read-only guarantee are pinned on real SQLite in
// backend/src/__tests__/canonical-products.test.ts; these scenarios prove the
// shipped HTTP contract answers an admin with the grouped report, hides unique
// names, and honours the bounded limit parameter.
//
// Seeding goes through the test-only /api/__test/direct-sql endpoint (the
// products-rename.steps.js idiom): the shared seed has no price catalog.

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/products-duplicates.feature')

const REPORT_PATH = '/api/admin/products/duplicates'

// Miniflare's D1 `exec` runs ONE statement per line, so every INSERT below is
// a single line; the pair scenario keeps one statement per product for
// readability, the three-group scenario uses one multi-row INSERT.
const PAIR_AND_UNIQUE_SQL = [
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('dup-a', 'duplikat--beras--a', 'Beras Ramos 5 kg', NULL, '5 kg', 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('dup-b', 'duplikat--beras--b', 'beras ramos 5 kg', NULL, '5 kg', 'provisional', 1, '2026-11-02T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-02T00:00:00Z');`,
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('uniq', 'gula--gulaku--1-kg', 'Gula Pasir Gulaku 1 kg', NULL, '1 kg', 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
].join('\n')

const THREE_GROUPS_SQL =
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ` +
  [
    ['g1a', 'duplikat--alpha--1', 'Alpha Widget', '2026-11-01T00:00:00Z'],
    ['g1b', 'duplikat--alpha--2', 'alpha widget', '2026-11-02T00:00:00Z'],
    ['g2a', 'duplikat--beta--1', 'Beta Widget', '2026-11-01T00:00:00Z'],
    ['g2b', 'duplikat--beta--2', 'beta widget', '2026-11-02T00:00:00Z'],
    ['g3a', 'duplikat--gamma--1', 'Gamma Widget', '2026-11-01T00:00:00Z'],
    ['g3b', 'duplikat--gamma--2', 'gamma widget', '2026-11-02T00:00:00Z'],
  ]
    .map(
      ([id, key, name, seen]) =>
        `('${id}', '${key}', '${name}', NULL, NULL, 'provisional', 1, '${seen}', '${seen}', '${seen}')`
    )
    .join(', ') +
  ';'

async function directSql(ctx, sql) {
  await ctx.sendRequestWithBody('POST', '/api/__test/direct-sql', { sql })
  expect(ctx.response.status, 'test-only direct-sql seed failed').toBe(200)
}

function allProductKeys(body) {
  return (body?.groups ?? []).flatMap((group) =>
    group.products.map((product) => product.productKey)
  )
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('The report groups products that share a name case-insensitively', ({
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
      'the catalog has two products sharing a name in different cases and one unique product',
      async () => {
        await directSql(ctx, PAIR_AND_UNIQUE_SQL)
      }
    )

    when('I read the duplicate-name report', async () => {
      await ctx.sendRequest('GET', REPORT_PATH)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
      // Admin-only reads are never cacheable by a shared cache.
      ctx.expectAuthenticatedCacheHeaders()
    })

    and('the report should contain one group with both duplicate product keys', () => {
      const body = ctx.responseBody
      expect(body.limit).toBe(200)
      expect(body.truncated).toBe(false)
      expect(body.groups).toHaveLength(1)

      const [group] = body.groups
      expect(group.normalizedName).toBe('beras ramos 5 kg')
      expect(group.productCount).toBe(2)
      expect(group.products.map((product) => product.productKey).sort()).toEqual([
        'duplikat--beras--a',
        'duplikat--beras--b',
      ])
      for (const product of group.products) {
        expect(product.status).toBe('provisional')
        expect(product.updatedAt).toBeTruthy()
        // Both spellings count as one NOCASE name; no alias was seeded.
        expect(product.stores).toEqual([])
        expect(product.primaryStore).toBeNull()
      }
    })

    and('the report should not contain the unique product', () => {
      expect(allProductKeys(ctx.responseBody).sort()).toEqual([
        'duplikat--beras--a',
        'duplikat--beras--b',
      ])
    })
  })

  test('The report is bounded by the limit parameter', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the catalog has three duplicate-name groups', async () => {
      await directSql(ctx, THREE_GROUPS_SQL)
    })

    when('I read the duplicate-name report with limit 1', async () => {
      await ctx.sendRequest('GET', `${REPORT_PATH}?limit=1`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the report should contain exactly one group marked truncated', () => {
      const body = ctx.responseBody
      expect(body.limit).toBe(1)
      // Three groups exist, the limit lists one: the flag must say the report
      // is partial, never present it as complete.
      expect(body.truncated).toBe(true)
      expect(body.groups).toHaveLength(1)
      expect(body.groups[0].normalizedName).toBe('alpha widget')
      expect(body.groups[0].productCount).toBe(2)
      expect(body.groups[0].products).toHaveLength(2)
    })
  })
})
