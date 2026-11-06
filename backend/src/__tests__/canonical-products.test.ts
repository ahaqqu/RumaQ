import { describe, it, expect } from 'vite-plus/test'
import {
  AuditNotFoundError,
  DuplicateNameError,
  InvalidNameError,
  InvalidReasonError,
  ProductNotFoundError,
  StaleProductError,
  StaleRevertError,
  getProductIdentity,
  renameProduct,
  revertProductRename,
} from '../lib/canonical-products.js'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtins carry no declarations — same contained suppressions as
// migrations.test.ts / match-review.test.ts. These semantics run on real SQLite
// (node:sqlite — D1 is SQLite) against the real migration chain, which is the
// only way to pin the guarded UPDATE / gated audit / unique-index rules.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number | bigint }
    all(...params: unknown[]): Array<Record<string, unknown>>
    get(...params: unknown[]): Record<string, unknown> | undefined
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')
const NOW = '2026-11-07T00:00:00.000Z'

function applyRealMigrations(db: SqliteDb): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

// Minimal D1-shaped adapter over node:sqlite: prepare → bind → first/all/run,
// and a batch that mirrors D1's all-or-nothing contract. The transaction is the
// point: the revert unique-index test relies on the failed INSERT rolling the
// guarded UPDATE back.
class TestStatement {
  constructor(
    private readonly sqlite: SqliteDb,
    readonly sql: string,
    readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): TestStatement {
    return new TestStatement(this.sqlite, this.sql, params)
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.params) ?? null) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) as T[] }
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.sqlite.prepare(this.sql).run(...this.params)
    return { success: true, meta: { changes: Number(info?.changes ?? 0) } }
  }
}

function runInBatch(sqlite: SqliteDb, statement: TestStatement) {
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement.sql)) {
    return {
      results: sqlite.prepare(statement.sql).all(...statement.params),
      success: true,
      meta: { changes: 0 },
    }
  }
  const info = sqlite.prepare(statement.sql).run(...statement.params)
  return { results: [], success: true, meta: { changes: Number(info?.changes ?? 0) } }
}

