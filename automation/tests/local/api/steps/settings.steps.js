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

  test('GET settings returns preferences and an empty AI block', ({ given, when, then, and }) => {
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
    and('the settings should include motion_preference and the AI block', () => {
      ctx.expectSettingsShape()
    })
    and('every AI capability should be not configured', () => {
      for (const capability of ['decision', 'reasoning', 'vision']) {
        ctx.expectAiStatus(capability, 'none')
      }
    })
    and('the response should not contain key material', () => {
      ctx.expectNoKeyMaterialInResponse()
    })
  })

  test('PATCH settings rejects the retired AI key fields', ({ given, when, then, and }) => {
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

  test('A configured provider and capability show up in GET settings', ({
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
    and('the user has a provider configured for "reasoning"', async () => {
      await ctx.configureAi(['reasoning'])
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the settings should include motion_preference and the AI block', () => {
      ctx.expectSettingsShape()
    })
    and('the reasoning capability should resolve to a household provider', () => {
      ctx.expectAiStatus('reasoning', 'household')
    })
    and('the response should not contain key material', () => {
      ctx.expectNoKeyMaterialInResponse()
    })
  })
})
