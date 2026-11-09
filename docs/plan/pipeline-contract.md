# Pipeline ↔ RumaQ Contract v2

> Status: **proposed; owner decisions recorded 2026-11-05.** This document defines the
> boundary between `ahaqqu/RumaQ` (public backend + admin) and `ahaqqu/RumaQ-pipeline`
> (scraper). `contract/src/index.ts` is the executable schema; this document is the
> semantic contract.
>
> Product-level explanation: [PRODUCT_METADATA.md](../PRODUCT_METADATA.md).
>
> Related: `ahaqqu/RumaQ-pipeline#21` (identity/naming), `ahaqqu/RumaQ#423` (admin
> rename), `ahaqqu/RumaQ-pipeline#22` (Jev benchmark), and
> `ahaqqu/RumaQ-pipeline/docs/plan/product-metadata.md` (metadata target).

## 1. Decisions

| Decision             | Choice                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Canonical owner      | RumaQ backend owns IDs, canonical metadata, status, and approved aliases                         |
| Pipeline role        | Raw observations + category proposals + candidate aliases; never canonical writes                |
| Contract home        | `contract/` in RumaQ; pipeline vendors a pinned SHA                                              |
| Enforcement          | Shared Valibot schemas; strict runtime validation both sides; fail closed                        |
| Compatibility        | Additive future changes; breaking changes use a new schema version, Worker-first                 |
| Version              | v2, clean break; v1 is retired (no customers, no data migration)                                 |
| Canonical index      | Private HTTP snapshot + pipeline local cache                                                     |
| Index auth           | Existing ingest bearer secret; no new secret                                                     |
| Index staleness      | Cache at most 48 hours old; otherwise fail before matching/publishing                            |
| New products         | First observation creates a provisional backend product; receipt maps `productKey` → `productId` |
| Aliases              | Observations create candidates; admin-only approval; only approved aliases enter the index       |
| Provisional products | Included in the index and matchable with a visible flag                                          |
| Category             | Existing 48-bucket taxonomy; pipeline proposal, backend null-fill; `productType` is separate     |
| Raw fields           | v2 names: `rawName`, `rawBrand`, `rawUnit`                                                       |
| Existing data        | No migration/backfill; clean reset of the price domain and pipeline catalog only                 |

## 2. Topology

```text
RumaQ backend (canonical registry)
  ├── GET  /api/internal/canonical-index ──────▶ pipeline
  │       products + approved aliases + status
  ◀── POST /api/internal/ingest/prices ──────── pipeline
  │       raw observations + category proposals
  └── ingest receipt: productKey → productId
```

The pipeline may compute prices, units, promo, provenance, match confidence, and a
category proposal. It may not send a canonical name, canonical brand, product type,
variant, description, status, `metadataVersion`, or an approved alias.

## 3. Ownership

| Field                              | Owner                                  | Pipeline may send?                              |
| ---------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `id` (UUID)                        | Backend                                | No; returned in receipt/index                   |
| `productKey`                       | Pipeline creates, backend freezes      | Yes, as the join key                            |
| `canonicalName`                    | Backend/admin                          | No                                              |
| `brand`, `productType`, `variant`  | Backend/admin                          | No                                              |
| `size`                             | Backend/admin                          | No; observation carries `unitQty`/`unitQtyUnit` |
| `description`                      | Backend                                | No                                              |
| `category`, `categoryVersion`      | Backend (pipeline proposal, null-fill) | `category` + `taxoVersion`                      |
| `status`                           | Backend/admin                          | No                                              |
| `metadataVersion`                  | Backend                                | No                                              |
| approved aliases                   | Backend/admin                          | No; raw names become candidates                 |
| observation price/promo/source/raw | Pipeline                               | Yes                                             |
| `matchMethod`, `matchConfidence`   | Pipeline                               | Yes, observation-level                          |
| `page`, `ocrModel`                 | Pipeline                               | Yes, observation-level                          |

