import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { JPEG_IMAGE_BYTES } from '../../../support/image-fixtures.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/ai-usage.feature')

// Seed n completed-call events for the test user, right now, so the 24h range
// includes them. Volume is deliberately irrelevant — usage must never gate a
// call (issue #353) — so the tokens are large on purpose.
async function seedUsageEvents(ctx, n) {
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  for (let i = 0; i < n; i += 1) {
    const id = `00000000-0000-0000-0001-${String(i).padStart(12, '0')}`
    // Single line: the test D1 shim's exec() splits statements on newlines.
    // #523 P3: rows carry the capability + funding dimensions now; the retired
    // `key_source` column is left NULL like the pre-0041 history.
    await ctx.sendRequestWithBody('POST', `/api/__test/direct-sql`, {
      sql: `INSERT INTO ai_usage_events (id, user_id, ts, date, provider, model, input_tokens, output_tokens, cached_tokens, capability, funding) VALUES ('${id}', '${ctx.testUserId}', '${now}', '${today}', 'gemini', 'test-model', 1000, 300, 700, 'reasoning', 'household')`,
    })
    if (ctx.response.status !== 200) {
      throw new Error(`seeding usage event ${i} failed: ${JSON.stringify(ctx.responseBody)}`)
    }
  }
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('Unauthenticated access returns 401', ({ given, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('GET usage returns zeroed uncapped totals for a new user', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('usage should show zeroed totals with no daily limit', () => {
      ctx.expectUsageDefaults()
    })
  })

  test('A completed chat call is recorded exactly once', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and('the user has a provider configured', async () => {
      // #523 P3: the household's own provider row is what makes a call possible;
      // the legacy settings ai_key write is retired with its columns.
      await ctx.configureAi(['decision', 'reasoning', 'vision'])
    })
    when(/I send a chat message "([^"]+)"/, async (message) => {
      await ctx.sendRequestWithBody('POST', '/api/ai/chat', { message })
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('GET usage shows 1 recorded call today', async () => {
      await ctx.sendRequest('GET', '/api/ai/usage')
      ctx.expectUsageUsed(1)
    })
  })

  test('Heavy recorded usage never blocks AI calls', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and('the user has a provider configured', async () => {
      // #523 P3: the household's own provider row is what makes a call possible;
      // the legacy settings ai_key write is retired with its columns.
      await ctx.configureAi(['decision', 'reasoning', 'vision'])
    })
    and('the user already has 5 usage events today', async () => {
      await seedUsageEvents(ctx, 5)
    })
    when(/I send a chat message "([^"]+)"/, async (message) => {
      await ctx.sendRequestWithBody('POST', '/api/ai/chat', { message })
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    when('I upload a receipt image for scanning', async () => {
      await ctx.sendMultipart(
        'POST',
        '/api/purchases/scan',
        'image',
        JPEG_IMAGE_BYTES,
        'receipt.jpg',
        'image/jpeg'
      )
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
  })

  test('Admin usage endpoint returns totals and per-user rows for an admin', ({
    given,
    when,
    then,
    and,
  }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and('the user already has 3 usage events today', async () => {
      await seedUsageEvents(ctx, 3)
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the admin usage shows 3 calls for the test user', () => {
      // 3 seeded events: input 3000, cached 2100 → exact 0.7 hit rate.
      ctx.expectBodyToMatch({
        range: '24h',
        totals: {
          calls: 3,
          input_tokens: 3000,
          output_tokens: 900,
          cached_tokens: 2100,
          cache_hit_rate: 0.7,
        },
        users: [{ user_id: ctx.testUserId, email: 'test@rumaq.dev', calls: 3 }],
      })
    })
  })

  test('Admin usage endpoint returns 403 for a non-admin', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and('the test user is not an admin', async () => {
      await ctx.sendRequestWithBody('POST', `/api/__test/direct-sql`, {
        sql: `UPDATE users SET is_admin = 0 WHERE id = '${ctx.testUserId}'`,
      })
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
  })
})
