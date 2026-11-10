// Real-SQL test scaffolding shared by the suites that pin SQL + control-flow
// semantics against a real SQLite engine (node:sqlite — D1 is SQLite): a
// D1-shaped adapter over node:sqlite, plus the migration chain loader. The
// adapter carries only the surface the production drivers use, with batch()
// wrapped in a transaction (the purge completion batch's atomicity is
// exercised, not assumed). `guard` lets a suite fail specific statements at
// prepare time (the read-error fixtures).
//
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — the suppressions are contained to
// this one support module.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

export type Db = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations')

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()
}

export function createD1Adapter(sqlite: Db, guard?: (sql: string) => void): D1Database {
  const runBound = (sql: string, params: unknown[]) => {
    const info = sqlite.prepare(sql).run(...params)
    return { meta: { changes: info.changes } }
  }
  // D1's batch() returns a D1Result per statement — SELECT rows included, not
  // just write metadata (the review queue's list read is a batched SELECT).
  // node:sqlite splits rows (all) from changes (run) and running BOTH would
  // execute a write twice, so the shape is chosen by the statement's kind.
  const batchResult = (sql: string, params: unknown[]) => {
    if (/^\s*(select|with)\b/i.test(sql)) {
      return { results: sqlite.prepare(sql).all(...params), meta: { changes: 0 } }
    }
    return { results: [], ...runBound(sql, params) }
  }
  return {
    prepare: (sql: string) => {
      guard?.(sql)
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
          run: async () => runBound(sql, params),
          // The batch() form of this bound statement — not part of the D1
          // surface the production code touches.
          batchResult: async () => batchResult(sql, params),
        }),
      }
    },
    batch: async (stmts: Array<{ batchResult: () => Promise<unknown> }>) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const stmt of stmts) {
          results.push(await stmt.batchResult())
        }
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  } as unknown as D1Database
}

export function createDb(guard?: (sql: string) => void): { sqlite: Db; d1: D1Database } {
  const sqlite = new DatabaseSync(':memory:') as unknown as Db
  for (const file of migrationFiles()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return { sqlite, d1: createD1Adapter(sqlite, guard) }
}
