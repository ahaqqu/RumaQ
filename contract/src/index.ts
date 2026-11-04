import {
  array,
  boolean,
  gtValue,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  nullish,
  picklist,
  pipe,
  record,
  regex,
  strictObject,
  string,
  type InferOutput,
} from 'valibot'

// Shared ingest contract between the rumaq-scraper (VPS) and the Worker
// (docs/plan/haqita-integration.md §5.2), exposed as a workspace package so
// both sides depend on it explicitly instead of reaching into each other's
// source tree. Additive changes only; bump schemaVersion for breaking ones.
// This module is intentionally free of any runtime-specific types (no
// D1/workers-types) so both a plain Bun/Node workspace and the Worker can
// import it directly and share a single definition.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isoDate = () => pipe(string(), regex(DATE_RE, 'Expected a YYYY-MM-DD date.'))

// JSON payloads from the scraper carry explicit nulls for absent values, so
// non-required fields are nullish (null | undefined), not just optional.
export const ingestStoreSchema = strictObject({
  slug: pipe(string(), minLength(1), maxLength(64)),
  name: pipe(string(), minLength(1)),
  region: nullish(string()),
  website: nullish(string()),
})

export const ingestItemSchema = strictObject({
  productKey: pipe(string(), minLength(1)),
  name: pipe(string(), minLength(1)),
  brand: nullish(string()),
  unit: nullish(string()),
  category: nullish(string()),
  storeSlug: pipe(string(), minLength(1)),
  price: pipe(number(), integer(), minValue(0)),
  // Issue #367: the strikethrough/original price when the source shows one —
  // what extraction accuracy is measured against. Additive: old payloads
  // (no field) still validate; a NEW payload hitting an OLD Worker fails
  // loudly (strictObject — the Worker-first deploy order exists for this).
  originalPrice: nullish(pipe(number(), integer(), minValue(0))),
  effectiveUnitPrice: nullish(number()),
  // Issue #368 phase A: canonical normalized quantity (qty in the base unit
  // — g/ml/pcs) and the listed price per display unit (per kg / per liter /
  // per piece, rounded integer). Both are derived by the producer's unit
  // parser; null simply means "not normalized", so old scrapers' payloads
  // (fields absent) still validate — additive, Worker-first deploy order
  // holds.
  // valibot 1.5 has no `positive()` action — gtValue(0) is the same "qty > 0".
  unitQty: nullish(pipe(number(), gtValue(0))),
  unitQtyUnit: nullish(picklist(['g', 'ml', 'pcs'])),
  unitPrice: nullish(pipe(number(), integer(), minValue(0))),
  promoType: nullish(string()),
  promoLabel: nullish(string()),
  validFrom: nullish(isoDate()),
  validUntil: nullish(isoDate()),
  // Defaults to the UTC date of scrapedAt so the backfill pass can replay
  // historical observations through the same contract.
  observedDate: nullish(isoDate()),
  matchMethod: nullish(picklist(['exact', 'embedding', 'ai', 'solo'])),
  matchConfidence: pipe(number(), minValue(0), maxValue(1)),
  brochureUrl: nullish(string()),
  // Issue #380: the retailer campaign/listing page the item was extracted
  // from — the same string rejectedItems already emit as `source` (a
  // brochure store's campaign page, a catalog store's listing page), kept
  // alongside the R2-backed brochureUrl so the review card can link the
  // retailer page AND the page image. Additive-nullish (#294 pattern): old
  // payloads (no field) still validate; a NEW payload hitting an OLD Worker
  // fails loudly (strictObject — the Worker-first deploy order exists for
  // this). No backfill: observations predating the field stay null.
  sourceUrl: nullish(pipe(string(), maxLength(500))),
  // Issue #373: the frozen taxonomy version that classified this item's name
  // ("v0.2", …) — stamped on the price_observations row so late taxonomy
  // bumps (v0.3+) can replay-backfill without drift. `category` itself has
  // ridden the schema since day one (null until the classifier publishes
  // one). Additive-nullish (#294 pattern): old payloads (no field) still
  // validate; a NEW payload hitting an OLD Worker fails loudly (strictObject
  // — the Worker-first deploy order exists for this). The cap mirrors
  // sourceUrl's: the value is producer-controlled, and one definition
  // (producer truncation = schema bound) keeps the strict ingest safe.
  taxoVersion: nullish(pipe(string(), maxLength(50))),
})

