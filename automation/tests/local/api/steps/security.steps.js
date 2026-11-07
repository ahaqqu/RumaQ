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

  test('AI key material never leaves the provider store', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and('the user has a provider configured for "reasoning"', async () => {
      // A real row with a real (encrypted) key is what makes the assertion
      // meaningful: the payload must never carry it back.
      await ctx.configureAi(['reasoning'])
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
    and('the provider list reports a key without exposing it', async () => {
      // The list is the other read a key could leak through, so the scenario
      // follows the pointer to it: presence signalled, material never.
      await ctx.sendRequest('GET', '/api/ai/providers')
      ctx.expectStatus(200)
      expect(ctx.responseBody.providers).toHaveLength(1)
      expect(ctx.responseBody.providers[0].has_key).toBe(true)
      ctx.expectNoKeyMaterialInResponse()
      expect(JSON.stringify(ctx.responseBody)).not.toContain('sk-test-key-12345')
    })
  })

  // ahaqqu/RumaQ#528: the Origin guard is exercised through the real stack —
  // the same proxy headers a browser request carries decide the own origin.
  test('A cross-origin cookie write is rejected', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and(/^the request Origin is "(.+)"$/, (origin) => {
      ctx.headers = { ...ctx.headers, Origin: origin }
    })
    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
    and('the response body should match', (body) => {
      ctx.expectBodyToMatch(JSON.parse(body))
    })
    // 403 is not enough: the write must not have landed. The list is read back
    // through the same authenticated context (same Origin in ctx.headers, which
    // is harmless on a GET — the guard only scopes POST/PUT/PATCH/DELETE).
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })
    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })
    and(/^the locations list should not contain "(.+)"$/, (label) => {
      expect(JSON.stringify(ctx.responseBody)).not.toContain(label)
    })
  })

  test("A cookie write from the app's own origin still works", ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })
    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })
    and(/^the request Origin is "(.+)"$/, (origin) => {
      ctx.headers = { ...ctx.headers, Origin: origin }
    })
    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })
  })

  test('A cookie write with no Origin (scripted admin) still works', ({
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
    when(/I send a (POST) request to (\S+) with body/, async (method, path, body) => {
      await ctx.sendRequestWithBody(method, path, JSON.parse(body))
    })
    then('the response status should be 201', () => {
      ctx.expectStatus(201)
    })
  })
})
