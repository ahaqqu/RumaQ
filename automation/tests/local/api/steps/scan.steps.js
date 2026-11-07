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

  test('Scan returns parsed items with a provider configured', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('the user has a provider configured', async () => {
      // #523 P3: a vision-capable provider is what the scan path resolves.
      await ctx.configureAi(['vision'])
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

  test('Scan without a provider returns 402', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('the user has no provider configured', async () => {
      // #523 P3: the fresh household starts with no provider and no capability
      // assignment (there is no server default to fall back to, D7/D8), so the
      // reset above already left the door closed.
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

  // "Scan under heavy usage stays uncapped" lives in ai-usage.feature — the
  // cross-route cap-removal guard (issue #353).

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
