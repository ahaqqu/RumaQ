import { describe, it, expect } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createScrapeCommand, claimNextScrapeCommand } from '../lib/scrape.js'
import { wipeStoreIngest } from '../lib/ingest-wipe.js'
import { createDb } from './support/d1-sqlite.js'

// Real-SQL coverage for the ingest wipe (#753) — the FIRST bulk DELETE surface.
// scrape.test.ts's string-matching fake is blind to deletes, cascades and the
// FK ORDER the wipe lives or dies by; this suite runs the exact statements
// against real SQLite (D1 is SQLite) through the full migration chain, with
// PRAGMA foreign_keys = ON so any wrong statement order fails loudly instead
// of silently leaving a dangling row (D1 enforces foreign keys; this adapter
// matches it).

type Sqlite = ReturnType<typeof createDb>['sqlite']

function freshDb(): { sqlite: Sqlite; d1: D1Database } {
  const { sqlite, d1 } = createDb()
  // D1 enforces foreign keys; node:sqlite defaults them OFF. The wipe's whole
  // statement order is the FK graph read top-down — tests must run under the
  // same enforcement or they prove nothing.
  sqlite.exec('PRAGMA foreign_keys = ON')
  return { sqlite, d1 }
}

// The multi-store fixture: superindo (A) is the wipe target, alfamart (B)
// proves isolation. Products cover the three fates an A wipe can hand out:
//   p-a-only  — observed only at A → deleted (orphaned by the wipe)
//   p-shared  — observed at A and B → survives (B's observation holds it)
//   p-b-only  — observed only at B → untouched, never in the wipe's scope
// plus p-orphan-b, a PRE-EXISTING orphan of B's (no observations at all): the
// wipe deletes only products it orphans, never pre-existing garbage from
// another store's catalog.
function seedCatalog(sqlite: Sqlite): void {
  const insertSource = sqlite.prepare(`INSERT INTO price_sources (id, slug, name) VALUES (?, ?, ?)`)
  insertSource.run('src-a', 'superindo', 'Superindo')
  insertSource.run('src-b', 'alfamart', 'Alfamart')

  const insertProduct = sqlite.prepare(
    `INSERT INTO price_products (id, product_key, name) VALUES (?, ?, ?)`
  )
  insertProduct.run('p-a-only', 'beras-a--merek--5-kg', 'Beras A')
  insertProduct.run('p-shared', 'gula-shared--merek--1-kg', 'Gula Shared')
  insertProduct.run('p-b-only', 'minyak-b--merek--1-l', 'Minyak B')
  insertProduct.run('p-orphan-b', 'sabun-orphan--merek--biji', 'Sabun Orphan')

  const insertObs = sqlite.prepare(
    `INSERT INTO price_observations
       (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
     VALUES (?, ?, ?, '2026-11-20', 20000, 1.0, '2026-11-20T06:00:00Z')`
  )
  insertObs.run('obs-a1', 'p-a-only', 'src-a')
  insertObs.run('obs-a2', 'p-shared', 'src-a')
  insertObs.run('obs-b1', 'p-shared', 'src-b')
  insertObs.run('obs-b2', 'p-b-only', 'src-b')

  // Aliases ride their product: the A-only one must cascade away, the shared
  // one must survive.
  const insertAlias = sqlite.prepare(
    `INSERT INTO price_product_aliases
       (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'approved', 'ocr', '2026-11-20T06:00:00Z', '2026-11-20T06:00:00Z')`
  )
  insertAlias.run('alias-a', 'p-a-only', 'superindo', 'beras a')
  insertAlias.run('alias-shared', 'p-shared', 'alfamart', 'gula shared')

  // Household plan items reference observations (0007's grounded-price FK):
  // one points into the wipe, one stays on B. The ITEMS survive; only the
  // A-pointing provenance link is nulled. The fixture user 'u-1' owns the
  // household (FK under foreign_keys=ON) and is deliberately distinct from
  // the route tests' admin 'user-1'.
  sqlite.exec(
    `INSERT INTO users (id, email) VALUES ('u-1', 'fixture@rumaq.dev');
     INSERT INTO households (id, name, created_by) VALUES ('hh-1', 'Test', 'u-1');
     INSERT INTO plans (id, household_id) VALUES ('plan-1', 'hh-1');
     INSERT INTO plan_items (id, plan_id, qty, price_observation_id)
       VALUES ('pi-a', 'plan-1', 1, 'obs-a2');
     INSERT INTO plan_items (id, plan_id, qty, price_observation_id)
       VALUES ('pi-b', 'plan-1', 1, 'obs-b1');`
  )
}

