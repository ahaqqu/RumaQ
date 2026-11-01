import {
  array,
  boolean,
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
  effectiveUnitPrice: nullish(number()),
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
export const rejectedItemSchema = strictObject({
  source: pipe(string(), maxLength(300)),
  name: nullish(pipe(string(), maxLength(300))),
  reason: pipe(string(), maxLength(200)),
})

export type RejectedItem = InferOutput<typeof rejectedItemSchema>

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
  entryProductKey: pipe(string(), minLength(1)),
  entryName: pipe(string(), minLength(1)),
  entryBrand: nullish(string()),
  entryUnit: nullish(string()),
  entryPrice: pipe(number(), integer(), minValue(0)),
  entryEffectiveUnitPrice: nullish(number()),
  entryStore: pipe(string(), minLength(1)),
  matchMethod: picklist(['exact', 'embedding', 'ai']),
  confidence: pipe(number(), minValue(0), maxValue(1)),
  reason: picklist(['price_ratio', 'verifier_unresolved']),
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
