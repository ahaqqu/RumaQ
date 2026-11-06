// Canonical product identity, admin rename, and rename revert (ahaqqu/RumaQ#423,
// PR B). The v2 pipeline contract makes the backend the owner of the canonical
// name (`price_products.name`); the pipeline sends raw observations and consumes
// the canonical index built from approved aliases. A rename is therefore a
// label fix on the canonical row — it never touches `product_key`/UUID and never
// needs a pipeline PR. The pipeline picks the new name up on its next run from
// the bumped `canonical_index_state`.
//
// Settled decisions (issue #423 owner sign-off — do not re-litigate):
// - Rename keeps `status = provisional`. Promoting an identity to `canonical`
//   is a separate action, not a side effect of a label fix.
// - Revert undoes the LATEST rename only (linear history). It appends a
//   compensating `revert` audit row with old/new swapped; audit rows are never
//   mutated or deleted.
// - An exact duplicate canonical name (case-insensitive) is a hard
//   `duplicate_name` — including a collision with another product's APPROVED
//   alias. There is deliberately no acknowledge path: merges are a non-goal, so
//   a rename must not paper over a wrong identity.
// - Similar names (Jaccard >= 0.8 over a bounded candidate set) are a
//   `similar_name` warning the admin may override with `acknowledgeWarnings`.
// - Alias approval is OUT OF SCOPE here. The rename path approves candidate
//   aliases that match the OLD canonical wording (a raw spelling already seen
//   in the catalog), but it never synthesises an alias and no admin endpoint
//   ships. When that endpoint lands, it MUST bump the canonical index version
//   with the same gated `indexBumpStatement` helper used below — a rename or
//   alias change that does not move the version is invisible to the pipeline.
//   The helper is intentionally unexported until a second caller exists; export
//   it then, do not copy the SQL.
//
// Every mutation is ONE `db.batch` call (never chunked: a multi-chunk batch is
// not atomic) and every statement after the guarded product UPDATE is gated on
// the state that UPDATE produced:
//   1. guarded `UPDATE price_products ... WHERE id = ? AND metadata_version = ?`
//   2. approve candidate aliases matching the old wording — gated on the
//      post-update metadata version so a stale request writes nothing
//   3. audit row INSERT ... SELECT gated on the post-update
//      version + name + updated_at (only this write can produce that triple)
//   4. index version bump gated on the audit row's existence, so exactly one
//      bump rides each committed audit row and a stale request bumps nothing.
// A zero-row guarded UPDATE is `StaleProductError` (409 stale_product); the
// duplicate/similar checks run before the batch, and the batch re-checks the
// version so a race cannot double-write.

const PRODUCT_NAME_MAX = 500
const REASON_MAX = 200
const AUDIT_PAGE = 10

// Similar-name scan bounds. The catalogue is finite, but a rename must not turn
// into an unbounded read: 1000 canonical names + 1000 approved aliases is a
// generous candidate set (the live catalogue is a few hundred products) and
// keeps the response small. The first 10 matches are enough to warn an admin.
const SIMILAR_CANDIDATE_LIMIT = 1000
const SIMILAR_WARNINGS_LIMIT = 10
const SIMILAR_THRESHOLD = 0.8

// Unicode control characters (the Cc category: C0, DEL, C1). Newlines and tabs
// are rejected on purpose: the canonical index schema's rawText(500) rejects
// neither, but a newline in a canonical name breaks the display and the
// Jaccard tokenizer, so the rename path rejects it instead of flattening it.
const CONTROL_CHARS = /\p{Cc}/u

type ProductStatus = 'canonical' | 'provisional' | 'needs_review'
type AliasStatus = 'candidate' | 'approved'
type AliasSource = 'ocr' | 'catalog' | 'admin'

type CanonicalProductDto = {
  id: string
  productKey: string
  name: string
  brand: string | null
  unit: string | null
  status: ProductStatus
  metadataVersion: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  updatedAt: string | null
}

type ProductAliasDto = {
  name: string
  storeSlug: string
  status: AliasStatus
  source: AliasSource
  firstSeenAt: string
  lastSeenAt: string
}

type ProductStatsDto = {
  observations: number
  stores: number
}

type ProductAuditDto = {
  id: string
  action: 'rename' | 'revert'
  oldName: string
  newName: string
  reason: string | null
  actorUserId: string
  metadataVersionBefore: number
  metadataVersionAfter: number
  revertsAuditId: string | null
  createdAt: string
}

