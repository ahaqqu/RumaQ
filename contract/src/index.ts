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
  // By-design skip (§2): a Tier-2 store the browser tier cannot reach while
  // its per-store proxy env var is unset — expected, not a nightly failure.
  needsProxy: nullish(boolean()),
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

// Scrape Now (docs/plan/scrape-now.md): admin-triggered, store-selectable
// scraping. The admin UI queues a command; the VPS agent claims it over the
// bearer channel, streams the run's output lines back as events, and posts a
// terminal finish. Shared by the Worker (validation + responses) and the
// agent (defense-in-depth re-validation of claimed slugs). Additive only.

export const SCRAPE_STORE_SLUGS = ['superindo', 'lotte-mart', 'astro'] as const

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

// Admin response schemas (the typed OpenAPI codegen depends on them).
export const scrapeCommandSchema = strictObject({
  id: string(),
  stores: array(string()),
  status: picklist(['pending', 'running', 'success', 'failed']),
  createdBy: string(),
  createdAt: string(),
  pickedUpAt: nullish(string()),
  finishedAt: nullish(string()),
  exitCode: nullish(pipe(number(), integer())),
  error: nullish(string()),
  logTruncated: boolean(),
})

export const scrapeCommandsFeedSchema = strictObject({
  commands: array(scrapeCommandSchema),
})

export const scrapeEventsFeedSchema = strictObject({
  events: array(scrapeEventSchema),
  // True when the agent's ring buffer dropped the head of the log before it
  // could be posted — the admin view is a tail, not the whole run.
  truncated: boolean(),
})

export const scrapeStoresSchema = strictObject({
  stores: array(string()),
})

export type ScrapeCommand = InferOutput<typeof scrapeCommandSchema>
export type ScrapeCommandsFeed = InferOutput<typeof scrapeCommandsFeedSchema>
export type ScrapeEventsFeed = InferOutput<typeof scrapeEventsFeedSchema>
