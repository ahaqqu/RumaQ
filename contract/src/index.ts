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
  safeParse,
  strictObject,
  string,
  union,
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

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const isoTimestamp = () => pipe(string(), regex(TIMESTAMP_RE, 'Expected an ISO 8601 timestamp.'))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const uuid = () => pipe(string(), regex(UUID_RE, 'Expected a UUID.'))

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
  // Issue #627 (part 1): the member/app price when the retailer prints one
  // separately from the shelf price. `price` stays the shelf price; this is
  // the price a (free-to-join) member actually pays, so readers use it as the
  // payable/comparison price WHEN IT IS LOWER — never above the shelf/promo
  // basis (a member premium must not raise the price). Additive-nullish
  // (#294 pattern): old payloads (no field) still validate; a NEW payload
  // hitting an OLD Worker fails loudly (strictObject — the Worker-first
  // deploy order exists for this). No backfill: observations predating the
  // field stay null. Member-only tiles (only the member price printed) are a
  // part-2 representation decision: `price` stays required in v1, so a
  // producer with no shelf price maps the member price into `price` until
  // then.
  memberPrice: nullish(pipe(number(), integer(), minValue(0))),
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

// ---------------------------------------------------------------------------
// Pipeline contract v2 — canonical ownership boundary.
//
// The pipeline sends raw observations; RumaQ owns the canonical product,
// status, and approved aliases. This section is additive until the backend
// and scraper switch to it together; the v1 schemas above remain the live
// ingest shape during that transition.
// ---------------------------------------------------------------------------

export const PIPELINE_CONTRACT_VERSION = 2 as const

const rawText = (max: number) => pipe(string(), minLength(1), maxLength(max))

export const ingestItemV2Schema = strictObject({
  productKey: rawText(300),
  rawName: rawText(500),
  rawBrand: nullish(pipe(string(), maxLength(200))),
  rawUnit: nullish(pipe(string(), maxLength(200))),
  category: nullish(pipe(string(), maxLength(50))),
  taxoVersion: nullish(pipe(string(), maxLength(50))),
  storeSlug: rawText(100),
  price: pipe(number(), integer(), minValue(0)),
  // Issue #627 (part 1): the member/app price when the retailer prints one
  // separately from the shelf price `price` — the price a (free-to-join)
  // member actually pays, used when lower (never above the shelf/promo
  // basis). Additive-nullish (#294 pattern), Worker-first: old payloads (no
  // field) still validate; a NEW payload hitting an OLD Worker fails loudly
  // (strictObject). No backfill — observations predating the field stay null.
  // Member-only tiles are a part-2 representation decision: `price` stays
  // required in v1 (a lone member price maps into `price` until then).
  memberPrice: nullish(pipe(number(), integer(), minValue(0))),
  originalPrice: nullish(pipe(number(), integer(), minValue(0))),
  effectiveUnitPrice: nullish(number()),
  unitQty: nullish(pipe(number(), gtValue(0))),
  unitQtyUnit: nullish(picklist(['g', 'ml', 'pcs'])),
  unitPrice: nullish(pipe(number(), integer(), minValue(0))),
  promoType: nullish(pipe(string(), maxLength(100))),
  promoLabel: nullish(pipe(string(), maxLength(200))),
  validFrom: nullish(isoDate()),
  validUntil: nullish(isoDate()),
  observedDate: nullish(isoDate()),
  matchMethod: nullish(picklist(['exact', 'embedding', 'ai', 'solo'])),
  matchConfidence: pipe(number(), minValue(0), maxValue(1)),
  brochureUrl: nullish(pipe(string(), maxLength(500))),
  sourceUrl: nullish(pipe(string(), maxLength(500))),
  page: nullish(pipe(number(), integer(), minValue(0))),
  ocrModel: nullish(pipe(string(), maxLength(100))),
})

export const ingestPayloadV2Schema = strictObject({
  schemaVersion: literal(PIPELINE_CONTRACT_VERSION),
  scrapedAt: isoTimestamp(),
  stores: array(ingestStoreSchema),
  items: array(ingestItemV2Schema),
})

