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
})

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
