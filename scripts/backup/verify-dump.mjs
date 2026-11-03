#!/usr/bin/env node
// D1 restore-drill verification core (ahaqqu/RumaQ#342).
//
// Rebuilds a D1 dump into a scratch in-memory SQLite database (node:sqlite —
// D1 is SQLite, the `migrations.test.ts` pattern) and asserts the dump is
// fully restorable BEFORE anyone points production at it (the backup design's
// hard acceptance, docs/plan/d1-backup.md §7-§8).
//
//   CLI:    node scripts/backup/verify-dump.mjs <dump.sql>
//                [--expect table=count ...] [--require-table name ...]
//   Module: import { verifyDump, parseExpectArgs } from './verify-dump.mjs'
//
// Checks, in order:
//   1. the dump file exists and is non-empty
//   2. the dump executes in full — a mid-statement truncation throws here
//   3. no transaction is left open — a dump truncated after the last
//      statement but before its COMMIT is caught by a ROLLBACK probe instead
//      of silently presenting session-local uncommitted rows as "restored"
//   4. PRAGMA integrity_check = ok
//   5. PRAGMA foreign_key_check = zero violations (the import runs with FK
//      enforcement off, exactly like the D1 import path, so referential
//      damage in the dump is caught here, not silently accepted)
//   6. row counts per user table — always reported; asserted when --expect
//      is given (`table=count` exact, `table>=count` floor)
//
// Exit 0 = verified; 1 = any failure. `restore-drill.sh` is the human
// entrypoint (default canary expectations). No secrets, no network, no
// production access — a dump file in, a verdict out.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const USAGE =
  'usage: node scripts/backup/verify-dump.mjs <dump.sql> [--expect table=count ...] [--require-table name ...]'

// Parses `table=count` / `table>=count` tokens into structured expectations.
export function parseExpectArgs(tokens) {
  const out = []
  for (const token of tokens) {
    const match = /^(.+?)(>=|=)(\d+)$/.exec(token)
    if (!match) {
      throw new Error(`invalid --expect "${token}" — expected table=count or table>=count`)
    }
    out.push({ table: match[1], op: match[2], count: Number(match[3]) })
  }
  return out
}

// Restores `dumpPath` into a scratch SQLite and returns the verdict. Never
// throws for a bad dump — failures come back as human-readable strings.
//
// @param {string} dumpPath
// @param {{ expect?: Array<{ table: string, op: string, count: number }>, requireTables?: string[] }} [options]
// @returns {{ integrity: string | null, fkViolations: Array<Record<string, unknown>>, counts: Record<string, number>, failures: string[] }}
export function verifyDump(dumpPath, options = {}) {
  const empty = { integrity: null, fkViolations: [], counts: {}, failures: [] }

  let sql = ''
  try {
    sql = readFileSync(dumpPath, 'utf8')
  } catch (err) {
    return { ...empty, failures: [`dump file not readable: ${dumpPath} (${err.message})`] }
  }
  if (sql.trim() === '') {
    return { ...empty, failures: [`dump file is empty: ${dumpPath}`] }
  }

  const db = new DatabaseSync(':memory:')
  try {
    // The dump runs as one script, exactly like it would against D1. A
    // mid-statement truncation surfaces here as a syntax error.
    try {
      db.exec(sql)
    } catch (err) {
      return {
        ...empty,
        failures: [`dump failed to execute (truncated or invalid SQL): ${err.message}`],
      }
    }

    // Truncation probe: a complete-statement dump missing its final COMMIT
    // leaves everything uncommitted in the session. ROLLBACK succeeds only
    // when a transaction is still open; a properly committed dump throws.
    let openTransaction = false
    try {
      db.exec('ROLLBACK')
      openTransaction = true
    } catch {
      // no transaction active — the dump committed cleanly
    }
    if (openTransaction) {
      return {
        ...empty,
        failures: ['dump ended inside an open transaction (missing COMMIT) — truncated dump?'],
      }
    }

    const integrityRow = db.prepare('PRAGMA integrity_check').get()
    const integrity = integrityRow ? String(integrityRow.integrity_check) : null
    if (integrity !== 'ok') {
      return { ...empty, failures: [`integrity_check failed: ${integrity}`] }
    }

    // Works even though the import ran with FK enforcement off (the default
    // per-connection pragma, same as the D1 import path).
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all()
    if (fkViolations.length > 0) {
      return {
        ...empty,
        integrity,
        fkViolations,
        failures: [
          `foreign_key_check found ${fkViolations.length} violation(s) — referential damage in the dump`,
        ],
      }
    }

    const counts = {}
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
    for (const row of tables) {
      const name = String(row.name)
      const quoted = `"${name.replaceAll('"', '""')}"`
      counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n)
    }

    const failures = []
    for (const required of options.requireTables ?? []) {
      if (!(required in counts)) failures.push(`required table missing from dump: ${required}`)
    }
    for (const expectation of options.expect ?? []) {
      const actual = counts[expectation.table]
      if (actual === undefined) {
        failures.push(`cannot assert ${expectation.table}: table missing from dump`)
        continue
      }
      if (expectation.op === '=' && actual !== expectation.count) {
        failures.push(
          `row count mismatch for ${expectation.table}: expected ${expectation.count}, got ${actual}`
        )
      }
      if (expectation.op === '>=' && actual < expectation.count) {
        failures.push(
          `row count floor for ${expectation.table}: expected >= ${expectation.count}, got ${actual}`
        )
      }
    }
    return { integrity, fkViolations, counts, failures }
  } finally {
    db.close()
  }
}

function printReport(dumpPath, result) {
  console.log(`dump: ${dumpPath}`)
  console.log(`integrity_check: ${result.integrity ?? 'not reached'}`)
  console.log(`foreign_key_check: ${result.fkViolations.length} violation(s)`)
  console.log(`tables: ${Object.keys(result.counts).length}`)
  for (const [table, count] of Object.entries(result.counts)) {
    console.log(`  ${table}: ${count}`)
  }
  if (result.failures.length === 0) {
    console.log('VERIFIED — dump restores cleanly (scratch SQLite; production untouched)')
  } else {
    console.log(`FAILED (${result.failures.length}):`)
    for (const failure of result.failures) console.log(`  - ${failure}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const positional = []
  const expectTokens = []
  const requireTables = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--expect') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        expectTokens.push(argv[++i])
      }
    } else if (arg === '--require-table') {
      if (i + 1 >= argv.length) {
        console.error(USAGE)
        process.exit(1)
      }
      requireTables.push(argv[++i])
    } else if (arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}\n${USAGE}`)
      process.exit(1)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length !== 1) {
    console.error(USAGE)
    process.exit(1)
  }

  let expect = []
  try {
    expect = parseExpectArgs(expectTokens)
  } catch (err) {
    console.error(String(err.message))
    process.exit(1)
  }

  const result = verifyDump(positional[0], { expect, requireTables })
  printReport(positional[0], result)
  process.exit(result.failures.length === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