export const ingestPayloadSchema = strictObject({
  schemaVersion: literal(1),
  scrapedAt: pipe(
    string(),
    regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Expected an ISO 8601 timestamp.')
  ),
  stores: array(ingestStoreSchema),
  items: array(ingestItemSchema),
})

export type IngestPayload = InferOutput<typeof ingestPayloadSchema>
export type IngestStore = InferOutput<typeof ingestStoreSchema>
export type IngestItem = InferOutput<typeof ingestItemSchema>

// Issue #362: one per-item reject the report carries — the monitor's direct
// answer to "which items, why" without ssh (the log keeps the full audit
// trail). source = the OCR page filename, or the campaign/brochure URL for
// catalog batches (the log's 3rd column); name is absent when the raw item
// had no readable name.
// The caps are runtime values (SCRAPE_STORE_SLUGS precedent) because the
// reject strings are unbounded upstream (raw OCR/catalog names, the raw
// price string a price_invalid reason embeds): the producer truncates its
// report copy to exactly what this schema enforces — one definition, no
// drift (thermos A1, PR #364). An over-cap field would 400 the whole
// report at the strict ingest.
export const REJECTED_ITEM_LIMITS = {
  source: 300,
  name: 300,
  reason: 200,
} as const

export const rejectedItemSchema = strictObject({
  source: pipe(string(), maxLength(REJECTED_ITEM_LIMITS.source)),
  name: nullish(pipe(string(), maxLength(REJECTED_ITEM_LIMITS.name))),
  reason: pipe(string(), maxLength(REJECTED_ITEM_LIMITS.reason)),
})

export type RejectedItem = InferOutput<typeof rejectedItemSchema>

// Issue #367 (phase 1): one field disagreement between the primary OCR
// extraction and the shadow re-extraction, frozen at diff time. primary/shadow
// are rendered values ('none' when a side saw no value); the caps are
// exported runtime values (the REJECTED_ITEM_LIMITS pattern) because the
// producer truncates its report copy to exactly what this schema enforces —
// one definition, no drift; an over-cap string would 400 the whole report.
export const AUDIT_DISAGREEMENT_LIMITS = {
  imageFilename: 120,
  field: 120,
  primary: 120,
  shadow: 120,
} as const

/** Max disagreements riding one store's report (the log-free sample). */
export const AUDIT_DISAGREEMENTS_LIMIT = 10

export const auditDisagreementSchema = strictObject({
  imageFilename: pipe(string(), maxLength(AUDIT_DISAGREEMENT_LIMITS.imageFilename)),
  field: pipe(string(), maxLength(AUDIT_DISAGREEMENT_LIMITS.field)),
  primary: pipe(string(), maxLength(AUDIT_DISAGREEMENT_LIMITS.primary)),
  shadow: pipe(string(), maxLength(AUDIT_DISAGREEMENT_LIMITS.shadow)),
})

export type AuditDisagreement = InferOutput<typeof auditDisagreementSchema>

// Issue #367 (phase 1): per-store shadow-OCR agreement metrics. The four
// percentages are 0–100 rounded integers; a zero denominator (nothing
// sampled/matched) reports 100 — vacuous agreement, no observed
// disagreement — with sampledPages carrying the real sample size.
// Additive like rejectedItems above: old scrapers' reports still validate;
// a new scraper's report on an OLD Worker fails loudly (Worker-first).
export const runAuditSchema = strictObject({
  sampledPages: pipe(number(), integer(), minValue(0)),
  nameAgreePct: pipe(number(), integer(), minValue(0), maxValue(100)),
  priceAgreePct: pipe(number(), integer(), minValue(0), maxValue(100)),
  originalAgreePct: pipe(number(), integer(), minValue(0), maxValue(100)),
  promoAgreePct: pipe(number(), integer(), minValue(0), maxValue(100)),
  disagreements: pipe(array(auditDisagreementSchema), maxLength(AUDIT_DISAGREEMENTS_LIMIT)),
})