function counts(sqlite: Sqlite, sql: string, ...params: unknown[]): number {
  return (sqlite.prepare(sql).get(...params) as { n: number }).n
}

function receiptOf(sqlite: Sqlite): {
  store_slug: string
  actor_user_id: string
  observations_deleted: number
  products_deleted: number
} {
  return sqlite
    .prepare(
      `SELECT store_slug, actor_user_id, observations_deleted, products_deleted
       FROM ingest_wipe_audit`
    )
    .get() as {
    store_slug: string
    actor_user_id: string
    observations_deleted: number
    products_deleted: number
  }
}

describe('wipeStoreIngest (real SQL, foreign_keys ON)', () => {
  it('wipes only the named store: observations, orphaned products, cascaded aliases; shared rows survive', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    const versionBefore = (
      sqlite.prepare('SELECT version FROM canonical_index_state WHERE id = 1').get() as {
        version: number
      }
    ).version

    const result = await wipeStoreIngest(d1, {
      storeSlug: 'superindo',
      actorUserId: 'user-1',
    })

    // The counts name the fixture exactly: 2 observations, the 1 orphaned product.
    expect(result).toMatchObject({
      storeSlug: 'superindo',
      observationsDeleted: 2,
      productsDeleted: 1,
    })

    const obsOf = (source: string) =>
      counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations WHERE source_id = ?`, source)
    expect(obsOf('src-a')).toBe(0)
    expect(obsOf('src-b')).toBe(2)

    const productIds = sqlite.prepare('SELECT id FROM price_products ORDER BY id').all()
    // Alphabetical: p-a-only is gone (orphaned by the wipe), everything else stays.
    expect(productIds).toEqual([{ id: 'p-b-only' }, { id: 'p-orphan-b' }, { id: 'p-shared' }])

    // The A-only alias cascaded with its product; the shared alias survives.
    expect(
      counts(sqlite, `SELECT COUNT(*) AS n FROM price_product_aliases WHERE id = ?`, 'alias-a')
    ).toBe(0)
    expect(
      counts(sqlite, `SELECT COUNT(*) AS n FROM price_product_aliases WHERE id = ?`, 'alias-shared')
    ).toBe(1)

    // Source rows survive — they carry name/kind metadata and the re-ingest
    // upserts them anyway.
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_sources`)).toBe(2)

    // Plan items survive; only the A-pointing provenance link was nulled.
    expect(
      sqlite.prepare(`SELECT price_observation_id FROM plan_items WHERE id = ?`).get('pi-a')
    ).toEqual({ price_observation_id: null })
    expect(
      sqlite.prepare(`SELECT price_observation_id FROM plan_items WHERE id = ?`).get('pi-b')
    ).toEqual({ price_observation_id: 'obs-b1' })

    // The receipt, exact.
    expect(receiptOf(sqlite)).toEqual({
      store_slug: 'superindo',
      actor_user_id: 'user-1',
      observations_deleted: 2,
      products_deleted: 1,
    })

    // The canonical index moved (deleted product/alias invalidates the cache).
    const versionAfter = (
      sqlite.prepare('SELECT version FROM canonical_index_state WHERE id = 1').get() as {
        version: number
      }
    ).version
    expect(versionAfter).toBe(versionBefore + 1)
  })

  it('is a no-op-safe wipe on an empty store: zero counts, receipt still written, index bumped', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)

    // tip-top has no source, no observations — the slug is valid, the store
    // is empty. (No price_sources row at all still wipes nothing.)
    const result = await wipeStoreIngest(d1, { storeSlug: 'tip-top', actorUserId: 'user-1' })
    expect(result).toMatchObject({ observationsDeleted: 0, productsDeleted: 0 })
    expect(receiptOf(sqlite)).toMatchObject({
      store_slug: 'tip-top',
      observations_deleted: 0,
      products_deleted: 0,
    })
    // The fixture's rows are untouched.
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
  })

  it('never deletes a PRE-EXISTING orphan of another store', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    await wipeStoreIngest(d1, { storeSlug: 'superindo', actorUserId: 'user-1' })
    // p-orphan-b had no observations before the wipe; the wipe's scope is the
    // products IT orphans, so another store's stale row stays.
    expect(
      counts(sqlite, `SELECT COUNT(*) AS n FROM price_products WHERE id = ?`, 'p-orphan-b')
    ).toBe(1)
  })

  it('refuses an unknown slug before touching anything', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    await expect(
      wipeStoreIngest(d1, { storeSlug: 'tokopedia', actorUserId: 'user-1' })
    ).rejects.toThrow('unknown store slug')
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM ingest_wipe_audit`)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Route-level: POST /api/admin/scrape with the flags — auth chain, the wipe
// before the command row, the flags round-trip into the command and the claim.
// ---------------------------------------------------------------------------

function routeEnv(d1: D1Database, extra: Record<string, unknown> = {}) {
  return {
    DB: d1,
    RECEIPTS: {},
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    TEST_MODE: 'true',
    HAQITA_INGEST_SECRET: 'ingest-secret',
    REVIEW_SCRIPT_TOKEN: 'tok-753',
    props: { userId: 'user-1', householdId: 'hh-1' },
    ...extra,
  }
}

function seedAdminAccount(sqlite: Sqlite): void {
  // The household row itself comes from seedCatalog (the plan items FK needs
  // it); this seeds the admin identity + membership the auth chain reads.
  sqlite.exec(
    `INSERT INTO users (id, email, is_admin) VALUES ('user-1', 'admin@rumaq.dev', 1);
     INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('hm-1', 'hh-1', 'user-1', 'owner');`
  )
}

function postScrape(env: unknown, body: unknown, headers: Record<string, string> = {}) {
  return apiApp.request(
    '/api/admin/scrape',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env as never
  )
}

describe('POST /api/admin/scrape with the #753 flags (real SQL)', () => {
  it('wipes before creating the command; the flags round-trip into the row, the 201 and the claim', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(routeEnv(d1), {
      stores: ['superindo'],
      resetNovelty: true,
      wipeIngest: true,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      wipe?: { storeSlug: string; observationsDeleted: number; productsDeleted: number }
    }
    expect(body.wipe).toMatchObject({
      storeSlug: 'superindo',
      observationsDeleted: 2,
      productsDeleted: 1,
    })

    // Order proof: the command row exists AND the store's rows are gone —
    // wipe-before-create, in that order (the command's created_at is not
    // asserted against the receipt's; the 201 carrying both is the contract).
    expect(
      counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations WHERE source_id = ?`, 'src-a')
    ).toBe(0)

    const row = sqlite
      .prepare(`SELECT reset_novelty, wipe_ingest, created_by FROM scrape_commands WHERE id = ?`)
      .get(body.id) as { reset_novelty: number; wipe_ingest: number; created_by: string }
    expect(row).toEqual({ reset_novelty: 1, wipe_ingest: 1, created_by: 'user-1' })

    // The agent's claim carries the flags it must honor (resetNovelty) and
    // the bookkeeping flag (wipeIngest).
    const claimed = await claimNextScrapeCommand(d1)
    expect(claimed).toMatchObject({
      id: body.id,
      stores: ['superindo'],
      resetNovelty: true,
      wipeIngest: true,
    })
  })

  it('a plain create (no flags) keeps the old shape: no wipe, flags 0, old response', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(routeEnv(d1), { stores: ['superindo'] })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; wipe?: unknown }
    // No wipe key on a plain create — the old response, byte for byte.
    expect(body.wipe).toBeUndefined()
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    const row = sqlite
      .prepare(`SELECT reset_novelty, wipe_ingest FROM scrape_commands WHERE id = ?`)
      .get(body.id) as { reset_novelty: number; wipe_ingest: number }
    expect(row).toEqual({ reset_novelty: 0, wipe_ingest: 0 })
  })

  it('400s a multi-store wipe (the contract check) without touching any store', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(routeEnv(d1), {
      stores: ['superindo', 'alfamart'],
      wipeIngest: true,
    })
    expect(res.status).toBe(400)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM scrape_commands`)).toBe(0)
  })

  it('400s an unknown slug (the picklist) and wipes nothing', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(routeEnv(d1), { stores: ['tokopedia'], wipeIngest: true })
    expect(res.status).toBe(400)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM ingest_wipe_audit`)).toBe(0)
  })

  it('409s on a live command BEFORE the wipe runs — the destructive flag never fires into a blocked queue', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    const res = await postScrape(routeEnv(d1), {
      stores: ['superindo'],
      wipeIngest: true,
    })
    expect(res.status).toBe(409)
    // Nothing was deleted, no receipt, and the queue still holds its one row.
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM ingest_wipe_audit`)).toBe(0)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM scrape_commands`)).toBe(1)
  })

  it('403s a non-admin before anything runs', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)
    sqlite.exec(`INSERT INTO users (id, email) VALUES ('user-2', 'pleb@rumaq.dev')`)

    const res = await postScrape(
      routeEnv(d1, { props: { userId: 'user-2', householdId: 'hh-1' } }),
      { stores: ['superindo'], wipeIngest: true }
    )
    expect(res.status).toBe(403)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM ingest_wipe_audit`)).toBe(0)
  })

  it('accepts the #656 script token on the flags path — acting as the admin', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(
      routeEnv(d1, { props: undefined }),
      { stores: ['superindo'], resetNovelty: true, wipeIngest: true },
      { Authorization: 'Bearer tok-753' }
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; wipe?: { storeSlug: string } }
    expect(body.wipe?.storeSlug).toBe('superindo')
    // The receipt names the ADMIN the token acts as — the acting identity is
    // resolved, not the token itself.
    expect(receiptOf(sqlite).actor_user_id).toBe('user-1')
    const row = sqlite
      .prepare(`SELECT reset_novelty, wipe_ingest FROM scrape_commands WHERE id = ?`)
      .get(body.id) as { reset_novelty: number; wipe_ingest: number }
    expect(row).toEqual({ reset_novelty: 1, wipe_ingest: 1 })
  })

  it('a wrong bearer token falls through to the cookie path: 401, nothing wiped', async () => {
    const { sqlite, d1 } = freshDb()
    seedCatalog(sqlite)
    seedAdminAccount(sqlite)

    const res = await postScrape(
      routeEnv(d1, { props: undefined }),
      { stores: ['superindo'], wipeIngest: true },
      { Authorization: 'Bearer tok-wrong' }
    )
    expect(res.status).toBe(401)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM price_observations`)).toBe(4)
    expect(counts(sqlite, `SELECT COUNT(*) AS n FROM ingest_wipe_audit`)).toBe(0)
  })

  it('the commands list surfaces the flags off real rows (plain + flagged)', async () => {
    // No account seeding — the lib-level claim/list flow never auths.
    const { d1 } = freshDb()
    const { listScrapeCommands, finishScrapeCommand } = await import('../lib/scrape.js')
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    // Terminalize so the second create passes the one-run-at-a-time guard.
    const claimed = (await claimNextScrapeCommand(d1))!
    await finishScrapeCommand(d1, claimed.id, { status: 'success', exitCode: 0 })
    const { id } = await createScrapeCommand(d1, {
      stores: ['superindo'],
      createdBy: 'user-1',
      resetNovelty: true,
      wipeIngest: true,
    })
    const rows = await listScrapeCommands(d1, 20)
    const flagged = rows.find((row) => row.id === id)!
    expect(flagged).toMatchObject({ resetNovelty: true, wipeIngest: true })
    const plain = rows.find((row) => row.id === claimed.id)!
    expect(plain).toMatchObject({ resetNovelty: false, wipeIngest: false })
  })
})
