import { describe, test as it, beforeEach } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/security.feature')

const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test("User A cannot read User B's stock", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the stock array should be empty', () => {
      expect(ctx.responseBody?.stock).toEqual([])
    })
  })

  test("User A cannot modify User B's stock", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (PATCH) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test("User A cannot read User B's locations", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the locations array should be empty', () => {
      expect(ctx.responseBody?.locations).toEqual([])
    })
  })

  test("User A cannot read User B's stores", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the stores array should be empty', () => {
      expect(ctx.responseBody?.stores).toEqual([])
    })
  })

  test("User A cannot read User B's purchases", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the purchases array should be empty', () => {
      expect(ctx.responseBody?.purchases).toEqual([])
    })
  })

  test("User A cannot read User B's purchase receipt", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 404', () => {
      ctx.expectStatus(404)
    })
  })

  test("User A cannot read User B's plans", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a second test user', async () => {
      ctx.headers = { Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }) }
    })
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and('the plans array should be empty', () => {
      expect(ctx.responseBody?.plans).toEqual([])
    })
  })

  test('Settings response never contains AI key material', ({ given, when, then, and }) => {
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
    and('the response should not contain encrypted_ai_key', () => {
      expect(ctx.responseBody).not.toHaveProperty('encrypted_ai_key')
    })
    and('the response should not contain ai_key', () => {
      expect(ctx.responseBody).not.toHaveProperty('ai_key')
    })
  })
})
