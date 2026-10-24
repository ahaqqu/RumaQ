import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/auth.feature')

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('Logout clears the session', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    and('I am authenticated as a test user', async () => {
      await ctx.authenticate()
    })

    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response body should contain { ok: true }', () => {
      ctx.expectBodyToMatch({ ok: true })
    })
  })

  test('Email login sets session cookie', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    when(/I login via email as "([^"]+)" with password "([^"]+)"/, async (email, password) => {
      await ctx.authenticateViaEmail(email, password)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response body should contain { ok: true }', () => {
      ctx.expectBodyToMatch({ ok: true })
    })

    and('a session cookie should be set', () => {
      expect(ctx.headers).toBeDefined()
      expect(ctx.headers.Cookie).toMatch(/^rumaq_session=/)
    })
  })

  test('Email logout clears session', ({ given, when, then, and }) => {
    given('the database has seed data', async () => {
      await ctx.resetAndSeed()
    })

    when(/I login via email as "([^"]+)" with password "([^"]+)"/, async (email, password) => {
      await ctx.authenticateViaEmail(email, password)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    when(/I send a (POST) request to (\S+)/, async (method, path) => {
      await ctx.sendRequest(method, path)
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    and('the response body should contain { ok: true }', () => {
      ctx.expectBodyToMatch({ ok: true })
    })
  })

  test('Login redirects to Google', ({ when, then, and }) => {
    when(/I send a (GET) request to (\S+)/, async (method, path) => {
      ctx.response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: ctx.headers,
      })
      ctx.responseBody = null
    })

    then('the response status should be 302', () => {
      ctx.expectStatus(302)
    })

    and('the Location header should point to accounts.google.com', () => {
      const location = ctx.response.headers.get('Location') || ''
      expect(location).toContain('accounts.google.com')
    })
  })
})