export type IngestItemV2 = InferOutput<typeof ingestItemV2Schema>
export type IngestPayloadV2 = InferOutput<typeof ingestPayloadV2Schema>

export const productSizeSchema = strictObject({
  quantity: nullish(pipe(number(), gtValue(0))),
  unit: nullish(picklist(['g', 'ml', 'pcs'])),
  packCount: nullish(pipe(number(), integer(), minValue(1))),
  totalQuantity: nullish(pipe(number(), gtValue(0))),
  packaging: nullish(pipe(string(), maxLength(100))),
  quantityMin: nullish(pipe(number(), gtValue(0))),
  quantityMax: nullish(pipe(number(), gtValue(0))),
})

export const approvedAliasSchema = strictObject({
  name: rawText(500),
  storeSlug: rawText(100),
  firstSeenAt: isoTimestamp(),
  lastSeenAt: isoTimestamp(),
  source: picklist(['ocr', 'catalog', 'admin']),
})

export const canonicalProductSchema = strictObject({
  id: uuid(),
  productKey: rawText(300),
  canonicalName: rawText(500),
  brand: nullish(pipe(string(), maxLength(200))),
  productType: nullish(pipe(string(), maxLength(100))),
  variant: nullish(pipe(string(), maxLength(200))),
  size: nullish(productSizeSchema),
  description: nullish(pipe(string(), maxLength(1000))),
  category: nullish(pipe(string(), maxLength(50))),
  categoryVersion: nullish(pipe(string(), maxLength(50))),
  status: picklist(['canonical', 'provisional', 'needs_review']),
  metadataVersion: pipe(number(), integer(), minValue(1)),
  firstSeenAt: isoTimestamp(),
  lastSeenAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
  aliases: array(approvedAliasSchema),
})

export const canonicalIndexSchema = strictObject({
  schemaVersion: literal(PIPELINE_CONTRACT_VERSION),
  indexVersion: pipe(number(), integer(), minValue(0)),
  generatedAt: isoTimestamp(),
  products: array(canonicalProductSchema),
})

export const ingestReceiptProductSchema = strictObject({
  productKey: rawText(300),
  productId: uuid(),
  status: picklist(['created', 'existing']),
})

export const ingestReceiptSchema = strictObject({
  schemaVersion: literal(PIPELINE_CONTRACT_VERSION),
  scrapedAt: isoTimestamp(),
  indexVersion: pipe(number(), integer(), minValue(0)),
  accepted: pipe(number(), integer(), minValue(0)),
  skipped: literal(0),
  productsCreated: pipe(number(), integer(), minValue(0)),
  observationsUpserted: pipe(number(), integer(), minValue(0)),
  products: array(ingestReceiptProductSchema),
})

export const apiErrorIssueSchema = strictObject({
  path: array(union([string(), number()])),
  message: pipe(string(), minLength(1)),
})

export const apiErrorSchema = strictObject({
  error: pipe(string(), minLength(1)),
  issues: nullish(array(apiErrorIssueSchema)),
})

export type ProductSize = InferOutput<typeof productSizeSchema>
export type ApprovedAlias = InferOutput<typeof approvedAliasSchema>
export type CanonicalProduct = InferOutput<typeof canonicalProductSchema>
export type CanonicalIndex = InferOutput<typeof canonicalIndexSchema>
export type IngestReceiptProduct = InferOutput<typeof ingestReceiptProductSchema>
export type IngestReceipt = InferOutput<typeof ingestReceiptSchema>
export type ApiErrorIssue = InferOutput<typeof apiErrorIssueSchema>
export type ApiError = InferOutput<typeof apiErrorSchema>

/**
 * Semantic validation shared by both sides of the v2 boundary: the schema
 * checks shape, and this helper checks that every item references a store
 * declared in the payload. The backend and the scraper both call it before
 * writing or sending, so an undeclared store cannot be silently skipped.
 */