export type RunAudit = InferOutput<typeof runAuditSchema>

// Issue #373: per-store taxonomy-classification metrics for a run — the
// shadow-mode audit surface (audit week-1), mirroring runAuditSchema above.
// Absent when the RUMAQ_CATEGORY gate is off or the store made no
// classification work. classified counts the distinct names that got a
// category this run (Jev + rules fallback); cacheHits is the name-hash cache
// share of them; fallbackRules counts names the rules head answered (Jev
// unavailable); lowConfidence (<0.5) and disagreements (rules↔Jev) count the
// flags routed to the match-review queue (reason 'taxonomy') — always also
// members of classified, never silent failures. Additive: old scrapers'
// reports (no field) still validate; a new scraper's report on an OLD Worker
// fails loudly (Worker deploys first).
export const runTaxonomySchema = strictObject({
  taxoVersion: pipe(string(), minLength(1), maxLength(50)),
  classified: pipe(number(), integer(), minValue(0)),
  cacheHits: pipe(number(), integer(), minValue(0)),
  fallbackRules: pipe(number(), integer(), minValue(0)),
  lowConfidence: pipe(number(), integer(), minValue(0)),
  disagreements: pipe(number(), integer(), minValue(0)),
})

export type RunTaxonomy = InferOutput<typeof runTaxonomySchema>

// Issue #373: one replay-backfill write — the product key and the frozen
// taxonomy version's classification of its name. Derived layer only: the
// backfill job classifies names it reads from the Worker and writes the
// answers back; it never re-scrapes. The cap mirrors the ingest item's
// taxoVersion (producer and contract ship together — one definition, no
// drift).
export const backfillCategoryItemSchema = strictObject({
  productKey: pipe(string(), minLength(1)),
  category: pipe(string(), minLength(1), maxLength(100)),
})

export type BackfillCategoryItem = InferOutput<typeof backfillCategoryItemSchema>

// The backfill POST's envelope: which taxonomy version produced the answers,
// and the classified products. Bounded (500 items ≤ 2 batch chunks) so one
// request can never spend unbounded D1 budget. Additive-new endpoint: old
// scrapers never call it.
export const backfillCategoriesPayloadSchema = strictObject({
  schemaVersion: literal(1),
  taxoVersion: pipe(string(), minLength(1), maxLength(50)),
  items: pipe(array(backfillCategoryItemSchema), maxLength(500)),
})

export type BackfillCategoriesPayload = InferOutput<typeof backfillCategoriesPayloadSchema>

// Issue #409: per-stage/per-store timing, so the monitor answers "which
// process took long" (a nightly can run ~70 minutes) without journal
// spelunking. Durations are wall-clock milliseconds, rounded integers.
//
// Per-store mapping (recorded where the pipeline structures the work):
//   - fetchMs: source-page discovery (plugin listing incl. browser-rendered
//     fetches) plus novelty classification with its image downloads.
//   - ocrMs: primary OCR model calls plus shadow-audit samples.
//   - uploadMs: R2 brochure page-image PUTs (structurally per-store work in
//     the scrape loop — distinct from the run-level ingest publish below).
//   - sleepMs: rate-limit/retry backoffs and browser-challenge polls waited
//     inside this store's scope — the hidden cost, separated from work time
//     (the sum of the journal's "Sleeping Nms" lines for the store).
//   - totalMs: wall clock around the store's whole run (failure included).
// Match and publish are single global sweeps over all stores' items (one
// matcher pass, one ingest POST), so the per-store entry carries none of
// them — their time lives on the run-level schema below.
//
// Additive: old scrapers' reports (no field) still validate; a new scraper's
// report on an OLD Worker fails loudly (Worker deploys first). Persisted
// today via the per_store JSON blob (price-runs.ts); a dedicated column is
// the future AdminScrape display ticket's concern.
export const runStoreTimingSchema = strictObject({
  fetchMs: pipe(number(), integer(), minValue(0)),
  ocrMs: pipe(number(), integer(), minValue(0)),
  uploadMs: pipe(number(), integer(), minValue(0)),
  sleepMs: pipe(number(), integer(), minValue(0)),
  totalMs: pipe(number(), integer(), minValue(0)),
})

