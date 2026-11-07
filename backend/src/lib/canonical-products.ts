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
// - Alias approval/rejection (#489) is a decision about the ALIAS, not a
//   canonical-product metadata edit: the CAS is the alias's own
//   `status = 'candidate'` -> `'approved' | 'rejected'`, and
//   `price_products.metadata_version` deliberately does NOT move. Reusing the
//   product version would make an alias decision race a rename for no reason,
//   and would suggest the canonical row changed when only an internal matching
//   key did.
// - Approve bumps the canonical index version (gated on the decision receipt)
//   because the index ships approved aliases only, so the pipeline must see the
//   new spelling on its next fetch. Reject bumps NOTHING: it removes nothing
//   from the index (a candidate was never in it) and must not invalidate the
//   pipeline's cache. Both use the same exported `indexBumpStatement` helper as
//   rename/revert instead of copying the SQL.
// - A decision is terminal per alias: rejected aliases are excluded from the
//   rename path (which approves only `candidate` rows) and from the index
//   (`approved` only), and ingest's upsert refreshes `last_seen_at` without
//   resetting status, so a rejected spelling cannot silently return as a
//   candidate.
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
//
// The alias decision (#489) uses the same one-batch discipline, with the alias
// row as the CAS:
//   1. guarded `UPDATE price_product_aliases SET status = ? WHERE id = ? AND
//      product_id = (SELECT id FROM price_products WHERE product_key = ?) AND
//      status = 'candidate'` — zero rows covers a decided alias (409
//      alias_state) and a wrong/unknown product (404)
//   2. audit row INSERT ... SELECT gated on `changes() = 1` AND the new status.
//      The status alone is NOT a safe gate: a second concurrent decision would
//      match the status the first writer just produced and append a second
//      receipt for a write it did not make. `changes()` proves statement 1
//      matched exactly one row in this batch.
//   3. approve only: exactly one index bump, gated on the receipt existing.
// Reject ships no bump statement at all, so a rejected alias never invalidates
// the pipeline's cached index.

import { BATCH_CHUNK, selectIn } from './d1.js'

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

// Duplicate-name report bounds (#485). The catalog is a few hundred products,
// so these ceilings never bite in practice — they exist so a report can never
// turn into an unbounded read. The group list is capped, each group lists at
// most 25 products, and the whole report carries at most 900 product rows, so
// the stores lookup costs at most 10 chunked queries (SELECT_IN_CHUNK) and the
// invocation stays well inside D1's ~50-query budget.
const DUPLICATE_GROUPS_DEFAULT = 200
const DUPLICATE_GROUPS_MAX = 500
const DUPLICATE_PRODUCTS_PER_GROUP = 25
const DUPLICATE_PRODUCTS_CEILING = 900

// Bulk exact-name alias approval (#515). Each alias costs two statements — the
// `candidate -> approved` CAS and the receipt gated on it (the per-alias
// decision pair, minus its per-decision bump) — so a 50-statement batch
// (BATCH_CHUNK, lib/d1.ts) carries 25 aliases. A batch is atomic, so a chunk
// either approves all of its aliases or none of them.
const BULK_APPROVE_ALIASES_PER_BATCH = Math.floor(BATCH_CHUNK / 2)

// Unicode control characters (the Cc category: C0, DEL, C1). Newlines and tabs
// are rejected on purpose: the canonical index schema's rawText(500) rejects
// neither, but a newline in a canonical name breaks the display and the
// Jaccard tokenizer, so the rename path rejects it instead of flattening it.
const CONTROL_CHARS = /\p{Cc}/u

type ProductStatus = 'canonical' | 'provisional' | 'needs_review'
// 'rejected' is the #489 addition: a terminal admin decision that keeps the
// spelling out of the index (0039 widens the 0030 CHECK to allow it).
type AliasStatus = 'candidate' | 'approved' | 'rejected'
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
  id: string
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

/**
 * One product in the duplicate-name report (#485). `stores` is every store
 * that recorded a name variant for it (alias rows, any status — a rejected
 * spelling is still evidence the store sells the product); `primaryStore` is
 * the most recently observed one, null when the product has no alias yet.
 */
type DuplicateProductDto = {
  productKey: string
  name: string
  status: ProductStatus
  updatedAt: string | null
  stores: string[]
  primaryStore: string | null
}