export function validateIngestV2(
  input: unknown
): { success: true; output: IngestPayloadV2 } | { success: false; issues: ApiErrorIssue[] } {
  const parsed = safeParse(ingestPayloadV2Schema, input)
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.issues.map((issue) => ({
        path: (issue.path ?? []).map((item) =>
          typeof item.key === 'number' ? item.key : String(item.key)
        ),
        message: issue.message,
      })),
    }
  }
  const stores = new Set(parsed.output.stores.map((store) => store.slug))
  const issues: ApiErrorIssue[] = []
  parsed.output.items.forEach((item, index) => {
    if (!stores.has(item.storeSlug)) {
      issues.push({
        path: ['items', index, 'storeSlug'],
        message: `Store '${item.storeSlug}' is not declared in stores.`,
      })
    }
  })
  return issues.length > 0 ? { success: false, issues } : { success: true, output: parsed.output }
}

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

// Issue #463: the bounded product summary of a v2 publish receipt — counts
// only (how many product keys the backend created vs. already had), never the
// productKey → UUID map. The map stays on the pipeline's local receipt; the
// monitor needs the shape of the outcome, not the identities.
export const runProductsSummarySchema = strictObject({
  created: pipe(number(), integer(), minValue(0)),
  existing: pipe(number(), integer(), minValue(0)),
})

export type RunProductsSummary = InferOutput<typeof runProductsSummarySchema>

// Issue #537: run cost and per-store failure as FIRST-CLASS TYPED fields.
//
// Before this block the report carried no AI spend at all and a store failure
// only as free text inside `error` ("Store failure(s): lotte-mart:
// BrowserTierRequired: …"), so a consumer had to grep a human sentence. The
// two consumers that motivated the change: RumaQ #542 (the admin run-view chip
// keys off a typed field) and RumaQ-pipeline #75 (a blocked store must not fail
// a night where the other seven published).
//
// Every block below is ADDITIVE: reports posted before the fields existed
// still validate (their absence is `null`/`undefined`), a NEW report hitting an
// OLD Worker fails loudly (strictObject — the Worker-first deploy order exists
// for exactly this), and the run report's `schemaVersion` stays 1 because the
// change is additive (see the versioning note above `runReportSchema`).

/**
 * One AI stage's metered spend for a run (issue #537). The provider's own
 * numbers: `tokensIn`/`tokensOut` from the reply's usage block and `cost` from
 * the provider-computed USD figure (the producer rounds to 6 dp — OpenRouter
 * prices are fractions of a cent, so a sub-cent night must not round to 0).
 *
 * `calls` counts BILLABLE replies (a call the provider answered and charged
 * for), not attempts: an attempt that never reached a billable response
 * (429/5xx/transport) costs nothing and is counted only in that stage's own
 * telemetry. `costMissing` counts the billable replies whose response carried
 * no `cost`, so a reported total is never silently incomplete — `cost` and
 * `costMissing` together are the honest spend, never a fabricated 0.
 */
export const runAiUsageStageSchema = strictObject({
  calls: pipe(number(), integer(), minValue(0)),
  tokensIn: pipe(number(), integer(), minValue(0)),
  tokensOut: pipe(number(), integer(), minValue(0)),
  cost: pipe(number(), minValue(0)),
  costMissing: pipe(number(), integer(), minValue(0)),
})

export type RunAiUsageStage = InferOutput<typeof runAiUsageStageSchema>

/**
 * The run's per-stage AI spend (issue #537). Three stages were metered into
 * the pipeline's private status.json all along (`ocr`, `verifier`,
 * `embedding`); `decision` is the taxonomy classifier, which records every
 * product name in every run and whose spend was invisible until now (a
 * ~1,412-call / ~$0.06 night had no surface anywhere).
 *
 * All four stages are REQUIRED inside a present `ai.usage` — the pipeline
 * builds them from one accumulator (`emptyAiUsage()`), so a report can never
 * legitimately carry three. `decision` is additive at the block level: an old
 * report simply has no `ai` object at all, which is why `ai` itself is
 * nullish.
 */
export const runAiUsageSchema = strictObject({
  ocr: runAiUsageStageSchema,
  verifier: runAiUsageStageSchema,
  embedding: runAiUsageStageSchema,
  decision: runAiUsageStageSchema,
})

