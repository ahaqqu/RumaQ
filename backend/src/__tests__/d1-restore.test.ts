import { describe, it, expect, afterEach } from 'vite-plus/test'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations. These suppressions are contained to
// this file, mirroring `migrations.test.ts`: the dump is exercised against a
// real SQLite engine (node:sqlite — D1 is SQLite), which a structural test
// cannot give.
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { tmpdir } from 'node:os'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

// The restore-drill core is plain JS (no node types in this tsconfig), so the
// import is suppressed and re-declared with the shape the drill contract
// guarantees — see scripts/backup/verify-dump.mjs.
type Expectation = { table: string; op: '>=' | '='; count: number }
type VerifyResult = {
  integrity: string | null
  fkViolations: Array<Record<string, unknown>>
  counts: Record<string, number>
  failures: string[]
}
// @ts-expect-error — plain-JS drill module outside the backend project
import { verifyDump as verifyDumpJs } from '../../../scripts/backup/verify-dump.mjs'
const verifyDump = verifyDumpJs as (
  dumpPath: string,
  options?: { expect?: Expectation[]; requireTables?: string[] }
) => VerifyResult

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()
}

// Canary rows are synthetic (#342 §8): no real PII, one row per table the
// runbook's canary table names, valid against the real migration chain.
function canaryRows(): string[] {
  const sha = 'a'.repeat(64)
  return [
    `INSERT INTO users (id, email, name) VALUES ('u1', 'canary@example.com', 'Canary');`,
    `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Canary', 'u1');`,
    `INSERT INTO household_members (id, household_id, user_id, role) VALUES ('m1', 'h1', 'u1', 'owner');`,
    `INSERT INTO items (id, household_id, name) VALUES ('i1', 'h1', 'Beras');`,
    `INSERT INTO stock (id, household_id, item_id, qty) VALUES ('s1', 'h1', 'i1', 2);`,
    `INSERT INTO purchases (id, household_id, date, total) VALUES ('p1', 'h1', '2026-11-03', 15000);`,
    `INSERT INTO documents (id, household_id, member_id, category, file_name, mime_type, size_bytes, storage_key, sha256, uploaded_by)
     VALUES ('doc1', 'h1', NULL, 'ktp', 'ktp.jpg', 'image/jpeg', 10, 'documents/h1/doc1', '${sha}', 'u1');`,
  ]
}

