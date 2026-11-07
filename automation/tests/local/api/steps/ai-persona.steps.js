import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

// The persona rewrite's deployed-stack proof (#523 P5): the route's auth
// use-line, the 402 gate and the TEST_MODE echo, through the same Worker +
// D1 the app talks to. Unit tests cover the prompt matrix; this is the one
// place the endpoint is exercised over HTTP with the real auth middleware.
setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/ai-persona.feature')

// The browser's whole request: the two roles, the language and the built-in
// copy — never a prompt, a provider, an endpoint or a key.
const BODY = {
  user_role: 'raja',
  ai_role: 'prajurit',
  language: 'en',
  copy: { homeLead: 'A calmer kitchen starts with what you already have.' },
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('Unauthenticated access returns 401', ({ given, when, then }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    when('I rewrite the persona copy', async () => {
      await ctx.sendRequestWithBody('POST', '/api/ai/generate/persona', BODY)
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('No reasoning assignment returns 402', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I rewrite the persona copy', async () => {
      await ctx.sendRequestWithBody('POST', '/api/ai/generate/persona', BODY)
    })

    then('the response status should be 402', () => {
      ctx.expectStatus(402)
    })
  })

  test('A configured household gets its own copy echoed back', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('the test user has a provider configured', async () => {
      await ctx.authenticate()
      await ctx.configureAi(['reasoning'])
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when('I rewrite the persona copy', async () => {
      await ctx.sendRequestWithBody('POST', '/api/ai/generate/persona', BODY)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the rewritten copy should echo the built-in strings', () => {
      // TEST_MODE: the route hands back the copy it was sent (no provider call).
      expect(ctx.responseBody.copy).toEqual(BODY.copy)
    })

    and('the response should be private and uncached', () => {
      ctx.expectAuthenticatedCacheHeaders()
    })
  })
})