/** Canonical products that share one name case-insensitively. */
type DuplicateNameGroup = {
  normalizedName: string
  displayName: string
  productCount: number
  products: DuplicateProductDto[]
}

type DuplicateNameReport = {
  limit: number
  truncated: boolean
  groups: DuplicateNameGroup[]
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

type AliasDecisionInput = {
  productKey: string
  aliasId: string
  actorUserId: string
}

/** The decided alias plus the index version the decision left behind. */
type AliasDecisionResult = {
  alias: ProductAliasDto
  indexVersion: number
}

type AliasDecision = 'approve' | 'reject'

/** Counts the alias-candidates panel renders before the bulk action (#515). */
type AliasCandidateCounts = {
  candidates: number
  exactCandidates: number
}

/** A candidate alias that restates its own product's canonical name. */
type ExactAliasCandidate = {
  id: string
  productKey: string
}

/**
 * The bulk approval's receipt (#515). `exactCandidates` is the set the run
 * targeted (0 on an idempotent second run), `approved` the rows this run
 * actually flipped, `remainingCandidates` the catalog-wide candidate count
 * afterwards, and `indexVersion` the version the run's single bump left behind.
 */
type BulkAliasApproveResult = {
  exactCandidates: number
  approved: number
  remainingCandidates: number
  indexVersion: number
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

/**
 * The alias does not exist, or it belongs to a different product than the
 * `productKey` in the URL. Both are a 404 to the admin: the route must not
 * confirm that an alias id exists under another product.
 */
export class AliasNotFoundError extends Error {
  constructor(readonly aliasId: string) {
    super(`Alias '${aliasId}' not found for this product`)
    this.name = 'AliasNotFoundError'
  }
}

/**
 * The alias was already decided (approved or rejected). The decision is a CAS
 * on the alias's own status, so a second request is 409 rather than a silent
 * no-op — the admin needs to know the row moved underneath them.
 */
export class AliasStateError extends Error {
  constructor(readonly currentStatus: AliasStatus) {
    super(`Alias is already '${currentStatus}'`)
    this.name = 'AliasStateError'
  }
}

/**
 * A bulk exact-name approval stopped mid-run (#515). Each chunk is
 * all-or-nothing, but the run is not one transaction: earlier chunks stay
 * committed, so the error carries how many aliases this run approved and the
 * index state those approvals left behind. The route answers 500 with that
 * count instead of pretending nothing happened (and a rerun continues, because
 * the action is idempotent).
 */
export class BulkAliasApproveError extends Error {
  constructor(
    readonly approved: number,
    readonly indexVersion: number | null,
    readonly remainingCandidates: number | null,
    readonly failure: unknown
  ) {
    super('Bulk alias approval failed')
    this.name = 'BulkAliasApproveError'
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
  id: string
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

const ALIAS_COLUMNS = `id, name, store_slug, status, source, first_seen_at, last_seen_at`

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
    id: row.id,
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
 * The alias decision's pre-check: the alias must exist AND belong to the
 * product named by the URL. Joined through `product_key` so an alias id from
 * another product is indistinguishable from an unknown id (both 404), which is
 * the point — the route must not confirm a cross-product alias exists.
 */
async function readAliasForProduct(
  db: D1Database,
  productKey: string,
  aliasId: string
): Promise<AliasRow | null> {
  return (
    (await db
      .prepare(
        `SELECT a.id, a.name, a.store_slug, a.status, a.source, a.first_seen_at, a.last_seen_at
         FROM price_product_aliases a
         JOIN price_products p ON p.id = a.product_id
         WHERE a.id = ? AND p.product_key = ?`
      )
      .bind(aliasId, productKey)
      .first<AliasRow>()) ?? null
  )
}

/** The committed alias a decision reads back (one of this batch's own rows). */
async function readAliasById(db: D1Database, aliasId: string): Promise<AliasRow | null> {
  return (
    (await db
      .prepare(`SELECT ${ALIAS_COLUMNS} FROM price_product_aliases WHERE id = ?`)
      .bind(aliasId)
      .first<AliasRow>()) ?? null
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
 * the receipt the same batch inserted: if the guarded UPDATE matched nothing,
 * neither receipt exists and the version does not move, so a stale request
 * writes nothing at all.
 *
 * `auditTable` is a closed union, never caller text — rename/revert gate on
 * `price_product_audit`, an alias approval on `price_product_alias_audit`
 * (#489). The alias endpoint imports this helper instead of inlining the SQL:
 * an approved alias that lands without the pipeline seeing the bumped version
 * is invisible until some later canonical write happens to bump it.
 */
export function indexBumpStatement(
  db: D1Database,
  auditId: string,
  auditTable: 'price_product_audit' | 'price_product_alias_audit'
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE canonical_index_state
       SET version = version + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM ${auditTable} WHERE id = ?)`
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
 * Admin product detail: canonical row, every alias with its id (candidate,
 * approved, and rejected — the id is what the approve/reject routes take),
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
        `SELECT ${ALIAS_COLUMNS}
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
 * Read-only duplicate-name report (#485): canonical products that share a name
 * case-insensitively, grouped by the name, newest-first inside each group.
 *
 * Why this exists: a rename and a concurrent ingest can race the rename guard's
 * pre-check, and a rename during the pipeline's ≤48 h cached-index window can
 * found a duplicate provisional product. Neither is enforced — there is
 * deliberately no UNIQUE index on `price_products.name` while legacy duplicate
 * names exist, and merges are a non-goal — so this surfaces the collision for
 * an admin instead.
 *
 * READ-ONLY by contract: no INSERT/UPDATE/DELETE, and in particular no
 * `canonical_index_state` bump. Reading the catalog must never invalidate the
 * pipeline's cache; a report that bumped the version would be a write.
 *
 * Bounds (one invocation must stay inside D1's ~50-query budget): `limit`
 * groups (default 200, max 500), at most 25 products per group, and at most
 * `DUPLICATE_PRODUCTS_CEILING` product rows in the whole report — the stores
 * lookup then costs ≤10 chunked queries. `truncated` is true when any of those
 * bounds bit, so the UI never presents a partial report as complete.
 */
export async function getDuplicateNameReport(
  db: D1Database,
  options: { limit?: number } = {}
): Promise<DuplicateNameReport> {
  const requested = options.limit ?? DUPLICATE_GROUPS_DEFAULT
  const limit = Math.min(Math.max(Math.trunc(requested), 1), DUPLICATE_GROUPS_MAX)

  // One extra row distinguishes "truncated at the limit" from "exactly the
  // limit". GROUP BY name COLLATE NOCASE is the same equality the rename guard
  // uses (`name = ? COLLATE NOCASE`) and rides idx_products_name_nocase.
  //
  // lower(name) IS the group key: SQLite's lower() folds exactly the ASCII
  // letters NOCASE folds, so it is constant within a NOCASE group and distinct
  // across groups. Deriving the key in SQL keeps JS out of the equality —
  // lowercasing a spelling in JS would fold Unicode too and could merge two
  // groups NOCASE keeps apart.
  const groupRows =
    (
      await db
        .prepare(
          `SELECT lower(name) AS normalizedName, COUNT(*) AS productCount
           FROM price_products
           GROUP BY name COLLATE NOCASE
           HAVING COUNT(*) > 1
           ORDER BY COUNT(*) DESC, name COLLATE NOCASE ASC
           LIMIT ?`
        )
        .bind(limit + 1)
        .all<{ normalizedName: string; productCount: number }>()
    ).results ?? []
  if (groupRows.length === 0) return { limit, truncated: false, groups: [] }

  // Products per group (capped at DUPLICATE_PRODUCTS_PER_GROUP via ROW_NUMBER)
  // in one statement: the group list is a subquery, so no bind-count ceiling
  // applies. `LIMIT ceiling + 1` bounds the whole report and flags truncation.
  //
  // The inner subquery repeats the group query's ORDER BY with the same
  // collation on purpose: the limit must cut the identical group set, or a
  // listed group would arrive with no rows while a cut group's rows were
  // silently dropped.
  const productRows =
    (
      await db
        .prepare(
          `SELECT product_key, name, status, updated_at, groupKey
           FROM (
             SELECT p.product_key, p.name, p.status, p.updated_at,
                    lower(p.name) AS groupKey,
                    ROW_NUMBER() OVER (
                      PARTITION BY p.name COLLATE NOCASE
                      ORDER BY p.updated_at DESC, p.product_key ASC
                    ) AS rn
             FROM price_products p
             JOIN (
               SELECT name AS dupName
               FROM price_products
               GROUP BY name COLLATE NOCASE
               HAVING COUNT(*) > 1
               ORDER BY COUNT(*) DESC, dupName COLLATE NOCASE ASC
               LIMIT ?
             ) d ON d.dupName = p.name COLLATE NOCASE
           )
           WHERE rn <= ?
           ORDER BY name COLLATE NOCASE, rn
           LIMIT ?`
        )
        .bind(limit, DUPLICATE_PRODUCTS_PER_GROUP, DUPLICATE_PRODUCTS_CEILING + 1)
        .all<{
          product_key: string
          name: string
          status: ProductStatus
          updated_at: string | null
          groupKey: string
        }>()
    ).results ?? []

  const products = productRows.slice(0, DUPLICATE_PRODUCTS_CEILING)
  const storesByKey = new Map<string, Array<{ storeSlug: string; lastSeenAt: string }>>()
  if (products.length > 0) {
    const storeRows = await selectIn<{
      productKey: string
      storeSlug: string
      lastSeenAt: string
    }>(
      db,
      // GROUP BY rides inside the subquery because selectIn appends the IN
      // list at the end of the statement. One row per (product, store), with
      // the newest sighting of ANY spelling — a rejected alias still proves
      // the store carries the product.
      `SELECT productKey, storeSlug, lastSeenAt FROM (
         SELECT p.product_key AS productKey, a.store_slug AS storeSlug,
                MAX(a.last_seen_at) AS lastSeenAt
         FROM price_product_aliases a
         JOIN price_products p ON p.id = a.product_id
         GROUP BY p.product_key, a.store_slug
       )
       WHERE productKey IN`,
      products.map((row) => row.product_key)
    )
    for (const row of storeRows) {
      const list = storesByKey.get(row.productKey) ?? []
      list.push({ storeSlug: row.storeSlug, lastSeenAt: row.lastSeenAt ?? '' })
      storesByKey.set(row.productKey, list)
    }
  }

  // Assemble in the group query's order, each row carrying its SQL group key —
  // no name is ever re-normalized in JS. Rows arrive newest-first inside a
  // group (the ROW_NUMBER order), which is the report's contract.
  const productsByKey = new Map<string, DuplicateProductDto[]>()
  for (const row of products) {
    const stores = (storesByKey.get(row.product_key) ?? []).sort(
      (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.storeSlug.localeCompare(b.storeSlug)
    )
    const list = productsByKey.get(row.groupKey) ?? []
    list.push({
      productKey: row.product_key,
      name: row.name,
      status: row.status,
      updatedAt: row.updated_at ?? null,
      stores: stores.map((store) => store.storeSlug),
      primaryStore: stores[0]?.storeSlug ?? null,
    })
    productsByKey.set(row.groupKey, list)
  }

  const groups: DuplicateNameGroup[] = []
  for (const row of groupRows.slice(0, limit)) {
    const productsInGroup = productsByKey.get(row.normalizedName)
    // The row ceiling can cut a group entirely, and a concurrent delete can
    // remove one between the two reads: a group with no rows is not listed, so
    // the report never shows a header with nothing under it.
    if (!productsInGroup) continue
    groups.push({
      normalizedName: row.normalizedName,
      // The newest product's wording names the group.
      displayName: productsInGroup[0].name,
      productCount: Number(row.productCount),
      products: productsInGroup,
    })
  }

  const truncated =
    groupRows.length > limit ||
    productRows.length > DUPLICATE_PRODUCTS_CEILING ||
    groups.some((group) => group.productCount > group.products.length)

  return { limit, truncated, groups }
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
    indexBumpStatement(db, auditId, 'price_product_audit'),
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
      indexBumpStatement(db, revertAuditId, 'price_product_audit'),
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

/**
 * Read back a committed alias decision (alias + index version) in ONE batch so
 * the two reads see the same snapshot — the response must not pair a decided
 * alias with a version a concurrent write produced afterwards.
 */
async function readAliasDecisionResult(
  db: D1Database,
  aliasId: string
): Promise<AliasDecisionResult> {
  const [aliasResult, stateResult] = (await db.batch([
    db.prepare(`SELECT ${ALIAS_COLUMNS} FROM price_product_aliases WHERE id = ?`).bind(aliasId),
    db.prepare('SELECT version FROM canonical_index_state WHERE id = 1'),
  ])) as unknown as BatchResult[]

  const alias = aliasResult?.results?.[0] as AliasRow | undefined
  if (!alias) throw new AliasNotFoundError(aliasId)
  const state = stateResult?.results?.[0] as { version?: number } | undefined
  return { alias: toAlias(alias), indexVersion: Number(state?.version ?? 0) }
}

/**
 * Shared body of approve/reject (#489): one CAS on the alias's OWN status, one
 * gated receipt, and — for approve only — one index bump.
 *
 * Deliberately no `price_products.metadata_version` read or write: an alias
 * decision changes no canonical field, so it must not contend with renames for
 * the product version (the #489 design decision). The status CAS is the whole
 * concurrency guard: two admins deciding the same candidate means one 200 and
 * one 409 alias_state, never a second receipt or a second bump.
 *
 * A pre-check answers fast and keeps the happy path cheap, but the batch's
 * guarded UPDATE is the authority — a decision that lands between the two is
 * answered from the re-read row (404 when the alias is gone, 409 when it is
 * already decided), exactly like rename's stale-version handling.
 */
async function decideAlias(
  db: D1Database,
  input: AliasDecisionInput,
  action: AliasDecision
): Promise<AliasDecisionResult> {
  const product = await readProductByKey(db, input.productKey)
  if (!product) throw new ProductNotFoundError(input.productKey)

  const existing = await readAliasForProduct(db, input.productKey, input.aliasId)
  if (!existing) throw new AliasNotFoundError(input.aliasId)
  if (existing.status !== 'candidate') throw new AliasStateError(existing.status)

  const status: AliasStatus = action === 'approve' ? 'approved' : 'rejected'
  const auditId = crypto.randomUUID()
  const now = new Date().toISOString()

  const statements = [
    // 1. The CAS: candidate-only and product-scoped. Zero rows means the alias
    // was decided (or removed) between the pre-check and this batch.
    db
      .prepare(
        `UPDATE price_product_aliases
         SET status = ?
         WHERE id = ?
           AND product_id = (SELECT id FROM price_products WHERE product_key = ?)
           AND status = 'candidate'`
      )
      .bind(status, input.aliasId, input.productKey),
    // 2. The receipt, gated on THIS update. `changes()` is the second half of
    // the gate because the status alone cannot tell this batch's write apart
    // from a concurrent writer's: a second approve would find status
    // 'approved' (just set by the winner) and append a receipt for a write it
    // never made. changes() proves statement 1 matched exactly one row.
    db
      .prepare(
        `INSERT INTO price_product_alias_audit
           (id, alias_id, product_id, product_key, store_slug, alias_name, action,
            actor_user_id, created_at)
         SELECT ?, a.id, a.product_id, p.product_key, a.store_slug, a.name, ?, ?, ?
         FROM price_product_aliases a
         JOIN price_products p ON p.id = a.product_id
         WHERE a.id = ? AND a.status = ? AND changes() = 1`
      )
      .bind(auditId, action, input.actorUserId, now, input.aliasId, status),
  ]
  // 3. Approve only: exactly one canonical-index bump per committed receipt.
  // Reject ships no bump at all — a candidate was never in the index, so
  // invalidating the pipeline's cache would be a lie.
  if (action === 'approve') {
    statements.push(indexBumpStatement(db, auditId, 'price_product_alias_audit'))
  }

  const results = (await db.batch(statements)) as unknown as BatchResult[]

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const current = await readAliasById(db, input.aliasId)
    if (!current) throw new AliasNotFoundError(input.aliasId)
    throw new AliasStateError(current.status)
  }

  return readAliasDecisionResult(db, input.aliasId)
}

/** Approve a candidate alias: admit it to the canonical index (version + 1). */
export async function approveAlias(
  db: D1Database,
  input: AliasDecisionInput
): Promise<AliasDecisionResult> {
  return decideAlias(db, input, 'approve')
}

/** Reject a candidate alias: keep it out of the index, bump nothing. */
export async function rejectAlias(
  db: D1Database,
  input: AliasDecisionInput
): Promise<AliasDecisionResult> {
  return decideAlias(db, input, 'reject')
}

// ---------------------------------------------------------------------------
// Bulk exact-name alias approval (#515, follow-up to #489). The per-alias
// decision is right for ambiguous spellings, but the catalog carries ~1,973
// candidates and the majority are just the canonical wording in another case.
// Owner decision (2026-11-07): ONE safe action approves exactly those, and
// nothing else — a whitespace variant, a size variant, or a different wording
// stays a manual decision. Equality is SQLite's NOCASE, the same collation the
// rename guard and the duplicate report use; it folds ASCII case only, so a
// non-ASCII difference is a difference and stays manual.
//
// The write path reuses the per-alias decision's shape (CAS + gated receipt),
// chunked because a run can touch far more rows than one batch may hold:
//   chunk: [CAS, receipt] * 25 aliases, one db.batch = one transaction
//   end:   one index bump gated on a receipt THIS run inserted
// The bump is deliberately NOT one per alias: it is a catalog-wide version and
// N increments would wake the pipeline N times for one logical change. It is
// also gated on a receipt rather than the requested count, so a run that lost
// every CAS to a concurrent admin bumps nothing.
// ---------------------------------------------------------------------------

/**
 * The alias-candidates panel's counts (#515): every candidate alias in the
 * catalog, and how many of them restate their own product's canonical name
 * case-insensitively — exactly the set the bulk action would approve. Read-only,
 * and no canonical-index bump: opening the panel must never wake the pipeline.
 */
export async function countAliasCandidates(db: D1Database): Promise<AliasCandidateCounts> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS candidates,
              COALESCE(SUM(CASE WHEN a.name = p.name COLLATE NOCASE THEN 1 ELSE 0 END), 0)
                AS exactCandidates
       FROM price_product_aliases a
       JOIN price_products p ON p.id = a.product_id
       WHERE a.status = 'candidate'`
    )
    .first<{ candidates?: number; exactCandidates?: number }>()
  // COUNT always returns a row; SUM needs COALESCE for the empty catalog.
  return {
    candidates: Number(row?.candidates ?? 0),
    exactCandidates: Number(row?.exactCandidates ?? 0),
  }
}

/** Reads back the version + candidate count a bulk run leaves behind. */
async function finalizeBulkApprove(
  db: D1Database,
  lastReceiptId: string | null
): Promise<{ indexVersion: number; remainingCandidates: number }> {
  const statements: D1PreparedStatement[] = []
  // Exactly one bump, gated on a receipt this run inserted. `lastReceiptId` is
  // the newest committed approval's receipt: the bump and the counts then ride
  // the same batch, so the response pairs them consistently. No receipt means
  // the run approved nothing (an idempotent second run) and the version stays.
  if (lastReceiptId) {
    statements.push(indexBumpStatement(db, lastReceiptId, 'price_product_alias_audit'))
  }
  statements.push(
    db.prepare('SELECT version FROM canonical_index_state WHERE id = 1'),
    db.prepare(
      `SELECT COUNT(*) AS candidates FROM price_product_aliases WHERE status = 'candidate'`
    )
  )
  const results = (await db.batch(statements)) as unknown as BatchResult[]
  const offset = lastReceiptId ? 1 : 0
  const state = results[offset]?.results?.[0] as { version?: number } | undefined
  const remaining = results[offset + 1]?.results?.[0] as { candidates?: number } | undefined
  return {
    indexVersion: Number(state?.version ?? 0),
    remainingCandidates: Number(remaining?.candidates ?? 0),
  }
}

/**
 * Approve every candidate alias whose name equals its product's canonical name
 * case-insensitively (#515). Never touches `price_products.metadata_version`
 * (an alias decision is not a canonical metadata edit — the #489 rule) and
 * never approves a whitespace/variant spelling.
 *
 * Idempotent: a second run finds no exact candidates, writes no receipt, and
 * does not bump the index version. A product with no aliases is simply never
 * in the candidate read.
 *
 * Failure: chunks are atomic, the run is not. If a chunk (or the tail batch)
 * fails, the approvals already committed are real, so the failing path bumps
 * the index for them and throws BulkAliasApproveError carrying the count
 * reached — the route turns that into an honest 500, and a rerun continues
 * where this one stopped. A run larger than the D1 query budget therefore
 * still makes progress instead of losing everything.
 */
export async function bulkApproveExactNameAliases(
  db: D1Database,
  actorUserId: string
): Promise<BulkAliasApproveResult> {
  const candidates =
    (
      await db
        .prepare(
          // `a.name = p.name COLLATE NOCASE` is the owner's exact-match rule:
          // case-insensitive, but a whitespace or wording variant is a
          // different name and stays a manual decision. Ordered so a chunked
          // run is deterministic.
          `SELECT a.id AS id, p.product_key AS productKey
           FROM price_product_aliases a
           JOIN price_products p ON p.id = a.product_id
           WHERE a.status = 'candidate' AND a.name = p.name COLLATE NOCASE
           ORDER BY p.product_key, a.id`
        )
        .all<ExactAliasCandidate>()
    ).results ?? []

  const now = new Date().toISOString()
  let approved = 0
  let lastReceiptId: string | null = null

  try {
    for (let i = 0; i < candidates.length; i += BULK_APPROVE_ALIASES_PER_BATCH) {
      const chunk = candidates.slice(i, i + BULK_APPROVE_ALIASES_PER_BATCH)
      const statements: D1PreparedStatement[] = []
      const receiptIds: string[] = []

      for (const candidate of chunk) {
        const receiptId = crypto.randomUUID()
        receiptIds.push(receiptId)
        // 1. The CAS: candidate-only and product-scoped, with the exact-name
        // rule re-checked at write time — a rename that landed after the read
        // must not let a now-variant spelling through.
        statements.push(
          db
            .prepare(
              `UPDATE price_product_aliases
               SET status = 'approved'
               WHERE id = ?
                 AND product_id = (SELECT id FROM price_products WHERE product_key = ?)
                 AND status = 'candidate'
                 AND name = (
                   SELECT p.name FROM price_products p
                   WHERE p.id = price_product_aliases.product_id
                 ) COLLATE NOCASE`
            )
            .bind(candidate.id, candidate.productKey)
        )
        // 2. The receipt, gated on THIS update (`changes() = 1`), exactly like
        // the per-alias decision: the status alone cannot tell this batch's
        // write apart from a concurrent admin's, and a receipt for a write we
        // did not make would be a lie.
        statements.push(
          db
            .prepare(
              `INSERT INTO price_product_alias_audit
                 (id, alias_id, product_id, product_key, store_slug, alias_name, action,
                  actor_user_id, created_at)
               SELECT ?, a.id, a.product_id, p.product_key, a.store_slug, a.name,
                      'approve', ?, ?
               FROM price_product_aliases a
               JOIN price_products p ON p.id = a.product_id
               WHERE a.id = ? AND a.status = 'approved' AND changes() = 1
                 AND a.name = p.name COLLATE NOCASE`
            )
            .bind(receiptId, actorUserId, now, candidate.id)
        )
      }

      const results = (await db.batch(statements)) as unknown as BatchResult[]
      for (let j = 0; j < chunk.length; j += 1) {
        const updated = results[j * 2]?.meta?.changes ?? 0
        const receipted = results[j * 2 + 1]?.meta?.changes ?? 0
        if (updated === 0) continue
        // The pair runs in one transaction, so a CAS without its receipt is a
        // broken batch, not a race: refuse to report an approval the catalog
        // cannot explain (the failure path below keeps the count honest).
        if (updated !== 1 || receipted !== 1) {
          throw new Error(
            `Bulk approval committed alias '${chunk[j].id}' without exactly one audit receipt`
          )
        }
        approved += 1
        lastReceiptId = receiptIds[j]
      }
    }

    const tail = await finalizeBulkApprove(db, lastReceiptId)
    return {
      exactCandidates: candidates.length,
      approved,
      remainingCandidates: tail.remainingCandidates,
      indexVersion: tail.indexVersion,
    }
  } catch (failure) {
    // Committed approvals are real: bump for them before failing, so the
    // pipeline sees what landed. If even that read fails, report the count
    // reached with nulls rather than masking the original failure.
    let indexVersion: number | null = null
    let remainingCandidates: number | null = null
    try {
      const tail = await finalizeBulkApprove(db, lastReceiptId)
      indexVersion = tail.indexVersion
      remainingCandidates = tail.remainingCandidates
    } catch {
      // Reported as nulls below.
    }
    throw new BulkAliasApproveError(approved, indexVersion, remainingCandidates, failure)
  }
}
