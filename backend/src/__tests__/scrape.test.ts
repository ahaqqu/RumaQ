import { describe, it, expect } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import {
  appendScrapeEvents,
  claimNextScrapeCommand,
  createScrapeCommand,
  finishScrapeCommand,
} from '../lib/scrape.js'

// Stateful in-memory D1 fake covering exactly the SQL shapes the scrape lib
// emits (the ingest/price-runs fakes match static SELECTs; a command queue
// needs mutations to be observable: claim flips, events dedupe, finishes
// guard). Unknown SQL throws loudly so lib drift fails tests, not silently.

type CommandRow = {
  id: string
  stores: string
  status: 'pending' | 'running' | 'success' | 'failed'
  created_by: string
  created_at: string
  picked_up_at: string | null
  finished_at: string | null
  exit_code: number | null
  error: string | null
  log_truncated: number
}

type EventRow = {
  command_id: string
  seq: number
  ts: string
  level: string
  message: string
}

function createScrapeDb(opts: { viewerEmail?: string | null; viewerIsAdmin?: number } = {}) {
  const commands: CommandRow[] = []
  const events: EventRow[] = []
  // requireAdmin only reads the flag; viewerEmail decides whether the row
  // exists at all (null = user row missing).
  const viewerEmail = opts.viewerEmail ?? 'admin@rumaq.dev'
  const viewerIsAdmin = opts.viewerIsAdmin ?? 1

  const find = (id: string) => commands.find((row) => row.id === id)

  const handle = (sql: string, params: unknown[]): unknown => {
    // --- auth ---
    if (sql.includes('SELECT is_admin FROM users WHERE id = ?')) {
      return viewerEmail === null ? [] : [{ is_admin: viewerIsAdmin }]
    }
    // --- createScrapeCommand ---
    if (sql.includes("SELECT id FROM scrape_commands WHERE status IN ('pending', 'running')")) {
      const active = commands.find((row) => row.status === 'pending' || row.status === 'running')
      return active ? [active] : []
    }
    if (sql.includes('INSERT INTO scrape_commands')) {
      const [id, stores, createdBy, createdAt] = params as [string, string, string, string]
      commands.push({
        id,
        stores,
        status: 'pending',
        created_by: createdBy,
        created_at: createdAt,
        picked_up_at: null,
        finished_at: null,
        exit_code: null,
        error: null,
        log_truncated: 0,
      })
      return []
    }
    if (sql.includes('WHERE id NOT IN')) {
      // Newest 50 by (created_at DESC, id DESC) survive; return the rest.
      const limit = params[0] as number
      const sorted = [...commands].sort((a, b) =>
        a.created_at === b.created_at
          ? b.id.localeCompare(a.id)
          : b.created_at.localeCompare(a.created_at)
      )
      return sorted.slice(limit).map((row) => ({ id: row.id }))
    }
    if (sql.includes('DELETE FROM scrape_run_events WHERE command_id IN')) {
      const ids = params as string[]
      for (const id of ids) {
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]!.command_id === id) events.splice(i, 1)
        }
      }
      return []
    }
    if (sql.includes('DELETE FROM scrape_commands WHERE id IN')) {
      const ids = params as string[]
      for (const id of ids) {
        const idx = commands.findIndex((row) => row.id === id)
        if (idx >= 0) commands.splice(idx, 1)
      }
      return []
    }
    // --- claimNextScrapeCommand ---
    if (sql.includes("SET status = 'failed'")) {
      const [finishedAt, staleBefore] = params as [string, string]
      for (const row of commands) {
        if (row.status === 'running' && row.picked_up_at && row.picked_up_at < staleBefore) {
          row.status = 'failed'
          row.finished_at = finishedAt
          row.error = 'agent lost — no terminal report'
        }
      }
      return []
    }
    if (sql.includes("WHERE status = 'pending' ORDER BY created_at LIMIT 1")) {
      const oldest = commands
        .filter((row) => row.status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      return oldest ? [oldest] : []
    }
    if (sql.includes('SET status = ') && sql.includes("WHERE id = ? AND status = 'pending'")) {
      const [pickedUpAt, id] = params as [string, string]
      const row = find(id)
      if (!row || row.status !== 'pending') return []
      row.status = 'running'
      row.picked_up_at = pickedUpAt
      return [{ id: row.id, stores: row.stores, created_at: row.created_at }]
    }
    // --- appendScrapeEvents / finishScrapeCommand guards ---
    if (sql.includes('SELECT status FROM scrape_commands WHERE id = ?')) {
      const row = find(params[0] as string)
      return row ? [row] : []
    }
    if (sql.includes('SELECT id, log_truncated FROM scrape_commands WHERE id = ?')) {
      const row = find(params[0] as string)
      return row ? [{ id: row.id, log_truncated: row.log_truncated }] : []
    }
    if (sql.includes('INSERT INTO scrape_run_events')) {
      const [commandId, seq, ts, level, message] = params as [
        string,
        number,
        string,
        string,
        string,
      ]
      if (events.some((event) => event.command_id === commandId && event.seq === seq)) {
        return [] // ON CONFLICT DO NOTHING
      }
      events.push({ command_id: commandId, seq, ts, level, message })
      return []
    }
    if (sql.includes('UPDATE scrape_commands') && sql.includes("AND status = 'running'")) {
      const [status, finishedAt, exitCode, error, logTruncated, id] = params as [
        string,
        string,
        number,
        string | null,
        number,
        string,
      ]
      const row = find(id)
      if (!row || row.status !== 'running') return []
      row.status = status as CommandRow['status']
      row.finished_at = finishedAt
      row.exit_code = exitCode
      row.error = error
      row.log_truncated = logTruncated
      return []
    }
    // --- reads ---
    if (sql.includes('FROM scrape_commands') && sql.includes('ORDER BY created_at DESC')) {
      const limit = params[0] as number
      return [...commands]
        .sort((a, b) =>
          a.created_at === b.created_at
            ? b.id.localeCompare(a.id)
            : b.created_at.localeCompare(a.created_at)
        )
        .slice(0, limit)
    }
    if (sql.includes('FROM scrape_run_events') && sql.includes('AND seq > ?')) {
      const [commandId, afterSeq, limit] = params as [string, number, number]
      return events
        .filter((event) => event.command_id === commandId && event.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
    }
    throw new Error(`scrape fake db: unhandled SQL: ${sql}`)
  }

  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params
          return stmt
        },
        async all() {
          return { results: handle(sql, stmt.params) }
        },
        async first() {
          const rows = handle(sql, stmt.params) as unknown[]
          return rows.length > 0 ? rows[0] : null
        },
        async run() {
          handle(sql, stmt.params)
          return { success: true }
        },
      }
      return stmt
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      for (const statement of statements) handle(statement.sql, statement.params)
      return statements.map(() => ({ success: true }))
    },
  }

  return {
    db: db as unknown as D1Database,
    commands,
    events,
    env(extra: Record<string, unknown> = {}) {
      return {
        DB: db,
        RECEIPTS: {},
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
        WORKER_JWT_SECRET: 'test-secret',
        WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
        EMAIL_AUTH_ENABLED: 'false',
        ASSETS: undefined as unknown as Fetcher,
        // Authenticated viewer (props path — the cookie path is covered by
        // the auth suite); users.is_admin decides admin via the SELECT above.
        props: { userId: 'user-1', householdId: 'h1' },
        TEST_MODE: 'true',
        HAQITA_INGEST_SECRET: 'ingest-secret',
        ...extra,
      }
    },
  }
}

