import { TAXONOMY_BUCKETS, TAXONOMY_VERSION, type ReviewItemPair } from '@rumaq/contract'
import {
  indexBumpStatement,
  normalizeReason,
  ProductNotFoundError,
  type CategorySource,
} from './canonical-products.js'
import {
  mergeReceiptReadStatement,
  mergeStatements,
  planProductMerge,
  type MergeReceiptCounts,
} from './product-merge.js'

// Storage + queries for the match review queue (issue #294, docs/294-design.md
// §2/§3/§4). One row per flagged candidate pair; display fields ride the
// pair_data JSON blob (contract-owned schema, price_runs.match_stats
// precedent) while identity/ordering/decision fields are columns.
//
// Never-reopen invariant: the upsert's DO UPDATE list refreshes evidence
// columns only and never mentions status/decided_at/decided_by — a human
// verdict stands no matter how often the pair re-flags. first_flagged_at
// also stays, so recurrence stays visible on the record.

export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type ReviewDecision = 'approved' | 'rejected'

// The flag reasons the queue serves — the contract's
// `reviewItemPairSchema.reason` picklist, kept here so the API schema (which
// the browser client is generated from) has ONE source to read. Issue #493:
// the OpenAPI enum had drifted to two values, so a 'taxonomy' flag rendered
// under the verifier label.
export const REVIEW_REASONS = ['price_ratio', 'verifier_unresolved', 'taxonomy'] as const

/** One flag reason — derivable, so the query param and the counts cannot drift. */
export type ReviewReason = (typeof REVIEW_REASONS)[number]

function isReviewReason(value: unknown): value is ReviewReason {
  return typeof value === 'string' && (REVIEW_REASONS as readonly string[]).includes(value)
}

// AI-review vocabulary (issue #484, migration 0038). It lives here — with the
// table whose rows it stores — so the queue read (which joins the verdict) and
// lib/review-ai.ts (which writes it) cannot drift on the value domain.
export type ReviewVerdictName = 'same' | 'different'
export type HumanAgreement = 'agreed' | 'disagreed'
/** Who produced the item's current decision; null = no decision (pending). */
export type ReviewDecisionSource = 'human' | 'ai_assist' | 'ai_auto'

/**
 * The queue decision a cached verdict implies (approve = "yes, same product").
 * It lives with the verdict vocabulary — this module owns the table — so the
 * decide route and lib/review-ai.ts's apply path cannot disagree on it.
 */
export function verdictDecision(verdict: ReviewVerdictName): ReviewDecision {
  return verdict === 'same' ? 'approved' : 'rejected'
}

/**
 * One cached AI verdict as the queue carries it (issue #484): the model's
 * answer plus the provenance that makes a verdict comparable across a
 * settings-driven model change. Null on the item = not evaluated (yet).
 */
export type CachedReviewVerdict = {
  verdict: ReviewVerdictName
  confidence: number
  reason: string | null
  /** The model that produced it; null = the provider default applied. */
  model: string | null
  humanAgreement: HumanAgreement | null
}

// Same budget math as ingest.ts: one db.batch() is one query against D1's
// per-invocation limit; 50 statements of 11 binds each keeps both the query
// budget and the per-statement parameter cap comfortable. The producer caps
// pairs at 200 per report (pipeline REVIEW_ITEM_PAIRS_CAP), so one ingest
// never exceeds 4 batches.
const BATCH_CHUNK = 50

type Statement = ReturnType<D1Database['prepare']>

async function runBatch(db: D1Database, statements: Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

/**
 * Persist a run report's review pairs (called by the runs ingest handler
 * after recordRunReport). Idempotent per (item, entry): a failed pair insert
 * 500s the report, the scraper's report retry re-runs the whole idempotent
 * upsert set — at-least-once, safe.
 */
export async function recordReviewItems(
  db: D1Database,
  runStartedAt: string,
  pairs: ReviewItemPair[]
): Promise<void> {
  if (pairs.length === 0) return
  await runBatch(
    db,
    pairs.map((pair) =>
      db
        .prepare(
          `INSERT INTO match_review_items
             (id, item_product_key, entry_product_key, pair_data, reason, match_method,
              confidence, run_started_at, first_flagged_at, last_flagged_at, flag_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(item_product_key, entry_product_key) DO UPDATE SET
             pair_data = excluded.pair_data,
             reason = excluded.reason,
             match_method = excluded.match_method,
             confidence = excluded.confidence,
             run_started_at = excluded.run_started_at,
             last_flagged_at = excluded.last_flagged_at,
             flag_count = flag_count + 1
           -- Same-run replay no-op: the scraper's report retry (postRunReport
           -- withRetries) re-runs the whole pair set, and an earlier chunk
           -- may already be committed — without this guard those pairs get
           -- flag_count + 1 again. A replay carries identical evidence, so
           -- skipping the update loses nothing; a genuine re-flag from a
           -- later run (different runStartedAt) still bumps.
           WHERE match_review_items.run_started_at <> excluded.run_started_at`
        )
        .bind(
          crypto.randomUUID(),
          pair.itemProductKey,
          pair.entryProductKey,
          JSON.stringify(pair),
          pair.reason,
          pair.matchMethod,
          pair.confidence,
          runStartedAt,
          runStartedAt,
          runStartedAt
        )
    )
  )
}

// The list/export response flattens the pair_data blob with the column
// fields the queue acts on — nothing filters on display fields, so they
// never earned columns.
type ReviewRow = {
  id: string
  pair_data: string
  status: string
  decided_at: string | null
  decided_by: string | null
  // The decision's provenance (0038): 'human' | 'ai_assist' | 'ai_auto',
  // null on a pending row. Tolerated as string from the DB, narrowed below.
  decided_source: string | null
  flag_count: number
  first_flagged_at: string
  last_flagged_at: string
  run_started_at: string
  run_id?: string | null
  // #626: the ITEM side's assigned category + taxonomy version, aliased off
  // the price_products LEFT JOIN (a missing product row → both null). A
  // taxonomy flag without its category was the issue's core complaint — the
  // human was asked to look at nothing actionable.
  item_category: string | null
  item_category_version: string | null
  // #728: the category's provenance ('human' = an admin override; NULL =
  // pipeline-assigned, the pre-0052 rows included). Tolerated as string from
  // the DB, narrowed below.
  item_category_source: string | null
  // The cached AI verdict (0038), aliased off the LEFT JOIN; every field is
  // null together when the item has never been evaluated.
  ai_verdict: string | null
  ai_confidence: number | null
  ai_reason: string | null
  ai_model: string | null
  ai_human_agreement: string | null
}

export type ReviewItem = ReviewItemPair & {
  id: string
  status: ReviewStatus
  decidedAt: string | null
  decidedBy: string | null
  /** Who produced the current decision (issue #484); null while pending. */
  decidedSource: ReviewDecisionSource | null
  /** The cached AI verdict + agreement (issue #484); null = not evaluated. */
  aiVerdict: CachedReviewVerdict | null
  flagCount: number
  firstFlaggedAt: string
  lastFlaggedAt: string
  runStartedAt: string
  /** price_runs.id for the monitor deep-link; null when the run aged out. */
  runId: string | null
  // #626: the item side's assigned category (+ taxonomy version) from
  // price_products — the context a taxonomy row is missing on its own. Both
  // null when the product row is gone.
  itemCategory: string | null
  itemCategoryVersion: string | null
  // #728: who wrote that category — 'human' is the override marker the card
  // renders as a chip (also on a re-flagged row, which is what keeps a
  // pending flag sitting on a corrected category legible); null =
  // pipeline-assigned.
  itemCategorySource: CategorySource | null
  // The RIGHT side's evidence (#380, store-pinned). #691 RC3: frozen-FIRST —
  // on a blob that carries a field, that non-null value IS the flag-time
  // sighting; on a pre-#691 blob every value here is the read-time lookup's
  // (it fills what the blob does not carry). Null when neither source has
  // it — or the live one predates source_url (no backfill).
  entryBrochureUrl: string | null
  entrySourceUrl: string | null
  entryObservedAt: string | null
  // QA-07 (pipeline #160): the entry sighting's struck original price, read
  // from price_observations by the same store-pinned lookup. The pair blob
  // does not freeze it (contract reviewItemPairSchema has no field), so this
  // is ALWAYS the live lookup's value — the store's latest observation, not
  // necessarily the flag-time sighting. Null when the observation predates
  // the 0052 column or the source prints no base price.
  entryOriginalPrice: number | null
}

export type ReviewCounts = {
  pending: number
  approved: number
  rejected: number
  /**
   * Issue #628: the exact pending split by flag reason, from the same
   * whole-queue GROUP BY rule as the status counts — never the active
   * filter or paging. Every reason is present (an absent one is 0), so the
   * client renders the split without existence checks.
   */
  pendingByReason: Record<ReviewReason, number>
}

export type ReviewListPage = {
  items: ReviewItem[]
  counts: ReviewCounts
  filteredTotal: number
}

/**
 * The `pair_data` blob parser — the ONE place a stored pair becomes a
 * `ReviewItemPair`, shared by the list/decide/undo/export reads and by
 * lib/review-ai.ts's prompt builder (thermos B1). A malformed blob must never
 * break a page, and a non-object JSON value (a bare string/number/array) is
 * malformed too: spreading it would fabricate fields.
 */
export function parseReviewPair(json: string): ReviewItemPair | null {
  try {
    const parsed = JSON.parse(json) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as ReviewItemPair)
      : null
  } catch {
    return null
  }
}