export type RunAiUsage = InferOutput<typeof runAiUsageSchema>

/**
 * The verifier prompt that produced a run's decisions (pipeline #83). The
 * verifier prompt now has materially different versions — v1 split
 * objectively-identical products on large price gaps, v2 carries the
 * instruction that stops it — and before this field the run report recorded
 * nothing about which prompt answered, so a prompt edit was invisible in the
 * data (the only trace was the commit, and commits are not joined to rows).
 *
 * - `id` mirrors the pipeline bench's prompt identity
 *   (`ocr.verifier.ai_prompt_template`). It is producer-controlled on the
 *   ingest endpoint, so it is capped like the other report strings.
 * - `version` is the integer the ticket asks for. `>= 1`, so 0 can never be
 *   mistaken for "absent" (absence is the whole field being absent/null).
 * - `sha256` is the template's digest as 64 LOWERCASE hex characters — the
 *   pipeline strips its `sha256:` display prefix and sends bare hex.
 *
 * `strictObject` makes a typo'd key fail at ingest instead of silently
 * dropping the identity (the run report is strict all the way down).
 */
export const runVerifierPromptSchema = strictObject({
  version: pipe(number(), integer(), minValue(1)),
  id: pipe(string(), minLength(1), maxLength(200)),
  sha256: pipe(string(), regex(/^[0-9a-f]{64}$/, 'Expected 64 lowercase hex characters.')),
})

export type RunVerifierPrompt = InferOutput<typeof runVerifierPromptSchema>

/**
 * The report's AI block (issue #537, extended by pipeline #83): `usage` is the
 * per-stage metering, and `verifierPrompt` is the identity of the prompt that
 * produced the run's verifier decisions. The effective generation config
 * (models, temperature, seed) and the credential preflight stay
 * pipeline-private in status.json — only the two facts the monitor needs ride
 * the contract.
 *
 * `verifierPrompt` is ADDITIVE-NULLISH (#294 pattern): old scrapers post an
 * `ai` block without it (and the current producer does not send it yet), so
 * its absence stays valid; a NEW report hitting an OLD Worker fails loudly
 * (strictObject — the Worker-first deploy order exists for exactly this).
 */
export const runAiSchema = strictObject({
  usage: runAiUsageSchema,
  verifierPrompt: nullish(runVerifierPromptSchema),
})

export type RunAi = InferOutput<typeof runAiSchema>

/**
 * The closed vocabulary of per-store run outcomes (issue #537), named after
 * what production actually emits — not a general taxonomy:
 *
 * - `fetch_timed_out` — the store's whole scrape leg exceeded
 *   `STORE_FETCH_TIMEOUT_MS`; it was aborted and skipped (pipeline #54). The
 *   producer's status.json calls this class `fetch timed out`; the report's
 *   code is the snake_case form.
 * - `deadline` — `RUN_DEADLINE_MS` was reached before the store started, or
 *   while its leg was in flight; fetching stopped, matching/publishing ran on
 *   what was staged (pipeline #54).
 * - `blocked` — the store answered a bot challenge (Imperva Incapsula on
 *   lotte-mart, a Trend Micro/F5 interstitial on the plain tier) that the
 *   fetch ladder could not clear, with or without the per-store Tier-3 proxy
 *   (pipeline #75). A blocked store is a REPORTED outcome, not a run failure;
 *   `blocked: true` marks it.
 * - `ocr_failed` — the store's OCR leg raised: a page failed to OCR or the
 *   whole vision chain died under it.
 * - `embedding_unavailable` — the match stage aborted because embeddings were
 *   unavailable (a spent quota carries `exitCode: 2` and an `embedding_quota:`
 *   message prefix; the enum has no separate quota code).
 * - `publish_failed` — the run died in the publish stage (payload build,
 *   producer-side contract check, or the ingest POST), so nothing was
 *   published.
 * - `other` — a store/run failure outside the classes above; the human
 *   `message` is the discriminator until a class is worth naming.
 */