describe('POST /api/admin/scrape (admin command queue)', () => {
  it('requires authentication', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      fake.env({ props: undefined })
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin user', async () => {
    const fake = createScrapeDb({ viewerEmail: 'pleb@rumaq.dev', viewerIsAdmin: 0 })
    const res = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      fake.env()
    )
    expect(res.status).toBe(403)
  })

  it('rejects an unknown store slug with 400', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["tokopedia"]}',
      },
      fake.env()
    )
    expect(res.status).toBe(400)
  })

  it('creates a pending command and 409s a second one while it is active', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    const res = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo","astro"]}',
      },
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBeDefined()
    expect(fake.commands).toHaveLength(1)
    expect(fake.commands[0]!.status).toBe('pending')
    expect(JSON.parse(fake.commands[0]!.stores)).toEqual(['superindo', 'astro'])

    const second = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      env
    )
    expect(second.status).toBe(409)
  })

  it('allows a new command once the previous one is terminal', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    const first = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      env
    )
    const { id } = (await first.json()) as { id: string }
    // Only a terminal command reopens the queue — drive it pending→running→success.
    await claimNextScrapeCommand(fake.db)
    await finishScrapeCommand(fake.db, id, { status: 'success', exitCode: 0 })

    const second = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["lotte-mart"]}',
      },
      env
    )
    expect(second.status).toBe(201)
  })
})