function sqliteD1(sqlite: SqliteDb): D1Database {
  return {
    prepare: (sql: string) => new TestStatement(sqlite, sql),
    batch: async (statements: TestStatement[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement) => runInBatch(sqlite, statement))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

function freshDb() {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
  applyRealMigrations(sqlite)
  return sqlite
}

type ProductSeed = {
  id: string
  productKey: string
  name: string
  brand: string | null
  unit: string | null
  status: string
  metadataVersion: number
}

function insertProduct(sqlite: SqliteDb, over: Partial<ProductSeed> = {}): ProductSeed {
  const row: ProductSeed = {
    id: 'prod-1',
    productKey: 'beras--ramos--5-kg',
    name: 'Beras Ramos 5 kg',
    brand: null,
    unit: '5 kg',
    status: 'provisional',
    metadataVersion: 1,
    ...over,
  }
  sqlite
    .prepare(
      `INSERT INTO price_products
         (id, product_key, name, brand, unit, status, metadata_version,
          first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.productKey,
      row.name,
      row.brand,
      row.unit,
      row.status,
      row.metadataVersion,
      NOW,
      NOW,
      NOW
    )
  return row
}

function insertAlias(
  sqlite: SqliteDb,
  input: {
    id: string
    productId: string
    storeSlug: string
    name: string
    status?: 'candidate' | 'approved'
    source?: 'ocr' | 'catalog' | 'admin'
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.productId,
      input.storeSlug,
      input.name,
      input.status ?? 'candidate',
      input.source ?? 'ocr',
      NOW,
      NOW
    )
}

function insertObservation(
  sqlite: SqliteDb,
  input: { id: string; productId: string; sourceId: string; observedDate: string }
): void {
  sqlite
    .prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
       VALUES (?, ?, ?, ?, 10000, 1.0, ?)`
    )
    .run(input.id, input.productId, input.sourceId, input.observedDate, NOW)
}

function insertSource(sqlite: SqliteDb, id: string, slug: string): void {
  sqlite.prepare('INSERT INTO price_sources (id, slug, name) VALUES (?, ?, ?)').run(id, slug, slug)
}

function insertAuditRow(
  sqlite: SqliteDb,
  over: {
    id: string
    productId?: string
    productKey?: string
    action?: 'rename' | 'revert'
    oldName: string
    newName: string
    before: number
    after: number
    revertsAuditId?: string | null
    createdAt: string
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO price_product_audit
         (id, product_id, product_key, actor_user_id, action, old_name, new_name, reason,
          metadata_version_before, metadata_version_after, reverts_audit_id, created_at)
       VALUES (?, ?, ?, 'admin-1', ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      over.id,
      over.productId ?? 'prod-1',
      over.productKey ?? 'beras--ramos--5-kg',
      over.action ?? 'rename',
      over.oldName,
      over.newName,
      over.before,
      over.after,
      over.revertsAuditId ?? null,
      over.createdAt
    )
}

function productById(sqlite: SqliteDb, id = 'prod-1') {
  return sqlite.prepare('SELECT * FROM price_products WHERE id = ?').get(id)
}

function indexVersion(sqlite: SqliteDb): number {
  return Number(
    sqlite.prepare('SELECT version FROM canonical_index_state WHERE id = 1').get()?.version
  )
}

function auditRows(sqlite: SqliteDb) {
  return sqlite
    .prepare('SELECT * FROM price_product_audit ORDER BY metadata_version_after ASC')
    .all()
}

describe('getProductIdentity — real-SQLite semantics', () => {
  it('returns product, every alias, observation stats, and the audit tail newest first', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertAlias(sqlite, {
      id: 'alias-1',
      productId: 'prod-1',
      storeSlug: 'superindo',
      name: 'Beras Ramos',
    })
    insertAlias(sqlite, {
      id: 'alias-2',
      productId: 'prod-1',
      storeSlug: 'lotte-mart',
      name: 'Beras Ramos 5kg',
      status: 'approved',
      source: 'admin',
    })
    insertSource(sqlite, 'src-1', 'superindo')
    insertSource(sqlite, 'src-2', 'lotte-mart')
    insertObservation(sqlite, {
      id: 'obs-1',
      productId: 'prod-1',
      sourceId: 'src-1',
      observedDate: '2026-11-01',
    })
    insertObservation(sqlite, {
      id: 'obs-2',
      productId: 'prod-1',
      sourceId: 'src-1',
      observedDate: '2026-11-02',
    })
    insertObservation(sqlite, {
      id: 'obs-3',
      productId: 'prod-1',
      sourceId: 'src-2',
      observedDate: '2026-11-02',
    })

    // Twelve receipts, only the newest ten should be returned. Same created_at
    // for the last two pins the metadata_version tie-break.
    for (let i = 1; i <= 12; i += 1) {
      insertAuditRow(sqlite, {
        id: `audit-${i}`,
        oldName: `Old ${i}`,
        newName: `New ${i}`,
        before: i,
        after: i + 1,
        createdAt:
          i === 11 || i === 12
            ? '2026-11-07T00:00:00.000Z'
            : `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      })
    }

    const identity = await getProductIdentity(sqliteD1(sqlite), 'beras--ramos--5-kg')
    expect(identity).not.toBeNull()
    expect(identity!.product).toMatchObject({
      id: 'prod-1',
      productKey: 'beras--ramos--5-kg',
      name: 'Beras Ramos 5 kg',
      status: 'provisional',
      metadataVersion: 1,
    })
    expect(identity!.aliases).toEqual([
      expect.objectContaining({ storeSlug: 'lotte-mart', status: 'approved', source: 'admin' }),
      expect.objectContaining({ storeSlug: 'superindo', status: 'candidate', source: 'ocr' }),
    ])
    expect(identity!.stats).toEqual({ observations: 3, stores: 2 })
    expect(identity!.audit).toHaveLength(10)
    expect(identity!.audit[0]).toMatchObject({ id: 'audit-12', metadataVersionAfter: 13 })
    expect(identity!.audit[1]).toMatchObject({ id: 'audit-11', metadataVersionAfter: 12 })
    expect(identity!.audit[9]).toMatchObject({ id: 'audit-3' })
  })

  it('returns null for an unknown productKey', async () => {
    const sqlite = freshDb()
    expect(await getProductIdentity(sqliteD1(sqlite), 'nope--x--1-kg')).toBeNull()
  })
})

describe('renameProduct — real-SQLite semantics', () => {
  it('renames, approves matching candidate aliases per store, audits, and bumps the index once', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertAlias(sqlite, {
      id: 'alias-superindo',
      productId: 'prod-1',
      storeSlug: 'superindo',
      name: 'Beras Ramos 5 kg',
    })
    insertAlias(sqlite, {
      id: 'alias-lotte',
      productId: 'prod-1',
      storeSlug: 'lotte-mart',
      name: ' Beras Ramos 5 kg ',
    })
    insertAlias(sqlite, {
      id: 'alias-alfamart',
      productId: 'prod-1',
      storeSlug: 'alfamart',
      name: 'Beras Ramos 5kg',
    })
    insertAlias(sqlite, {
      id: 'alias-approved',
      productId: 'prod-1',
      storeSlug: 'indomaret',
      name: 'Beras Ramos',
      status: 'approved',
    })

    const result = await renameProduct(sqliteD1(sqlite), {
      productKey: 'beras--ramos--5-kg',
      canonicalName: '  Beras   Ramos Premium Kualitas Baru  ',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
      reason: '  label fix  ',
    })

    expect(result.product).toMatchObject({
      name: 'Beras Ramos Premium Kualitas Baru',
      metadataVersion: 2,
      // Decision 1: a rename is a label fix, never a promotion.
      status: 'provisional',
    })
    expect(result.indexVersion).toBe(1)
    expect(result.warnings).toEqual([])
    expect(result.audit).toHaveLength(1)
    expect(result.audit[0]).toMatchObject({
      action: 'rename',
      oldName: 'Beras Ramos 5 kg',
      newName: 'Beras Ramos Premium Kualitas Baru',
      reason: 'label fix',
      actorUserId: 'admin-1',
      metadataVersionBefore: 1,
      metadataVersionAfter: 2,
      revertsAuditId: null,
    })

    const product = productById(sqlite)!
    expect(product.name).toBe('Beras Ramos Premium Kualitas Baru')
    expect(product.metadata_version).toBe(2)
    expect(product.status).toBe('provisional')

    const aliases = sqlite.prepare('SELECT id, status FROM price_product_aliases ORDER BY id').all()
    expect(aliases).toEqual([
      { id: 'alias-alfamart', status: 'candidate' }, // spelling differs, not approved
      { id: 'alias-approved', status: 'approved' }, // already approved, untouched
      { id: 'alias-lotte', status: 'approved' }, // trim(name) matched
      { id: 'alias-superindo', status: 'approved' },
    ])
    expect(auditRows(sqlite)).toHaveLength(1)
    expect(indexVersion(sqlite)).toBe(1)
  })

  it('rejects a stale expectedMetadataVersion and writes nothing', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertAlias(sqlite, {
      id: 'alias-1',
      productId: 'prod-1',
      storeSlug: 'superindo',
      name: 'Beras Ramos 5 kg',
    })

    await expect(
      renameProduct(sqliteD1(sqlite), {
        productKey: 'beras--ramos--5-kg',
        canonicalName: 'Beras Ramos Premium',
        expectedMetadataVersion: 9,
        actorUserId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(StaleProductError)

    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(productById(sqlite)!.metadata_version).toBe(1)
    expect(sqlite.prepare('SELECT status FROM price_product_aliases').get()).toEqual({
      status: 'candidate',
    })
    expect(auditRows(sqlite)).toHaveLength(0)
    expect(indexVersion(sqlite)).toBe(0)
  })

  it('rejects a canonical-name collision with another product (case-insensitive)', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertProduct(sqlite, {
      id: 'prod-2',
      productKey: 'gula--gulaku--1-kg',
      name: 'Gula Pasir Gulaku 1 kg',
    })

    await expect(
      renameProduct(sqliteD1(sqlite), {
        productKey: 'beras--ramos--5-kg',
        canonicalName: 'gula pasir gulaku 1 KG',
        expectedMetadataVersion: 1,
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({
      name: 'DuplicateNameError',
      conflicts: [{ productKey: 'gula--gulaku--1-kg', source: 'product' }],
    })

    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(auditRows(sqlite)).toHaveLength(0)
    expect(indexVersion(sqlite)).toBe(0)
  })

  it("rejects a collision with another product's approved alias, but ignores a candidate alias", async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertProduct(sqlite, {
      id: 'prod-2',
      productKey: 'gula--gulaku--1-kg',
      name: 'Gula Pasir Gulaku 1 kg',
    })
    insertAlias(sqlite, {
      id: 'alias-approved',
      productId: 'prod-2',
      storeSlug: 'superindo',
      name: 'Gulaku Premium',
      status: 'approved',
    })
    insertAlias(sqlite, {
      id: 'alias-candidate',
      productId: 'prod-2',
      storeSlug: 'lotte-mart',
      name: 'Tepung Terigu',
    })

    const db = sqliteD1(sqlite)
    await expect(
      renameProduct(db, {
        productKey: 'beras--ramos--5-kg',
        canonicalName: 'GULAKU PREMIUM',
        expectedMetadataVersion: 1,
        actorUserId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(DuplicateNameError)

    // A candidate alias is not canonical, so it does not block the rename.
    const result = await renameProduct(db, {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Tepung Terigu',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    })
    expect(result.product.name).toBe('Tepung Terigu')
    expect(indexVersion(sqlite)).toBe(1)
  })

  it('warns on a similar name (Jaccard >= 0.8) and proceeds when acknowledged', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertProduct(sqlite, {
      id: 'prod-2',
      productKey: 'beras--ramos--5-kg-super',
      name: 'Beras Ramos 5 kg Super',
    })

    const db = sqliteD1(sqlite)
    const input = {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos 5 kg Super Extra',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    }

    await expect(renameProduct(db, input)).rejects.toMatchObject({
      name: 'SimilarNameError',
      warnings: [
        {
          productKey: 'beras--ramos--5-kg-super',
          name: 'Beras Ramos 5 kg Super',
          similarity: 0.833,
        },
      ],
    })
    // A 409 writes nothing.
    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(auditRows(sqlite)).toHaveLength(0)
    expect(indexVersion(sqlite)).toBe(0)

    const result = await renameProduct(db, { ...input, acknowledgeWarnings: true })
    expect(result.warnings).toHaveLength(1)
    expect(result.product.name).toBe('Beras Ramos 5 kg Super Extra')
    expect(result.indexVersion).toBe(1)
  })

  it('does not synthesise an alias when no candidate matches the old name', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertAlias(sqlite, {
      id: 'alias-1',
      productId: 'prod-1',
      storeSlug: 'superindo',
      name: 'Beras Ramos 5kg',
    })

    const result = await renameProduct(sqliteD1(sqlite), {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos Premium Kualitas Baru',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    })

    expect(result.product.name).toBe('Beras Ramos Premium Kualitas Baru')
    const aliases = sqlite.prepare('SELECT name, status FROM price_product_aliases').all()
    expect(aliases).toEqual([{ name: 'Beras Ramos 5kg', status: 'candidate' }])
  })

  it('validates the name and reason before writing anything', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    const db = sqliteD1(sqlite)
    const base = {
      productKey: 'beras--ramos--5-kg',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    }

    for (const canonicalName of ['   ', 'Beras\nRamos', 'x'.repeat(501)]) {
      await expect(renameProduct(db, { ...base, canonicalName })).rejects.toBeInstanceOf(
        InvalidNameError
      )
    }
    await expect(
      renameProduct(db, { ...base, canonicalName: 'Beras Ramos 5 kg' })
    ).rejects.toBeInstanceOf(InvalidNameError)
    await expect(
      renameProduct(db, {
        ...base,
        canonicalName: 'Beras Ramos Premium',
        reason: 'x'.repeat(201),
      })
    ).rejects.toBeInstanceOf(InvalidReasonError)
    await expect(
      renameProduct(db, {
        ...base,
        canonicalName: 'Beras Ramos Premium',
        reason: 'bad\nreason',
      })
    ).rejects.toBeInstanceOf(InvalidReasonError)

    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(auditRows(sqlite)).toHaveLength(0)
    expect(indexVersion(sqlite)).toBe(0)
  })

  it('throws ProductNotFoundError for an unknown productKey', async () => {
    const sqlite = freshDb()
    await expect(
      renameProduct(sqliteD1(sqlite), {
        productKey: 'nope--x--1-kg',
        canonicalName: 'Anything',
        expectedMetadataVersion: 1,
        actorUserId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(ProductNotFoundError)
  })
})

describe('revertProductRename — real-SQLite semantics', () => {
  it('restores the previous name, appends a compensating row, and bumps versions once', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    const db = sqliteD1(sqlite)

    const renamed = await renameProduct(db, {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos Premium',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
      reason: 'fix',
    })
    const renameAuditId = renamed.audit[0]!.id

    const reverted = await revertProductRename(db, {
      productKey: 'beras--ramos--5-kg',
      auditId: renameAuditId,
      actorUserId: 'admin-2',
      reason: 'wrong label',
    })

    expect(reverted.product).toMatchObject({
      name: 'Beras Ramos 5 kg',
      metadataVersion: 3,
      status: 'provisional',
    })
    expect(reverted.indexVersion).toBe(2)
    expect(reverted.warnings).toEqual([])
    expect(reverted.audit).toHaveLength(2)
    expect(reverted.audit[0]).toMatchObject({
      action: 'revert',
      oldName: 'Beras Ramos Premium',
      newName: 'Beras Ramos 5 kg',
      reason: 'wrong label',
      actorUserId: 'admin-2',
      metadataVersionBefore: 2,
      metadataVersionAfter: 3,
      revertsAuditId: renameAuditId,
    })
    expect(reverted.audit[1]).toMatchObject({ id: renameAuditId, action: 'rename' })

    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(productById(sqlite)!.metadata_version).toBe(3)
    expect(auditRows(sqlite)).toHaveLength(2)
    expect(indexVersion(sqlite)).toBe(2)
  })

  it('rejects a revert of a rename that is no longer the latest', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    const db = sqliteD1(sqlite)

    const first = await renameProduct(db, {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos Premium',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    })
    await renameProduct(db, {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos Premium Baru',
      expectedMetadataVersion: 2,
      actorUserId: 'admin-1',
    })

    await expect(
      revertProductRename(db, {
        productKey: 'beras--ramos--5-kg',
        auditId: first.audit[0]!.id,
        actorUserId: 'admin-2',
      })
    ).rejects.toBeInstanceOf(StaleRevertError)

    expect(productById(sqlite)!.name).toBe('Beras Ramos Premium Baru')
    expect(productById(sqlite)!.metadata_version).toBe(3)
    expect(auditRows(sqlite)).toHaveLength(2)
    expect(indexVersion(sqlite)).toBe(2)
  })

  it('rejects a second revert of the same rename and leaves the first compensation intact', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    const db = sqliteD1(sqlite)

    const renamed = await renameProduct(db, {
      productKey: 'beras--ramos--5-kg',
      canonicalName: 'Beras Ramos Premium',
      expectedMetadataVersion: 1,
      actorUserId: 'admin-1',
    })
    await revertProductRename(db, {
      productKey: 'beras--ramos--5-kg',
      auditId: renamed.audit[0]!.id,
      actorUserId: 'admin-1',
    })

    await expect(
      revertProductRename(db, {
        productKey: 'beras--ramos--5-kg',
        auditId: renamed.audit[0]!.id,
        actorUserId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(StaleRevertError)

    expect(productById(sqlite)!.name).toBe('Beras Ramos 5 kg')
    expect(productById(sqlite)!.metadata_version).toBe(3)
    expect(auditRows(sqlite)).toHaveLength(2)
    expect(indexVersion(sqlite)).toBe(2)
  })

  it('maps the reverts_audit_id unique index to StaleRevertError', async () => {
    // Pin the storage-level backstop directly: a current-version rename row
    // that already has a compensating row passes the "latest" pre-check, so the
    // insert itself hits idx_price_product_audit_revert_once. The whole batch
    // must roll back — a failed 409 may not leave the product renamed.
    const sqlite = freshDb()
    insertProduct(sqlite, { name: 'Beras Ramos Premium', metadataVersion: 2 })
    insertAuditRow(sqlite, {
      id: 'audit-rename',
      oldName: 'Beras Ramos 5 kg',
      newName: 'Beras Ramos Premium',
      before: 1,
      after: 2,
      createdAt: '2026-11-07T00:00:00.000Z',
    })
    insertAuditRow(sqlite, {
      id: 'audit-revert-existing',
      action: 'revert',
      oldName: 'Beras Ramos Premium',
      newName: 'Beras Ramos 5 kg',
      before: 2,
      after: 3,
      revertsAuditId: 'audit-rename',
      createdAt: '2026-11-07T00:00:01.000Z',
    })

    await expect(
      revertProductRename(sqliteD1(sqlite), {
        productKey: 'beras--ramos--5-kg',
        auditId: 'audit-rename',
        actorUserId: 'admin-1',
      })
    ).rejects.toBeInstanceOf(StaleRevertError)

    expect(productById(sqlite)!.name).toBe('Beras Ramos Premium')
    expect(productById(sqlite)!.metadata_version).toBe(2)
    expect(auditRows(sqlite)).toHaveLength(2)
    expect(indexVersion(sqlite)).toBe(0)
  })

  it('refuses an audit id that is unknown, belongs to another product, or is a revert', async () => {
    const sqlite = freshDb()
    insertProduct(sqlite)
    insertProduct(sqlite, {
      id: 'prod-2',
      productKey: 'gula--gulaku--1-kg',
      name: 'Gula Pasir Gulaku 1 kg',
    })
    insertAuditRow(sqlite, {
      id: 'audit-other',
      productId: 'prod-2',
      productKey: 'gula--gulaku--1-kg',
      oldName: 'Gula',
      newName: 'Gula Pasir Gulaku 1 kg',
      before: 1,
      after: 2,
      createdAt: '2026-11-07T00:00:00.000Z',
    })
    insertAuditRow(sqlite, {
      id: 'audit-revert',
      action: 'revert',
      oldName: 'Beras Ramos Premium',
      newName: 'Beras Ramos 5 kg',
      before: 2,
      after: 3,
      createdAt: '2026-11-07T00:00:01.000Z',
    })

    const db = sqliteD1(sqlite)
    for (const auditId of ['missing', 'audit-other', 'audit-revert']) {
      await expect(
        revertProductRename(db, {
          productKey: 'beras--ramos--5-kg',
          auditId,
          actorUserId: 'admin-1',
        })
      ).rejects.toBeInstanceOf(AuditNotFoundError)
    }
  })
})
