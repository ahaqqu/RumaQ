import { describe, it, expect } from 'vite-plus/test'
import {
  DEPLOYMENT_FLAGS_TTL_MS,
  DEPLOYMENT_FLAGS_SQL,
  deploymentFlagKey,
  getDeploymentFlags,
  isPluginDeploymentAvailable,
} from '../plugins/flags.js'

// The ops kill-switch (§3.3/§4.6): data (0029), read once per isolate with a
// ≤30 s cache, FAIL-OPEN on a read error — the deliberate opposite of the
// household enablement posture. The cache is keyed by the env object (the
// gateway secretCache pattern), so a fresh env is a fresh isolate in tests.

type Rows = Array<{ key: string; value: string }> | { error: unknown }

function createFlagsDb(rows: Rows) {
  let reads = 0
  const db = {
    prepare: (sql: string) => {
      const exec = () => ({
        all: async () => {
          if ('error' in rows) throw rows.error
          reads += 1
          return { results: rows }
        },
        first: async () => {
          throw new Error(`fake DB: unexpected first(): ${sql}`)
        },
        run: async () => {
          throw new Error(`fake DB: unexpected run(): ${sql}`)
        },
      })
      // Both D1 shapes: prepare().all() (the flags reader's form) and
      // prepare().bind(...).all().
      return { ...exec(), bind: () => exec() }
    },
  }
  return { db: db as unknown as D1Database, reads: () => reads }
}

const envWith = (db: D1Database) => ({ DB: db })

describe('isPluginDeploymentAvailable — fail-open postures', () => {
  it('absent flag table rows mean available (default on)', async () => {
    const { db } = createFlagsDb([])
    expect(await isPluginDeploymentAvailable(envWith(db), 'documents')).toBe(true)
  })

  it("an explicit 'on' means available, an explicit 'off' does not", async () => {
    const on = createFlagsDb([{ key: deploymentFlagKey('documents'), value: 'on' }])
    expect(await isPluginDeploymentAvailable(envWith(on.db), 'documents')).toBe(true)

    const off = createFlagsDb([{ key: deploymentFlagKey('documents'), value: 'off' }])
    expect(await isPluginDeploymentAvailable(envWith(off.db), 'documents')).toBe(false)
  })

  it('only the exact key for the plugin counts — other flags are noise', async () => {
    const { db } = createFlagsDb([
      { key: deploymentFlagKey('other-plugin'), value: 'off' },
      { key: 'unrelated.ops.flag', value: 'off' },
    ])
    expect(await isPluginDeploymentAvailable(envWith(db), 'documents')).toBe(true)
  })

  it('FAILS OPEN on a read error — a flags outage must not take the vault down (§3.3)', async () => {
    const { db } = createFlagsDb({ error: new Error('D1 unavailable') })
    expect(await isPluginDeploymentAvailable(envWith(db), 'documents')).toBe(true)
  })

  it('reads the whole tiny table in one statement (cached per isolate)', async () => {
    expect(DEPLOYMENT_FLAGS_SQL).toBe('SELECT key, value FROM deployment_flags')
    expect(DEPLOYMENT_FLAGS_TTL_MS).toBe(30_000)
  })
})

describe('getDeploymentFlags — the ≤30 s isolate cache', () => {
  it('reads once per env within the TTL and re-reads after it expires', async () => {
    const { db, reads } = createFlagsDb([])
    const env = envWith(db)

    const t0 = 1_000_000
    await getDeploymentFlags(env, t0)
    await getDeploymentFlags(env, t0 + DEPLOYMENT_FLAGS_TTL_MS - 1) // cached
    expect(reads()).toBe(1)

    await getDeploymentFlags(env, t0 + DEPLOYMENT_FLAGS_TTL_MS) // expired → re-read
    expect(reads()).toBe(2)
  })

  it('keys the cache by env object — a fresh env is a fresh isolate', async () => {
    const { db, reads } = createFlagsDb([])
    const envA = envWith(db)
    const envB = envWith(db)
    const t0 = 2_000_000
    await getDeploymentFlags(envA, t0)
    await getDeploymentFlags(envB, t0) // different env → its own read
    expect(reads()).toBe(2)
  })

  it('does NOT cache a failed read — the next request retries and recovers', async () => {
    let failNext = true
    let reads = 0
    const db = {
      prepare: () => {
        const exec = () => ({
          all: async () => {
            reads += 1
            if (failNext) throw new Error('D1 unavailable')
            return { results: [{ key: deploymentFlagKey('documents'), value: 'off' }] }
          },
        })
        return { ...exec(), bind: () => exec() }
      },
    }
    const env = { DB: db as unknown as D1Database }
    const t0 = 3_000_000
    // Read error → null (the fail-open signal), NOT cached.
    expect(await getDeploymentFlags(env, t0)).toBeNull()

    failNext = false
    // Still inside any TTL window from t0 on the SAME env: the recovered
    // table now answers, proving the failure was not cached for the TTL.
    expect(await isPluginDeploymentAvailable(env, 'documents', t0 + 1)).toBe(false)
    expect(reads).toBe(2)
  })

  it('returns the flag map so callers can inspect keys beyond plugins', async () => {
    const { db } = createFlagsDb([{ key: 'x.y', value: 'on' }])
    const flags = await getDeploymentFlags(envWith(db), 4_000_000)
    expect(flags?.get('x.y')).toBe('on')
  })
})