export type RunStoreTiming = InferOutput<typeof runStoreTimingSchema>

// Issue #409: run-level timing. fetchMs/ocrMs/uploadMs are the sums of the
// per-store values (stores run sequentially); matchMs/taxonomyMs/publishMs
// time the global stages the per-store entries cannot carry (the match
// sweep, the taxonomy classification gate, the payload build + ingest POST);
// sleepMs accumulates every wait across all scopes (stores + match +
// taxonomy + publish); totalMs is finishedAt − runStartedAt. Additive like
// the per-store block above.
export const runTimingSchema = strictObject({
  fetchMs: pipe(number(), integer(), minValue(0)),
  ocrMs: pipe(number(), integer(), minValue(0)),
  uploadMs: pipe(number(), integer(), minValue(0)),
  matchMs: pipe(number(), integer(), minValue(0)),
  taxonomyMs: pipe(number(), integer(), minValue(0)),
  publishMs: pipe(number(), integer(), minValue(0)),
  sleepMs: pipe(number(), integer(), minValue(0)),
  totalMs: pipe(number(), integer(), minValue(0)),
})

export type RunTiming = InferOutput<typeof runTimingSchema>

// Run report (haqita-integration.md §7.1): the scraper reports each live run
// to the backend so the admin scraping monitor can show run history without
// reading journald. One POST per finished run — including failed runs, which
// are exactly the ones the monitor exists to surface. Reporting failures are
// swallowed by the scraper; this schema must therefore stay additive.
export const runReportStoreSchema = strictObject({
  pagesFound: pipe(number(), integer(), minValue(0)),
  newImages: pipe(number(), integer(), minValue(0)),
  existingImages: pipe(number(), integer(), minValue(0)),
  skipped: pipe(number(), integer(), minValue(0)),
  itemsExtracted: pipe(number(), integer(), minValue(0)),
  itemsRejected: pipe(number(), integer(), minValue(0)),
  error: nullish(string()),
  // By-design skip (§2): a Tier-2 store the browser tier cannot reach while
  // its per-store proxy env var is unset — expected, not a nightly failure.
  needsProxy: nullish(boolean()),
  // Issue #322 (A4): non-fatal anomalies a store ride through a cycle —
  // e.g. a zero-card campaign (a scheduled/teaser page) or a brochure page
  // without a usable pdfUrl — recorded with their URL so the anomaly is
  // visible on the monitor without discarding the healthy items. Additive:
  // old scrapers' reports (no field) still validate.
  warnings: nullish(array(pipe(string(), maxLength(500)))),
  // Issue #347: the ordered model-chain rungs this store actually OCR'd
  // with — the quality-drift audit trail when the chain advances mid-run.
  // Absent when the store made no successful OCR call. Additive: old
  // scrapers' reports (no field) still validate.
  modelsUsed: nullish(array(pipe(string(), maxLength(100)))),
  // Issue #362: the first 10 rejects with their reasons, mirroring
  // rejected-items.log so the monitor answers "which items, why" directly.
  // itemsRejected (above) keeps the true count when the list is truncated.
  // Additive: old scrapers' reports (no field) still validate; a new
  // scraper's report on an OLD Worker fails loudly (Worker deploys first).
  rejectedItems: nullish(array(rejectedItemSchema)),
  // Issue #367: shadow-OCR agreement metrics for the sampled fresh pages —
  // the dual-rung diff's monitor surface (phase 1). Absent when the audit
  // gate is off or nothing was sampled. Additive: old scrapers' reports (no
  // field) still validate; a new scraper's report on an OLD Worker fails
  // loudly (Worker deploys first).
  audit: nullish(runAuditSchema),
  // Issue #373: taxonomy-classification metrics for this store's items —
  // the RUMAQ_CATEGORY shadow-mode audit surface. Absent when the gate is
  // off or the store had no items. Same additive contract as audit above.
  taxonomy: nullish(runTaxonomySchema),
  // Issue #409: per-stage timing for this store (fetchMs / ocrMs / uploadMs
  // / sleepMs / totalMs — the mapping comment on runStoreTimingSchema).
  // Absent from reports produced before the field existed. Additive: old
  // scrapers' reports (no field) still validate; a new scraper's report on
  // an OLD Worker fails loudly (Worker deploys first).
  timing: nullish(runStoreTimingSchema),
})