type ProductIdentity = {
  product: CanonicalProductDto
  aliases: ProductAliasDto[]
  stats: ProductStatsDto
  audit: ProductAuditDto[]
}

/** A product or approved alias already carrying the candidate name. */
type RenameConflict = {
  productKey: string
  name: string
  source: 'product' | 'alias'
}

/** A near-duplicate the admin may acknowledge past. */
type SimilarNameWarning = {
  productKey: string
  name: string
  similarity: number
}

type ProductMutationResult = {
  product: CanonicalProductDto
  warnings: SimilarNameWarning[]
  audit: ProductAuditDto[]
  indexVersion: number
}

type RenameProductInput = {
  productKey: string
  canonicalName: string
  expectedMetadataVersion: number
  actorUserId: string
  reason?: string | null
  acknowledgeWarnings?: boolean
}

type RevertProductRenameInput = {
  productKey: string
  auditId: string
  actorUserId: string
  reason?: string | null
}

export class ProductNotFoundError extends Error {
  constructor(readonly productKey: string) {
    super(`Product '${productKey}' not found`)
    this.name = 'ProductNotFoundError'
  }
}

export class DuplicateNameError extends Error {
  constructor(readonly conflicts: RenameConflict[]) {
    super(`Canonical name conflicts with ${conflicts.length} existing name(s)`)
    this.name = 'DuplicateNameError'
  }
}

export class SimilarNameError extends Error {
  constructor(readonly warnings: SimilarNameWarning[]) {
    super(`Canonical name is similar to ${warnings.length} existing name(s)`)
    this.name = 'SimilarNameError'
  }
}

export class StaleProductError extends Error {
  constructor(readonly current: { name: string; metadataVersion: number }) {
    super('Product changed since it was read; refresh and retry')
    this.name = 'StaleProductError'
  }
}

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNameError'
  }
}

export class InvalidReasonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReasonError'
  }
}

export class AuditNotFoundError extends Error {
  constructor(readonly auditId: string) {
    super(`Audit entry '${auditId}' not found for this product`)
    this.name = 'AuditNotFoundError'
  }
}

export class StaleRevertError extends Error {
  constructor() {
    super('Only the latest rename can be reverted')
    this.name = 'StaleRevertError'
  }
}

type ProductRow = {
  id: string
  product_key: string
  name: string
  brand: string | null
  unit: string | null
  status: ProductStatus
  metadata_version: number
  first_seen_at: string | null
  last_seen_at: string | null
  updated_at: string | null
}

type AliasRow = {
  name: string
  store_slug: string
  status: AliasStatus
  source: AliasSource
  first_seen_at: string
  last_seen_at: string
}

type StatsRow = { observations: number; stores: number }

type AuditRow = {
  id: string
  product_id: string
  product_key: string
  actor_user_id: string
  action: 'rename' | 'revert'
  old_name: string
  new_name: string
  reason: string | null
  metadata_version_before: number
  metadata_version_after: number
  reverts_audit_id: string | null
  created_at: string
}

type RevertTargetRow = {
  id: string
  product_id: string
  action: 'rename' | 'revert'
  old_name: string
  new_name: string
  metadata_version_after: number
}

// D1 batches return one result per statement. The Cloudflare type requires a
// full D1Meta, but the tests' adapters (and any D1-shaped stub) only carry the
// fields read here, so the batch surface is narrowed once instead of cast at
// every call site.
type BatchResult = { results?: unknown[]; meta?: { changes?: number } }

const PRODUCT_COLUMNS = `id, product_key, name, brand, unit, status, metadata_version,
  first_seen_at, last_seen_at, updated_at`

const AUDIT_COLUMNS = `id, product_id, product_key, actor_user_id, action, old_name, new_name,
  reason, metadata_version_before, metadata_version_after, reverts_audit_id, created_at`

const AUDIT_ORDER = 'ORDER BY created_at DESC, metadata_version_after DESC'

function toProduct(row: ProductRow): CanonicalProductDto {
  return {
    id: row.id,
    productKey: row.product_key,
    name: row.name,
    brand: row.brand,
    unit: row.unit,
    status: row.status,
    metadataVersion: row.metadata_version,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  }
}

function toAlias(row: AliasRow): ProductAliasDto {
  return {
    name: row.name,
    storeSlug: row.store_slug,
    status: row.status,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }
}

