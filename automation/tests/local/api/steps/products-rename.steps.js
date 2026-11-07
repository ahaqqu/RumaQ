import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

// Admin canonical rename/revert (ahaqqu/RumaQ#423) against the real endpoints.
// The unit + real-SQLite suites pin the write semantics; these scenarios pin
// the shipped HTTP contract end-to-end: the auth chain, the 400/404/409
// mapping, the alias approval a rename performs, and the compensating revert.
//
// Seeding is scenario-local through the test-only /api/__test/direct-sql
// endpoint (the ai-usage.steps.js idiom): the shared seed has no price catalog,
// so the canonical product, its per-store candidate aliases, the observations
// behind its stats, and the index baseline are written here. `reset` runs
// first (inside "I am authenticated as an admin"), so every scenario starts
// from the same catalog.

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/products-rename.feature')

const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const PRODUCT_KEY = 'beras--ramos--5-kg'
const PRODUCT_PATH = `/api/admin/products/${PRODUCT_KEY}`
const OLD_NAME = 'Beras Ramos 5 kg'
const NEW_NAME = 'Beras Ramos 5 kg Premium'
const OTHER_GULA = 'Gula Pasir Gulaku 1 kg'
const OTHER_SUPER = 'Beras Ramos 5 kg Super'

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function otherProductKey(name) {
  return `other--${slugify(name)}`
}

// Miniflare's D1 `exec` runs ONE statement per line — a statement folded over
// several lines fails with "incomplete input". Every statement below is a
// single line; statements are joined by newlines (the worker-server's own
// flattenSql does the same for migrations). The canonical index counter is
// reset to 0 so "bumped exactly once per write" is an exact assertion instead
// of a difference from an unknown baseline.
const CATALOG_STATEMENTS = [
  'UPDATE canonical_index_state SET version = 0 WHERE id = 1;',
  `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('prod-rename-1', '${PRODUCT_KEY}', '${OLD_NAME}', 'Ramos', '5 kg', 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`,
  `INSERT INTO price_sources (id, slug, name) VALUES ('src-superindo', 'superindo', 'Superindo'), ('src-lotte', 'lotte-mart', 'Lotte Mart');`,
  // One candidate alias per observing store, both carrying the old wording:
  // the rename approves exactly these rows.
  `INSERT INTO price_product_aliases (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at) VALUES ('alias-superindo', 'prod-rename-1', 'superindo', '${OLD_NAME}', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-06T00:00:00Z'), ('alias-lotte', 'prod-rename-1', 'lotte-mart', '${OLD_NAME}', 'candidate', 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z');`,
  `INSERT INTO price_observations (id, product_id, source_id, observed_date, price, match_confidence, scraped_at) VALUES ('obs-rename-1', 'prod-rename-1', 'src-superindo', '2026-11-06', 23000, 1.0, '2026-11-06T00:00:00Z'), ('obs-rename-2', 'prod-rename-1', 'src-lotte', '2026-11-07', 22500, 1.0, '2026-11-07T00:00:00Z');`,
]

async function directSql(ctx, sql) {
  await ctx.sendRequestWithBody('POST', '/api/__test/direct-sql', { sql })
  expect(ctx.response.status, 'test-only direct-sql seed failed').toBe(200)
}

async function seedCatalog(ctx) {
  await directSql(ctx, CATALOG_STATEMENTS.join('\n'))
}

async function insertNamedProduct(ctx, name) {
  const key = otherProductKey(name)
  await directSql(
    ctx,
    `INSERT INTO price_products (id, product_key, name, brand, unit, status, metadata_version, first_seen_at, last_seen_at, updated_at) VALUES ('${key}', '${key}', '${name}', NULL, NULL, 'provisional', 1, '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z');`
  )
}

async function readIdentity(ctx) {
  await ctx.sendRequest('GET', PRODUCT_PATH)
  expect(ctx.response.status).toBe(200)
  return ctx.responseBody
}