`productType` is the product kind (`Minyak Goreng`, `Susu UHT`, `Beras`). `category` is
the existing 48-bucket shopping taxonomy (`minyak-goreng`, `susu-uht`, `beras`) and is
feature-flagged by `RUMAQ_CATEGORY=off|shadow|on`. They are separate fields.

## 4. Ingest v2

**Endpoint:** `POST /api/internal/ingest/prices`  
**Auth:** existing bearer secret (pipeline `RUMAQ_INGEST_SECRET`, Worker
`HAQITA_INGEST_SECRET`, including the existing rotation candidate)  
**Content type:** `application/json`  
**Success:** `200` with an ingest receipt

### 4.1 Payload

```jsonc
{
  "schemaVersion": 2,
  "scrapedAt": "2026-11-05T23:00:05Z",
  "stores": [{ "slug": "superindo", "name": "Superindo", "region": "jakarta", "website": null }],
  "items": [
    {
      "productKey": "filma-minyak-goreng-pch-2l--filma--2-l",
      "rawName": "FILMA MINYAK GORENG PCH 2L",
      "rawBrand": "Filma",
      "rawUnit": "2 L",
      "category": "minyak-goreng",
      "taxoVersion": "v0.2",
      "storeSlug": "superindo",
      "price": 34500,
      "originalPrice": 39900,
      "effectiveUnitPrice": 17250,
      "unitQty": 2000,
      "unitQtyUnit": "ml",
      "unitPrice": 17250,
      "promoType": "discount_pct",
      "promoLabel": "Diskon 14%",
      "validFrom": "2026-11-01",
      "validUntil": "2026-11-07",
      "observedDate": "2026-11-05",
      "matchMethod": "exact",
      "matchConfidence": 1,
      "brochureUrl": "https://example.test/brochure",
      "sourceUrl": "https://example.test/campaign",
      "page": 2,
      "ocrModel": "gemini-3.8-flash",
    },
  ],
}
```

### 4.2 Item fields

| Field                | Type                                 | Required | Notes                                           |
| -------------------- | ------------------------------------ | -------: | ----------------------------------------------- |
| `productKey`         | string, 1–300                        |      yes | Frozen pipeline key; backend maps to `id`       |
| `rawName`            | string, 1–500                        |      yes | Source name; never treated as canonical         |
| `rawBrand`           | string/null, ≤200                    |       no | Source brand                                    |
| `rawUnit`            | string/null, ≤200                    |       no | Source unit string                              |
| `category`           | string/null, ≤50                     |       no | Taxonomy proposal; backend fills only when null |
| `taxoVersion`        | string/null, ≤50                     |       no | Taxonomy version for the proposal               |
| `storeSlug`          | string, 1–100                        |      yes | Must be declared in `stores`                    |
| `price`              | integer, ≥0                          |      yes | IDR                                             |
| `originalPrice`      | integer/null, ≥0                     |       no | Strikethrough price                             |
| `effectiveUnitPrice` | number/null                          |       no | Promo-effective unit price                      |
| `unitQty`            | number/null, >0                      |       no | Normalized quantity in base unit                |
| `unitQtyUnit`        | `g`/`ml`/`pcs`/null                  |       no | Base unit                                       |
| `unitPrice`          | integer/null, ≥0                     |       no | Listed price per display unit                   |
| `promoType`          | string/null, ≤100                    |       no | Existing promo vocabulary                       |
| `promoLabel`         | string/null, ≤200                    |       no | Human label                                     |
| `validFrom`          | ISO date/null                        |       no | Promo start                                     |
| `validUntil`         | ISO date/null                        |       no | Promo end                                       |
| `observedDate`       | ISO date/null                        |       no | Defaults to the UTC date of `scrapedAt`         |
| `matchMethod`        | `exact`/`embedding`/`ai`/`solo`/null |       no | Observation-level                               |
| `matchConfidence`    | number, 0–1                          |      yes | Observation-level                               |
| `brochureUrl`        | string/null, ≤500                    |       no | Page image                                      |
| `sourceUrl`          | string/null, ≤500                    |       no | Retailer campaign/listing page                  |
| `page`               | integer/null, ≥0                     |       no | Source page number                              |
| `ocrModel`           | string/null, ≤100                    |       no | OCR model actually used                         |

