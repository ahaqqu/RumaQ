import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/purchases.feature')

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

  test('Create purchase updates stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(
      /I create a purchase with store "([^"]+)" and date "([^"]+)" and items/,
      async (storeId, date, itemsTable) => {
        const items = itemsTable.map((row) => ({
          name: row.name,
          qty: parseFloat(row.qty),
          unit: row.unit,
          price: parseInt(row.price, 10),
        }))
        await ctx.sendRequestWithBody('POST', '/api/purchases', {
          store_id: storeId,
          date,
          items,
        })
      }
    )

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })

    and('the response should have a purchase object', () => {
      ctx.expectPurchaseShape()
    })

    and('the response should have items array', () => {
      ctx.expectItemsArray()
    })

    and('the response should have stock array', () => {
      ctx.expectStockArray()
    })

    and('the stock for "Milk" should have qty 2', () => {
      ctx.expectStockForItem('Milk', 2)
    })

    and('the stock for "Cooking Oil" should have qty 1.5', () => {
      ctx.expectStockForItem('Cooking Oil', 1.5)
    })
  })

  test('Create purchase with new item creates item and stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(
      /I create a purchase with store "([^"]+)" and date "([^"]+)" and items/,
      async (storeId, date, itemsTable) => {
        const items = itemsTable.map((row) => ({
          name: row.name,
          qty: parseFloat(row.qty),
          unit: row.unit,
          price: parseInt(row.price, 10),
        }))
        await ctx.sendRequestWithBody('POST', '/api/purchases', {
          store_id: storeId,
          date,
          items,
        })
      }
    )

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })

    and('the response should have a purchase object', () => {
      ctx.expectPurchaseShape()
    })

    and('the stock for "Tofu" should have qty 3', () => {
      ctx.expectStockForItem('Tofu', 3)
    })
  })

  test('Create purchase with existing item updates qty', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(
      /I create a purchase with store "([^"]+)" and date "([^"]+)" and items/,
      async (storeId, date, itemsTable) => {
        const items = itemsTable.map((row) => ({
          name: row.name,
          qty: parseFloat(row.qty),
          unit: row.unit,
          price: parseInt(row.price, 10),
        }))
        await ctx.sendRequestWithBody('POST', '/api/purchases', {
          store_id: storeId,
          date,
          items,
        })
      }
    )

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })

    and('the stock for "Rice" should have qty 7', () => {
      ctx.expectStockForItem('Rice', 7)
    })
  })

  test('Invalid items schema returns 400', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('Another household cannot access purchase receipt', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('Unauthenticated access to patterns returns 401', ({ given, when, then }) => {
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

  test('List purchases returns history with items', ({ given, when, then, and }) => {
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

    and('the response should have purchases array', () => {
      ctx.expectPurchasesArray()
    })

    and('each purchase should have items', () => {
      ctx.expectEachPurchaseHasItems()
    })

    and('the response should have month_totals', () => {
      ctx.expectMonthTotals()
    })

    and('the response should have avg_per_month', () => {
      ctx.expectAvgPerMonth()
    })

    and('the purchases list should contain seed purchases', () => {
      ctx.expectSeedPurchasesInList()
    })
  })

  test('List purchases filtered by store', ({ given, when, then, and }) => {
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

    and(/^all purchases should be from store "([^"]+)"$/, (label) => {
      ctx.expectAllPurchasesFromStore(label)
    })
  })

  test('List purchases filtered by date range', ({ given, when, then, and }) => {
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

    and(/^all purchases should be within date range (\S+) to (\S+)$/, (from, to) => {
      ctx.expectAllPurchasesInDateRange(from, to)
    })
  })

  test('List purchases filtered by text search', ({ given, when, then, and }) => {
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

    and(/^the purchases should contain items matching "([^"]+)"$/, (name) => {
      ctx.expectPurchasesContainItem(name)
    })
  })

  test('Get single purchase detail', ({ given, when, then, and }) => {
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

    and(/^the purchase detail should be for "([^"]+)"$/, (id) => {
      ctx.expectPurchaseDetail(id)
    })

    and('the purchase detail should have items', () => {
      ctx.expectPurchaseDetailHasItems()
    })
  })

  test('Get non-existent purchase returns 404', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('Get purchase patterns', ({ given, when, then, and }) => {
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

    and('the response should have patterns array', () => {
      ctx.expectPatternsArray()
    })

    and(/^the patterns should contain "([^"]+)"$/, (name) => {
      ctx.expectPatternContains(name)
    })
  })
})