export const RUN_FAILURE_CODES = [
  'fetch_timed_out',
  'deadline',
  'blocked',
  'ocr_failed',
  'embedding_unavailable',
  'publish_failed',
  'other',
] as const

export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number]

/**
 * Caps the producer truncates its report copy to (the REJECTED_ITEM_LIMITS
 * precedent: one definition, no drift). `message` is producer-controlled and
 * unbounded upstream (a nested error string), so an untruncated copy would
 * 400 the WHOLE report at the strict ingest — the monitor would then see
 * nothing. `store` mirrors the ingest item's storeSlug cap; there is no
 * minLength on `message` for the same reason (an empty human string must
 * never cost the run's report).
 */
export const RUN_FAILURE_LIMITS = {
  store: 100,
  message: 500,
} as const

/**
 * Max entries in the report's run-level `failures` summary: one per store in
 * the 9-store universe plus one run-level entry (a store-less embedding or
 * publish abort). A checked boundary, not just a convention — the Worker
 * rejects an over-cap array rather than spending D1 batches on one request.
 */
export const RUN_FAILURES_LIMIT = 16

/**
 * One typed failure on the run report (issue #537) — the machine-readable
 * counterpart of the free-text `error`, which stays (the journal and the
 * monitor's human line still read it).
 *
 * `store` is always set on a per-store failure (and repeats the `perStore`
 * key, so a mirrored entry stays self-describing); it is `null` only on the
 * run-level summary's store-less entry — an `embedding_unavailable` abort
 * happens in one global match sweep and a `publish_failed` in one global
 * POST, so no single store owns either.
 *
 * `blocked` is the run's verdict, not a second spelling of the code: `true`
 * means the outcome is an expected external block that must NOT fail the run
 * (it is reported as a per-store outcome instead, pipeline #75). A consumer
 * may render "skipped, blocked" from this flag without re-deriving the
 * policy from the code list — and a future code that is non-fatal can set it
 * without changing every consumer.
 */
export const runFailureSchema = strictObject({
  store: nullish(pipe(string(), minLength(1), maxLength(RUN_FAILURE_LIMITS.store))),
  code: picklist(RUN_FAILURE_CODES),
  message: pipe(string(), maxLength(RUN_FAILURE_LIMITS.message)),
  blocked: nullish(boolean()),
})

export type RunFailure = InferOutput<typeof runFailureSchema>

