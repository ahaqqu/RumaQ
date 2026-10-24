import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/locations.feature')

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

  test('Authenticated access returns locations', ({ given, when, then, and }) => {
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
    and('the locations array should have 3 items', () => {
      ctx.expectLocationsLength(3)
    })
  })

  test('Create a new location', ({ given, when, then, and }) => {
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
    and('the created location should have label "Garage"', () => {
      ctx.expectCreatedLocationLabel('Garage')
    })
  })

  test('Delete a location not referenced by stock', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when('I create a new location "Test Delete"', async () => {
      await ctx.sendRequestWithBody('POST', '/api/locations', { label: 'Test Delete' })
    })
    and('I delete the created location', async () => {
      const id = ctx.responseBody?.location?.id || 'loc-pantry'
      await ctx.sendRequest('DELETE', `/api/locations/${id}`)
    })
    then('the response status should be 204', () => {
      expect(ctx.response.status).toBe(204)
    })
  })

  test('Delete a location referenced by stock returns 409', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    when(/I send a (DELETE) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })
  })

  test('Delete nonexistent location returns 404', ({ given, when, then, and }) => {
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
