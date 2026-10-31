import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/home.feature')

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

  test('Home returns zero stats for a new user', ({ given, when, then, and }) => {
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

    and('the home response should have required stats', () => {
      ctx.expectHomeShape()
    })

    and('the total items should be 3', () => {
      ctx.expectHomeTotalItems(3)
    })

    and('the expiring within 7 days should be 0', () => {
      ctx.expectHomeExpiring7d(0)
    })

    and('there should be items running out within 7 days', () => {
      ctx.expectHomeRunningOutItems()
    })
  })

  test('Home low_stock list has items', ({ given, when, then, and }) => {
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

    and('the low_stock array should have items', () => {
      ctx.expectLowStockArray()
      ctx.expectLowStockLength(1)
    })

    and('each low stock item should have id, name, qty, unit, and location', () => {
      ctx.expectLowStockItemShape()
    })
  })

  test('Home returns current month spending', ({ given, when, then, and }) => {
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

    and('the home response should have required stats', () => {
      ctx.expectHomeShape()
    })

    and('the current month spending should be present', () => {
      ctx.expectHomeSpendingShape()
    })
  })

  test('Home has authenticated cache headers', ({ given, when, then, and }) => {
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

    and('the response should have authenticated cache headers', () => {
      ctx.expectAuthenticatedCacheHeaders()
    })
  })
})