function toAudit(row: AuditRow): ProductAuditDto {
  return {
    id: row.id,
    action: row.action,
    oldName: row.old_name,
    newName: row.new_name,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    metadataVersionBefore: row.metadata_version_before,
    metadataVersionAfter: row.metadata_version_after,
    revertsAuditId: row.reverts_audit_id,
    createdAt: row.created_at,
  }
}

async function readProductByKey(db: D1Database, productKey: string): Promise<ProductRow | null> {
  return (
    (await db
      .prepare(`SELECT ${PRODUCT_COLUMNS} FROM price_products WHERE product_key = ?`)
      .bind(productKey)
      .first<ProductRow>()) ?? null
  )
}

async function readRevertTarget(db: D1Database, auditId: string): Promise<RevertTargetRow | null> {
  return (
    (await db
      .prepare(
        `SELECT id, product_id, action, old_name, new_name, metadata_version_after
         FROM price_product_audit WHERE id = ?`
      )
      .bind(auditId)
      .first<RevertTargetRow>()) ?? null
  )
}

/**
 * Trim, collapse internal whitespace, and reject anything the canonical index
 * cannot carry: blank names, C0 control characters (newlines included), and
 * names over the contract's rawText(500) ceiling — one oversize canonical name
 * fails the whole index (canonicalIndexSchema), so it must never be stored.
 */
function normalizeCanonicalName(raw: string): string {
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidNameError('Canonical name must not contain control characters.')
  }
  const normalized = raw.trim().replace(/\s+/g, ' ')
  if (!normalized) {
    throw new InvalidNameError('Canonical name must not be blank.')
  }
  if (normalized.length > PRODUCT_NAME_MAX) {
    throw new InvalidNameError(`Canonical name must be at most ${PRODUCT_NAME_MAX} characters.`)
  }
  return normalized
}

/** Optional audit reason: trimmed, bounded, and control-character free. */
function normalizeReason(raw: string | null | undefined): string | null {
  if (raw == null) return null
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidReasonError('Reason must not contain control characters.')
  }
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > REASON_MAX) {
    throw new InvalidReasonError(`Reason must be at most ${REASON_MAX} characters.`)
  }
  return trimmed
}

// Lowercase letter/number tokens; digit/letter runs split apart so "5kg" and
// "5 kg" tokenize alike. Jaccard over these sets catches wording/size variants
// without the false positives of a substring check.
function nameTokens(name: string): Set<string> {
  const tokens = new Set<string>()
  for (const word of name.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const part of word[0].match(/[\p{L}]+|[\p{N}]+/gu) ?? []) tokens.add(part)
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * Exact-name collisions for the rename guard: another product's canonical name
 * OR another product's APPROVED alias, both case-insensitive (the NOCASE
 * indexes from migration 0037 are what make these seeks rather than scans).
 * The product being renamed is excluded — its own aliases are not a conflict.
 */