describe('GET /api/admin/scrape/stores', () => {
  it('lists the contract store slugs (indomaret included)', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request('/api/admin/scrape/stores', {}, fake.env())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { stores: string[] }
    expect(body.stores).toEqual(['superindo', 'lotte-mart', 'astro', 'hypermart', 'indomaret'])
  })
})

describe('GET /api/admin/scrape/commands + events', () => {
  it('feeds commands newest first with parsed stores', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    const a = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      env
    )
    const firstId = ((await a.json()) as { id: string }).id
    // Terminalize the first (agent lifecycle: claim → finish) so the second
    // create passes the one-run-at-a-time guard.
    await claimNextScrapeCommand(fake.db)
    await finishScrapeCommand(fake.db, firstId, { status: 'success', exitCode: 0 })
    const b = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["lotte-mart"]}',
      },
      env
    )
    expect(b.status).toBe(201)
    const res = await apiApp.request('/api/admin/scrape/commands', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      commands: Array<{ id: string; stores: string[]; status: string; logTruncated: boolean }>
    }
    expect(body.commands).toHaveLength(2)
    expect(body.commands[0]!.stores).toEqual(['lotte-mart'])
    expect(body.commands[1]!.id).toBe(firstId)
    expect(body.commands[1]!.status).toBe('success')
    // The browser client sends limit as a digit string (query params have no
    // types on the wire) — it must coerce, not 400 (regression: the SPA's
    // history panel failed to load when this validator rejected strings).
    const limited = await apiApp.request('/api/admin/scrape/commands?limit=20', {}, env)
    expect(limited.status).toBe(200)
    expect(((await limited.json()) as { commands: unknown[] }).commands).toHaveLength(2)
    const badLimit = await apiApp.request('/api/admin/scrape/commands?limit=0', {}, env)
    expect(badLimit.status).toBe(400)
  })

  it('404s events for an unknown command', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request('/api/admin/scrape/commands/nope/events', {}, fake.env())
    expect(res.status).toBe(404)
  })

  it('returns the full log when afterSeq is absent (seq 0 reachable)', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["astro"]}',
      },
      env
    )
    const claimed = (await claimNextScrapeCommand(fake.db))!
    await appendScrapeEvents(fake.db, claimed.id, [
      { seq: 0, ts: '2026-10-28T01:00:00Z', level: 'info', message: 'first' },
      { seq: 1, ts: '2026-10-28T01:00:01Z', level: 'info', message: 'second' },
    ])
    const full = await apiApp.request(`/api/admin/scrape/commands/${claimed.id}/events`, {}, env)
    expect(full.status).toBe(200)
    expect(
      ((await full.json()) as { events: Array<{ seq: number }> }).events.map((e) => e.seq)
    ).toEqual([0, 1])
  })
})

