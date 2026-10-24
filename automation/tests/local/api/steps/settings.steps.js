import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/settings.feature')

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

  test('GET settings returns public fields without AI key', ({ given, when, then, and }) => {
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
    and('the settings should include motion_preference and has_ai_key', () => {
      ctx.expectSettingsShape()
    })
    and('has_ai_key should be false', () => {
      ctx.expectHasAiKey(false)
    })
  })

  test('PATCH settings encrypts the AI key', ({ given, when, then, and }) => {
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
    and('has_ai_key should be true', () => {
      ctx.expectHasAiKey(true)
    })
    and('the response should not contain the plain AI key', () => {
      ctx.expectNoAiKeyInResponse()
    })
  })

  test('PATCH settings updates persona', ({ given, when, then, and }) => {
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
    and(/setting "([^"]+)" should be "([^"]+)"/, (field, value) => {
      ctx.expectSetting(field, value)
    })
    and(/setting "([^"]+)" should be true/, (field) => {
      ctx.expectSetting(field, true)
    })
  })

  test('GET settings returns has_ai_key true after key is saved', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('has_ai_key should be true', () => {
      ctx.expectHasAiKey(true)
    })
  })
})