// Run report (haqita-integration.md §7.1): the scraper reports each live run
// to the backend so the admin scraping monitor can show run history without
// reading journald. One POST per finished run — including failed runs, which
// are exactly the ones the monitor exists to surface. Reporting failures are
// swallowed by the scraper; this schema must therefore stay additive.
//
// Versioning (docs/plan/pipeline-contract.md §8.4): `schemaVersion` stays 1
// for additive fields — an old scraper's report must keep validating while the
// Worker deploys first, and bumping the literal would reject every report from
// a box that has not re-synced yet. Only a change that RENAMES or REMOVES
// something bumps it to 2. The contract PACKAGE version marks the additive
// revision instead (0.2.0 for pipeline contract v2, 0.3.0 for issue #537,
// 0.4.0 for pipeline #83); the pipeline pins the exact bytes by SHA
// (CONTRACT_SOURCE_SHA).
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
  // Issue #463: matches this store made against a canonical-index product the
  // backend still holds provisionally (not yet promoted to canonical) — the
  // monitor's measure of how much of a run's matching rides provisional
  // identities. Additive-nullish like the blocks above: absent on reports from
  // before the field existed.
  provisionalMatches: nullish(pipe(number(), integer(), minValue(0))),
  // Issue #537: this store's typed failure — the machine-readable form of the
  // `error` sentence above (which stays: humans and journald read it). Absent
  // when the store rode the run clean. `store` repeats this map key. A blocked
  // store carries `{ code: 'blocked', blocked: true }` and does NOT fail the
  // run when other stores published (pipeline #75). Additive-nullish (#294
  // pattern): old scrapers' reports still validate; a new scraper's report on
  // an OLD Worker fails loudly (Worker-first).
  failure: nullish(runFailureSchema),
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
      // Issue #418: AI-verifier resilience telemetry — the monitor sees a
      // degraded verifier (quota / budget / circuit breaker) instead of
      // inferring it from a flagged-pairs spike. All additive-nullish
      // (#294 pattern): old scrapers' reports still validate; a NEW
      // scraper's report on an OLD Worker fails loudly (Worker-first
      // deploy order). Pairs/calls/errors are counts over the verifier
      // stage of one run; the three booleans are the degradation state.
      // - verifierPairs: borderline pairs the verifier was asked about.
      // - verifierCalls: generateContent calls actually made (retries
      //   included) — the quota spend, and the evidence a call budget
      //   bound the stage.
      // - verifierSaturationErrors: 503 UNAVAILABLE responses seen across
      //   all attempts — the storm metric from the 2026-11-04 incident.
      // - verifierQuotaExhausted: the whole model chain hit daily quota.
      // - verifierBreakerTripped: N consecutive failed pairs skipped the
      //   remaining sweep (degraded to flagged-for-review, never guessed).
      // - verifierBudgetExhausted: the per-run call or wall-clock budget
      //   stopped the sweep early (same degrade path).
      verifierPairs: nullish(pipe(number(), integer(), minValue(0))),
      verifierCalls: nullish(pipe(number(), integer(), minValue(0))),
      verifierSaturationErrors: nullish(pipe(number(), integer(), minValue(0))),
      verifierQuotaExhausted: nullish(boolean()),
      verifierBreakerTripped: nullish(boolean()),
      verifierBudgetExhausted: nullish(boolean()),
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
  // Issue #463: the v2 publish receipt's canonical index version — the
  // receipt (not the payload) is the source of truth for what the backend
  // accepted, so the monitor shows which index the run published at. Nullish
  // (not optional-only) like the other additive fields: old scrapers' reports
  // without it still validate, a new scraper's report on an OLD Worker fails
  // loudly (Worker-first deploy order), and a dry-run/never-published run
  // legitimately carries none. schemaVersion stays 1 — additive, optional.
  indexVersion: nullish(pipe(number(), integer(), minValue(0))),
  // Issue #463: the bounded product summary of that receipt — created vs.
  // already-existing product keys, counts only. The productKey → UUID map
  // stays on the pipeline's local receipt: the monitor needs the shape of
  // the outcome, not the identities.
  products: nullish(runProductsSummarySchema),
  // Issue #409: run-level timing (runTimingSchema) — the global match/
  // taxonomy/publish stage times plus the per-stage totals the monitor
  // sorts by to answer "which process took long". Absent from reports
  // produced before the field existed. Additive like perStore timing above;
  // persistence beyond the validated payload is the AdminScrape display
  // ticket's concern.
  timing: nullish(runTimingSchema),
  // Issue #537: what this run's AI cost, per stage — the same numbers the
  // pipeline has always written to its private status.json, now on the report
  // the backend stores. `ai.usage.decision` is the taxonomy classifier's
  // spend, the stage that had no metering at all. Additive-nullish (#294
  // pattern): old scrapers post no `ai` block and still validate; a new
  // scraper's report on an OLD Worker fails loudly (Worker-first).
  // Pipeline #83: `ai.verifierPrompt` (also nullish) names the verifier
  // prompt that produced the run's decisions — the version + sha256 the bench
  // already computes, so a prompt edit is visible in run history instead of
  // only in git.
  ai: nullish(runAiSchema),
  // Issue #537: the run-level failure summary — every per-store `failure`
  // mirrored here (so "which stores failed, and how" is one array walk, not a
  // perStore sweep) PLUS the store-less entries a run-level abort owns
  // (`embedding_unavailable`, `publish_failed`; `store: null`). Empty/absent
  // on a clean run. The per-store copy stays authoritative for that store;
  // this is the summary a monitor banner reads. Cap: RUN_FAILURES_LIMIT —
  // 9 stores max + 1 run-level entry fits with room, and the Worker rejects
  // an over-cap array instead of spending D1 budget on one request.
  failures: nullish(pipe(array(runFailureSchema), maxLength(RUN_FAILURES_LIMIT))),
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