async function findDuplicateConflicts(
  db: D1Database,
  productId: string,
  canonicalName: string
): Promise<RenameConflict[]> {
  const { results } = await db
    .prepare(
      `SELECT productKey, name, source FROM (
         SELECT p.product_key AS productKey, p.name AS name, 'product' AS source
         FROM price_products p
         WHERE p.name = ? COLLATE NOCASE AND p.id <> ?
         UNION
         SELECT p.product_key AS productKey, a.name AS name, 'alias' AS source
         FROM price_product_aliases a
         JOIN price_products p ON p.id = a.product_id
         WHERE a.name = ? COLLATE NOCASE AND a.status = 'approved' AND a.product_id <> ?
       )
       -- Products before aliases: one name can be an approved alias for many
       -- products, and a 409 that lists only aliases hides the harder
       -- product-name collision. UNION (not UNION ALL) collapses the same other
       -- product's per-store rows before the LIMIT, so they cannot eat the budget.
       ORDER BY source = 'alias', productKey
       LIMIT 20`
    )
    .bind(canonicalName, productId, canonicalName, productId)
    .all<RenameConflict>()

  // A name can be carried by several stores' aliases of the same product;
  // dedupe so the 409 body reads as a list of products, not stores.
  const seen = new Set<string>()
  const conflicts: RenameConflict[] = []
  for (const row of results ?? []) {
    const key = `${row.source}\u0000${row.productKey}\u0000${row.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    conflicts.push({ productKey: row.productKey, name: row.name, source: row.source })
  }
  return conflicts
}

/**
 * Jaccard >= 0.8 over a bounded candidate set (canonical names + approved
 * aliases of other products). Advisory only: the route lets an admin proceed
 * with `acknowledgeWarnings`.
 */
async function findSimilarNames(
  db: D1Database,
  productId: string,
  canonicalName: string
): Promise<SimilarNameWarning[]> {
  const [productRows, aliasRows] = await Promise.all([
    db
      .prepare(
        `SELECT product_key AS productKey, name FROM price_products
         WHERE id <> ? ORDER BY product_key LIMIT ${SIMILAR_CANDIDATE_LIMIT}`
      )
      .bind(productId)
      .all<{ productKey: string; name: string }>(),
    db
      .prepare(
        `SELECT p.product_key AS productKey, a.name
         FROM price_product_aliases a
         JOIN price_products p ON p.id = a.product_id
         WHERE a.status = 'approved' AND a.product_id <> ?
         ORDER BY p.product_key, a.name
         LIMIT ${SIMILAR_CANDIDATE_LIMIT}`
      )
      .bind(productId)
      .all<{ productKey: string; name: string }>(),
  ])

  const candidateTokens = nameTokens(canonicalName)
  const below = canonicalName.toLowerCase()
  const warnings: SimilarNameWarning[] = []
  const seen = new Set<string>()

  for (const row of [...(productRows.results ?? []), ...(aliasRows.results ?? [])]) {
    if (row.name.toLowerCase() === below) continue
    const key = `${row.productKey}\u0000${row.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const similarity = jaccard(candidateTokens, nameTokens(row.name))
    if (similarity < SIMILAR_THRESHOLD) continue
    warnings.push({
      productKey: row.productKey,
      name: row.name,
      similarity: Math.round(similarity * 1000) / 1000,
    })
  }

  warnings.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.name.localeCompare(b.name) ||
      a.productKey.localeCompare(b.productKey)
  )
  return warnings.slice(0, SIMILAR_WARNINGS_LIMIT)
}

/**
 * The one canonical-index version bump every canonical write must use. Gated on
 * the audit row that the same batch inserted: if the guarded product UPDATE
 * matched nothing, the audit row does not exist and the version does not move,
 * so a stale request writes nothing at all.
 *
 * Not exported: #423 ships no alias-approval endpoint, so there is no second
 * caller yet. The future alias-approval endpoint must export and reuse this
 * helper — never re-inline the SQL, or a write can land without the pipeline
 * noticing.
 */
function indexBumpStatement(db: D1Database, auditId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE canonical_index_state
       SET version = version + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM price_product_audit WHERE id = ?)`
    )
    .bind(auditId)
}

/** Reads back the committed mutation (product + audit tail + index version). */
async function readMutationResult(
  db: D1Database,
  productId: string,
  warnings: SimilarNameWarning[]
): Promise<ProductMutationResult> {
  const [productResult, auditResult, stateResult] = (await db.batch([
    db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM price_products WHERE id = ?`).bind(productId),
    db
      .prepare(
        `SELECT ${AUDIT_COLUMNS} FROM price_product_audit
         WHERE product_id = ? ${AUDIT_ORDER} LIMIT ${AUDIT_PAGE}`
      )
      .bind(productId),
    db.prepare('SELECT version FROM canonical_index_state WHERE id = 1'),
  ])) as unknown as BatchResult[]

  const row = productResult?.results?.[0] as ProductRow | undefined
  if (!row) throw new ProductNotFoundError(productId)
  const state = stateResult?.results?.[0] as { version?: number } | undefined
  return {
    product: toProduct(row),
    warnings,
    audit: ((auditResult?.results ?? []) as AuditRow[]).map(toAudit),
    indexVersion: Number(state?.version ?? 0),
  }
}

/**
 * Admin product detail: canonical row, every alias (candidate AND approved),
 * observation stats, and the last 10 audit rows newest first. One batch so the
 * four reads see the same snapshot; null when the productKey is unknown.
 */