**Removed from v1:** `name`, `brand`, `unit` — replaced by `rawName`, `rawBrand`,
`rawUnit`. No v1 compatibility is provided.

### 4.3 Validation and write rules

- The schema is `strictObject`: unknown fields are a `400`, not ignored.
- Every `items[].storeSlug` must appear in `stores[]`. An undeclared store is a `400`;
  v2 does not skip items.
- The backend validates the entire payload before any write. Schema failure writes
  nothing.
- Database writes are idempotent and retryable:
  - product upsert by `product_key`;
  - observation upsert by `(product_id, source_id, observed_date)`.
- An unknown `productKey` creates a **provisional** product with a backend UUID. The
  backend derives a provisional canonical name/brand from the raw fields; it does not
  trust them as canonical.
- A raw name attached to a product is stored as a **candidate alias** for that product
  and store. It is never auto-approved.
- `category` is a proposal. The backend fills `price_products.category` only when null,
  records `taxo_version`, and never overwrites an existing category. Admin/backfill may
  override.
- The backend does **not** auto-merge by name/alias. A new `productKey` creates a
  provisional product; an alias collision becomes an admin review item, not a silent
  merge.
- `matchMethod`, `matchConfidence`, `page`, `ocrModel`, and raw fields are observation
  metadata. They do not change canonical fields.

## 5. Ingest receipt

The `200` response is a receipt, not just counts:

```jsonc
{
  "schemaVersion": 2,
  "scrapedAt": "2026-11-05T23:00:05Z",
  "indexVersion": 42,
  "accepted": 120,
  "skipped": 0,
  "productsCreated": 3,
  "observationsUpserted": 120,
  "products": [
    {
      "productKey": "filma-minyak-goreng-pch-2l--filma--2-l",
      "productId": "0b6f6f0e-6e0e-4f0e-9a0e-000000000001",
      "status": "created",
    },
  ],
}
```

- `products[]` contains one entry per distinct `productKey` in the payload.
- `status` is `created` or `existing`.
- Re-posting the same payload returns the same IDs and `existing` statuses; the
  observations are upserted.
- `indexVersion` is the backend's current canonical-index version after the write. The
  pipeline stores it with its cached index.
- `skipped` is retained in the shape but must be `0` in v2. A non-zero value is a
  backend bug, not a normal outcome.
- The pipeline validates the receipt with the shared schema before using any ID. An
  invalid receipt fails the run; it is never partially trusted.

## 6. Canonical index

**Endpoint:** `GET /api/internal/canonical-index`  
**Auth:** the same bearer secret as ingest  
**Cache:** `Cache-Control: no-store`; the pipeline caches locally

### 6.1 Response

```jsonc
{
  "schemaVersion": 2,
  "indexVersion": 42,
  "generatedAt": "2026-11-05T22:55:00Z",
  "products": [
    {
      "id": "0b6f6f0e-6e0e-4f0e-9a0e-000000000001",
      "productKey": "filma-minyak-goreng-pch-2l--filma--2-l",
      "canonicalName": "Filma Minyak Goreng Pouch 2 L",
      "brand": "Filma",
      "productType": "Minyak Goreng",
      "variant": null,
      "size": {
        "quantity": 2000,
        "unit": "ml",
        "packCount": 1,
        "totalQuantity": 2000,
        "packaging": "Pouch",
        "quantityMin": null,
        "quantityMax": null,
      },
      "description": "Filma Minyak Goreng 2 L",
      "category": "minyak-goreng",
      "categoryVersion": "v0.2",
      "status": "canonical",
      "metadataVersion": 1,
      "firstSeenAt": "2026-10-26T00:00:00Z",
      "lastSeenAt": "2026-11-05T00:00:00Z",
      "updatedAt": "2026-11-05T22:50:00Z",
      "aliases": [
        {
          "name": "FILMA MINYAK GORENG PCH 2L",
          "storeSlug": "superindo",
          "firstSeenAt": "2026-10-26T00:00:00Z",
          "lastSeenAt": "2026-11-05T00:00:00Z",
          "source": "ocr",
        },
      ],
    },
  ],
}
```