// One flagged candidate pair the matcher reports for the admin review queue
// (issue #294): A = the incoming item being matched, B = the catalog entry's
// last sighting, both frozen at flag time. The run envelope owns
// runStartedAt — pairs carry none, so the report replay key stays single.
export const reviewItemPairSchema = strictObject({
  itemProductKey: pipe(string(), minLength(1)),
  itemName: pipe(string(), minLength(1)),
  itemBrand: nullish(string()),
  itemUnit: nullish(string()),
  itemPrice: pipe(number(), integer(), minValue(0)),
  itemEffectiveUnitPrice: nullish(number()),
  itemStore: pipe(string(), minLength(1)),
  // Issue #380: the LEFT side's evidence — the page image URL (the R2-backed
  // same-origin object URL per OCR'd image, the same value the observation's
  // brochure_url stores; catalog items have no page image) and the retailer
  // campaign/listing page the item was extracted from. Both are additive-
  // nullish (#294 pattern): pairs frozen before the field exist do not carry
  // it (no backfill — old rows stay null), and a NEW report hitting an OLD
  // Worker fails loudly (Worker-first deploy order).
  itemBrochureUrl: nullish(pipe(string(), maxLength(500))),
  itemSourceUrl: nullish(pipe(string(), maxLength(500))),
  entryProductKey: pipe(string(), minLength(1)),
  entryName: pipe(string(), minLength(1)),
  entryBrand: nullish(string()),
  entryUnit: nullish(string()),
  entryPrice: pipe(number(), integer(), minValue(0)),
  entryEffectiveUnitPrice: nullish(number()),
  entryStore: pipe(string(), minLength(1)),
  matchMethod: picklist(['exact', 'embedding', 'ai']),
  confidence: pipe(number(), minValue(0), maxValue(1)),
  // Issue #373: 'taxonomy' flags a classification, not a match — the item and
  // entry sides reference the SAME catalog product (a self-pair), and the
  // confidence is the Jev classification confidence. Low-confidence (<0.5)
  // and rules↔Jev disagreement land here so a classification is never
  // silently wrong (the match queue is the existing human-review channel).
  // Additive: old scrapers' reports still validate; a new scraper's report
  // hitting an OLD Worker fails loudly (Worker-first deploy order).
  reason: picklist(['price_ratio', 'verifier_unresolved', 'taxonomy']),
})

export type ReviewItemPair = InferOutput<typeof reviewItemPairSchema>

