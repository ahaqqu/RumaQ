# RumaQ v2 — pipeline, prompt, model, quality, and cost audit

> Status: read-only research for [#758](https://github.com/ahaqqu/RumaQ/issues/758).
> Audited pipeline revision: `b8d7138e2a7703a530912943e7d0f7fc9d182a01` (2026-11-22), plus the RumaQ ingest/Scrape-Now consumer. No live scrape, deployment, secret access, or code change occurred. Committed costs and quality measurements are historical evidence, not a fresh post-fix benchmark.
>
> Unless otherwise noted, `src/...` paths below mean `groceries/scraper/src/...` in `ahaqqu/RumaQ-pipeline` at the audited revision.

## 1. Executive conclusion

The current pipeline has strong operational machinery: typed per-store failures, content novelty, staged replay, immutable evidence, strict contract validation, idempotent ingest, and provider-reported AI usage. It is not yet a trustworthy publication pipeline:

- new/solo products become matchable provisional identities immediately;
- verifier failure or an unresolved answer retains the ambiguous match;
- category rules/research can answer or clear flags without human acceptance;
- discovery can silently truncate pages;
- Scrape Now publishes directly rather than stopping at review;
- store selection is mostly static configuration, not explicit certification state.

For v2, retain proven source/transport/parsing/evidence/ingest primitives. Replace the decision and publication policy with source artifacts, fail-closed identity resolution, human acceptance, and explicit per-store enablement.

## 2. End-to-end stage audit

| Stage                | Current behavior                                                                                                                                                                       | Disposition                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight / registry | Requires `OPEN_ROUTER_KEY`; loads the full canonical index, with only a validated <=48 h cache fallback (`pipeline.ts:3038-3046,3304-3318`; `publish/canonical-index.ts:1-19`).        | Keep fail-fast validation. Add source, prompt, model, schema, and code versions to the run manifest.                                                                      |
| Discovery / fetch    | Plain-first, browser and optional per-store proxy escalation; 15 min/store and 90 min/run deadlines (`fetch/strategy.ts`; `deadlines.ts:12-40,55-58`).                                 | Keep adapter isolation and transport primitives. Require a complete campaign/page manifest; distinguish empty, changed, blocked, capped, and failed.                      |
| Novelty / state      | Content hashes and perceptual-hash skips; state checkpoints after successful OCR/upload; store-specific edition/daily gates (`fetch/state.ts`; `pipeline.ts:1260-1266`).               | Keep immutable hashes and append-before-remember. Make every skip auditable and support campaign-scoped reprocessing from cached bytes.                                   |
| OCR / extraction     | Serial inline-image calls, same-model retries, no alternate model; self-reported recall shortfall can trigger one enumeration pass (`ocr/vision.ts`; `ocr/recall.ts`).                 | Keep adapter and deterministic decoding. Use a strict versioned output schema; persist raw response, prompt/model, image hash, and evidence lineage.                      |
| Parse / validation   | Pure IDR/date/unit/price/member/original/promo rules, rejection reasons, and dated-price selection (`ocr/parse.ts`).                                                                   | Keep and extend pure rules. `priceText` agreement only validates the model against its own text; it is not independent evidence.                                          |
| Normalize / identity | Backend index, local catalog, normalization, exact/embedding tiers, gates, verifier, then solo founding (`match/index-match.ts`; `match/matcher.ts`).                                  | Replace decision policy. Approved aliases and deterministic size tuples may auto-attach; embeddings only propose candidates; new/ambiguous identities remain unpublished. |
| Category             | Exact-name cache, decision model, sealed rules, confidence/disagreement flags, then web research (`categorize/classify.ts`).                                                           | Category is not a price-publication blocker. Permit null, review it independently, and cache by stable product identity.                                                  |
| Evidence             | Brochure pages upload to R2 before novelty commit; catalog item crops may fall back to a page URL on capture/upload gaps (`publish/brochures.ts`; `stores/alfamart.ts:901-930`).       | Keep immutable evidence. Certification requires page/item evidence on every accepted offer; no warning-only evidence fallback.                                            |
| Publish / ingest     | Per-store match/classify/publish; strict contract, chunks of 400, idempotent upsert and receipt (`pipeline.ts:2734-2821`; `publish/client.ts`; `publish/payload.ts`).                  | Keep the validated, idempotent boundary. Publish only the accepted artifact set, not every staged candidate.                                                              |
| Reports              | Rich `status.json`, provider usage, run reports, and admin events; some acceptance-relevant fields are stripped from strict reports (`status/monitoring.ts`; `pipeline.ts:3950-3999`). | Keep telemetry. Add durable, append-only per-store certification and cost reports; last-run status is not acceptance history.                                             |
| Scrape Now           | Admin command -> D1 queue -> 15 s VPS poll -> detached child with `--publish`; lease/reaping exists (`agent.ts`; `main.ts`; RumaQ `backend/src/lib/scrape.ts`).                        | Add discover/extract/review/publish modes, campaign scope, cost preview, and certification state. Manual extraction must not imply live publication.                      |

## 3. Production prompts and models

All production model traffic uses OpenRouter (`util/openrouter.ts:53-65`). OCR, verifier, and research use temperature 0 and seed 42. No structured response schema is sent (`ocr/generation.ts:23-51`). No alternate-provider/model fallback exists for OCR, verifier, or embeddings.

| Call                  | Purpose and prompt identity                                                                                                                                                                                   | Default model / controls                                                       | Failure behavior and assessment                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary brochure OCR  | `ocr-brochure-v2`; enumerate priced tiles into name/brand/unit/price/priceText/memberPrice/originalPrice/promo/period; member/payment badges, multi-variant omission, no arithmetic (`ocr/vision.ts:43-182`). | `google/gemini-3.8-flash`; `OCR_MODEL`; 180 s/attempt; two retries.            | Same-model retry only; exhausted failures stop the page/store and retain replay state. Add structured output and evidence, not hidden fallback.     |
| Recall enumeration    | Same page schema with an explicit “EVERY priced tile” instruction; at most one extra call when the model-reported shortfall >=2.                                                                              | Same OCR model/configuration.                                                  | Additive only. Self-count is diagnostic, never coverage proof.                                                                                      |
| Shadow OCR audit      | Replays the primary machinery and diffs selected fields (`ocr/audit.ts`).                                                                                                                                     | Off by default; `RUMAQ_OCR_AUDIT_MODEL` defaults to the primary model; cap 12. | Errors swallowed; never changes publish. Same-model agreement is self-consistency, not independent verification. Move to sampled/manual evaluation. |
| Embeddings            | Candidate similarity, batches <=100, model/dimension-keyed cache (`match/embedding.ts`).                                                                                                                      | `qwen/qwen3-embedding-8b`; one transport attempt plus quota policy.            | Failure aborts matching before publish. Keep for candidate generation, not identity authority.                                                      |
| Pair verifier         | `verifier-pair-v2`; YES/NO same physical product, explicitly ignoring cross-store price gaps (`ocr/verify.ts:40-78`).                                                                                         | `google/gemini-3.8-flash`; two retries; max 400 attempts/30 min.               | Unparseable/failure => null, but matcher keeps the pair and flags it. This must become abstain/unpublished.                                         |
| Category decision     | Choose exactly one sealed taxonomy slug (`categorize/taxonomy.ts:110-132`).                                                                                                                                   | `perplexity/pplx-decider-v1.2`; `/api/alpha/decisions`; 10 s; one retry.       | Breaker falls back to rules/null and still publishes. Category may be null in v2; no fallback needs to force an answer.                             |
| Category web research | Research ambiguous names online and return `{choice,confidence}` (`categorize/research.ts`).                                                                                                                  | `deepseek/deepseek-v4.1-flash`; web plugin; 30 s; one retry; cap 40.           | Confidence >=0.95 can clear its own flag. Remove from the publication critical path; review or defer instead.                                       |

No other production LLM call site was found. Lab/benchmark arms are not production routing. The backend's household AI gateway is a separate product surface and is not part of grocery extraction.

## 4. Store/source inventory

`config.stores` is the nightly source of truth; `--stores` only scopes it. There is no common enabled/certified state. Admin exposes static contract slugs, including dead or dormant sources.

| Store                  | Source and extraction                                    | Current condition / v2 action                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superindo`            | Two HTML hubs -> gallery images -> vision OCR.           | **Pilot.** Reuse allowlist/gallery parser. Remove silent `.slice(0,maxPages)` behavior; require zero/churn/coverage sentinels and a complete page manifest. Current regional scope remains Jabodetabek-Palembang. |
| `hypermart`            | Static HTML carousel -> JAWA images -> OCR.              | Reuse selectors/hash handling. Only ALL JAWA is currently in scope; no fresh accepted quality baseline.                                                                                                           |
| `indomaret`            | HTML -> PDF -> 150 DPI images -> OCR.                    | Reuse PDF renderer/churn sentinels. Current page cap can intentionally publish a partial brochure; certification forbids that.                                                                                    |
| `yogya`                | Browser campaign pages -> catalogue images -> OCR.       | Anti-bot/navigation risk; 40-page cap versus 81 observed pages means incomplete coverage. Do not enable before evidence.                                                                                          |
| `astro`                | Embedded Next Flight JSON -> structured rows; no OCR.    | Reuse parser/variant mapping. Current coverage is only first 30 items/category; historical sample was tiny.                                                                                                       |
| `alfamart`             | Browser-rendered Nuxt cards; no OCR; image crops.        | Reuse card scoping/churn/evidence. Conflicting same-key cards currently choose the lowest price; v2 must reject/quarantine instead.                                                                               |
| `tip-top`              | Server-rendered catalog/JSM cards; no OCR.               | Current 12-card/page and PDF-tail gaps; historical 10-row sample was weak. Recertify coverage and dates.                                                                                                          |
| `hari-hari`            | Browser X/syndication captions plus page images/OCR.     | Source reliability unproven; blocked/missing-proxy days can appear as green skips. Keep disabled pending the separate egress decision and certification.                                                          |
| `lotte-grosir`         | Legacy encrypted Next.js catalog.                        | Source is dead/superseded yet default-active. Remove from enabled/admin-certified paths; retain archived fixtures only if useful.                                                                                 |
| `lotte-grosir-promosi` | HTML -> text-layer PDF -> coordinate-bound rows; no OCR. | Reusable deterministic approach, but no committed human-evidence baseline. Certify before enabling.                                                                                                               |
| `lotte-mart`           | Browser promo HTML -> images -> OCR.                     | Dormant legacy lever; silent page slicing and an inconsistent admin-selectable path. Hide unless deliberately rebuilt and certified.                                                                              |

The next store is not preselected. Choose it from source health, user value, coverage, and cost after Superindo passes two complete campaign gates.

## 5. Accuracy findings that become hard requirements

1. **No auto-solo publication.** Extraction does not establish canonical identity.
2. **No unresolved auto-attach.** Verifier null/failure, low evidence, conflicting same-key prices, and ambiguous aliases produce review tasks, never public offers.
3. **No silent coverage loss.** Page caps, rotations, skipped pages, unexpected empty results, and discovery drift block certification and are visible in the run report.
4. **No model self-agreement as ground truth.** Gold labels and source evidence decide accuracy.
5. **No forced category.** Null is preferable to a guessed public category.
6. **No evidence-free offer.** Every accepted offer resolves to immutable campaign/page evidence and, where the source supports it, an item crop or region.
7. **No corrupt-outbox loss.** Malformed replay lines quarantine the artifact; successful later publishes cannot retire unreplayable evidence.
8. **No operational-success conflation.** Exit 0, a receipt, or “some rows published” does not mean a store passed acceptance.
9. **No duplicate identity authority.** The backend owns canonical identity; pipeline-local state is a derived candidate/cache, never a second mergeable registry.
10. **No routine destructive wipe in the quality loop.** Reprocess a campaign/version from immutable bytes and supersede accepted versions transactionally. Reserve destructive reset for the initial fresh start.

## 6. Cost evidence and instrumentation

Current instrumentation records provider `usage.cost`, token counts, and missing-cost indicators by stage in status/journal/run report. It lacks per-store total cost, proxy/R2/web-search allocation, accepted-item denominators, and hard dollar budgets.

Historical committed evidence only:

- Eight production runs from 2026-11-09…17 averaged 2.5 h and cost **$29.40 total**; OCR was **94% of $28.95** AI spend. Superindo was the highest historical store cost at **$7.12** for that window (`docs/audit/pipeline-audit-2026-11-18.md:58-96`).
- Frozen ten-page vision benchmark: Gemini 3.8 default **$0.020345/page**, p50 27.2 s; reasoning-low **$0.007710/page**, p50 11.1 s. Another model showed lower cost but there were no human labels, so it is only an experiment candidate (`docs/OCR-ROUTE-BENCH.md`).
- Embedding benchmark: Qwen3-Embedding-8B measured **$0.0000074/name** on its frozen sample.
- Decision benchmark v2/taxonomy v0.3: 1,623 calls / **$0.0919**; current taxonomy v0.4/v3 lacks a full benchmark.
- Verifier evidence: 688 shadow calls cost **$0.2050**; only 28 skewed owner-labelled identity pairs, insufficient to choose solely on price.

V2 must record per store, campaign, run, stage, model, and prompt version:

- pages discovered/downloaded/extracted/accepted/rejected;
- calls, retries, input/cached/output tokens, provider-reported cost, and missing-cost count;
- wall time and human review minutes;
- accepted offers and corrections;
- proxy/Actor usage and other paid platform consumption;
- **cost per accepted offer = allocated AI + paid source/platform spend / accepted offers**;
- monthly infrastructure shown separately as incremental cost and total cost, so an already-paid VPS is not presented as free capacity.

No model switch is approved from these historical numbers. Evaluate frozen, human-labelled Superindo artifacts; accuracy first, then latency and cost.

## 7. Keep / change / remove / add

### Keep

- source-specific fixtures, host allowlists, structured HTML/JSON/PDF parsers;
- plain/browser/proxy transport primitives and typed store failures;
- pure IDR/date/unit/promo validation and canonical size/alias concepts;
- immutable evidence, staged replay, idempotent ingest/receipts;
- prompt/model hashes and provider usage telemetry.

### Change

- emit a deterministic artifact manifest for every campaign/page/extraction;
- separate raw observation, canonical identity, optional category, and public offer acceptance;
- make publish consume approved artifacts only;
- add real store states shared by nightly, CLI, and admin;
- persist raw responses and exact model/prompt/schema/config versions;
- make public current-offer reads validity-aware and coverage-aware.

### Remove

- auto-solo canonicalization and verifier-null auto-attach;
- lowest-price conflict resolution and raw-key identity fallback;
- same-model shadow as correctness evidence;
- forced category/web-research answers in the publish path;
- dead/dormant stores from enabled and selectable defaults;
- the second mergeable local identity registry.

### Add

- `disabled -> discovering -> extracted -> human_review -> accepted -> publish_enabled -> suspended` certification state;
- explicit `disabled / manual_only / scheduled` store controls;
- human-labelled tile gold sets, including deliberate omissions and no-price regions;
- durable reviewer/evidence/version verdicts;
- discovery coverage, evidence completeness, identity precision, field accuracy, and corrupt-state gates;
- per-store/run cost ceilings and paid-run confirmation;
- dry-run/reprocess/review/publish command separation.

## 8. Superindo acceptance contract

Owner decisions: identity-gated publication, nullable category, current Jabodetabek-Palembang scope, and two complete campaigns before another store.

1. Only Superindo is manually enabled; every other store is disabled for both nightly and Scrape Now.
2. Discover every in-scope campaign/page and record source URL, region, validity, content hash, and coverage status. Overflow or unexpected zero discovery fails closed.
3. Freeze the first complete campaign as immutable bytes. Label every printed priced tile, including no-price/deliberate-omission regions. Record raw fields, price roles, promo conditions, dates, evidence, and expected identity disposition.
4. Replay extraction from frozen bytes without publishing. Store raw model responses and exact versions. Every missing/rejected tile needs a human-reviewed disposition.
5. Require zero known wrong accepted price/member/original/date/evidence/identity rows. New and ambiguous identities await owner approval; category may remain null.
6. Publish only the approved set to the fresh environment; reconcile receipt, persisted fields, public reads, evidence links, validity, region, and selected-store comparisons.
7. Repeat on the next complete fresh campaign. The second pass may use risk-based review, but every automated skip must reconcile to the approved baseline and every exception remains human-gated.
8. Owner signs the two-campaign evidence and cost report before Superindo becomes scheduled and before any next store becomes manually enabled.

A fresh-campaign observation window is part of acceptance; one successful command is not.
