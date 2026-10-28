import { describe, test as it, beforeEach, expect } from 'vite-plus/test'
import { setJestCucumberConfiguration, loadFeature, defineFeature } from 'jest-cucumber'
import { ApiContext } from './helpers.js'
import { signTestCookie } from '../../../support/auth.js'

setJestCucumberConfiguration({ runner: { describe, test: it } })

const feature = loadFeature('automation/tests/local/api/features/scrape.feature')

// Mirrors HAQITA_INGEST_SECRET in automation/tests/support/worker-server.mjs.
const INGEST_SECRET = 'test-ingest-secret'
const SECOND_USER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

function authHeaders(ctx) {
  return { ...ctx.headers, 'Content-Type': 'application/json' }
}

async function queueScrape(ctx, stores, { session = true } = {}) {
  const headers = session ? authHeaders(ctx) : { 'Content-Type': 'application/json' }
  ctx.response = await fetch(`${ctx.baseUrl}/api/admin/scrape`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ stores }),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

async function claimNext(ctx, bearer = INGEST_SECRET) {
  ctx.response = await fetch(`${ctx.baseUrl}/api/internal/scrape/next`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

async function postEvents(ctx, commandId, events, bearer = INGEST_SECRET) {
  ctx.response = await fetch(`${ctx.baseUrl}/api/internal/scrape/commands/${commandId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ events }),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

async function postFinish(ctx, commandId, body, bearer = INGEST_SECRET) {
  ctx.response = await fetch(`${ctx.baseUrl}/api/internal/scrape/commands/${commandId}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
  try {
    ctx.responseBody = await ctx.response.json()
  } catch {
    ctx.responseBody = null
  }
}

function twoEvents() {
  return [
    { seq: 0, ts: '2026-10-28T01:00:00Z', level: 'info', message: '[pipeline] starting superindo' },
    { seq: 1, ts: '2026-10-28T01:00:05Z', level: 'info', message: '[pipeline] astro: 3 items' },
  ]
}

/** Drives pending → running → success exactly like the VPS agent does. */
async function runFullLifecycle(ctx) {
  await queueScrape(ctx, ['superindo', 'astro'])
  expect(ctx.response.status).toBe(201)
  ctx.commandId = ctx.responseBody.id
  await claimNext(ctx)
  ctx.claimed = ctx.responseBody.command
  expect(ctx.claimed).not.toBeNull()
  await postEvents(ctx, ctx.commandId, twoEvents())
  await postFinish(ctx, ctx.commandId, { status: 'success', exitCode: 0, error: null })
}

defineFeature(feature, (test) => {
  let ctx

  beforeEach(() => {
    ctx = new ApiContext()
  })

  test('Queueing a scrape requires an authenticated session', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('I queue a scrape of the superindo store without a session', async () => {
      await queueScrape(ctx, ['superindo'], { session: false })
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('Queueing a scrape requires an admin', ({ given, and, when, then }) => {
    given('the API is running', () => {})

    and('I am authenticated as a non-admin user', async () => {
      ctx.headers = {
        ...ctx.headers,
        Cookie: await signTestCookie(SECOND_USER_ID, { email: 'second@rumaq.dev' }),
      }
    })

    when('I queue a scrape of the superindo store', async () => {
      await queueScrape(ctx, ['superindo'])
    })

    then('the response status should be 403', () => {
      ctx.expectStatus(403)
    })
  })

  test('The agent needs the bearer secret to claim commands', ({ given, when, then }) => {
    given('the API is running', () => {})

    when('the agent polls for the next scrape command with a wrong bearer token', async () => {
      await claimNext(ctx, 'wrong-secret')
    })

    then('the response status should be 401', () => {
      ctx.expectStatus(401)
    })
  })

  test('An unknown store slug is rejected', ({ given, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I queue a scrape of an unknown store', async () => {
      await queueScrape(ctx, ['tokopedia'])
    })

    then('the response status should be 400', () => {
      ctx.expectStatus(400)
    })
  })

  test('The full agent lifecycle from queue to live log', ({ given, when, then, and }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    when('I queue a scrape of the superindo and astro stores', async () => {
      await queueScrape(ctx, ['superindo', 'astro'])
      ctx.commandId = ctx.responseBody.id
    })

    then('the response status should be 201', () => {
      ctx.expectStatus(201)
      expect(ctx.commandId).toBeDefined()
    })

    and('the stores endpoint should list every contract store', async () => {
      await ctx.sendRequest('GET', '/api/admin/scrape/stores')
      ctx.expectStatus(200)
      expect(ctx.responseBody.stores).toEqual(['superindo', 'lotte-mart', 'astro'])
      ctx.expectAuthenticatedCacheHeaders()
    })

    when('a second scrape is queued while the first is pending', async () => {
      await queueScrape(ctx, ['lotte-mart'])
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })

    and('a second queue attempt while running should also return 409', async () => {
      await claimNext(ctx)
      ctx.claimed = ctx.responseBody.command
      expect(ctx.claimed).toMatchObject({ id: ctx.commandId })
      await queueScrape(ctx, ['lotte-mart'])
      ctx.expectStatus(409)
    })

    when('the agent claims the next scrape command', async () => {
      // Already claimed in the 409-while-running check above; re-verify the
      // shape here so this step stays the lifecycle's claim reference.
      expect(ctx.claimed).toMatchObject({ id: ctx.commandId })
    })

    then('the claimed command should carry the requested stores', () => {
      expect(ctx.claimed.stores).toEqual(['superindo', 'astro'])
    })

    and('a second claim should return no command', async () => {
      await claimNext(ctx)
      expect(ctx.responseBody.command).toBeNull()
    })

    when('the agent pushes the scrape log events', async () => {
      await postEvents(ctx, ctx.commandId, twoEvents())
    })

    then('the response status should be 200', () => {
      ctx.expectStatus(200)
    })

    when('the agent pushes the same log events again', async () => {
      // The agent's retry after a lost response: seq-dedupe keeps one row each.
      await postEvents(ctx, ctx.commandId, twoEvents())
    })

    when('the agent finishes the scrape command successfully', async () => {
      await postFinish(ctx, ctx.commandId, { status: 'success', exitCode: 0, error: null })
    })

    when('the admin reads the command feed', async () => {
      await ctx.sendRequest('GET', '/api/admin/scrape/commands')
    })

    then('the feed should show one successful command for the requested stores', () => {
      ctx.expectStatus(200)
      expect(ctx.responseBody.commands).toHaveLength(1)
      expect(ctx.responseBody.commands[0]).toMatchObject({
        id: ctx.commandId,
        stores: ['superindo', 'astro'],
        status: 'success',
        exitCode: 0,
      })
      expect(ctx.responseBody.commands[0].finishedAt).not.toBeNull()
      ctx.expectAuthenticatedCacheHeaders()
    })

    and('the admin reading the incremental log after seq 0 should see only the tail', async () => {
      await ctx.sendRequest('GET', `/api/admin/scrape/commands/${ctx.commandId}/events?afterSeq=0`)
      ctx.expectStatus(200)
      expect(ctx.responseBody.events).toHaveLength(1)
      expect(ctx.responseBody.events[0].seq).toBe(1)
      expect(ctx.responseBody.truncated).toBe(false)
    })

    and('the full event log should hold exactly two events', async () => {
      // The retried batch must not have duplicated anything.
      await ctx.sendRequest('GET', `/api/admin/scrape/commands/${ctx.commandId}/events`)
      ctx.expectStatus(200)
      expect(ctx.responseBody.events).toHaveLength(2)
    })
  })

  test('A finished command refuses new events', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('a scrape command ran through the full agent lifecycle', async () => {
      await runFullLifecycle(ctx)
      expect(ctx.claimed).not.toBeNull()
    })

    when('the agent pushes events after the finish', async () => {
      await postEvents(ctx, ctx.commandId, [
        { seq: 2, ts: '2026-10-28T01:00:09Z', level: 'info', message: 'late line' },
      ])
    })

    then('the response status should be 409', () => {
      ctx.expectStatus(409)
    })
  })

  test('Repeating the finish never changes the recorded outcome', ({ given, and, when, then }) => {
    given('I am authenticated as an admin', async () => {
      await ctx.resetAndSeed()
      await ctx.authenticate()
    })

    and('a scrape command ran through the full agent lifecycle', async () => {
      await runFullLifecycle(ctx)
      expect(ctx.claimed).not.toBeNull()
    })

    when('the agent repeats the finish with a conflicting outcome', async () => {
      // A retry after a lost response — must be a no-op, not an overwrite.
      await postFinish(ctx, ctx.commandId, { status: 'failed', exitCode: 1, error: 'conflict' })
      await ctx.sendRequest('GET', '/api/admin/scrape/commands')
    })

    then('the feed should still show the original successful outcome', () => {
      ctx.expectStatus(200)
      expect(ctx.responseBody.commands[0]).toMatchObject({ status: 'success', exitCode: 0 })
      expect(ctx.responseBody.commands[0].error).toBeNull()
    })
  })
})
