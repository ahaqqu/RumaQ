import { describe, it, expect, vi } from 'vite-plus/test'
// Real-SQL coverage for the plugin cron handoff (ahaqqu/RumaQ#441 — plugin
// architecture ticket 7, plan §4.3 scheduling + §4.4 failure isolation),
// following the plugin-purge.test.ts pattern: the driver's isolation and
// enablement claims are SQL + control-flow semantics, so they are pinned
// against a real SQLite engine (node:sqlite — D1 is SQLite), with fixture
// plugin registrations injected (runPluginCronTasks takes the registration
// list for exactly this — production callers get the composed registry).
//
//   - THE ACCEPTANCE (error isolation): one plugin's task throwing must not
//     break other plugins' tasks in the same tick, other households of its
//     own plugin, or the core tick on the other trigger — per-task and
//     per-household try/catch with the failure logged,
//   - enablement per household (the §4.3 truth table): an explicit disabled
//     row skips that household, an absent row falls to the manifest default,
//     a default-off plugin runs only where explicitly enabled, and a
//     'global' task ignores enablement entirely,
//   - the enabled-set read error fails closed FOR THE PLUGIN (its task skips
//     the tick) and open for everything else,
//   - compose drift (declared task, no handler) is soft-guarded: logged,
//     counted, never thrown,
//   - a failing task cannot consume or destroy OTHER seams' state: the purge
//     drain's cursor and state (the other seam on the nightly crons) resume
//     untouched after a plugin task fails.
//
// The D1-shaped adapter + migration chain loader (and the node: builtin
// suppressions) live in ./support/d1-sqlite.js — shared with the other
// real-SQL suites instead of duplicated per file.
import { Hono } from 'hono'
import { runPluginCronTasks, cronTaskBindingViolations } from '../lib/plugin-cron.js'
import { runPluginPurgeTick } from '../lib/plugin-purge.js'
import { PURGE_INITIATE_SQL } from '../lib/plugins.js'
import {
  resolveEnabledHouseholdIds,
  HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL,
  HOUSEHOLDS_ENABLED_EXPLICIT_SQL,
} from '../plugins/enablement.js'
import { pluginRegistrations } from '../plugins/registry.js'
import type { PluginCronTaskHandler, PluginRegistration } from '../plugins/types.js'
import { createDocumentsStub } from './support/env.js'
import { createDb, createD1Adapter, type Db } from './support/d1-sqlite.js'