describe('internal scrape routes (bearer channel)', () => {
  it('401s without the ingest secret', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request(
      '/api/internal/scrape/next',
      { headers: { Authorization: 'Bearer wrong' } },
      fake.env()
    )
    expect(res.status).toBe(401)
  })

  it('claims the oldest pending command once, then reports no work', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo","astro"]}',
      },
      env
    )
    const headers = { Authorization: 'Bearer ingest-secret' }
    const first = await apiApp.request('/api/internal/scrape/next', { headers }, env)
    expect(first.status).toBe(200)
    const body = (await first.json()) as {
      command: { id: string; stores: string[] } | null
    }
    expect(body.command).not.toBeNull()
    expect(body.command!.stores).toEqual(['superindo', 'astro'])
    expect(fake.commands[0]!.status).toBe('running')
    expect(fake.commands[0]!.picked_up_at).not.toBeNull()

    const second = await apiApp.request('/api/internal/scrape/next', { headers }, env)
    const secondBody = (await second.json()) as { command: unknown }
    expect(secondBody.command).toBeNull()
  })

  it('sweeps a stale running command to failed and reopens the queue', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      env
    )
    // Claim, then age the command past the 2h stale window.
    await claimNextScrapeCommand(fake.db)
    const stale = fake.commands[0]!
    stale.picked_up_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()

    const headers = { Authorization: 'Bearer ingest-secret' }
    await apiApp.request('/api/internal/scrape/next', { headers }, env)
    expect(stale.status).toBe('failed')
    expect(stale.error).toBe('agent lost — no terminal report')
    expect(stale.finished_at).not.toBeNull()
    // Queue is open again — a fresh command can now be created and claimed.
    const next = await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["astro"]}',
      },
      env
    )
    expect(next.status).toBe(201)
  })

  it('accepts events idempotently and 409s events for a terminal command', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      env
    )
    const claimed = await claimNextScrapeCommand(fake.db)
    expect(claimed).not.toBeNull()
    const id = claimed!.id
    const headers = { Authorization: 'Bearer ingest-secret', 'Content-Type': 'application/json' }
    const events = {
      events: [
        { seq: 0, ts: '2026-10-28T01:00:00Z', level: 'info', message: '[pipeline] starting' },
        { seq: 1, ts: '2026-10-28T01:00:01Z', level: 'error', message: 'store failed: boom' },
      ],
    }
    const post = await apiApp.request(
      `/api/internal/scrape/commands/${id}/events`,
      { method: 'POST', headers, body: JSON.stringify(events) },
      env
    )
    expect(post.status).toBe(200)

    // Retry the identical batch — seq dedupe keeps one row each.
    await apiApp.request(
      `/api/internal/scrape/commands/${id}/events`,
      { method: 'POST', headers, body: JSON.stringify(events) },
      env
    )
    expect(fake.events).toHaveLength(2)

    // Admin incremental read with afterSeq.
    const feed = await apiApp.request(`/api/admin/scrape/commands/${id}/events?afterSeq=0`, {}, env)
    expect(feed.status).toBe(200)
    const feedBody = (await feed.json()) as {
      events: Array<{ seq: number; level: string }>
      truncated: boolean
    }
    expect(feedBody.events).toHaveLength(1)
    expect(feedBody.events[0]!.seq).toBe(1)
    expect(feedBody.truncated).toBe(false)

    // Terminal command refuses new events.
    await finishScrapeCommand(fake.db, id, { status: 'failed', exitCode: 1, error: 'boom' })
    const late = await apiApp.request(
      `/api/internal/scrape/commands/${id}/events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          events: [{ seq: 2, ts: '2026-10-28T01:00:02Z', level: 'info', message: 'late' }],
        }),
      },
      env
    )
    expect(late.status).toBe(409)
  })

  it('404s events and finish for an unknown command', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    const headers = { Authorization: 'Bearer ingest-secret', 'Content-Type': 'application/json' }
    const events = await apiApp.request(
      '/api/internal/scrape/commands/nope/events',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          events: [{ seq: 0, ts: '2026-10-28T01:00:00Z', level: 'info', message: 'x' }],
        }),
      },
      env
    )
    expect(events.status).toBe(404)
    const finish = await apiApp.request(
      '/api/internal/scrape/commands/nope/finish',
      { method: 'POST', headers, body: JSON.stringify({ status: 'success', exitCode: 0 }) },
      env
    )
    expect(finish.status).toBe(404)
  })

  it('guards finish: only running→terminal, repeats are no-ops', async () => {
    const fake = createScrapeDb()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["superindo"]}',
      },
      fake.env()
    )
    const claimed = await claimNextScrapeCommand(fake.db)
    const id = claimed!.id

    await finishScrapeCommand(fake.db, id, { status: 'success', exitCode: 0 })
    const done = fake.commands[0]!
    expect(done.status).toBe('success')
    expect(done.finished_at).not.toBeNull()

    // A repeated (or conflicting) finish must not overwrite the outcome.
    await finishScrapeCommand(fake.db, id, { status: 'failed', exitCode: 2, error: 'late' })
    expect(fake.commands[0]!.status).toBe('success')
    expect(fake.commands[0]!.exit_code).toBe(0)
    expect(fake.commands[0]!.error).toBeNull()
  })

  it('finish accepts the exitCode picklist and rejects anything else', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    await apiApp.request(
      '/api/admin/scrape',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"stores":["astro"]}',
      },
      env
    )
    const claimed = (await claimNextScrapeCommand(fake.db))!
    const headers = { Authorization: 'Bearer ingest-secret', 'Content-Type': 'application/json' }
    expect(
      (
        await apiApp.request(
          `/api/internal/scrape/commands/${claimed.id}/finish`,
          { method: 'POST', headers, body: JSON.stringify({ status: 'success', exitCode: 2 }) },
          env
        )
      ).status
    ).toBe(200)
    const bad = await apiApp.request(
      `/api/internal/scrape/commands/${claimed.id}/finish`,
      { method: 'POST', headers, body: JSON.stringify({ status: 'success', exitCode: 3 }) },
      env
    )
    expect(bad.status).toBe(400)
  })
})

describe('history prune (newest 50)', () => {
  it('deletes commands beyond the newest 50 along with their events', async () => {
    const fake = createScrapeDb()
    const base = Date.now() - 1000 * 60 * 60 // keep created_at below "now"
    for (let i = 0; i < 52; i++) {
      await createScrapeCommand(fake.db, {
        stores: ['superindo'],
        createdBy: 'user-1',
      })
      // Backdate each row so ordering is deterministic; log an event while
      // it is still non-terminal (terminal commands refuse events), then
      // terminalize it — the one-run-at-a-time guard only allows one active.
      const row = fake.commands[fake.commands.length - 1]!
      row.created_at = new Date(base + i * 1000).toISOString()
      await appendScrapeEvents(fake.db, row.id, [
        { seq: 0, ts: row.created_at, level: 'info', message: 'x' },
      ])
      row.status = 'success'
      row.finished_at = row.created_at
    }
    // Prune runs on EVERY create, so the loop itself already holds the cap.
    expect(fake.commands).toHaveLength(50)
    const oldestBefore = [...fake.commands].sort((a, b) => a.created_at.localeCompare(b.created_at))
    expect(oldestBefore[0]!.created_at).toBe(new Date(base + 2 * 1000).toISOString())
    const { id } = await createScrapeCommand(fake.db, {
      stores: ['astro'],
      createdBy: 'user-1',
    })
    expect(fake.commands).toHaveLength(50)
    expect(fake.commands.some((row) => row.id === id)).toBe(true)
    // The oldest survivor from before is gone now too.
    const oldest = [...fake.commands].sort((a, b) => a.created_at.localeCompare(b.created_at))
    expect(oldest[0]!.created_at).toBe(new Date(base + 3 * 1000).toISOString())
    expect(fake.events.every((event) => fake.commands.some((c) => c.id === event.command_id))).toBe(
      true
    )
  })
})
