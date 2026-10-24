import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/ai-chat.feature')

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

  test('No AI key returns 402', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a chat message "([^"]+)"/, async (message) => {
      await ctx.sendRequestWithBody('POST', '/api/ai/chat', {
        message,
      })
    })

    then('the response status should be 402', () => {
      ctx.expectStatus(402)
    })
  })

  test('Chat returns a reply with valid AI key', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('the test user has an AI key configured', async () => {
      await ctx.authenticate()
      await ctx.sendRequestWithBody('PATCH', '/api/settings', {
        ai_key: 'sk-test-key-12345',
        ai_provider: 'openai',
      })
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a chat message "([^"]+)"/, async (message) => {
      await ctx.sendRequestWithBody('POST', '/api/ai/chat', {
        message,
      })
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response should have a chat reply', () => {
      ctx.expectChatReply()
    })
  })
})
