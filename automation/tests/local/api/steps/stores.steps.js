import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/stores.feature')

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

  test('Authenticated access returns stores', ({ given, when, then, and }) => {
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
    and('the stores array should have 2 items', () => {
      ctx.expectStoresLength(2)
    })
  })

  test('Create a new store', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })
    and('the created store should have label "New Store"', () => {
      ctx.expectCreatedStoreLabel('New Store')
    })
  })

  test('Delete a store', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when('I create a new store "Test Delete Store"', async () => {
      await ctx.sendRequestWithBody('POST', '/api/stores', { label: 'Test Delete Store' })
    })
    and('I delete the created store', async () => {
      const id = ctx.responseBody?.store?.id || 'store-super'
      await ctx.sendRequest('DELETE', `/api/stores/${id}`)
    })
    then('the response status should be 204', () => {
      expect(ctx.response.status).toBe(204)
    })
  })

  test('Delete nonexistent store returns 404', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when(/I send a (DELETE) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })
})