### 6.2 Index rules

- `schemaVersion` is the contract version; `indexVersion` is a monotonic data version.
  The backend increments it on any product create/update or approved-alias change.
- `products[]` includes `canonical`, `provisional`, and `needs_review` products.
  Provisional products are matchable but must carry a visible provisional flag in the
  pipeline's match output and review queue. `needs_review` products are visible but not
  matchable until an admin resolves them.
- `aliases[]` contains **approved aliases only**. Candidate aliases are internal to the
  backend and never enter the index.
- `size` is nullable; each subfield is nullable. `quantity` is per pack in the base unit;
  `totalQuantity` is `quantity × packCount` when both are known. Ranges use
  `quantityMin`/`quantityMax`; the midpoint is never guessed.
- `description` is a neutral generated descriptor, not marketing copy.
- `category` is the existing taxonomy; `categoryVersion` is the taxonomy version.
- No price, promo, or observation data is in the index. Those belong to observations.
- The endpoint returns a full snapshot. If the catalog grows beyond the Worker response
  budget, pagination is an additive change; the current contract does not paginate.

### 6.3 Pipeline cache and freshness

- On every run, before matching, the pipeline fetches the full index and validates it
  with the shared schema.
- It writes the new snapshot atomically only after validation succeeds. It keeps the
  previous snapshot until then.
- If the request fails or the response is invalid, the pipeline may use its cached
  snapshot only when `fetchedAt` is at most **48 hours** old. The snapshot's
  `generatedAt` must also be within 48 hours; otherwise the run fails before
  matching/publishing.
- If the returned `indexVersion` is lower than the cached version, the run fails
  (rollback/freshness violation). If it is equal, the cached copy is still valid; if
  higher, the new snapshot replaces it.
- A missing or stale canonical index is a **failed run**, not a reason to fall back to
  the local catalog.
- An admin rename (and a revert) bumps `indexVersion` and reaches the pipeline on its
  next fetch; during a ≤48 h cached-index window the pipeline can still match to the
  pre-rename name, so a rename can leave two products sharing one name — surfaced
  read-only by `GET /api/admin/products/duplicates`, never enforced or merged.

### 6.4 Lookup key