export const runReportSchema = strictObject({
  schemaVersion: literal(1),
  // Stable identity for the run (its scrapedAt) — replay-safe upsert key.
  runStartedAt: pipe(
    string(),
    regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Expected an ISO 8601 timestamp.')
  ),
  finishedAt: pipe(
    string(),
    regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Expected an ISO 8601 timestamp.')
  ),
  // 0 ok / 1 failure / 2 quota — same codes as the process exit.
  exitCode: picklist([0, 1, 2]),
  status: picklist(['success', 'failed']),
  // Where the run got to — the monitor's first answer to "why did it fail".
  stage: picklist(['scrape', 'match', 'publish', 'done']),
  perStore: record(string(), runReportStoreSchema),
  match: nullish(
    strictObject({
      exact: pipe(number(), integer(), minValue(0)),
      embedding: pipe(number(), integer(), minValue(0)),
      ai: pipe(number(), integer(), minValue(0)),
      solo: pipe(number(), integer(), minValue(0)),
      reviewItems: pipe(number(), integer(), minValue(0)),
      embeddingsDegraded: boolean(),
      // Issue #294: the flagged pairs themselves (capped at 200 per run by
      // the publisher). All three are nullish so old scrapers' reports —
      // which predate them — still validate; a NEW scraper's report with
      // these fields hitting an OLD Worker fails loudly instead (the
      // deploy order is Worker-first for exactly this reason).
      // reviewItems (above) keeps meaning "pre-slice total", so the monitor
      // number is unaffected by the cap; reviewItemsTotal is kept as an
      // explicit field to make the truncation arithmetic self-describing.
      // The cap is a checked boundary here, not just a producer convention:
      // the Worker rejects an over-cap array instead of letting
      // recordReviewItems spend unbounded D1 batches on one request.
      reviewItemPairs: nullish(pipe(array(reviewItemPairSchema), maxLength(200))),
      reviewItemsTotal: nullish(pipe(number(), integer(), minValue(0))),
      reviewItemsTruncated: nullish(boolean()),
    })
  ),
  publish: nullish(
    strictObject({
      mode: picklist(['dry-run', 'published']),
      accepted: nullish(pipe(number(), integer(), minValue(0))),
      skipped: nullish(pipe(number(), integer(), minValue(0))),
      error: nullish(string()),
    })
  ),
  // Issue #409: run-level timing (runTimingSchema) — the global match/
  // taxonomy/publish stage times plus the per-stage totals the monitor
  // sorts by to answer "which process took long". Absent from reports
  // produced before the field existed. Additive like perStore timing above;
  // persistence beyond the validated payload is the AdminScrape display
  // ticket's concern.
  timing: nullish(runTimingSchema),
  error: nullish(pipe(string(), maxLength(2000))),
})

export type RunReport = InferOutput<typeof runReportSchema>
export type RunReportStore = InferOutput<typeof runReportStoreSchema>

// Scrape Now (docs/plan/scrape-now.md): admin-triggered, store-selectable
// scraping. The admin UI queues a command; the VPS agent claims it over the
// bearer channel, streams the run's output lines back as events, and posts a
// terminal finish. Shared by the Worker (request validation) and the agent
// (defense-in-depth re-validation of claimed slugs). Additive only.

export const SCRAPE_STORE_SLUGS = [
  'superindo',
  'lotte-mart',
  'astro',
  'hypermart',
  'indomaret',
  'alfamart',
  'tip-top',
  'hari-hari',
  'yogya',
] as const

export const scrapeCommandCreateSchema = strictObject({
  stores: pipe(array(picklist(SCRAPE_STORE_SLUGS)), minLength(1)),
})

export const scrapeEventSchema = strictObject({
  // Agent-assigned, monotonic per command — the (command_id, seq) upsert key.
  seq: pipe(number(), integer(), minValue(0)),
  ts: pipe(
    string(),
    regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Expected an ISO 8601 timestamp.')
  ),
  level: picklist(['info', 'error']),
  // Raw scraper output line — an empty line is still a line the admin saw.
  message: pipe(string(), maxLength(8000)),
})

export const scrapeEventsPostSchema = strictObject({
  events: pipe(array(scrapeEventSchema), minLength(1), maxLength(100)),
})

export const scrapeFinishSchema = strictObject({
  status: picklist(['success', 'failed']),
  exitCode: picklist([0, 1, 2]),
  error: nullish(pipe(string(), maxLength(2000))),
  logTruncated: nullish(boolean()),
})

export type ScrapeEvent = InferOutput<typeof scrapeEventSchema>