function toDecisionSource(value: string | null): ReviewDecisionSource | null {
  return value === 'human' || value === 'ai_assist' || value === 'ai_auto' ? value : null
}

// #728: narrow the category provenance to the 0052 CHECK vocabulary — anything
// else (a row predating the column read through a stale statement) is null.
function toCategorySource(value: string | null): CategorySource | null {
  return value === 'pipeline' || value === 'human' ? value : null
}

function toCachedVerdict(row: ReviewRow): CachedReviewVerdict | null {
  if (row.ai_verdict !== 'same' && row.ai_verdict !== 'different') return null
  return {
    verdict: row.ai_verdict,
    confidence: row.ai_confidence ?? 0,
    reason: row.ai_reason,
    model: row.ai_model,
    humanAgreement:
      row.ai_human_agreement === 'agreed' || row.ai_human_agreement === 'disagreed'
        ? row.ai_human_agreement
        : null,
  }
}

function toReviewItem(row: ReviewRow): ReviewItem | null {
  const pair = parseReviewPair(row.pair_data)
  if (!pair) return null
  return {
    ...pair,
    id: row.id,
    status: (row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : 'pending') as ReviewStatus,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedSource: toDecisionSource(row.decided_source),
    aiVerdict: toCachedVerdict(row),
    flagCount: row.flag_count,
    firstFlaggedAt: row.first_flagged_at,
    lastFlaggedAt: row.last_flagged_at,
    runStartedAt: row.run_started_at,
    runId: row.run_id ?? null,
    itemCategory: row.item_category ?? null,
    itemCategoryVersion: row.item_category_version ?? null,
    itemCategorySource: toCategorySource(row.item_category_source ?? null),
    // #691 RC3: the blob's frozen evidence wins per field (`?? null`
    // normalizes old blobs, which lack the keys); enrichEntryEvidence fills
    // only the fields still null right after the rows land.
    entryBrochureUrl: pair.entryBrochureUrl ?? null,
    entrySourceUrl: pair.entrySourceUrl ?? null,
    entryObservedAt: pair.entryObservedAt ?? null,
    // QA-07: the blob never freezes the original price (the contract pair
    // schema has no field), so it starts null and only the live lookup fills
    // it.
    entryOriginalPrice: null,
  }
}

// ---------------------------------------------------------------------------
// Entry-side evidence (#380, store-pinned per the owner's production report
// 2026-11-15; frozen-first per #691 RC3): the review card's RIGHT side must
// show the ONE sighting the verdict was made from. The pair blob freezes the
// entry's name/price/store at flag time — that snapshot is the price-ratio
// basis AND the AI verdict's input — and since #691 RC3 it also freezes the
// sighting's evidence itself (contract entryBrochureUrl/entrySourceUrl/
// entryObservedAt), so a verdict stays REPRODUCIBLE: re-opening the card
// months later shows what the flagger saw. Reads prefer the blob per field;
// the read-time lookup below fills only the fields an old (pre-#691) blob
// does not carry: price_observations.brochure_url (the R2 object URL for
// brochure stores / the listing page for catalog stores), retailer page
// source_url (null for rows ingested before the column), observed_date — the
// entry's latest observation at the frozen entryStore, ordered like the
// prices read paths' LATEST_OBSERVATION_SUBQUERY (observed date, then scrape
// time). Live-only evidence was exactly what caused #691: the alfamart
// campaign rotation advanced the store's sighting after flag time, so the
// card rendered its FROZEN name/price next to LIVE evidence and contradicted
// itself mid-review (the earlier #380 lookup had also keyed on the product
// key alone, taking the latest observation across ALL sources of a
// multi-store canonical entry — the norm — and swapping another store's page
// onto the frozen label). Deliberately NO cross-store fallback — showing
// another store's page would reintroduce the contradiction — and NO
// confidence floor: evidence for a human verdict must not hide rows the
// explorer hides. A pre-#691 blob whose frozen store has no surviving
// observation (renamed store, pre-0017 rows) simply renders evidence-less,
// which is honest.

const ENTRY_EVIDENCE_CHUNK = 90

type EntryEvidenceRow = {
  evidence_key: string
  brochure_url: string | null
  source_url: string | null
  observed_date: string | null
  original_price: number | null
}

type EntryEvidence = {
  entryBrochureUrl: string | null
  entrySourceUrl: string | null
  entryObservedAt: string | null
  entryOriginalPrice: number | null
}

/** One (entry product, frozen store) lookup pair — the map is keyed on the
 * `productKey|storeSlug` composite both here and in enrichEntryEvidence. */
export type EntryEvidenceLookup = { productKey: string; storeSlug: string }