async function rename(ctx, body) {
  await ctx.sendRequestWithBody('POST', `${PRODUCT_PATH}/rename`, body)
  return ctx.responseBody
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('The product identity endpoint requires an authenticated session', ({
    given,
    when,
    then,
  }) => {
    given('the API is running', () => {})

    when('I read an admin product identity without a session', async () => {
      ctx.response = await fetch(`${ctx.baseUrl}${PRODUCT_PATH}`)
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

  test('The product identity endpoint requires an admin', ({ given, and, when, then }) => {
    given('the API is running', () => {})

    and('I am authenticated as a non-admin user', async () => {
      // Reset + seed here, not in the scenario: the seeded second user is
      // what makes the cookie's 403 an AUTHORIZATION answer instead of a 401
      // from a missing account, and this file must not depend on whichever
      // suite happened to leave users behind.
      await ctx.resetAndSeed()
      ctx.headers = {
        ...ctx.headers,
        Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }),
      }
    })

    when('I read an admin product identity', async () => {
      await ctx.sendRequest('GET', PRODUCT_PATH)
    })

    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
  })

  test('An invalid rename body is rejected', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    when('I send a rename without a canonical name', async () => {
      await rename(ctx, { expectedMetadataVersion: 1 })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('A blank canonical name is rejected', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    when('I rename the product to a blank name', async () => {
      await rename(ctx, { canonicalName: '   ', expectedMetadataVersion: 1 })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('An unknown product cannot be renamed', ({ given, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I rename an unknown product', async () => {
      await ctx.sendRequestWithBody('POST', '/api/admin/products/nope--x--1-kg/rename', {
        canonicalName: 'Some Name',
        expectedMetadataVersion: 1,
      })
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('A stale metadata version cannot overwrite a newer write', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    when('I rename the product with an outdated metadata version', async () => {
      await rename(ctx, { canonicalName: NEW_NAME, expectedMetadataVersion: 0 })
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    and('the error code should be stale_product with the current name and version', () => {
      expect(ctx.responseBody).toMatchObject({
        error: 'stale_product',
        current: { name: OLD_NAME, metadataVersion: 1 },
      })
    })
  })

  test('A duplicate canonical name is refused', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    and(/^the catalog has another product named "([^"]+)"$/, async (name) => {
      await insertNamedProduct(ctx, name)
    })

    when(/^I rename the product to "([^"]+)"$/, async (name) => {
      await rename(ctx, { canonicalName: name, expectedMetadataVersion: 1 })
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    and('the error code should be duplicate_name with the conflicting product', () => {
      expect(ctx.responseBody).toMatchObject({
        error: 'duplicate_name',
        conflicts: [
          {
            productKey: otherProductKey(OTHER_GULA),
            name: OTHER_GULA,
            source: 'product',
          },
        ],
      })
    })
  })

  test('A similar name warns until the admin acknowledges it', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    and(/^the catalog has another product named "([^"]+)"$/, async (name) => {
      await insertNamedProduct(ctx, name)
    })

    when(/^I rename the product to "([^"]+)"$/, async (name) => {
      await rename(ctx, { canonicalName: name, expectedMetadataVersion: 1 })
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    and('the error code should be similar_name with at least one warning', () => {
      expect(ctx.responseBody?.error).toBe('similar_name')
      expect(ctx.responseBody?.warnings?.length ?? 0).toBeGreaterThanOrEqual(1)
      expect(ctx.responseBody.warnings[0]).toMatchObject({
        productKey: otherProductKey(OTHER_SUPER),
        name: OTHER_SUPER,
      })
    })

    when(/^I rename the product to "([^"]+)" acknowledging the warnings$/, async (name) => {
      const body = await rename(ctx, {
        canonicalName: name,
        expectedMetadataVersion: 1,
        acknowledgeWarnings: true,
      })
      // The success body returns the warnings it overrode, not an empty list.
      expect(ctx.response.status).toBe(200)
      expect(body?.warnings?.length ?? 0).toBeGreaterThanOrEqual(1)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the rename should return the acknowledged warnings', () => {
      expect(ctx.responseBody.product).toMatchObject({
        name: 'Beras Ramos 5 kg Super Extra',
        status: 'provisional',
      })
      expect(ctx.responseBody.warnings[0]).toMatchObject({ name: OTHER_SUPER })
    })
  })

  test('An admin renames a product, then reverts the latest rename', ({
    given,
    and,
    when,
    then,
  }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('the canonical catalog has a product with candidate aliases', async () => {
      await seedCatalog(ctx)
    })

    when('I read the product identity', async () => {
      ctx.identity = await readIdentity(ctx)
    })

    then('the identity should carry the product, its aliases, stats, and an empty audit', () => {
      expect(ctx.identity.product).toMatchObject({
        productKey: PRODUCT_KEY,
        name: OLD_NAME,
        status: 'provisional',
        metadataVersion: 1,
      })
      expect(ctx.identity.aliases).toHaveLength(2)
      expect(ctx.identity.aliases.map((alias) => alias.status)).toEqual(['candidate', 'candidate'])
      expect(ctx.identity.stats).toEqual({ observations: 2, stores: 2 })
      expect(ctx.identity.audit).toEqual([])
    })

    when('I rename the product with the current metadata version', async () => {
      const currentVersion = ctx.identity.product.metadataVersion
      ctx.renameResult = await rename(ctx, {
        canonicalName: NEW_NAME,
        expectedMetadataVersion: currentVersion,
        reason: 'label fix',
      })
      ctx.renameAuditId = ctx.renameResult?.audit?.[0]?.id
    })

    then(
      'the rename should return the new name, one rename audit row, and a bumped index version',
      () => {
        expect(ctx.renameResult.product).toMatchObject({ name: NEW_NAME, metadataVersion: 2 })
        expect(ctx.renameResult.audit).toHaveLength(1)
        expect(ctx.renameResult.audit[0]).toMatchObject({
          action: 'rename',
          oldName: OLD_NAME,
          newName: NEW_NAME,
          reason: 'label fix',
          metadataVersionBefore: 1,
          metadataVersionAfter: 2,
        })
        // The seed set the index baseline to 0: one write, one bump.
        expect(ctx.renameResult.indexVersion).toBe(1)
      }
    )

    and('the product status should still be provisional', () => {
      expect(ctx.renameResult.product.status).toBe('provisional')
    })

    when('I read the product identity again', async () => {
      ctx.identityAfterRename = await readIdentity(ctx)
    })

    then('the old wording should be an approved alias for each store that observed it', () => {
      const aliases = ctx.identityAfterRename.aliases
      expect(aliases).toHaveLength(2)
      for (const alias of aliases) {
        expect(alias.name).toBe(OLD_NAME)
        expect(alias.status).toBe('approved')
      }
      expect(aliases.map((alias) => alias.storeSlug).sort()).toEqual(['lotte-mart', 'superindo'])
      expect(ctx.identityAfterRename.product.name).toBe(NEW_NAME)
    })

    when('I revert the latest rename', async () => {
      expect(ctx.renameAuditId).toBeTruthy()
      await ctx.sendRequestWithBody('POST', `${PRODUCT_PATH}/audit/${ctx.renameAuditId}/revert`, {})
      expect(ctx.response.status).toBe(200)
      ctx.revertResult = ctx.responseBody
    })

    then(
      'the revert should restore the original name and append a compensating revert audit row',
      () => {
        expect(ctx.revertResult.product).toMatchObject({ name: OLD_NAME, metadataVersion: 3 })
        const [latest] = ctx.revertResult.audit
        expect(latest).toMatchObject({
          action: 'revert',
          oldName: NEW_NAME,
          newName: OLD_NAME,
          revertsAuditId: ctx.renameAuditId,
        })
      }
    )

    and('the canonical index version should have advanced exactly once per write', () => {
      // rename: 0 -> 1; revert: 1 -> 2. Two writes, two bumps, no more.
      expect(ctx.renameResult.indexVersion).toBe(1)
      expect(ctx.revertResult.indexVersion).toBe(2)
    })

    when('I try to revert the same rename again', async () => {
      await ctx.sendRequestWithBody('POST', `${PRODUCT_PATH}/audit/${ctx.renameAuditId}/revert`, {})
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    and('the error code should be stale_revert', () => {
      expect(ctx.responseBody).toEqual({ error: 'stale_revert' })
    })
  })
})
