import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/rate-limit.feature')

async function seedAiUsage(ctx) {
  const today = new Date().toISOString().slice(0, 10)
  const id = '00000000-0000-0000-0000-000000000099'
  await ctx.sendRequestWithBody('POST', `/api/__test/direct-sql`, {
    sql: `INSERT INTO ai_usage (id, user_id, date, provider, used, daily_limit) VALUES ('${id}', '${ctx.testUserId}', '${today}', 'openai', 20, 20)`,
  })
}

async function sendTestImage(ctx, method, path) {
  const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  await ctx.sendMultipart(method, path, 'image', img, 'receipt.jpg', 'image/jpeg')
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('AI scan with a user key is uncapped when the daily limit is exceeded', ({
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
    and('the user has an AI key configured', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'openai',
      })
    })
    and('the user has exceeded the AI usage limit', async () => {
      await seedAiUsage(ctx)
    })
    when(/I send a (POST) request to (\S+) with a test image/, async (method, path) => {
      await sendTestImage(ctx, method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
  })

  test('AI plan generation with a user key is uncapped when the daily limit is exceeded', ({
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
    and('the user has an AI key configured', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'openai',
      })
    })
    and('the user has exceeded the AI usage limit', async () => {
      await seedAiUsage(ctx)
    })
    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
  })

  test('AI chat with a user key is uncapped when the daily limit is exceeded', ({
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
    and('the user has an AI key configured', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'openai',
      })
    })
    and('the user has exceeded the AI usage limit', async () => {
      await seedAiUsage(ctx)
    })
    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
  })
})