export async function getProductIdentity(
  db: D1Database,
  productKey: string
): Promise<ProductIdentity | null> {
  const [productResult, aliasResult, statsResult, auditResult] = (await db.batch([
    db
      .prepare(`SELECT ${PRODUCT_COLUMNS} FROM price_products WHERE product_key = ?`)
      .bind(productKey),
    db
      .prepare(
        `SELECT name, store_slug, status, source, first_seen_at, last_seen_at
         FROM price_product_aliases
         WHERE product_id = (SELECT id FROM price_products WHERE product_key = ?)
         ORDER BY store_slug COLLATE NOCASE, name COLLATE NOCASE`
      )
      .bind(productKey),
    db
      .prepare(
        `SELECT COUNT(*) AS observations, COUNT(DISTINCT source_id) AS stores
         FROM price_observations
         WHERE product_id = (SELECT id FROM price_products WHERE product_key = ?)`
      )
      .bind(productKey),
    db
      .prepare(
        `SELECT ${AUDIT_COLUMNS} FROM price_product_audit
         WHERE product_id = (SELECT id FROM price_products WHERE product_key = ?)
         ${AUDIT_ORDER} LIMIT ${AUDIT_PAGE}`
      )
      .bind(productKey),
  ])) as unknown as BatchResult[]

  const row = productResult?.results?.[0] as ProductRow | undefined
  if (!row) return null

  const stats = (statsResult?.results?.[0] as StatsRow | undefined) ?? {
    observations: 0,
    stores: 0,
  }
  return {
    product: toProduct(row),
    aliases: ((aliasResult?.results ?? []) as AliasRow[]).map(toAlias),
    stats: { observations: Number(stats.observations), stores: Number(stats.stores) },
    audit: ((auditResult?.results ?? []) as AuditRow[]).map(toAudit),
  }
}

/**
 * Rename the canonical name of one product.
 *
 * Validation: blank/oversize/control-character names and reasons are rejected
 * before any write; the new name must differ from the stored one. Duplicate and
 * similar checks run before the batch (a 409 writes nothing); the batch
 * re-checks the optimistic version so a race cannot double-write.
 *
 * On success the old canonical wording is approved as an alias where a
 * candidate already exists for this product (per store); no alias is ever
 * synthesised. `status` is untouched (stays provisional). `metadata_version`
 * and the canonical index version each advance exactly once.
 */
export async function renameProduct(
  db: D1Database,
  input: RenameProductInput
): Promise<ProductMutationResult> {
  const canonicalName = normalizeCanonicalName(input.canonicalName)
  const reason = normalizeReason(input.reason)
  const product = await readProductByKey(db, input.productKey)
  if (!product) throw new ProductNotFoundError(input.productKey)

  if (canonicalName === product.name) {
    throw new InvalidNameError('Canonical name must differ from the current name.')
  }

  if (product.metadata_version !== input.expectedMetadataVersion) {
    throw new StaleProductError({
      name: product.name,
      metadataVersion: product.metadata_version,
    })
  }

  const conflicts = await findDuplicateConflicts(db, product.id, canonicalName)
  if (conflicts.length > 0) throw new DuplicateNameError(conflicts)

  // Computed even when acknowledged: a successful rename returns the warnings
  // it overrode so the caller can surface them in its success message.
  const warnings = await findSimilarNames(db, product.id, canonicalName)
  if (warnings.length > 0 && !input.acknowledgeWarnings) {
    throw new SimilarNameError(warnings)
  }

  const now = new Date().toISOString()
  const auditId = crypto.randomUUID()
  const nextVersion = product.metadata_version + 1

  const results = (await db.batch([
    // 1. Guarded optimistic update. Zero rows = the version moved underneath us.
    db
      .prepare(
        `UPDATE price_products
         SET name = ?, metadata_version = metadata_version + 1, updated_at = ?
         WHERE id = ? AND metadata_version = ?`
      )
      .bind(canonicalName, now, product.id, product.metadata_version),
    // 2. The old wording is a real observed spelling: approve the candidate
    // alias rows that already carry it. Never INSERT — a store-less alias is
    // not data, it is a fabricated receipt.
    db
      .prepare(
        `UPDATE price_product_aliases
         SET status = 'approved'
         WHERE product_id = ? AND status = 'candidate' AND trim(name) = trim(?)
           AND (SELECT metadata_version FROM price_products WHERE id = ?) = ?
           AND (SELECT name FROM price_products WHERE id = ?) = ?
           AND (SELECT updated_at FROM price_products WHERE id = ?) = ?`
      )
      .bind(
        product.id,
        product.name,
        product.id,
        nextVersion,
        product.id,
        canonicalName,
        product.id,
        now
      ),
    // 3. Gated receipt. The version/name/updated_at triple can only be
    // produced by statement 1 in this batch, so a stale request inserts
    // nothing (and therefore cannot bump the index in statement 4).
    db
      .prepare(
        `INSERT INTO price_product_audit
           (id, product_id, product_key, actor_user_id, action, old_name, new_name,
            reason, metadata_version_before, metadata_version_after, reverts_audit_id,
            created_at)
         SELECT ?, ?, ?, ?, 'rename', ?, ?, ?, ?, ?, NULL, ?
         FROM price_products p
         WHERE p.id = ? AND p.metadata_version = ? AND p.name = ? AND p.updated_at = ?`
      )
      .bind(
        auditId,
        product.id,
        product.product_key,
        input.actorUserId,
        product.name,
        canonicalName,
        reason,
        product.metadata_version,
        nextVersion,
        now,
        product.id,
        nextVersion,
        canonicalName,
        now
      ),
    // 4. Exactly one canonical-index bump per committed audit row.
    indexBumpStatement(db, auditId),
  ])) as unknown as BatchResult[]

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const current = await readProductByKey(db, input.productKey)
    if (!current) throw new ProductNotFoundError(input.productKey)
    throw new StaleProductError({
      name: current.name,
      metadataVersion: current.metadata_version,
    })
  }

  return readMutationResult(db, product.id, warnings)
}

