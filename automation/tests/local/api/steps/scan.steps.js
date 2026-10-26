import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/scan.feature')

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('Unauthenticated access returns 401', ({ given, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Scan returns parsed items with AI key configured', ({ given, when, then, and }) => {
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

    when('I upload a receipt image for scanning', async () => {
      const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
      await ctx.sendMultipart(
        'POST',
        '/api/purchases/scan',
        'image',
        img,
        'receipt.jpg',
        'image/jpeg'
      )
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should contain parsed items', () => {
      ctx.expectScanItems()
    })

    and('the response should contain an imageKey', () => {
      ctx.expectImageKey()
    })

    and('the store guess should be "Indomaret"', () => {
      ctx.expectStoreGuess('Indomaret')
    })
  })

  test('Scan without AI key returns 402', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('the user has no AI key configured', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_provider: null,
      })
    })

    when(/I send a (POST) request to (\S+) with a test image/, async (_method, _path) => {
      const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
      await ctx.sendMultipart(
        'POST',
        '/api/purchases/scan',
        'image',
        img,
        'receipt.jpg',
        'image/jpeg'
      )
    })

    then('the response status should be 402', () => {
      ctx.expectStatus(402)
    })
  })

  test('Scan with a user key is uncapped when the daily limit is exceeded', ({
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

    and('the user has exceeded the AI usage limit', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'gemini',
      })
      const today = new Date().toISOString().slice(0, 10)
      const id = '00000000-0000-0000-0000-000000000099'
      await ctx.sendRequestWithBody('POST', `/api/__test/direct-sql`, {
        sql: `INSERT INTO ai_usage (id, user_id, date, provider, used, daily_limit) VALUES ('${id}', '${ctx.testUserId}', '${today}', 'gemini', 20, 20)`,
      })
    })

    when(/I send a (POST) request to (\S+) with a test image/, async (_method, _path) => {
      const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
      await ctx.sendMultipart(
        'POST',
        '/api/purchases/scan',
        'image',
        img,
        'receipt.jpg',
        'image/jpeg'
      )
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
  })

  test('Scan with non-image file returns 400', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I upload a non-image file for scanning', async () => {
      const txt = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
      await ctx.sendMultipart('POST', '/api/purchases/scan', 'image', txt, 'test.txt', 'text/plain')
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })
})