function evidenceKey(entry: EntryEvidenceLookup): string {
  return `${entry.productKey}|${entry.storeSlug}`
}

/**
 * One chunked lookup per ≤90 (entry, store) pairs (the ingest
 * SELECT_IN_CHUNK budget — D1 caps bound parameters per query at 100). A
 * review page is ≤200 rows, so this is at most 3 queries; an empty list
 * skips the round trip entirely. Exported for the real-SQLite semantics test
 * (the string-matching fake db cannot pin ordering/tie-break behavior).
 */
export async function fetchEntryEvidence(
  db: D1Database,
  entries: EntryEvidenceLookup[]
): Promise<Map<string, EntryEvidence>> {
  const evidence = new Map<string, EntryEvidence>()
  const unique = new Map<string, EntryEvidenceLookup>()
  for (const entry of entries) unique.set(evidenceKey(entry), entry)
  const pairs = [...unique.values()]
  for (let i = 0; i < pairs.length; i += ENTRY_EVIDENCE_CHUNK) {
    const chunk = pairs.slice(i, i + ENTRY_EVIDENCE_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db
      .prepare(
        `SELECT p.product_key || '|' || s.slug AS evidence_key,
                o.brochure_url AS brochure_url,
                o.source_url AS source_url,
                o.observed_date AS observed_date,
                o.original_price AS original_price
         FROM price_observations o
         JOIN price_products p ON p.id = o.product_id
         JOIN price_sources s ON s.id = o.source_id
         WHERE (p.product_key || '|' || s.slug) IN (${placeholders})
           AND o.id = (
             SELECT o2.id FROM price_observations o2
             JOIN price_products p2 ON p2.id = o2.product_id
             JOIN price_sources s2 ON s2.id = o2.source_id
             WHERE p2.product_key = p.product_key
               AND s2.slug = s.slug
             -- Same ordering as the prices read paths'
             -- LATEST_OBSERVATION_SUBQUERY. Within one store the table's
             -- UNIQUE(product_id, source_id, observed_date) already forbids
             -- same-date ties, so observed_date DESC decides; scraped_at/id
             -- stay as harmless parity with the unpinned ordering.
             ORDER BY o2.observed_date DESC, o2.scraped_at DESC, o2.id DESC
             LIMIT 1
           )`
      )
      .bind(...chunk.map(evidenceKey))
      .all<EntryEvidenceRow>()
    for (const row of results ?? []) {
      evidence.set(row.evidence_key, {
        entryBrochureUrl: row.brochure_url ?? null,
        entrySourceUrl: row.source_url ?? null,
        entryObservedAt: row.observed_date ?? null,
        entryOriginalPrice: row.original_price ?? null,
      })
    }
  }
  return evidence
}

// Thermos B1 (issue #380): any row shape carrying the evidence fields —
// ReviewItem and ReviewExportRow both qualify structurally, so ONE loop serves
// the queue list, the decide/undo responses, and the export pages alike; the
// export rows cannot silently diverge from the card's evidence shape.
type EvidenceCarrier = {
  entryProductKey: string
  entryStore: string
  entryBrochureUrl: string | null
  entrySourceUrl: string | null
  entryObservedAt: string | null
  entryOriginalPrice: number | null
}

function enrichEntryEvidence<T extends EvidenceCarrier>(
  items: T[],
  evidence: Map<string, EntryEvidence>
): void {
  for (const item of items) {
    // The carrier's field names differ from EntryEvidenceLookup's, so the
    // composite is built inline instead of via evidenceKey().
    const found = evidence.get(`${item.entryProductKey}|${item.entryStore}`)
    if (!found) continue
    // Per-field frozen-first (#691 RC3): a non-null field is the blob's
    // flag-time sighting and is NEVER overwritten by the live lookup — live
    // fills only what an old blob does not carry. entryOriginalPrice (QA-07)
    // has no frozen counterpart, so the live lookup always fills it.
    if (item.entryBrochureUrl === null) item.entryBrochureUrl = found.entryBrochureUrl
    if (item.entrySourceUrl === null) item.entrySourceUrl = found.entrySourceUrl
    if (item.entryObservedAt === null) item.entryObservedAt = found.entryObservedAt
    if (item.entryOriginalPrice === null) item.entryOriginalPrice = found.entryOriginalPrice
  }
}

/** True when at least one evidence field is still null and only the live
 * lookup can fill it — a fully-frozen item (#691 blob) skips its round trip
 * entirely (enrichment could not change it anyway). entryOriginalPrice
 * (QA-07) never freezes, so any item still needs the lookup until the
 * observation itself has no original price to give. */
function needsEntryEvidenceLookup(item: EvidenceCarrier): boolean {
  return (
    item.entryBrochureUrl === null ||
    item.entrySourceUrl === null ||
    item.entryObservedAt === null ||
    item.entryOriginalPrice === null
  )
}

// One projection for BOTH reads of a review row — the list page and the
// decide/undo re-read — so the response shape can never drift between them
// (it already repeated the run join; issue #484 adds the verdict join). A
// LEFT JOIN means an unevaluated item's ai_* columns are uniformly NULL.
const REVIEW_ROW_COLUMNS = `r.id, r.pair_data, r.status, r.decided_at, r.decided_by,
        r.decided_source, r.flag_count, r.first_flagged_at, r.last_flagged_at,
        r.run_started_at, p.id AS run_id,
        pp.category AS item_category, pp.category_version AS item_category_version,
        pp.category_source AS item_category_source,
        v.verdict AS ai_verdict, v.confidence AS ai_confidence, v.reason AS ai_reason,
        v.model AS ai_model, v.human_agreement AS ai_human_agreement`

const REVIEW_ROW_JOINS = `LEFT JOIN price_runs p ON p.run_started_at = r.run_started_at
      LEFT JOIN price_products pp ON pp.product_key = r.item_product_key
      LEFT JOIN review_ai_verdicts v ON v.review_item_id = r.id`

// The pair blob's flag reason, NULL when the blob is malformed — ONE owner of
// the json_valid/json_extract plumbing, so every statement that must agree on
// "what is a taxonomy flag" parses it identically: the page WHERE, the
// filteredTotal WHERE, the pendingByReason GROUP BY and the bulk ack (#626).
// `col` is qualified in the joined reads (r.pair_data) and bare in the
// single-table count/ack statements.
function pairReasonSql(col: string): string {
  return `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.reason') END)`
}

// The status/pendingByReason counts shared by the list route (#628) and the
// scripted queue report (#656) — one owner for the vocabulary policy: every
// reason present from the start (an absent reason counts 0, and the client
// renders the split without existence checks), while a malformed blob (the
// json_valid CASE yields NULL) or an unknown value is dropped rather than
// widening the response vocabulary.
function buildReviewCounts(
  statusResult: { results?: unknown[] },
  reasonResult: { results?: unknown[] }
): ReviewCounts {
  const counts: ReviewCounts = {
    pending: 0,
    approved: 0,
    rejected: 0,
    pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
  }
  for (const row of (statusResult.results ?? []) as unknown as {
    status: string
    count: number
  }[]) {
    if (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected') {
      counts[row.status] = row.count
    }
  }
  for (const row of (reasonResult.results ?? []) as unknown as {
    flag_reason: string | null
    count: number
  }[]) {
    if (isReviewReason(row.flag_reason)) counts.pendingByReason[row.flag_reason] = row.count
  }
  return counts
}

/**
 * One page of the review queue, newest flags first, plus the exact
 * per-status counts. Offset pagination on purpose: last_flagged_at mutates
 * via upsert, so a cursor would skip/repeat rows across a re-flag — the
 * table is order-of-hundreds and the UI appends pages, so offsets are
 * honest. Counts come from one GROUP BY: exact at any size, independent of
 * paging.
 *
 * Issue #628: `reason` narrows the PAGE (and filteredTotal) only — the
 * counts stay whole-queue, and `counts.pendingByReason` splits the pending
 * total by flag reason. Both reads go through `json_valid` because
 * `json_extract` THROWS on a malformed blob, and this read deliberately
 * tolerates one (parseReviewPair drops it from the page instead of failing
 * the request).
 *
 * Deliberately NO AI here (issue #484): the list read is the hot path and
 * must never wait on a provider. Verdicts are computed by the explicit
 * evaluate route or the cron sweep and merely JOINED in when cached.
 */
export async function listReviewItems(
  db: D1Database,
  options: {
    status?: ReviewStatus | 'all'
    /** Issue #628: optional flag-reason filter, combinable with the status. */
    reason?: ReviewReason
    limit?: number
    offset?: number
  } = {}
): Promise<ReviewListPage> {
  const status = options.status ?? 'pending'
  // #626: absent reason = the IDENTITY queue — every reason EXCEPT taxonomy.
  // A taxonomy flag is a self-pair the identity workflow cannot act on
  // (review-ai.ts skips it by design), and 600 of them drowning the match
  // queue was the issue's whole point; the taxonomy page is the explicit
  // `reason: 'taxonomy'` read. A malformed blob (json_valid → NULL) is not a
  // taxonomy flag and stays in the identity queue (COALESCE → '').
  const reason = options.reason ?? null
  // The reason guard takes one of two shapes: an explicit reason matches the
  // blobs that name it (one bind); the absent reason IS the identity-queue
  // exclusion (no bind). Building the fragment instead of binding `reason`
  // three times keeps the bind sequences flat.
  const reasonGuardSql = (col: string): string =>
    reason ? `${pairReasonSql(col)} = ?` : `COALESCE(${pairReasonSql(col)}, '') <> 'taxonomy'`
  const reasonBinds: unknown[] = reason ? [reason] : []
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.min(Math.max(options.offset ?? 0, 0), Number.MAX_SAFE_INTEGER)

  const [pageResult, countResult, reasonCountResult, filteredResult] = await db.batch([
    db
      .prepare(
        `SELECT ${REVIEW_ROW_COLUMNS}
         FROM match_review_items r
         ${REVIEW_ROW_JOINS}
         WHERE (? = 'all' OR r.status = ?)
           AND ${reasonGuardSql('r.pair_data')}
         -- Pairs flagged by the same run share last_flagged_at; the natural
         -- key tie-break makes the total order deterministic so an offset
         -- page walk cannot skip/repeat tied rows across reads.
         ORDER BY r.last_flagged_at DESC, r.item_product_key ASC, r.entry_product_key ASC
         LIMIT ? OFFSET ?`
      )
      .bind(status, status, ...reasonBinds, limit, offset),
    db.prepare(`SELECT status, COUNT(*) AS count FROM match_review_items GROUP BY status`).bind(),
    // Issue #628: the exact pending split by reason. The alias cannot be
    // `reason` — that is a real column, and SQLite resolves a GROUP BY name
    // to the column over the output alias — so `flag_reason` it is.
    db
      .prepare(
        `SELECT ${pairReasonSql('r.pair_data')} AS flag_reason,
                COUNT(*) AS count
         FROM match_review_items r
         WHERE r.status = 'pending'
         GROUP BY flag_reason`
      )
      .bind(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM match_review_items
         WHERE (? = 'all' OR status = ?)
           AND ${reasonGuardSql('pair_data')}`
      )
      .bind(status, status, ...reasonBinds),
  ])

  const items: ReviewItem[] = []
  for (const row of (pageResult.results ?? []) as unknown as ReviewRow[]) {
    const item = toReviewItem(row)
    if (item) items.push(item)
  }
  // The RIGHT side's evidence rides every list read — pending, decided, and
  // `all` alike (after-the-fact review is the point) — frozen-first (#691
  // RC3): fully-frozen items skip the live lookup below.
  enrichEntryEvidence(
    items,
    await fetchEntryEvidence(
      db,
      items
        .filter(needsEntryEvidenceLookup)
        .map((i) => ({ productKey: i.entryProductKey, storeSlug: i.entryStore }))
    )
  )

  const counts = buildReviewCounts(countResult, reasonCountResult)

  const filteredRows = (filteredResult.results ?? []) as unknown as { count: number }[]
  return { items, counts, filteredTotal: filteredRows[0]?.count ?? 0 }
}

// The scripted queue report (ahaqqu/RumaQ#656) — the whole-queue aggregates
// the auto-mode switch checklist (docs/REVIEW-AUTO-MODE.md) is decided from.
// Read-only, one db.batch like listReviewItems. A confidence band is the
// switch thresholds' vocabulary: < 0.6 untrusted, 0.6–0.8 inspect, >= 0.8 the
// auto floor (REVIEW_AUTO_MIN_CONFIDENCE). `human_agreement` NULL means the
// item was decided before its cached verdict existed — it counts toward
// `decided` but neither agreed nor disagreed (no AI opinion to compare).
export const REVIEW_CONFIDENCE_BANDS = ['<0.6', '0.6-0.8', '>=0.8'] as const
export type ReviewConfidenceBand = (typeof REVIEW_CONFIDENCE_BANDS)[number]

export type ReviewQueueReport = {
  generatedAt: string
  counts: ReviewCounts
  ai: {
    pendingWithVerdict: number
    pendingWithoutVerdict: number
    models: { provider: string | null; model: string | null; count: number }[]
    confidenceBands: { band: ReviewConfidenceBand; count: number }[]
    autoEligible: number
  }
  agreement: {
    band: ReviewConfidenceBand
    decided: number
    agreed: number
    disagreed: number
    precision: number | null
  }[]
}

const QUEUE_REPORT_BAND_CASE = `(CASE WHEN v.confidence < 0.6 THEN 0
                WHEN v.confidence < 0.8 THEN 1
                ELSE 2 END)`

export async function fetchReviewQueueReport(db: D1Database): Promise<ReviewQueueReport> {
  const [statusResult, reasonResult, coverageResult, modelResult, bandResult, agreementResult] =
    await db.batch([
      db.prepare(`SELECT status, COUNT(*) AS count FROM match_review_items GROUP BY status`).bind(),
      db
        .prepare(
          `SELECT (CASE WHEN json_valid(r.pair_data)
                        THEN json_extract(r.pair_data, '$.reason') END) AS flag_reason,
                  COUNT(*) AS count
           FROM match_review_items r
           WHERE r.status = 'pending'
           GROUP BY flag_reason`
        )
        .bind(),
      db
        .prepare(
          `SELECT (v.review_item_id IS NULL) AS uncovered, COUNT(*) AS count
           FROM match_review_items r
           LEFT JOIN review_ai_verdicts v ON v.review_item_id = r.id
           WHERE r.status = 'pending'
           GROUP BY uncovered`
        )
        .bind(),
      db
        .prepare(
          `SELECT v.provider AS provider, v.model AS model, COUNT(*) AS count
           FROM match_review_items r
           JOIN review_ai_verdicts v ON v.review_item_id = r.id
           WHERE r.status = 'pending'
           GROUP BY v.provider, v.model
           ORDER BY count DESC, provider, model`
        )
        .bind(),
      db
        .prepare(
          `SELECT ${QUEUE_REPORT_BAND_CASE} AS band, COUNT(*) AS count
           FROM match_review_items r
           JOIN review_ai_verdicts v ON v.review_item_id = r.id
           WHERE r.status = 'pending'
           GROUP BY band`
        )
        .bind(),
      db
        .prepare(
          `SELECT ${QUEUE_REPORT_BAND_CASE} AS band,
                  v.human_agreement AS agreement,
                  COUNT(*) AS count
           FROM match_review_items r
           JOIN review_ai_verdicts v ON v.review_item_id = r.id
           WHERE r.status != 'pending'
           GROUP BY band, agreement`
        )
        .bind(),
    ])

  const counts = buildReviewCounts(statusResult, reasonResult)

  let pendingWithVerdict = 0
  let pendingWithoutVerdict = 0
  for (const row of (coverageResult.results ?? []) as unknown as {
    uncovered: number
    count: number
  }[]) {
    if (row.uncovered) pendingWithoutVerdict += row.count
    else pendingWithVerdict += row.count
  }

  const models = (modelResult.results ?? []) as unknown as {
    provider: string | null
    model: string | null
    count: number
  }[]

  const bands: ReviewQueueReport['ai']['confidenceBands'] = REVIEW_CONFIDENCE_BANDS.map((band) => ({
    band,
    count: 0,
  }))
  for (const row of (bandResult.results ?? []) as unknown as { band: number; count: number }[]) {
    const slot = bands[row.band]
    if (slot) slot.count += row.count
  }

  const agreement: ReviewQueueReport['agreement'] = REVIEW_CONFIDENCE_BANDS.map((band) => ({
    band,
    decided: 0,
    agreed: 0,
    disagreed: 0,
    precision: null,
  }))
  for (const row of (agreementResult.results ?? []) as unknown as {
    band: number
    agreement: string | null
    count: number
  }[]) {
    const slot = agreement[row.band]
    if (!slot) continue
    slot.decided += row.count
    if (row.agreement === 'agreed') slot.agreed += row.count
    if (row.agreement === 'disagreed') slot.disagreed += row.count
  }
  for (const slot of agreement) {
    const comparable = slot.agreed + slot.disagreed
    slot.precision = comparable > 0 ? slot.agreed / comparable : null
  }

  return {
    generatedAt: new Date().toISOString(),
    counts,
    ai: {
      pendingWithVerdict,
      pendingWithoutVerdict,
      models,
      confidenceBands: bands,
      autoEligible: bands[2]?.count ?? 0,
    },
    agreement,
  }
}

/**
 * #691 Phase A: the per-ID inspection read behind the queue-report's optional
 * `ids` query param — the manager's diagnosis tool reads a FROZEN pair and
 * its evidence in one response (frozen-first since RC3: the card's evidence
 * fields ARE the flag-time sighting when the blob carries them). Ids resolve
 * EXACT-OR-PREFIX: rows are keyed by the ingest UUID, while the ids humans
 * quote are the queue card's 8-hex short form (#42a3e6a8, the owner's #691
 * report) — an exact IN-list would report every such request found:false, a
 * false "rows gone" diagnosis. Each validated token therefore binds as ONE
 * LIKE prefix pattern (hex/dash tokens cannot carry LIKE wildcards, and a
 * full-UUID token's pattern can only match its own row); one bind per id, far
 * under D1's 100-bind cap, so one statement. The mapping/enrichment is the
 * shared hydrateReviewRows pipeline, so the item shape cannot drift from the
 * decide/undo re-reads'. Entries come back in the REQUESTED order; a token
 * matching no row is a `found: false` entry, not an error (the tool must
 * report the whole requested set), and a token matching several rows resolves
 * to the lexicographically-first id — visible in the returned item.id for
 * disambiguation. `item` is null when the row exists but its pair blob is
 * malformed — "the row is there" and "the pair is renderable" are different
 * facts, and a diagnosis tool wants both.
 */
export type ReviewItemLookup = {
  id: string
  found: boolean
  item: ReviewItem | null
}

export async function fetchReviewItemsByIds(
  db: D1Database,
  ids: string[]
): Promise<ReviewItemLookup[]> {
  if (ids.length === 0) return []
  const { results } = await db
    .prepare(
      `SELECT ${REVIEW_ROW_COLUMNS}
       FROM match_review_items r
       ${REVIEW_ROW_JOINS}
       WHERE ${ids.map(() => 'r.id LIKE ?').join(' OR ')}`
    )
    .bind(...ids.map((id) => `${id}%`))
    .all<ReviewRow>()
  const itemByRowId = await hydrateReviewRows(db, (results ?? []) as unknown as ReviewRow[])
  return ids.map((id) => {
    const matchId = [...itemByRowId.keys()]
      .filter((rowId) => rowId.startsWith(id))
      .sort()
      .at(0)
    if (matchId === undefined) return { id, found: false, item: null }
    return { id, found: true, item: itemByRowId.get(matchId) ?? null }
  })
}

// One hydration pipeline for BOTH review-row reads — toReviewItem plus the
// entry evidence enrichment — so the decide/undo re-read and the per-ID
// inspection render the identical card shape. Returns row-id → item (null
// when the pair blob is malformed); parseable items carry their FROZEN
// evidence (#691 RC3), with the store-pinned live lookup (fetchEntryEvidence)
// filling only the fields an old blob does not carry.
async function hydrateReviewRows(
  db: D1Database,
  rows: ReviewRow[]
): Promise<Map<string, ReviewItem | null>> {
  const itemByRowId = new Map<string, ReviewItem | null>()
  const items: ReviewItem[] = []
  for (const row of rows) {
    const item = toReviewItem(row)
    itemByRowId.set(row.id, item)
    if (item) items.push(item)
  }
  enrichEntryEvidence(
    items,
    await fetchEntryEvidence(
      db,
      items
        .filter(needsEntryEvidenceLookup)
        .map((i) => ({ productKey: i.entryProductKey, storeSlug: i.entryStore }))
    )
  )
  return itemByRowId
}

async function getReviewRow(db: D1Database, id: string): Promise<ReviewItem | null> {
  // EXACT on purpose: this re-read renders the row the decide/undo UPDATE
  // (also exact WHERE id = ?) just touched. Prefix resolution here would turn
  // a short-id decision write into a silent no-op reported as success — the
  // exact write matches nothing while this read finds a prefix neighbour.
  // The inspection read (fetchReviewItemsByIds) resolves prefixes; the write
  // path's re-read must not.
  const row = await db
    .prepare(
      `SELECT ${REVIEW_ROW_COLUMNS}
       FROM match_review_items r
       ${REVIEW_ROW_JOINS}
       WHERE r.id = ?`
    )
    .bind(id)
    .first<ReviewRow>()
  if (!row) return null
  const items = await hydrateReviewRows(db, [row])
  return items.get(row.id) ?? null
}

/**
 * Record a human verdict (last verdict wins — deciding twice overwrites).
 * Returns the updated row plus the decision's registry outcome, or null for
 * an unknown id (404 at the route).
 *
 * Issue #484: `agreement` is the AI-assist path — the human accepted or
 * rejected a CACHED AI verdict. It records the verdict's human_agreement and
 * the item's `decided_source='ai_assist'`; without it (or without a verdict
 * to agree with) the decision carries plain human provenance.
 *
 * Issue #744: an APPROVE decision also merges the registry — the entry-side
 * product identity is absorbed into the item-side survivor (observations
 * re-pointed, aliases moved, the absorbed row deleted, one merge receipt, one
 * canonical-index bump) INSIDE the same batch as the verdict write, so an
 * approval can never commit without its merge. The merge runs on EVERY
 * approve (last-wins re-approval included); idempotency comes from the
 * receipt's state gates, not from skipping — a re-approval of an
 * already-absorbed pair plans nothing to absorb and writes nothing. A REJECT
 * decides only: the batch stays exactly the pre-#744 two statements.
 * `registry` is the receipt's counts when this batch merged, null otherwise;
 * the merge itself is terminal (an undo resets the review row, never the
 * catalog — the receipt is the record).
 */
export async function decideReviewItem(
  db: D1Database,
  id: string,
  decision: ReviewDecision,
  userId: string,
  agreement?: HumanAgreement
): Promise<{ item: ReviewItem | null; registry: MergeReceiptCounts | null }> {
  const verdict = await db
    .prepare('SELECT verdict FROM review_ai_verdicts WHERE review_item_id = ?')
    .bind(id)
    .first<{ verdict: ReviewVerdictName }>()
  const decidedSource: ReviewDecisionSource = agreement && verdict ? 'ai_assist' : 'human'
  // Thermos A4: the agreement is DERIVED from what the human actually did
  // against the cached verdict, never trusted from the request. A client that
  // sends "agreed" while reversing the AI's answer would otherwise record
  // provenance that contradicts the decision itself — and the agreement
  // history is the signal the whole assist mode is meant to build.
  const humanAgreement: HumanAgreement | null =
    agreement && verdict
      ? verdictDecision(verdict.verdict) === decision
        ? 'agreed'
        : 'disagreed'
      : null
  const decidedAt = new Date().toISOString()
  const statements = [
    db
      .prepare(
        `UPDATE match_review_items
         SET status = ?, decided_at = ?, decided_by = ?, decided_source = ?
         WHERE id = ?`
      )
      .bind(decision, decidedAt, userId, decidedSource, id),
  ]
  if (verdict) {
    // The agreement describes THIS decision (issue #484), so a plain decision
    // after an Agree/Disagree clears it rather than leaving stale provenance
    // next to a `decided_source='human'` row. The verdict itself is untouched.
    statements.push(
      db
        .prepare('UPDATE review_ai_verdicts SET human_agreement = ? WHERE review_item_id = ?')
        .bind(humanAgreement, id)
    )
  }

  // The registry merge rides THIS batch (#744), approvals only — a reject
  // decides and touches no catalog row. The pair keys name the sides; an
  // unknown id reads no keys and the merge planning is skipped — the verdict
  // UPDATE below still matches nothing and the route 404s as before.
  let registry: MergeReceiptCounts | null = null
  let receiptReadAppended = false
  if (decision === 'approved') {
    const keys = await db
      .prepare('SELECT item_product_key, entry_product_key FROM match_review_items WHERE id = ?')
      .bind(id)
      .first<{ item_product_key: string; entry_product_key: string }>()
    const plan = keys
      ? await planProductMerge(db, keys.item_product_key, keys.entry_product_key)
      : null
    if (plan?.kind === 'merge') {
      const receiptId = crypto.randomUUID()
      statements.push(
        ...mergeStatements(db, {
          reviewItemId: id,
          receiptId,
          survivor: plan.survivor,
          absorbed: plan.absorbed,
          actorUserId: userId,
          decidedSource,
          decidedAt,
          decidedBy: userId,
        }),
        // The response's registry block reads back the receipt this batch
        // (conditionally) wrote — a no-op merge returns no row.
        mergeReceiptReadStatement(db, receiptId)
      )
      receiptReadAppended = true
    }
  }

  const batchResults = await db.batch(statements)
  if (receiptReadAppended) {
    const read = batchResults[batchResults.length - 1] as
      | { results?: Array<{ repointed: number; dropped: number; movedAliases: number }> }
      | undefined
    // No row = the receipt gate rejected (a no-op merge); the route answers
    // `registry: null`.
    registry = read?.results?.[0] ?? null
  }
  return { item: await getReviewRow(db, id), registry }
}

/**
 * Undo a verdict: back to pending, decision fields cleared. Undoing an
 * already-pending row is an idempotent no-op. Returns the row, or null for an
 * unknown id.
 *
 * The provenance goes with the decision (issue #484): a pending row has no
 * source, and the verdict's human_agreement described the decision being
 * undone. The cached verdict itself STAYS — verdicts are cached forever, so
 * re-deciding (or a later auto sweep) needs no new provider call.
 */
export async function undoReviewDecision(db: D1Database, id: string): Promise<ReviewItem | null> {
  await db.batch([
    db
      .prepare(
        `UPDATE match_review_items
         SET status = 'pending', decided_at = NULL, decided_by = NULL, decided_source = NULL
         WHERE id = ?`
      )
      .bind(id),
    db
      .prepare('UPDATE review_ai_verdicts SET human_agreement = NULL WHERE review_item_id = ?')
      .bind(id),
  ])
  return getReviewRow(db, id)
}

// D1's run() reports the affected-row count at meta.changes; the node:sqlite
// adapter the real-SQLite tests run through exposes the same number flat. One
// structural read covers both shapes.
function statementChanges(run: unknown): number {
  const meta = run as { meta?: { changes?: number }; changes?: number }
  return meta.meta?.changes ?? meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// Taxonomy acknowledgement (#626). A taxonomy flag is a SELF-pair — the
// category-quality signal the identity workflow cannot act on (review-ai.ts
// skips it by design, and a "reject" on a pair whose sides are the same
// product has no meaning). There is no category-edit path yet, so the honest
// decision is an EXPLICIT ACKNOWLEDGEMENT: the human says "seen — the
// assigned category stands". It records exactly like a manual verdict
// (approved, decided_source='human', decided_by = the acting admin) through
// one statement, and undoReviewDecision keeps working per row. Re-flags do
// NOT reopen it: the ingest upsert never touches `status`, so an
// acknowledged pair stays silent unless the classifier raises NEW evidence.
export async function acknowledgePendingTaxonomy(
  db: D1Database,
  userId: string,
  now: Date = new Date()
): Promise<{ acknowledged: number; remaining: number }> {
  // The UPDATE and its remaining-count read name the same pending-taxonomy
  // set through pairReasonSql — the ONE owner of the blob-reason expression,
  // shared with the list reads, so the ack can never drift from what the
  // taxonomy page shows.
  const pendingTaxonomySql = `status = 'pending'
         AND COALESCE(${pairReasonSql('pair_data')}, '') = 'taxonomy'`
  const run = await db
    .prepare(
      `UPDATE match_review_items
       SET status = 'approved', decided_at = ?, decided_by = ?, decided_source = 'human'
       WHERE ${pendingTaxonomySql}`
    )
    .bind(now.toISOString(), userId)
    .run()
  const { results } = await db
    .prepare(`SELECT COUNT(*) AS count FROM match_review_items WHERE ${pendingTaxonomySql}`)
    .bind()
    .all<{ count: number }>()
  return {
    acknowledged: statementChanges(run),
    remaining: results?.[0]?.count ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Human category override (#728). The #626 ack is "seen — the assigned
// category stands"; this is the act the issue adds: the admin SETS the
// category. The write follows the 0037 rename-receipt rails, adapted per the
// reconciled design: the override binds to the product ROW the flag names
// (price_products.id — product keys derive from raw names and a #21 re-key
// must never orphan the override), stamps `category_source='human'` and the
// sealed `TAXONOMY_VERSION`, appends one price_product_category_audit
// receipt, bumps the canonical index once (the corrected category rides back
// to the pipeline within its ≤48 h cached-index window), and settles the
// flag decided_source='human' exactly like acknowledgePendingTaxonomy — all
// inside ONE db.batch, every statement after the guarded UPDATE gated on the
// state it produced, so a stale request writes nothing at all.
//
// The sealed vocabulary is the authority: the category MUST be one of the
// contract's TAXONOMY_BUCKETS (the pipeline's frozen 49-slug list). Strictness
// is not pedantry — a stray slug permanently pollutes the explorer filter
// domain (SELECT DISTINCT category) and can 500 the whole canonical index
// parse (maxLength(50)), which is why the pipeline treats an out-of-domain
// answer as a hard failure too.
//
// Deliberately NO flag-settle breadth beyond the opened flag (owner decision
// 2026-11-19): a product re-flagged tomorrow lands as a NEW row whose settle
// is the admin's next action; the card's itemCategorySource='human' chip
// explains it.
// ---------------------------------------------------------------------------

export class CategoryUnknownError extends Error {
  constructor(readonly category: string) {
    super(`Category '${category}' is not in the sealed taxonomy vocabulary`)
    this.name = 'CategoryUnknownError'
  }
}

export class CategoryUnchangedError extends Error {
  constructor(readonly category: string) {
    super('Category already matches; confirming is the acknowledgement path')
    this.name = 'CategoryUnchangedError'
  }
}

/** The from-value CAS lost — the category moved since the card was read. */
export class StaleCategoryError extends Error {
  constructor(readonly category: string) {
    super('Category changed since it was read; refresh and retry')
    this.name = 'StaleCategoryError'
  }
}

/** The review row the override addresses does not exist, or is not renderable. */
export class ReviewItemNotFoundError extends Error {
  constructor(readonly reviewItemId: string) {
    super(`Review item '${reviewItemId}' not found`)
    this.name = 'ReviewItemNotFoundError'
  }
}

type OverrideCategoryInput = {
  reviewItemId: string
  category: string
  actorUserId: string
  reason?: string | null
  now?: Date
}

/**
 * The product-side facts an override needs, read before the batch. The
 * product row resolves through the flag's item_product_key column; the pair
 * blob must parse (the queue card renders FROM it, and overriding a flag
 * whose context cannot be shown is a zombie path — 404 either way).
 */
type OverrideSourceRow = {
  item_product_key: string
}

type OverrideProductRow = {
  id: string
  product_key: string
  category: string | null
  category_version: string | null
  metadata_version: number
}

// The batch surface narrowed once (canonical-products.ts's BatchResult, kept
// local: match-review.ts owns no other call site that reads meta.changes —
// statementChanges covers the .run() shape instead).
type BatchRunResult = { results?: unknown[]; meta?: { changes?: number } }

export async function overrideTaxonomyCategory(
  db: D1Database,
  input: OverrideCategoryInput
): Promise<ReviewItem | null> {
  if (!(TAXONOMY_BUCKETS as readonly string[]).includes(input.category)) {
    throw new CategoryUnknownError(input.category)
  }
  const reason = normalizeReason(input.reason)

  const source = await db
    .prepare('SELECT item_product_key, pair_data FROM match_review_items WHERE id = ?')
    .bind(input.reviewItemId)
    .first<OverrideSourceRow & { pair_data: string }>()
  if (!source || parseReviewPair(source.pair_data) === null) {
    throw new ReviewItemNotFoundError(input.reviewItemId)
  }

  const product = await db
    .prepare(
      `SELECT id, product_key, category, category_version, metadata_version FROM price_products
       WHERE product_key = ?`
    )
    .bind(source.item_product_key)
    .first<OverrideProductRow>()
  if (!product) throw new ProductNotFoundError(source.item_product_key)

  // Confirming the assigned category is the ack's job (#626): the override is
  // a CHANGE, so a same-value request is a 400, not a silent re-write.
  if (product.category === input.category) {
    throw new CategoryUnchangedError(input.category)
  }

  const now = (input.now ?? new Date()).toISOString()
  const auditId = crypto.randomUUID()
  const nextVersion = product.metadata_version + 1

  // One D1 batch (one transaction — statements see each other's writes):
  //   (1) guarded product UPDATE — the FROM-VALUE CAS (`category IS ?`,
  //       NULL-safe). The review card carries no expectedMetadataVersion, so
  //       the from-value plays the role the rename gives to the version: a
  //       concurrent category write 0-rows this update. A concurrent RENAME
  //       (bumps the version, never the category) composes fine.
  //   (2) gated receipt — the category/version/updated_at triple can only be
  //       produced by statement (1) in this batch, so a stale request inserts
  //       nothing (and therefore cannot bump the index or settle the flag).
  //   (3) index bump, gated on the receipt (indexBumpStatement).
  //   (4) flag settle, gated on the receipt AND the pending status — decided
  //       rows keep their decision while the category still moves (fixing the
  //       catalog on a decided row is legitimate; the card renders them).
  const results = (await db.batch([
    db
      .prepare(
        `UPDATE price_products
         SET category = ?, category_version = ?, category_source = 'human',
             metadata_version = metadata_version + 1, updated_at = ?
         WHERE id = ? AND category IS ?`
      )
      .bind(input.category, TAXONOMY_VERSION, now, product.id, product.category),
    db
      .prepare(
        `INSERT INTO price_product_category_audit
           (id, product_id, product_key, actor_user_id, action, old_category,
            old_category_version, new_category, new_category_version, reason,
            review_item_id, metadata_version_before, metadata_version_after,
            reverts_audit_id, created_at)
         SELECT ?, ?, ?, ?, 'set', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
         FROM price_products p
         WHERE p.id = ? AND p.category = ? AND p.metadata_version = ? AND p.updated_at = ?`
      )
      .bind(
        auditId,
        product.id,
        product.product_key,
        input.actorUserId,
        product.category,
        product.category_version,
        input.category,
        TAXONOMY_VERSION,
        reason,
        input.reviewItemId,
        product.metadata_version,
        nextVersion,
        now,
        product.id,
        input.category,
        nextVersion,
        now
      ),
    indexBumpStatement(db, auditId, 'price_product_category_audit'),
    db
      .prepare(
        `UPDATE match_review_items
         SET status = 'approved', decided_at = ?, decided_by = ?, decided_source = 'human'
         WHERE id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM price_product_category_audit WHERE id = ?)`
      )
      .bind(now, input.actorUserId, input.reviewItemId, auditId),
  ])) as unknown as BatchRunResult[]

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new StaleCategoryError(input.category)
  }

  return getReviewRow(db, input.reviewItemId)
}

// ---------------------------------------------------------------------------
// Export — the artifact a future matcher-feedback loop consumes. Versioned
// envelope, keyset-paged reads so the export carries EVERY decided row no
// matter how the list paginates (non-truncation pinned by test).

export type ReviewExportRow = {
  itemProductKey: string
  itemName: string
  itemStore: string
  itemPrice: number
  entryProductKey: string
  entryName: string
  entryStore: string
  entryPrice: number
  decision: ReviewDecision
  decidedAt: string
  decidedBy: string | null
  runStartedAt: string
  confidence: number
  matchMethod: string
  reason: string
  flagCount: number
  // The entry-side evidence, same shape as the queue rows — frozen-first
  // since #691 RC3 (the blob's flag-time sighting; the live lookup fills
  // only what an old blob does not carry). Additive on the rows; the
  // envelope stays schema:1 (JSON consumers read what they know).
  entryBrochureUrl: string | null
  entrySourceUrl: string | null
  entryObservedAt: string | null
  // QA-07 (pipeline #160): the entry sighting's struck original price —
  // never frozen (the contract pair schema has no field), so always the
  // live lookup's value from the store's latest observation.
  entryOriginalPrice: number | null
}

const EXPORT_PAGE = 200

type ExportRow = {
  id: string
  pair_data: string
  status: string
  decided_at: string
  decided_by: string | null
  flag_count: number
  run_started_at: string
}

function toExportRow(row: ExportRow): ReviewExportRow | null {
  const pair = parseReviewPair(row.pair_data)
  if (!pair) return null
  return {
    itemProductKey: pair.itemProductKey,
    itemName: pair.itemName,
    itemStore: pair.itemStore,
    itemPrice: pair.itemPrice,
    entryProductKey: pair.entryProductKey,
    entryName: pair.entryName,
    entryStore: pair.entryStore,
    entryPrice: pair.entryPrice,
    decision: row.status === 'approved' ? 'approved' : 'rejected',
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    runStartedAt: row.run_started_at,
    confidence: pair.confidence,
    matchMethod: pair.matchMethod,
    reason: pair.reason,
    flagCount: row.flag_count,
    // #691 RC3: the blob's frozen evidence, like the queue rows; the per-page
    // enrichment below fills only the fields still null.
    entryBrochureUrl: pair.entryBrochureUrl ?? null,
    entrySourceUrl: pair.entrySourceUrl ?? null,
    entryObservedAt: pair.entryObservedAt ?? null,
    // QA-07: never frozen, only the live lookup fills it.
    entryOriginalPrice: null,
  }
}

type DecidedPage = {
  /** Parsed, stream-ready rows — a malformed blob is dropped, never fatal. */
  rows: Array<{ id: string; row: ReviewExportRow }>
  /** Cursor from the last RAW row: pagination must jump past a dropped tail
   * row too, or the next page would silently lose its undropped neighbors. */
  cursor: { decidedAt: string; id: string } | null
  /** Whether the RAW result filled the page — parse failures must never end
   * the pagination loop early (the export's non-truncation guarantee). */
  full: boolean
}

async function listDecidedPage(db: D1Database, after: { decidedAt: string; id: string } | null) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.pair_data, r.status, r.decided_at, r.decided_by, r.flag_count, r.run_started_at
       FROM match_review_items r
       WHERE r.status != 'pending'
         AND (? IS NULL OR r.decided_at > ? OR (r.decided_at = ? AND r.id > ?))
       ORDER BY r.decided_at ASC, r.id ASC
       LIMIT ${EXPORT_PAGE}`
    )
    .bind(
      after?.decidedAt ?? null,
      after?.decidedAt ?? null,
      after?.decidedAt ?? null,
      after?.id ?? null
    )
    .all<ExportRow>()
  const raw = results ?? []
  const page: DecidedPage = { rows: [], cursor: null, full: raw.length >= EXPORT_PAGE }
  for (const row of raw) {
    const parsed = toExportRow(row)
    if (parsed) page.rows.push({ id: row.id, row: parsed })
  }
  // Issue #380: export rows carry the entry-side evidence too — per keyset
  // page, so the stream's memory stays flat. Same enrichment helper and the
  // same frozen-first rule as the queue rows (thermos B1); fully-frozen rows
  // skip the live lookup.
  const evidence = await fetchEntryEvidence(
    db,
    page.rows
      .map(({ row }) => row)
      .filter(needsEntryEvidenceLookup)
      .map((row) => ({ productKey: row.entryProductKey, storeSlug: row.entryStore }))
  )
  enrichEntryEvidence(
    page.rows.map(({ row }) => row),
    evidence
  )
  const last = raw[raw.length - 1]
  if (last) page.cursor = { decidedAt: last.decided_at, id: last.id }
  return page
}

/**
 * Stream every decided row as `{"schema":1,"exportedAt":"…","decisions":[…]}`
 * — chunks enqueue as each keyset page lands, so memory stays flat and the
 * file is complete regardless of the list endpoint's pagination.
 */
export function exportReviewDecisions(db: D1Database): ReadableStream {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `{"schema":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"decisions":[`
        )
      )
      let first = true
      let after: { decidedAt: string; id: string } | null = null
      for (;;) {
        const page = await listDecidedPage(db, after)
        for (const { row } of page.rows) {
          controller.enqueue(encoder.encode(`${first ? '' : ','}${JSON.stringify(row)}`))
          first = false
        }
        // Fullness and the cursor are RAW-row based: a malformed blob drops
        // one stream entry but must not end the walk or skip its neighbors.
        if (!page.full) break
        after = page.cursor!
      }
      controller.enqueue(encoder.encode(']}'))
      controller.close()
    },
  })
}