function seedHousehold(sqlite: Db, id: string, name: string): void {
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(`u-${id}`, `${id}@b.com`)
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, name, `u-${id}`)
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES (?, ?, ?, 'owner')`
    )
    .run(`m-${id}`, id, `u-${id}`)
}

// A fixture registration whose manifest declares `cronTasks` and whose
// registration binds `handlers` — the driver's two contract surfaces,
// exercised through the same types production plugins use.
function fixturePlugin(args: {
  id: string
  defaultEnabled?: boolean
  cronTasks?: Array<{ name: string; scope: 'global' | 'household' }>
  handlers?: Record<string, PluginCronTaskHandler>
}): PluginRegistration {
  return {
    manifest: {
      id: args.id,
      name: args.id,
      version: '0.1.0',
      routePrefix: `/api/${args.id}`,
      defaultEnabled: args.defaultEnabled ?? true,
      capabilities: [],
      ports: [],
      ownedTables: [`${args.id}_rows`],
      cronTasks: args.cronTasks,
    },
    app: new Hono(),
    cronTaskHandlers: args.handlers,
  }
}

function driverEnv(d1: D1Database): Parameters<typeof runPluginCronTasks>[0] {
  return { DB: d1 } as unknown as Parameters<typeof runPluginCronTasks>[0]
}

describe('plugin cron handoff — error isolation is the contract (#441)', () => {
  it("one plugin's poisoned task does not break another plugin's task in the SAME tick, nor core", async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const goodCalls: Array<string | undefined> = []
    const pluginA = fixturePlugin({
      id: 'plugin-a',
      cronTasks: [{ name: 'good_task', scope: 'household' }],
      handlers: {
        good_task: async ({ householdId }) => {
          goodCalls.push(householdId)
        },
      },
    })
    const pluginB = fixturePlugin({
      id: 'plugin-b',
      cronTasks: [{ name: 'boom_task', scope: 'household' }],
      handlers: {
        boom_task: async () => {
          throw new Error('poisoned task')
        },
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await runPluginCronTasks(driverEnv(d1), [pluginA, pluginB])

    // No throw out of the tick: plugin-b failed per household (logged, it
    // retries next tick), plugin-a ran for BOTH households.
    expect(summary).toEqual({ ran: 2, failed: 2 })
    expect(goodCalls).toEqual(['h1', 'h2'])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('task failed for plugin-b/boom_task/h1'),
      expect.anything()
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('task failed for plugin-b/boom_task/h2'),
      expect.anything()
    )
    errorSpy.mockRestore()
  })

  it('a poisoned household fails alone: the healthy household of the SAME plugin still runs', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const ranFor: string[] = []
    const plugin = fixturePlugin({
      id: 'plugin-a',
      cronTasks: [{ name: 'task', scope: 'household' }],
      handlers: {
        task: async ({ householdId }) => {
          if (householdId === 'h1') throw new Error('h1 is poisoned')
          ranFor.push(householdId as string)
        },
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await runPluginCronTasks(driverEnv(d1), [plugin])

    expect(summary).toEqual({ ran: 1, failed: 1 })
    expect(ranFor).toEqual(['h2'])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('task failed for plugin-a/task/h1'),
      expect.anything()
    )
    errorSpy.mockRestore()
  })
})

describe('plugin cron handoff — enablement is respected per household (#441)', () => {
  it('a global task ignores enablement: it runs even with an explicit disabled row (§4.3)', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    sqlite
      .prepare(
        "INSERT INTO household_plugins (household_id, plugin_id, status) VALUES ('h1', 'plugin-g', 'disabled')"
      )
      .run()
    let ran = 0
    const pluginG = fixturePlugin({
      id: 'plugin-g',
      cronTasks: [{ name: 'global_sweep', scope: 'global' }],
      handlers: {
        global_sweep: async () => {
          ran += 1
        },
      },
    })

    const summary = await runPluginCronTasks(driverEnv(d1), [pluginG])

    expect(summary).toEqual({ ran: 1, failed: 0 })
    expect(ran).toBe(1)
  })

  it('the §4.3 truth table: explicit rows win, absent rows fall to the manifest default', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    // h1 expressed choices: default-ON plugin disabled, default-OFF plugin
    // enabled. h2 expressed nothing — both resolve to their defaults.
    sqlite
      .prepare(
        "INSERT INTO household_plugins (household_id, plugin_id, status) VALUES ('h1', 'plugin-on', 'disabled')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO household_plugins (household_id, plugin_id, status) VALUES ('h1', 'plugin-off', 'enabled')"
      )
      .run()
    const ranFor: Record<string, string[]> = { 'plugin-on': [], 'plugin-off': [] }
    const pluginOn = fixturePlugin({
      id: 'plugin-on',
      defaultEnabled: true,
      cronTasks: [{ name: 'task', scope: 'household' }],
      handlers: {
        task: async ({ householdId }) => {
          ranFor['plugin-on'].push(householdId as string)
        },
      },
    })
    const pluginOff = fixturePlugin({
      id: 'plugin-off',
      defaultEnabled: false,
      cronTasks: [{ name: 'task', scope: 'household' }],
      handlers: {
        task: async ({ householdId }) => {
          ranFor['plugin-off'].push(householdId as string)
        },
      },
    })

    const summary = await runPluginCronTasks(driverEnv(d1), [pluginOn, pluginOff])

    // plugin-on: h1's explicit 'disabled' beats the true default; h2 (absent
    // row) runs. plugin-off: h1's explicit 'enabled' beats the false default;
    // h2 (absent row) does NOT run. Neither plugin saw the other's household.
    expect(summary).toEqual({ ran: 2, failed: 0 })
    expect(ranFor['plugin-on']).toEqual(['h2'])
    expect(ranFor['plugin-off']).toEqual(['h1'])
  })

  it('an enabled-set read error fails closed FOR that plugin and open for the rest of the tick', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const guarded = createD1Adapter(sqlite, (sql) => {
      if (sql === HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL) throw new Error('DB down')
      if (sql === HOUSEHOLDS_ENABLED_EXPLICIT_SQL) throw new Error('DB down')
    })

    let globalRan = 0
    const pluginOn = fixturePlugin({
      id: 'plugin-on',
      defaultEnabled: true,
      cronTasks: [{ name: 'task', scope: 'household' }],
      handlers: { task: async () => {} },
    })
    // The default-OFF branch reads the OTHER statement — its read error
    // fails closed the same way (both enablement statements are the
    // driver's contract, not just the default-ON one).
    const pluginOff = fixturePlugin({
      id: 'plugin-off',
      defaultEnabled: false,
      cronTasks: [{ name: 'task', scope: 'household' }],
      handlers: { task: async () => {} },
    })
    const pluginG = fixturePlugin({
      id: 'plugin-g',
      cronTasks: [{ name: 'global_sweep', scope: 'global' }],
      handlers: {
        global_sweep: async () => {
          globalRan += 1
        },
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await runPluginCronTasks(driverEnv(guarded), [pluginOn, pluginOff, pluginG])

    // Both plugins' household tasks skipped for the night (§4.4: fail
    // closed for the plugin, open for core); plugin-g's global task ran
    // anyway.
    expect(summary).toEqual({ ran: 1, failed: 2 })
    expect(globalRan).toBe(1)
    // The driver's line names the plugin/task; the error itself rides the
    // enablement resolver's own log line ([plugins] enabled-set read
    // failed... — the resolver owns the read, the driver owns the posture).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('enabled-set read failed for plugin-on/task; failing closed')
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('enabled-set read failed for plugin-off/task; failing closed')
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plugins] enabled-set read failed for plugin-on'),
      expect.anything()
    )
    errorSpy.mockRestore()
  })
})

describe('plugin cron handoff — compose drift and the binding check (#441)', () => {
  it('a declared task with no bound handler is skipped and logged, never thrown', async () => {
    const { d1 } = createDb()
    let healthyRan = 0
    const drifted = fixturePlugin({
      id: 'plugin-d',
      cronTasks: [{ name: 'orphan_task', scope: 'global' }],
    })
    const healthy = fixturePlugin({
      id: 'plugin-h',
      cronTasks: [{ name: 'healthy_task', scope: 'global' }],
      handlers: {
        healthy_task: async () => {
          healthyRan += 1
        },
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await runPluginCronTasks(driverEnv(d1), [drifted, healthy])

    expect(summary).toEqual({ ran: 1, failed: 1 })
    expect(healthyRan).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('plugin-d/orphan_task is declared with no bound handler')
    )
    errorSpy.mockRestore()
  })

  it('cronTaskBindingViolations reports both drift directions; the real registry is clean', () => {
    const drifted = fixturePlugin({
      id: 'plugin-d',
      cronTasks: [
        { name: 'declared_no_handler', scope: 'global' },
        { name: 'bound', scope: 'global' },
      ],
      handlers: { bound: async () => {}, handler_no_declaration: async () => {} },
    })
    const violations = cronTaskBindingViolations([drifted])
    expect(violations).toHaveLength(2)
    expect(violations[0]).toContain('declared with no bound handler')
    expect(violations[0]).toContain('manifest plugin-d')
    expect(violations[1]).toContain('has no manifest declaration')

    // The shipped registry binds everything it declares — and declares
    // nothing yet (§4.3: "No plugin in v1 needs either").
    const env = { DOCUMENTS: createDocumentsStub() } as unknown as Parameters<
      typeof pluginRegistrations
    >[0]
    expect(cronTaskBindingViolations(pluginRegistrations(env))).toEqual([])
  })
})

describe('plugin cron handoff — coexistence with the purge seam (#441)', () => {
  // Seeds a document + one file row directly (the lean bulk path; the
  // bytes-before-rows ordering itself is plugin-purge.test.ts's suite).
  function seedDocument(sqlite: Db, householdId: string, documentId: string): void {
    sqlite
      .prepare(
        `INSERT INTO documents (id, household_id, name, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(documentId, householdId, `Dok ${documentId}`, `u-${householdId}`, '2026-11-01 10:00:00')
    sqlite
      .prepare(
        `INSERT INTO document_files
           (id, document_id, r2_key, file_name, size_bytes, content_type, sort_order, sha256, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `f-${documentId}`,
        documentId,
        `documents/${householdId}/${documentId}/file`,
        'f.pdf',
        8,
        'application/pdf',
        1,
        'a'.repeat(64),
        `u-${householdId}`
      )
  }

  function requestPurge(sqlite: Db, householdId: string, requestedBy: string): void {
    sqlite
      .prepare(
        `INSERT INTO household_plugins (household_id, plugin_id, status)
         VALUES (?, 'documents', 'enabled')
         ON CONFLICT (household_id, plugin_id) DO NOTHING`
      )
      .run(householdId)
    sqlite.prepare(PURGE_INITIATE_SQL).run(requestedBy, householdId, 'documents')
  }

  it("a plugin task failure leaves the purge drain's cursor and state untouched: the drain resumes and completes", async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedDocument(sqlite, 'h1', 'd-1')
    requestPurge(sqlite, 'h1', 'u-h1')
    const bucket = createDocumentsStub()
    const env = {
      DB: d1,
      DOCUMENTS: bucket,
    } as unknown as Parameters<typeof runPluginPurgeTick>[0]
    const poisoned = fixturePlugin({
      id: 'plugin-b',
      cronTasks: [{ name: 'boom_task', scope: 'global' }],
      handlers: {
        boom_task: async () => {
          throw new Error('poisoned task')
        },
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The plugin-tasks invocation: the fixture task fails, logged, and the
    // tick carries on (nothing else declared).
    const cronSummary = await runPluginCronTasks(
      env as unknown as Parameters<typeof runPluginCronTasks>[0],
      [poisoned]
    )
    expect(cronSummary).toEqual({ ran: 0, failed: 1 })

    // The purge seam is UNTOUCHED: the drain the failing task did not consume
    // resumes on the core tick, bytes go, cursor advances, receipt lands.
    const night1 = await runPluginPurgeTick(env)
    expect(night1).toEqual({ objects: 1, chunks: 1, failed: 0 })
    const night2 = await runPluginPurgeTick(env)
    expect(night2).toEqual({ objects: 0, chunks: 1, failed: 0 })
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM documents').get() as { cnt: number }).cnt
    ).toBe(0)
    expect(
      sqlite
        .prepare(
          `SELECT purge_state FROM household_plugins WHERE household_id = 'h1' AND plugin_id = 'documents'`
        )
        .get()
    ).toMatchObject({ purge_state: 'done' })
    expect(bucket.deleted).toEqual(['documents/h1/d-1/file'])
    errorSpy.mockRestore()
  })
})

describe('plugin cron handoff — the enabled-set resolver (enablement.ts, #441)', () => {
  it('answers the enabled set per the §4.3 truth table and null on a read error', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    sqlite
      .prepare(
        "INSERT INTO household_plugins (household_id, plugin_id, status) VALUES ('h1', 'on', 'disabled')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO household_plugins (household_id, plugin_id, status) VALUES ('h1', 'off', 'enabled')"
      )
      .run()

    // default ON: h1's explicit disabled row wins; h2 rides the default.
    expect(await resolveEnabledHouseholdIds(d1, { id: 'on', defaultEnabled: true })).toEqual(['h2'])
    // default OFF: h1's explicit enabled row wins; h2 (absent) does not.
    expect(await resolveEnabledHouseholdIds(d1, { id: 'off', defaultEnabled: false })).toEqual([
      'h1',
    ])

    const broken = {
      prepare: () => {
        throw new Error('DB down')
      },
    } as unknown as D1Database
    expect(await resolveEnabledHouseholdIds(broken, { id: 'on', defaultEnabled: true })).toBeNull()
  })
})
