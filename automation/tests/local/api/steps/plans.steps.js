import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/plans.feature')

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

  test('Generate a plan returns draft items', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('the user has an AI key configured', async () => {
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'gemini',
      })
    })

    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have generated items', () => {
      expect(ctx.responseBody).toHaveProperty('items')
      expect(Array.isArray(ctx.responseBody.items)).toBe(true)
      expect(ctx.responseBody.items.length).toBeGreaterThan(0)
    })

    and('the generated items should have name, qty, unit, and why', () => {
      for (const item of ctx.responseBody.items) {
        expect(item).toHaveProperty('name')
        expect(item).toHaveProperty('qty')
        expect(item).toHaveProperty('unit')
        expect(item).toHaveProperty('why')
      }
    })
  })

  test('Save a plan creates an active plan', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I create a new plan with items/, async (itemsTable) => {
      const items = itemsTable.map((row) => {
        const item = {
          name: row.name,
          qty: parseFloat(row.qty),
          unit: row.unit,
        }
        if (row.store_id) item.store_id = row.store_id
        if (row.price_estimate) item.price_estimate = parseInt(row.price_estimate, 10)
        if (row.why) item.why = row.why
        return item
      })
      await ctx.sendRequestWithBody('POST', '/api/plans', { items })
    })

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })

    and('the response should have a plan object', () => {
      expect(ctx.responseBody).toHaveProperty('plan')
      expect(ctx.responseBody.plan).toHaveProperty('id')
      expect(ctx.responseBody.plan.status).toBe('active')
    })

    and('the plan should have items', () => {
      expect(ctx.responseBody.plan).toHaveProperty('items')
      expect(ctx.responseBody.plan.items.length).toBeGreaterThan(0)
    })
  })

  test('GET /api/plans returns the active plan', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          { name: 'Milk', qty: 2, unit: 'L' },
          { name: 'Eggs', qty: 12, unit: 'pcs' },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have plans array', () => {
      expect(ctx.responseBody).toHaveProperty('plans')
      expect(Array.isArray(ctx.responseBody.plans)).toBe(true)
    })

    and('the first plan should have items', () => {
      expect(ctx.responseBody.plans.length).toBeGreaterThan(0)
      expect(ctx.responseBody.plans[0]).toHaveProperty('items')
      expect(ctx.responseBody.plans[0].items.length).toBeGreaterThan(0)
    })
  })

  test('Marking an item bought updates stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan with items', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          {
            name: 'Milk',
            qty: 2,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 25000,
            why: 'running low',
          },
          {
            name: 'Cooking Oil',
            qty: 1,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 15000,
            why: 'expires soon',
          },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
      ctx.__planId = ctx.responseBody.plan.id
      ctx.__itemId = ctx.responseBody.plan.items[0].id
    })

    when(/I mark the first plan item as "([^"]+)"/, async (status) => {
      await ctx.sendRequestWithBody('PATCH', `/api/plans/${ctx.__planId}/items/${ctx.__itemId}`, {
        status,
      })
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the plan item status should be "bought"', () => {
      expect(ctx.responseBody.item.status).toBe('bought')
    })
  })

  test('Marking an item skipped does not update stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan with items', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          {
            name: 'Milk',
            qty: 2,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 25000,
            why: 'running low',
          },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
      ctx.__planId = ctx.responseBody.plan.id
      ctx.__itemId = ctx.responseBody.plan.items[0].id
    })

    when(/I mark the first plan item as "([^"]+)"/, async (status) => {
      await ctx.sendRequestWithBody('PATCH', `/api/plans/${ctx.__planId}/items/${ctx.__itemId}`, {
        status,
      })
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the plan item status should be "skipped"', () => {
      expect(ctx.responseBody.item.status).toBe('skipped')
    })
  })

  test('Replacing an active plan archives the old one', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [{ name: 'Milk', qty: 2, unit: 'L', why: 'running low' }],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
    })

    when(/I create a new plan with items/, async (itemsTable) => {
      const items = itemsTable.map((row) => ({
        name: row.name,
        qty: parseFloat(row.qty),
        unit: row.unit,
        why: row.why,
      }))
      await ctx.sendRequestWithBody('POST', '/api/plans', { items })
    })

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })

    and(/GET \/api\/plans with status active returns the new plan/, async () => {
      await ctx.sendRequest('GET', '/api/plans?status=active')
      expect(ctx.responseBody.plans.length).toBe(1)
      expect(ctx.responseBody.plans[0].items.length).toBe(1)
      expect(ctx.responseBody.plans[0].items[0].item_name).toBe('Rice')
    })

    and(/GET \/api\/plans with status archived returns the old plan/, async () => {
      await ctx.sendRequest('GET', '/api/plans?status=archived')
      expect(ctx.responseBody.plans.length).toBe(1)
    })
  })

  test('Modifying a non-existent plan item returns 404', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a PATCH request to (\S+) with body/, async (path, body) => {
      await ctx.sendRequestWithBody('PATCH', path, JSON.parse(body))
    })

    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test('Modifying an item on an archived plan returns 400', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan with items', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          {
            name: 'Milk',
            qty: 2,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 25000,
            why: 'running low',
          },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
      ctx.__planId = ctx.responseBody.plan.id
      ctx.__itemId = ctx.responseBody.plan.items[0].id
    })

    when(/I create a new plan with items/, async (itemsTable) => {
      const items = itemsTable.map((row) => ({
        name: row.name,
        qty: parseFloat(row.qty),
        unit: row.unit,
        why: row.why,
      }))
      await ctx.sendRequestWithBody('POST', '/api/plans', { items })
    })

    and(/I mark the first plan item as "([^"]+)"/, async (status) => {
      await ctx.sendRequestWithBody('PATCH', `/api/plans/${ctx.__planId}/items/${ctx.__itemId}`, {
        status,
      })
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('Invalid status query returns 400', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('GET /api/plans?status=active returns active plans', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          { name: 'Milk', qty: 2, unit: 'L' },
          { name: 'Eggs', qty: 12, unit: 'pcs' },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
    })

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have plans array', () => {
      expect(ctx.responseBody).toHaveProperty('plans')
      expect(Array.isArray(ctx.responseBody.plans)).toBe(true)
    })

    and('the first plan should have items', () => {
      expect(ctx.responseBody.plans.length).toBeGreaterThan(0)
      expect(ctx.responseBody.plans[0]).toHaveProperty('items')
      expect(ctx.responseBody.plans[0].items.length).toBeGreaterThan(0)
    })
  })

  test('GET /api/plans?status=archived returns archived plans', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          { name: 'Milk', qty: 2, unit: 'L' },
          { name: 'Eggs', qty: 12, unit: 'pcs' },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
    })

    when(/I create a new plan with items/, async (itemsTable) => {
      const items = itemsTable.map((row) => ({
        name: row.name,
        qty: parseFloat(row.qty),
        unit: row.unit,
      }))
      await ctx.sendRequestWithBody('POST', '/api/plans', { items })
    })

    and(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have plans array', () => {
      expect(ctx.responseBody).toHaveProperty('plans')
      expect(Array.isArray(ctx.responseBody.plans)).toBe(true)
    })

    and('the first plan should be archived', () => {
      expect(ctx.responseBody.plans.length).toBeGreaterThan(0)
      expect(ctx.responseBody.plans[0].status).toBe('archived')
    })
  })

  test('Marking an item bought twice does not duplicate stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    and('there is an active plan with items', async () => {
      await ctx.sendRequestWithBody('POST', '/api/plans', {
        items: [
          {
            name: 'Milk',
            qty: 2,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 25000,
            why: 'running low',
          },
          {
            name: 'Cooking Oil',
            qty: 1,
            unit: 'L',
            store_id: 'store-indo',
            price_estimate: 15000,
            why: 'expires soon',
          },
        ],
      })
      expect(ctx.responseBody?.plan?.status).toBe('active')
      ctx.__planId = ctx.responseBody.plan.id
      ctx.__itemId = ctx.responseBody.plan.items[0].id
    })

    when(/I mark the first plan item as "([^"]+)"/, async (status) => {
      await ctx.sendRequestWithBody('PATCH', `/api/plans/${ctx.__planId}/items/${ctx.__itemId}`, {
        status,
      })
    })

    and(/I mark the first plan item as "([^"]+)"/, async (status) => {
      await ctx.sendRequestWithBody('PATCH', `/api/plans/${ctx.__planId}/items/${ctx.__itemId}`, {
        status,
      })
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and(/GET \/api\/stock shows "([^"]+)" with qty ([\d.]+)/, async (name, qty) => {
      await ctx.sendRequest('GET', '/api/stock')
      ctx.expectStockForItem(name, parseFloat(qty))
    })
  })
})