// A dump in the shape the D1 export produces: the FK pragma, an explicit
// transaction wrapper, the schema (here: the real migration chain — the same
// SQL a migrated production DB contains) and the data rows.
function chainDump(dataRows: string[], truncate = false): string {
  const parts = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;']
  for (const file of migrationFiles()) {
    parts.push(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  parts.push(...dataRows)
  if (!truncate) parts.push('COMMIT;')
  return parts.join('\n')
}

const CANARY_TABLES = [
  'users',
  'households',
  'household_members',
  'stock',
  'purchases',
  'documents',
]

// Static edge-case fixture: the dump-format wrapper (FK pragma + explicit
// transaction) with hostile string literals — semicolons, doubled quotes and
// a newline inside VALUES, plus a payload that looks like SQL injection.
// Deterministic counts, independent of the migration chain's seeds.
function canaryFixture(): string {
  return [
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;',
    'CREATE TABLE canary (id TEXT PRIMARY KEY, payload TEXT NOT NULL);',
    `INSERT INTO canary VALUES ('g1', 'semi ; colon ''quoted'' and`,
    `a newline');`,
    `INSERT INTO canary VALUES ('g2', 'Robert''); DROP TABLE users;--');`,
    'COMMIT;',
  ].join('\n')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeTempDump(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'd1-restore-test-'))
  tempDirs.push(dir)
  const file = join(dir, 'dump.sql')
  writeFileSync(file, sql)
  return file
}

// The hard acceptance of the backup design (ahaqqu/RumaQ#342): a restore
// path that is TESTED. `verifyDump` must rebuild a real dump into scratch
// SQLite and prove integrity, referential sanity, and row counts — and must
// refuse dumps that are truncated, FK-damaged, or not what they claim.
describe('restore drill: verifyDump (scripts/backup/verify-dump.mjs)', () => {
  it('restores a dump built from the real migration chain and asserts the canary counts', () => {
    // Deltas against an empty-chain restore: the migration chain seeds rows
    // of its own (0014's admin bootstrap), so the canary's proof is "exactly
    // one more row per canary table than the bare schema holds".
    const base = verifyDump(writeTempDump(chainDump([])))
    expect(base.failures).toEqual([])

    const dumpPath = writeTempDump(chainDump(canaryRows()))
    const result = verifyDump(dumpPath, {
      requireTables: CANARY_TABLES,
    })

    expect(result.failures).toEqual([])
    expect(result.integrity).toBe('ok')
    expect(result.fkViolations).toEqual([])
    // Every canary table survived the dump round-trip with exactly its row.
    for (const table of CANARY_TABLES) {
      expect(result.counts[table]).toBe(base.counts[table] + 1)
    }
    // Untouched production tables come back zeroed, not missing — the vault
    // audit trail is present-and-empty, not dropped.
    expect(result.counts['document_audit']).toBe(0)
    expect(result.counts['household_invites']).toBe(0)
  })

  it('handles the dump-format wrapper: string literals with semicolons, escaped quotes and newlines', () => {
    const result = verifyDump(writeTempDump(canaryFixture()), {
      expect: [{ table: 'canary', op: '=', count: 2 }],
    })

    expect(result.failures).toEqual([])
    expect(result.counts['canary']).toBe(2)
  })

  it('catches referential damage the import itself does not reject (foreign_key_check)', () => {
    // The D1 import path runs with FK enforcement off, exactly like the
    // drill's restore — a child row naming a missing parent lands silently.
    // The drill exists to catch precisely this, so the probe must be real.
    const sql = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN TRANSACTION;',
      'CREATE TABLE parent (id TEXT PRIMARY KEY);',
      'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));',
      `INSERT INTO child (id, parent_id) VALUES ('c1', 'ghost');`,
      'COMMIT;',
    ].join('\n')
    const result = verifyDump(writeTempDump(sql))

    expect(result.integrity).toBe('ok')
    expect(result.fkViolations).toHaveLength(1)
    expect(JSON.stringify(result.fkViolations[0])).toContain('child')
    expect(result.failures.join('\n')).toMatch(/foreign_key_check found 1 violation/)
  })

  it('fails a dump truncated mid-statement', () => {
    // Simulates a cut-off download: the byte stream ends inside the INSERT
    // keyword itself, so the final statement is syntactically incomplete.
    const full = chainDump(canaryRows())
    const cutAt = full.indexOf('INSERT INTO purchases') + 'INSERT INTO purcha'.length
    const truncated = full.slice(0, cutAt)
    expect(truncated).not.toContain('COMMIT;')
    const result = verifyDump(writeTempDump(truncated))

    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.join('\n')).toMatch(/failed to execute/)
  })

  it('fails a dump truncated before its COMMIT (all statements complete)', () => {
    // The subtler truncation: every statement parses, so nothing throws —
    // but the transaction never commits, and reporting the session-local
    // rows as "restored" would be a lie. The ROLLBACK probe catches it.
    const withoutCommit =
      chainDump(canaryRows().slice(0, 1), true) +
      `\nINSERT INTO users (id, email, name) VALUES ('u2', 'late@example.com', 'Late');`
    const result = verifyDump(writeTempDump(withoutCommit))

    expect(result.failures.join('\n')).toMatch(/missing COMMIT/)
  })

  it('fails on a wrong --expect (exact and floor)', () => {
    // The static canary fixture holds exactly 2 rows — deterministic counts,
    // independent of what the migration chain seeds.
    const dumpPath = writeTempDump(canaryFixture())
    const exact = verifyDump(dumpPath, {
      expect: [{ table: 'canary', op: '=', count: 999 }],
    })
    expect(exact.failures.join('\n')).toMatch(/row count mismatch for canary: expected 999, got 2/)

    const floor = verifyDump(dumpPath, {
      expect: [{ table: 'canary', op: '>=', count: 5 }],
    })
    expect(floor.failures.join('\n')).toMatch(/row count floor for canary: expected >= 5, got 2/)

    const passingFloor = verifyDump(dumpPath, {
      expect: [{ table: 'canary', op: '>=', count: 2 }],
    })
    expect(passingFloor.failures).toEqual([])
  })

  it('fails when a required canary table is missing from the dump', () => {
    const sql = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN TRANSACTION;',
      'CREATE TABLE users (id TEXT PRIMARY KEY);',
      `INSERT INTO users VALUES ('u1');`,
      'COMMIT;',
    ].join('\n')
    const result = verifyDump(writeTempDump(sql), { requireTables: CANARY_TABLES })

    expect(result.failures.length).toBe(CANARY_TABLES.length - 1)
    expect(result.failures.join('\n')).toMatch(/required table missing from dump: households/)
  })

  it('fails readable on an unreadable or empty dump file', () => {
    const missing = verifyDump('/nonexistent/path/dump.sql')
    expect(missing.failures.join('\n')).toMatch(/dump file not readable/)

    const empty = verifyDump(writeTempDump('   \n  '))
    expect(empty.failures.join('\n')).toMatch(/dump file is empty/)
  })
})