/**
 * Undo the LATEST rename of one product by appending a compensating `revert`
 * audit row (old/new swapped, `reverts_audit_id` pointing at the rename).
 * Audit rows are append-only; nothing is updated or deleted.
 *
 * "Latest" is checked structurally: the rename's `metadata_version_after` must
 * equal the product's current `metadata_version` (every audited write bumps the
 * version, so a newer write makes the rename historical). A second request for
 * the same rename therefore hits `StaleRevertError`; the unique partial index
 * `idx_price_product_audit_revert_once` is the storage-level backstop and is
 * also mapped to the same 409.
 */
export async function revertProductRename(
  db: D1Database,
  input: RevertProductRenameInput
): Promise<ProductMutationResult> {
  const reason = normalizeReason(input.reason)
  const product = await readProductByKey(db, input.productKey)
  if (!product) throw new ProductNotFoundError(input.productKey)

  const target = await readRevertTarget(db, input.auditId)
  if (!target || target.product_id !== product.id || target.action !== 'rename') {
    throw new AuditNotFoundError(input.auditId)
  }

  // Linear history: only the write that produced the current version can be
  // compensated. The name check closes the gap where a manual edit bumped the
  // version without an audit row.
  if (
    target.metadata_version_after !== product.metadata_version ||
    target.new_name !== product.name
  ) {
    throw new StaleRevertError()
  }

  const now = new Date().toISOString()
  const revertAuditId = crypto.randomUUID()
  const nextVersion = product.metadata_version + 1

  let results: BatchResult[]
  try {
    results = (await db.batch([
      // 1. Guarded restore of the previous wording.
      db
        .prepare(
          `UPDATE price_products
           SET name = ?, metadata_version = metadata_version + 1, updated_at = ?
           WHERE id = ? AND metadata_version = ?`
        )
        .bind(target.old_name, now, product.id, product.metadata_version),
      // 2. Compensating receipt, gated on the restored row. The unique index on
      // reverts_audit_id rejects a second compensation for the same rename.
      db
        .prepare(
          `INSERT INTO price_product_audit
             (id, product_id, product_key, actor_user_id, action, old_name, new_name,
              reason, metadata_version_before, metadata_version_after, reverts_audit_id,
              created_at)
           SELECT ?, ?, ?, ?, 'revert', ?, ?, ?, ?, ?, ?, ?
           FROM price_products p
           WHERE p.id = ? AND p.metadata_version = ? AND p.name = ? AND p.updated_at = ?`
        )
        .bind(
          revertAuditId,
          product.id,
          product.product_key,
          input.actorUserId,
          target.new_name,
          target.old_name,
          reason,
          product.metadata_version,
          nextVersion,
          target.id,
          now,
          product.id,
          nextVersion,
          target.old_name,
          now
        ),
      // 3. One bump, gated on the revert receipt existing.
      indexBumpStatement(db, revertAuditId),
    ])) as unknown as BatchResult[]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unique/i.test(message) && message.includes('reverts_audit_id')) {
      throw new StaleRevertError()
    }
    throw error
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) throw new StaleRevertError()

  return readMutationResult(db, product.id, [])
}
