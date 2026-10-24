import { describe, test as it } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/health.feature')

defineFeature(feature, (test) => {
  test('Health check returns ok', ({ given, when, then, and }) => {
    const ctx = new ApiContext()

    given('the API is running', () => {})

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response body should contain { ok: true }', () => {
      ctx.expectBodyToMatch({ ok: true })
    })
  })

  test('Health check returns public cache headers', ({ given, when, then, and }) => {
    const ctx = new ApiContext()

    given('the API is running', () => {})

    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have public cache headers with max-age=60', () => {
      ctx.expectPublicCacheHeaders()
    })
  })
})