The pipeline matches an observation using a **size-inclusive lookup key**: the normalized
name plus the normalized size tuple. The index already carries that tuple (`quantity`,
`unit`, `quantityMin`/`quantityMax`, `packCount`), so the key needs no schema or endpoint
change; the pipeline implementation follows in a separate PR (RumaQ#465, option (a)).

- Quantity is unit-normalized before comparison: mass in kg or g, volume in L or ml, so a
  `2 L` item and a `2000 ml` product are the same size.
- Ranges compare against `quantityMin`/`quantityMax`; a range is never collapsed to a
  guessed midpoint.
- `packCount` is part of the identity when present: a 6 × 200 ml pack is not a 200 ml
  product.
- Resolution order:
  1. The exact size-inclusive key.
  2. The size-stripped name key, only when it is unique across the index and the item's
     size does not contradict the candidate. An item with no size cannot confirm a size
     family, so it stays ambiguous.
  3. Anything still ambiguous is dropped. The pipeline never guesses.
- A size-mismatched candidate never resolves through the index. The pre-fix pre-pass
  matched a 10 kg item to the 5 kg canonical product at confidence 1.0 (pipeline PR #28,
  finding A2); the key compares size instead of stripping it.
- Tradeoff: size families now resolve through the index, so coverage rises, while
  unknown/missing sizes stay ambiguous and fall through to the local matcher. The local
  matcher still handles everything the index drops.
- Evidence: the live AI probe on 2026-11-07 found that 3 of 5 flagged pairs were pure size
  mismatches (210 ml vs 30 ml; 70 ml vs a larger pack; a missing unit vs 1 kg). Dropping
  size families sends those into the local matcher, and from there to the review queue.

## 7. Errors

All internal-route errors use:

```jsonc
{
  "error": "human-readable reason",
  "issues": [{ "path": ["items", 3, "rawName"], "message": "Expected a string" }],
}
```

- `400`: contract violation or undeclared store. `issues` is present for schema
  failures. No DB writes.
- `401`: missing/invalid bearer secret.
- `503`: endpoint unconfigured or database unavailable.
- `500`: unexpected server error.
- The pipeline treats `400`/`401` as fatal and does not retry. It may retry `429`/`5xx`
  with bounded backoff, using the same payload; the ingest is idempotent.
- No error response contains secrets, aliases, or raw store data beyond the request.

## 8. Enforcement

### 8.1 One schema, two projects

- `contract/src/index.ts` is the single source of truth for:
  - `ingestPayloadSchema` (`schemaVersion: 2`);
  - `ingestReceiptSchema`;
  - `canonicalIndexSchema`;
  - `canonicalProductSchema`, `productSizeSchema`, `approvedAliasSchema`;
  - `apiErrorSchema`;
  - `runReportSchema` and its blocks (`runReportStoreSchema`, the match/publish
    summaries, timing, the AI spend block and the typed failure object — §8.5);
  - shared constants (store slugs, limits). The 48-bucket category taxonomy and its
    criteria remain pipeline-owned until a separate taxonomy contract moves them.
- The pipeline vendors `contract/` at `CONTRACT_SOURCE_SHA` via
  `./scripts/sync-contract.sh`. Manual edits to the vendored copy are forbidden; CI
  fails on drift.
- The sync script and drift check must include `contract/fixtures/` as well as
  `package.json`, `tsconfig.json`, and `src/index.ts`.

### 8.2 Runtime validation

- **Producer (pipeline):** validate the payload before `POST`; validate the receipt and
  index before use. A validation failure fails the run; it never sends or trusts a
  partially valid message.
- **Consumer (backend):** validate the request with the same schema before any DB write.
  An invalid request is a `400`; no partial write.
- `strictObject` everywhere; unknown fields are failures, not ignored.
- No `any` casts at the boundary; no duplicate local schema definitions.

### 8.3 Shared fixtures and tests

`contract/fixtures/` contains:

| Fixture                                   | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `valid/ingest-v2.json`                    | Full v2 payload accepted by both projects |
| `valid/ingest-receipt.json`               | Receipt accepted by both projects         |
| `valid/canonical-index.json`              | Full index accepted by both projects      |
| `invalid/ingest-unknown-field.json`       | Must be rejected                          |
| `invalid/ingest-missing-raw-name.json`    | Must be rejected                          |
| `invalid/ingest-undeclared-store.json`    | Must be rejected                          |
| `invalid/index-bad-status.json`           | Must be rejected                          |
| `invalid/receipt-missing-product-id.json` | Must be rejected                          |

Both projects run:

- a **producer test**: every valid fixture parses; every invalid fixture fails;
- a **consumer test**: the backend route rejects invalid fixtures with `400` and accepts
  valid ones;
- a **round-trip test**: pipeline payload → backend ingest → receipt → pipeline cache →
  index snapshot, using the same fixtures.

RumaQ CI runs its contract tests; pipeline CI runs `contract.test.ts`; the drift check
ensures both run the same vendored bytes.

### 8.4 Versioning

- `schemaVersion: 2` is mandatory in the ingest payload, receipt, and index.
- Future optional fields are additive; old payloads remain valid only within the same
  `schemaVersion`.
- A breaking change bumps `schemaVersion` to `3` (and/or adds a new endpoint). The
  backend deploys first, then the pipeline syncs and deploys. There is no silent
  in-place type change.
- The run report has its own `runReportSchema.schemaVersion` (still `1`). Additive
  report fields keep it at `1`: an old scraper's report must keep validating while the
  Worker deploys first, so bumping the literal would reject every report from a box
  that has not re-synced yet. Only a rename/removal bumps the report version.
- The contract package version is bumped for every contract revision (`0.2.0` for
  pipeline contract v2, `0.3.0` for the issue #537 run-report additions); the pinned
  SHA identifies the exact schema in the pipeline.
- The backend returns `400` for an unsupported `schemaVersion`; it never guesses.

### 8.5 Run report: AI spend and typed failures (issue #537)

The run report (`runReportSchema`) is the scraper's per-run POST to
`/api/internal/ingest/runs`, the monitor's data source. Issue #537 made two facts
first-class typed fields instead of free text; both are additive.

**AI spend — `ai.usage`.** One stage entry per AI stage the pipeline meters —
`ocr`, `verifier`, `embedding`, `decision` — each `{ calls, tokensIn, tokensOut, cost,
costMissing }`:

| field         | meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `calls`       | billable replies (a 2xx that produced a usage block), never attempts                 |
| `tokensIn`    | provider-reported prompt/input tokens, summed                                        |
| `tokensOut`   | provider-reported completion/output tokens, summed                                   |
| `cost`        | provider-computed USD, 6-dp rounded by the producer                                  |
| `costMissing` | billable replies whose response carried no `cost`, so `cost` is never silently short |

`decision` is the taxonomy classifier (one call per unique product name per taxonomy
version). Before #537 its spend was metered nowhere — a ~1,412-call night cost about
$0.06 with no surface recording it. The effective generation config and the credential
preflight stay pipeline-private in `status.json`; only metering rides the contract.

**Per-store failure — `stores[].failure` and the run-level `failures`.** A typed
failure is `{ store, code, message, blocked? }`:

| field     | meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `store`   | the store slug (always set per store; `null` on a store-less run-level entry)            |
| `code`    | closed enum, below                                                                       |
| `message` | human sentence, capped at `RUN_FAILURE_LIMITS.message` (the producer truncates its copy) |
| `blocked` | `true` when the outcome is an expected external block that must not fail the run         |

The closed code enum, named after what production emits:

| code                    | outcome                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `fetch_timed_out`       | the store's scrape leg exceeded `STORE_FETCH_TIMEOUT_MS` (pipeline #54)                      |
| `deadline`              | `RUN_DEADLINE_MS` reached before/while the store ran (pipeline #54)                          |
| `blocked`               | a bot challenge the fetch ladder could not clear (Incapsula on lotte-mart, TSP/F5 elsewhere) |
| `ocr_failed`            | the store's OCR leg raised (a page failed, or the vision chain died)                         |
| `embedding_unavailable` | the match stage aborted before publish (a spent quota also carries `exitCode: 2`)            |
| `publish_failed`        | the run died in the publish stage, so nothing was published                                  |
| `other`                 | anything outside the classes above; `message` discriminates                                  |

A `blocked` store is a reported per-store outcome, not a run failure: a night where the
other stores published exits 0 with `status: 'success'` and the blocked store's entry
carrying `{ code: 'blocked', blocked: true }`. Every other store failure keeps its
fail-the-run behaviour (exit 1 after publishing what it could). The report's run-level
`failures` array mirrors every per-store failure and adds the store-less entries a
run-level abort owns (`embedding_unavailable`, `publish_failed`); `RUN_FAILURES_LIMIT`
bounds it.

The existing free-text `error` (per store and run-level) stays: the monitor's human
line and the journal read it.

**Where it is stored.** `recordRunReport` writes the per-store failure inside the
existing `per_store` JSON blob (the store entry keeps its `failure` object) and the
spend block and run-level summary into two columns added by migration 0043 —
`price_runs.ai_usage` and `price_runs.failures` (the validated report slices,
stringified verbatim, the #463 precedent). `listPriceRuns` reads both back, so
`GET /api/admin/price-runs` carries `ai` and `failures` per run. Both columns are
NULL on rows recorded before #537 (and for any producer that sends neither), which
the monitor renders as "absent" — a validated field the read path then drops is not
a surface, so the persistence is part of the contract change, not a follow-up.

## 9. Reset and rollout

There is **no data migration**. Existing price data is test data and is discarded.

### Reset scope

- RumaQ: clear the price domain — `price_observations`, `price_products`, aliases,
  review queue, taxonomy-backfill queue, and price-run history. Keep `price_sources`,
  users, and application tables.
- Pipeline: clear the local catalog/match state and outbox. Keep code, configuration, and
  source evidence (brochures) unless the operator chooses to purge them too.
- The reset is operator-owned and performed once, after the v2 backend is deployed and
  before the first v2 pipeline run. It is not part of the ingest contract.

### Order

1. **RumaQ spec PR:** add this document. No backend behavior change.
2. **RumaQ contract PR:** add v2 schemas, fixtures, and contract tests. No backend
   behavior change.
3. **RumaQ backend PR:** canonical schema (stable ID, canonical fields, aliases,
   raw-observation fields), canonical-index endpoint, receipt, strict validation, tests.
   Deploy the Worker.
4. **Pipeline contract sync:** `./scripts/sync-contract.sh <rumaq-sha>` and update the
   vendored fixtures.
5. **Pipeline PR:** v2 raw fields, canonical-index client/cache, receipt handling,
   approved-alias matching, provisional flags, v2 tests. Deploy.
6. **Clean reset**, then run the first v2 scrape. Verify receipt IDs, index version, and
   admin alias approval before enabling the nightly timer.

Because v2 is a clean break, the old v1 pipeline must not run after the v2 Worker is
deployed. With no customers and no data, a short maintenance window is acceptable.

## 10. Acceptance criteria

- [ ] Both projects import the same `@rumaq/contract` schemas; no duplicated boundary
      types.
- [ ] A v1 payload is rejected with `400`; a v2 payload is accepted.
- [ ] Unknown fields, missing `rawName`, and undeclared stores are rejected with `400`
      and write nothing.
- [ ] Every distinct `productKey` receives a backend UUID; the receipt maps it; a retry
      returns the same IDs.
- [ ] New products are `provisional`; they appear in the index and are matchable with a
      flag.
- [ ] Raw names become candidate aliases; only admin-approved aliases appear in the
      index.
- [ ] `category` is proposal-only and null-fills; an existing category is never
      overwritten.
- [ ] The pipeline fetches/validates/caches the index; a missing or >48h snapshot fails
      the run.
- [ ] The price domain is clean; no v1 data is migrated.
- [ ] RumaQ CI, pipeline tests, and the contract-drift check pass.
- [ ] The pipeline metadata doc and `docs/ARCHITECTURE.md` link this contract.

## 11. Non-goals

- Public canonical-product API shape (the public app may expose canonical data; this
  document only defines the internal pipeline boundary).
- Admin UI implementation (covered by `ahaqqu/RumaQ#423`).
- Taxonomy changes (the 48-bucket v0.2 taxonomy and its gate stay as implemented).
- AI/verifier model selection (covered by `ahaqqu/RumaQ-pipeline#22`).
- Backfilling old data (explicitly not done).
