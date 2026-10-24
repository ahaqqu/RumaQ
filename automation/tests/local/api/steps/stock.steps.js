import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/stock.feature')

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

  test('Authenticated access returns stock', ({ given, when, then, and }) => {
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

    and('the response should contain a stock array', () => {
      ctx.expectStockArray()
    })

    and('the stock array should have 3 items', () => {
      ctx.expectStockLength(3)
    })
  })

  test('Each stock item has required fields', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then(/each item should have id, name, qty, unit, and location/, () => {
      ctx.expectItemShape()
    })
  })

  test('Filter stock by location', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(
      /I send a (GET) request to \/api\/stock with location "([^"]+)"/,
      async (method, location) => {
        await ctx.sendRequest('GET', `/api/stock?location=${location}`)
      }
    )

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the stock array should have 1 item', () => {
      ctx.expectStockLength(1)
    })

    and('the first item should be named "Cooking Oil"', () => {
      ctx.expectNamedFirstItem('Cooking Oil')
    })
  })

  test('Search stock by name', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to \/api\/stock with q "([^"]+)"/, async (method, q) => {
      await ctx.sendRequest('GET', `/api/stock?q=${q}`)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the stock array should have 1 item', () => {
      ctx.expectStockLength(1)
    })

    and('the first item should be named "Eggs"', () => {
      ctx.expectNamedFirstItem('Eggs')
    })
  })

  test('Stock is ordered by urgency', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the items should be ordered by run_out_days ascending', () => {
      ctx.expectOrderedByRunOutDays()
    })
  })

  test('PATCH stock updates quantity and recalculates run-out', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the stock item should have qty 1', () => {
      ctx.expectStockUpdatedQty(1)
    })

    and('the stock item should have run_out_days computed', () => {
      ctx.expectStockRunOutComputed()
    })
  })

  test('PATCH stock with another household stock returns 404', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('PATCH stock validates schema rejects negative qty', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('PATCH stock with invalid location returns 400', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('Authenticated stock response has per-user cache headers', ({ given, when, then, and }) => {
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
