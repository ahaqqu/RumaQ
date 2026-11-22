import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import {
  appendScrapeEvents,
  claimNextScrapeCommand,
  createScrapeCommand,
  finishScrapeCommand,
  STALE_PENDING_AFTER_MS,
  STALE_SILENCE_AFTER_MS,
} from '../lib/scrape.js'

// Stateful in-memory D1 fake covering exactly the SQL shapes the scrape lib
// emits (the ingest/price-runs fakes match static SELECTs; a command queue
// needs mutations to be observable: claim flips, events renew, finishes
// guard). Unknown SQL throws loudly so lib drift fails tests, not silently.

type CommandRow = {
  id: string
  stores: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'reaped'
  created_by: string
  created_at: string
  picked_up_at: string | null
  heartbeat_at: string | null
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
    if (
      sql.includes('SELECT id, status, created_at, picked_up_at') &&
      sql.includes("WHERE status IN ('pending', 'running')")
    ) {
      const active = [...commands]
        .filter((row) => row.status === 'pending' || row.status === 'running')
        .sort((a, b) =>
          a.created_at === b.created_at
            ? a.id.localeCompare(b.id)
            : a.created_at.localeCompare(b.created_at)
        )[0]
      return active
        ? [
            {
              id: active.id,
              status: active.status,
              created_at: active.created_at,
              picked_up_at: active.picked_up_at,
            },
          ]
        : []
    }
    if (sql.includes('INSERT INTO scrape_commands')) {
      const [id, stores, createdBy, createdAt] = params as [string, string, string, string]
      // The guarded INSERT…SELECT: no row is written while a live one exists —
      // the same condition the real SQL evaluates inside the batch transaction.
      if (
        sql.includes('WHERE NOT EXISTS') &&
        commands.some((row) => row.status === 'pending' || row.status === 'running')
      ) {
        return []
      }
      commands.push({
        id,
        stores,
        status: 'pending',
        created_by: createdBy,
        created_at: createdAt,
        picked_up_at: null,
        heartbeat_at: null,
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
    // --- reaper (create batch + claim sweep): silence for running, age for pending ---
    if (sql.includes("SET status = 'reaped'") && sql.includes("WHERE status = 'running'")) {
      const [error, finishedAt, silentBefore] = params as [string, string, string]
      for (const row of commands) {
        const since = row.heartbeat_at ?? row.picked_up_at ?? row.created_at
        if (row.status === 'running' && since < silentBefore) {
          row.status = 'reaped'
          row.finished_at = finishedAt
          // NO exit_code: the run never finished (audit M1 — exit_code 1 was
          // the old overloading).
          row.error = error
        }
      }
      return []
    }
    if (sql.includes("SET status = 'reaped'") && sql.includes("WHERE status = 'pending'")) {
      const [error, finishedAt, staleBefore] = params as [string, string, string]
      for (const row of commands) {
        if (row.status === 'pending' && row.created_at < staleBefore) {
          row.status = 'reaped'
          row.finished_at = finishedAt
          row.error = error
        }
      }
      return []
    }
    // --- claimNextScrapeCommand ---
    if (sql.includes("WHERE status = 'pending' ORDER BY created_at, id LIMIT 1")) {
      const oldest = commands
        .filter((row) => row.status === 'pending')
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0]
      return oldest ? [oldest] : []
    }
    if (sql.includes('SET status = ') && sql.includes("WHERE id = ? AND status = 'pending'")) {
      const [pickedUpAt, heartbeatAt, id] = params as [string, string, string]
      const row = find(id)
      if (!row || row.status !== 'pending') return []
      row.status = 'running'
      row.picked_up_at = pickedUpAt
      row.heartbeat_at = heartbeatAt
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
    // The lease renewal rides the events batch (2 params: ts, id) — matched
    // BEFORE the finish UPDATE below: SET heartbeat_at + a bare 'running'
    // guard is a distinct SQL shape from the finish's SET status + IN guard.
    if (sql.includes('SET heartbeat_at') && sql.includes("AND status = 'running'")) {
      const [renewedAt, id] = params as [string, string]
      const row = find(id)
      if (!row || row.status !== 'running') return []
      row.heartbeat_at = renewedAt
      return []
    }
    if (
      sql.includes('UPDATE scrape_commands') &&
      sql.includes("AND status IN ('running', 'reaped')")
    ) {
      const [status, finishedAt, exitCode, error, logTruncated, id] = params as [
        string,
        string,
        number,
        string | null,
        number,
        string,
      ]
      const row = find(id)
      // The widened finish guard (#178): a late report settles a reaped row too.
      if (!row || (row.status !== 'running' && row.status !== 'reaped')) return []
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
      // Yield first so two concurrent create requests both reach their batch
      // before either commits — the race the guarded INSERT must survive.
      await Promise.resolve()
      return statements.map((statement) => {
        const before = commands.length
        // Real D1 reports per-statement changes; the writes whose counts the
        // lib reads are the guarded INSERT (0 = conflict) and the finish
        // UPDATE (0 = the row was neither running nor reaped). An UPDATE's
        // mutation is detected by row snapshot — the routes mutate rows in place.
        const rowsBefore = statement.sql.startsWith('UPDATE scrape_commands')
          ? JSON.stringify(commands)
          : ''
        const results = handle(statement.sql, statement.params) as unknown[]
        const changes =
          statement.sql.includes('INSERT INTO scrape_commands') && commands.length > before
            ? 1
            : statement.sql.startsWith('UPDATE scrape_commands') &&
                JSON.stringify(commands) !== rowsBefore
              ? 1
              : 0
        return {
          success: true,
          results,
          meta: { changes },
        }
      })
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

/** Seeds a row directly — the fake is the storage, so tests can fabricate age. */
function seedCommand(
  fake: ReturnType<typeof createScrapeDb>,
  row: Pick<CommandRow, 'id' | 'status'> & Partial<CommandRow>
) {
  fake.commands.push({
    stores: '["superindo"]',
    created_by: 'user-1',
    created_at: new Date().toISOString(),
    picked_up_at: null,
    heartbeat_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    log_truncated: 0,
    ...row,
  })
}

function postScrape(
  env: ReturnType<ReturnType<typeof createScrapeDb>['env']>,
  body = '{"stores":["superindo"]}'
) {
  return apiApp.request(
    '/api/admin/scrape',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
    env
  )
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

  it('reaps a silent running command and creates the new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const fake = createScrapeDb()
      // No heartbeat_at (pre-lease row): silence measures from picked_up_at.
      const pickedUpAt = new Date(now.getTime() - STALE_SILENCE_AFTER_MS - 60_000).toISOString()
      seedCommand(fake, {
        id: 'stale-running',
        status: 'running',
        created_at: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        picked_up_at: pickedUpAt,
      })

      const res = await postScrape(fake.env())
      expect(res.status).toBe(201)

      const reaped = fake.commands.find((row) => row.id === 'stale-running')!
      expect(reaped).toMatchObject({
        status: 'reaped',
        // The run never finished — there is no exit code (audit M1: the old
        // failed + exit_code 1 overloading is gone).
        exit_code: null,
        // Exact string the admin history renders.
        error: 'reaped: silent for 45 min (no heartbeat, events, or finish report)',
        finished_at: now.toISOString(),
        // Preserved: it still records when the agent claimed the run.
        picked_up_at: pickedUpAt,
      })
      expect(fake.commands).toHaveLength(2)
      const created = fake.commands.find((row) => row.id !== 'stale-running')!
      expect(created.status).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('409s on a fresh running command, names it, and leaves it untouched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const fake = createScrapeDb()
      const createdAt = new Date(now.getTime() - 8 * 60 * 1000).toISOString()
      const pickedUpAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
      seedCommand(fake, {
        id: 'live-running',
        status: 'running',
        created_at: createdAt,
        picked_up_at: pickedUpAt,
      })

      const res = await postScrape(fake.env())
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'A scrape is already pending or running',
        activeCommand: {
          id: 'live-running',
          status: 'running',
          createdAt,
          pickedUpAt,
        },
      })

      expect(fake.commands).toHaveLength(1)
      expect(fake.commands[0]).toMatchObject({
        status: 'running',
        finished_at: null,
        exit_code: null,
        error: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaps a stale pending command (never picked up) — unchanged by the lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const fake = createScrapeDb()
      seedCommand(fake, {
        id: 'stale-pending',
        status: 'pending',
        created_at: new Date(now.getTime() - STALE_PENDING_AFTER_MS - 60_000).toISOString(),
      })

      const res = await postScrape(fake.env())
      expect(res.status).toBe(201)

      const reaped = fake.commands.find((row) => row.id === 'stale-pending')!
      expect(reaped).toMatchObject({
        status: 'reaped',
        exit_code: null,
        error: 'reaped: never picked up after 60 min',
        finished_at: now.toISOString(),
      })
      expect(fake.commands).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reap a live command that is just under its ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)

      const runningFake = createScrapeDb()
      seedCommand(runningFake, {
        id: 'recent-running',
        status: 'running',
        created_at: new Date(now.getTime() - STALE_SILENCE_AFTER_MS + 60_000).toISOString(),
        picked_up_at: new Date(now.getTime() - STALE_SILENCE_AFTER_MS + 60_000).toISOString(),
      })
      expect((await postScrape(runningFake.env())).status).toBe(409)
      expect(runningFake.commands[0]!.status).toBe('running')

      const pendingFake = createScrapeDb()
      seedCommand(pendingFake, {
        id: 'recent-pending',
        status: 'pending',
        created_at: new Date(now.getTime() - STALE_PENDING_AFTER_MS + 60_000).toISOString(),
      })
      expect((await postScrape(pendingFake.env())).status).toBe(409)
      expect(pendingFake.commands[0]!.status).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates exactly one command when two trigger requests race', async () => {
    const fake = createScrapeDb()
    const env = fake.env()

    // Both requests enter createScrapeCommand before either commits — the
    // guarded INSERT + batch is what must serialise them into one row.
    const [first, second] = await Promise.all([
      postScrape(env),
      postScrape(env, '{"stores":["astro"]}'),
    ])
    expect([first.status, second.status].sort()).toEqual([201, 409])
    expect(fake.commands).toHaveLength(1)
    expect(fake.commands[0]!.status).toBe('pending')

    const created = [first, second].find((res) => res.status === 201)!
    const conflict = [first, second].find((res) => res.status === 409)!
    const { id } = (await created.json()) as { id: string }
    const body = (await conflict.json()) as { activeCommand: { id: string } }
    expect(body.activeCommand.id).toBe(id)
  })
})

describe('GET /api/admin/scrape/stores', () => {
  it('lists the contract store slugs (alfamart included)', async () => {
    const fake = createScrapeDb()
    const res = await apiApp.request('/api/admin/scrape/stores', {}, fake.env())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { stores: string[] }
    expect(body.stores).toEqual([
      'superindo',
      'lotte-mart',
      'astro',
      'hypermart',
      'indomaret',
      'alfamart',
      'tip-top',
      'hari-hari',
      'yogya',
      'lotte-grosir',
      'lotte-grosir-promosi',
    ])
  })
})

describe('GET /api/admin/scrape/commands + events', () => {
  it('feeds commands newest first with parsed stores', async () => {
    // Date-only fake timers: the feed orders by created_at DESC with an id
    // (random UUID) tiebreak, so two same-millisecond creations would leave
    // the order to UUID chance on a fast CI runner (observed on #383's CI).
    // A strictly later clock for the second command makes newest-first
    // deterministic.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
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
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'))
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
    } finally {
      vi.useRealTimers()
    }
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

  it('logs one structured rejection line on 401 without the secret', async () => {
    const fake = createScrapeDb()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    try {
      const res = await apiApp.request(
        '/api/internal/scrape/next',
        { headers: { Authorization: 'Bearer wrong-value' } },
        fake.env()
      )
      expect(res.status).toBe(401)
    } finally {
      // Restore even when the status assertion fails — a leaking spy would
      // silence console.log for every later test in the file.
      spy.mockRestore()
    }
    expect(logs).toHaveLength(1)
    const entry = JSON.parse(logs[0]!) as Record<string, unknown>
    expect(entry.evt).toBe('ingest_401')
    expect(entry.route).toBe('/api/internal/scrape/next')
    expect(entry.tokenLength).toBe('wrong-value'.length)
    expect(entry.candidates).toBe(1)
    expect(entry.matched).toBe(false)
    // Neither the configured secret nor the presented token may leak —
    // length only (#451).
    expect(logs.join('\n')).not.toContain('ingest-secret')
    expect(logs.join('\n')).not.toContain('wrong-value')
  })

  it('logs the not-configured rejection when no candidate secret exists', async () => {
    const fake = createScrapeDb()
    const env = fake.env()
    delete (env as Record<string, unknown>).HAQITA_INGEST_SECRET
    delete (env as Record<string, unknown>).HAQITA_INGEST_SECRET_NEXT
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    try {
      const res = await apiApp.request('/api/internal/scrape/next', {}, env)
      expect(res.status).toBe(503)
    } finally {
      spy.mockRestore()
    }
    expect(logs).toHaveLength(1)
    const entry = JSON.parse(logs[0]!) as Record<string, unknown>
    expect(entry.evt).toBe('ingest_503')
    expect(entry.candidates).toBe(0)
    expect(entry.tokenLength).toBe(0)
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

  it('breaks a same-second claim tie by id (#596 — the #555 sweep missed this site)', async () => {
    const fake = createScrapeDb()
    const now = new Date().toISOString()
    const row = (id: string): CommandRow => ({
      id,
      stores: JSON.stringify(['astro']),
      status: 'pending',
      created_by: 'user-1',
      created_at: now, // datetime('now') resolution — two rows in one second are legal
      picked_up_at: null,
      heartbeat_at: null,
      finished_at: null,
      exit_code: null,
      error: null,
      log_truncated: 0,
    })
    // Insertion order is the pre-#596 nondeterminism: the bare
    // `ORDER BY created_at` sort could hand either row to the agent; the id
    // tiebreaker pins the smaller id first (created_at, id ASC).
    fake.commands.push(row('cmd-b'), row('cmd-a'))
    const claimed = await claimNextScrapeCommand(fake.db)
    expect(claimed!.id).toBe('cmd-a')
  })

  it('sweeps a silent running command to reaped and reopens the queue', async () => {
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
    // Claim, then age the command's last report past the silence ceiling
    // (45 min) — the agent stopped posting events and never finished, so
    // heartbeat_at (the claim's stamp) is as stale as the pickup.
    await claimNextScrapeCommand(fake.db)
    const stale = fake.commands[0]!
    stale.picked_up_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    stale.heartbeat_at = stale.picked_up_at

    const headers = { Authorization: 'Bearer ingest-secret' }
    await apiApp.request('/api/internal/scrape/next', { headers }, env)
    expect(stale.status).toBe('reaped')
    expect(stale.error).toBe('reaped: silent for 45 min (no heartbeat, events, or finish report)')
    expect(stale.exit_code).toBeNull()
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

  it('renews the lease on every events POST — a reporting run is never reaped', async () => {
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
    const claimed = (await claimNextScrapeCommand(fake.db))!
    const id = claimed.id
    // Claimed over an hour ago (would exceed ANY total-age ceiling).
    fake.commands[0]!.picked_up_at = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    fake.commands[0]!.heartbeat_at = new Date(Date.now() - 90 * 60 * 1000).toISOString()

    const headers = { Authorization: 'Bearer ingest-secret', 'Content-Type': 'application/json' }
    // Events arrive NOW — the renewal stamps heartbeat_at fresh.
    const post = await apiApp.request(
      `/api/internal/scrape/commands/${id}/events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          events: [{ seq: 0, ts: new Date().toISOString(), level: 'info', message: 'still alive' }],
        }),
      },
      env
    )
    expect(post.status).toBe(200)
    expect(fake.commands[0]!.heartbeat_at).not.toBeNull()

    // The poll that runs the reaper: a FRESH heartbeat keeps the row live
    // despite the 90-minute total age (the old age-since-claim ceiling would
    // have reaped it — the L1 coupling this machine removes).
    const poll = await apiApp.request('/api/internal/scrape/next', { headers }, env)
    expect(poll.status).toBe(200)
    expect(fake.commands[0]!.status).toBe('running')
    expect(fake.commands[0]!.finished_at).toBeNull()
  })

  it('a silent row reaps at the 45-minute silence boundary and a late finish then settles it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const fake = createScrapeDb()
      const env = fake.env()
      await postScrape(env)
      const claimed = (await claimNextScrapeCommand(fake.db))!
      const headers = { Authorization: 'Bearer ingest-secret', 'Content-Type': 'application/json' }

      // One minute BEFORE the silence ceiling: still live.
      vi.setSystemTime(new Date(now.getTime() + STALE_SILENCE_AFTER_MS - 60_000))
      const before = await apiApp.request('/api/internal/scrape/next', { headers }, env)
      expect(before.status).toBe(200)
      expect(fake.commands[0]!.status).toBe('running')

      // One minute PAST it (silence measured from picked_up_at): the claim
      // sweep reaps to the named state, exit_code untouched.
      vi.setSystemTime(new Date(now.getTime() + STALE_SILENCE_AFTER_MS + 60_000))
      await apiApp.request('/api/internal/scrape/next', { headers }, env)
      expect(fake.commands[0]!.status).toBe('reaped')
      expect(fake.commands[0]!.exit_code).toBeNull()

      // Late events are still refused while the row sits reaped — the
      // terminal gate on events does not widen with the finish guard.
      const late = await apiApp.request(
        `/api/internal/scrape/commands/${claimed.id}/events`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            events: [{ seq: 0, ts: now.toISOString(), level: 'info', message: 'late' }],
          }),
        },
        env
      )
      expect(late.status).toBe(409)

      // The agent's finish arrives after the reap: it settles the record
      // (#178) — the report is proof the run completed, so the route answers
      // ok (no phantom-refusal 409) and the row takes the real outcome.
      const finish = await apiApp.request(
        `/api/internal/scrape/commands/${claimed.id}/finish`,
        { method: 'POST', headers, body: JSON.stringify({ status: 'success', exitCode: 0 }) },
        env
      )
      expect(finish.status).toBe(200)
      expect(fake.commands[0]!.status).toBe('success')
      expect(fake.commands[0]!.exit_code).toBe(0)
      expect(fake.commands[0]!.error).toBeNull()
      expect(fake.commands[0]!.finished_at).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
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

  it('guards finish: running|reaped→terminal, repeats are no-ops', async () => {
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

    // A repeated finish must not overwrite the settled outcome.
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
