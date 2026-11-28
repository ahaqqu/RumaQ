# RumaQ v2 — reconciled product and architecture design

> Status: **approved with the plan (C0, 2026-11-28)**, tracked by [#758](https://github.com/ahaqqu/RumaQ/issues/758). This reconciles independent product-manager and product-architect passes with the owner's decisions. Phase 2's code topology and core data model are refined by the design addendum on [#763](https://github.com/ahaqqu/RumaQ/issues/763). It authorizes no implementation, paid run, deployment, or workflow change by itself.

## 1. Product definition

RumaQ is a **promo-first household companion**: find a current offer for your region, verify the exact product/price/conditions against its brochure evidence, and turn it into a personal or household shopping list.

- Guests receive the complete public promo explorer without login.
- Accounts add synchronization, alerts, and household capabilities—not better prices.
- The initial public source is **Superindo**, region scope **Jabodetabek-Palembang**.
- All public offers are human-approved during the two pilot campaigns. Category may remain null.
- Two distinct complete campaigns gate scheduled Superindo operation and the next store.
- The new site takes **`rumaq.ahaqqu.com` immediately** once its shell passes release QA. Before approved data exists it shows a truthful empty state, never demo offers.
- The legacy app moves to **`rumaq-v1.ahaqqu.com`**. A separate origin avoids service-worker, cache, cookie, and API-prefix collisions that a `/v1` path would introduce.
- Everything starts fresh: no D1 rows, accounts, products, aliases, sessions, pipeline catalog, or outbox are imported.

The prototype remains a visual reference. Production code will not port its single-file `innerHTML` implementation, demo data, or fabricated claims.

## 2. Non-negotiable truth contract

### 2.1 Publication

An offer is publicly current only when:

1. Its product identity is human-approved. Every new or ambiguous identity has a named reviewer decision.
2. Product, pack/size, store, region, price basis, validity, evidence, and promotion conditions have passed review.
3. It has a bounded inclusive validity window. Missing or open-ended validity is not current.
4. Its campaign revision has complete page/tile accounting.
5. Its publication batch is approved and its current version has not been withdrawn.
6. Its source and evidence are publicly visible.
7. Any extraction, date, member, quantity, multi-buy, or conflict ambiguity has been resolved; otherwise the candidate is rejected or remains private.

Category is nullable and independent of publication. Model/rules/research output is a suggestion, never self-approving.

For the first two Superindo campaigns, every candidate receives a coded publish/reject disposition and every published offer receives human approval. After the gate, automatic publication of known approved identities is a separate owner-approved policy, not an assumed optimization.

### 2.2 Claims

| Claim              | Allowed only when                                                                                                                                          | Required behavior                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discount / hemat   | Same approved product, pack, store, region, and comparable condition have a printed original price or dated prior approved reference greater than current. | Name the reference basis. Without it, omit strike-through, percentage, and savings.                                                                     |
| Cheapest           | At least two enabled stores have current, valid, region-comparable offers for the exact product and comparable price basis.                                | Say “Termurah dari N toko yang tercakup”. One-store results say “Harga Superindo”. Never mix member-only and unconditional bases without qualification. |
| Price drop         | A prior approved observation exists for the same product/store/region/condition.                                                                           | Show prior date and amount. A lower price elsewhere is “lebih murah di …”, not a price drop.                                                            |
| Member price       | Membership requirement is explicit.                                                                                                                        | Show member and shelf prices as separate evidenced bases; do not flatten them into one lowest number.                                                   |
| Multi-buy / bundle | Required quantity and whether the printed amount is total or per-unit are known.                                                                           | Show quantity, total, and derived unit price only when unambiguous.                                                                                     |
| Quantity limit     | Limit is captured.                                                                                                                                         | Include it in totals; never extrapolate promo pricing beyond eligibility.                                                                               |
| Harga mulai        | Exact variant identity and condition are resolved.                                                                                                         | Otherwise quarantine the candidate.                                                                                                                     |

Never fabricate views, saves, popularity, “best”, historical lows, potential aggregate savings, normal prices, or update times. Private analytics never become fake social proof.

### 2.3 Coverage and freshness

Every list/detail carries selected store, region, validity, and last-checked time. Campaign copy says “X penawaran terverifikasi” and “Hanya item yang lolos pemeriksaan ditampilkan”; it does not imply every branch or every printed item is covered.

Freshness windows are source-specific and established from measured cadence. Stale offers leave default current feeds/rankings/alerts. A direct link may show labelled historical information, never a stale price as currently verified. Expiry follows the retailer's local date grid.

## 3. System architecture

```text
Guest / account / admin browser
          │
   Cloudflare DNS + CDN + WAF
          │
        nginx
          │
  rumaq-web-api (Bun, loopback)
  ├─ React/TanStack public SSR
  ├─ Hono public/account/admin APIs
  └─ loopback-only internal ingest API
          │                 ▲
          │                 │ authenticated, idempotent ingest
    PostgreSQL 17       rumaq-pipeline
    + pgvector          separate process/cgroup
    + pg_trgm           Superindo only initially
          │
    rumaq-worker (separate process/cgroup)
    ├─ scheduling and leases
    ├─ publication and outbox
    ├─ cache invalidation
    └─ retention/reconciliation

R2 public: immutable, rehosted brochure pages + official source URL
R2 private: raw model responses, review artifacts, household/receipt data
R2 backups: encrypted PostgreSQL/WAL + pinned-evidence manifests
```

### Commitments

- **PostgreSQL 17** in a new `rumaq` database is the system of record.
- **Bun + Hono modular monolith** replaces another monolithic route file.
- Web/API and worker share one codebase/deployment artifact but run as separate systemd units.
- Separate PostgreSQL roles: `rumaq_migrator`, `rumaq_app`, and `rumaq_readonly`. The pipeline gets no DB credentials.
- Internal ingest binds loopback and is not proxied by public nginx.
- R2 objects are content-addressed and immutable. Public brochure evidence is intentionally rehosted; raw provider payloads remain private.
- PostgreSQL-backed jobs, leases, and transactional outbox are sufficient; no Redis, Kafka, Elasticsearch, or microservices initially.
- Cloudflare is retained for DNS/CDN/WAF, not as the v2 database or default application compute.
- Host configuration lives only in `ahaqqu/vps`; application deployment uses the existing artifact/swap/health/rollback discipline through the repository's single deploy entrypoint.

### Resource envelope

The live VPS check showed 113 GB free, 3.28 GiB available RAM, and low load. It is still a shared 2 vCPU/4 GiB/no-swap host. Begin with an API/worker memory ceiling around 768 MiB and a small PG pool; retain the scraper's 1.2 GiB ceiling. These are safety limits, not coverage/cost shortcuts. A combined API + worker + PostgreSQL + pipeline + resident-apps stress test is mandatory.

If the host cannot meet the gates, compare a VPS upgrade with managed PostgreSQL. Do not expose the existing loopback DB merely to enable Hyperdrive and do not fall back silently to D1 Free.

## 4. PostgreSQL domain model

### 4.1 Conventions

- Application-generated UUIDv7 IDs; UTC `timestamptz` for events; retailer-local `date` for validity.
- IDR as `bigint` with nonnegative checks; quantities as `numeric`.
- JSONB only for immutable raw/provider payloads and bounded snapshots, not authorization/filter fields.
- Accepted versions and review decisions are append-only; corrections create new versions or compensating events.
- Use foreign keys, partial unique indexes, transactions, and optimistic entity versions.
- Public catalog tables have no `household_id`; private child rows carry composite household FKs so cross-household references are structurally impossible.

### 4.2 Main entities

| Area               | Entities                                                                                                       | Purpose                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Retailers          | `retailers`, `retailer_regions`, `store_sources`, `store_certifications`, `source_state_events`                | Explicit region, source plugin, run mode, public visibility, current release, and signed certification history.      |
| Campaigns          | `campaigns`, `campaign_revisions`, `campaign_pages`, `source_tiles`                                            | Campaign identity independent of image URL; immutable manifest, coverage counts, page/tile lineage, and gold labels. |
| Evidence           | `evidence_assets`                                                                                              | SHA-256-addressed R2 object, MIME/size/kind/visibility; no overwrite.                                                |
| Runs               | `pipeline_runs`, `run_events`                                                                                  | Stable run UUID, command kind, release/config, lease, ordered event sequence, typed failures.                        |
| Extraction         | `raw_extractions`, `extraction_items`                                                                          | Exact prompt/model/schema/input, private raw response, normalized candidates, validation/disposition.                |
| Identity           | `products`, `identity_candidates`, `product_aliases`, `identity_match_candidates`, `product_embeddings`        | Human-approved products, private candidates, approved aliases only in matching, advisory embeddings/verifier.        |
| Category           | `taxonomy_versions`, `categories`, `category_suggestions`                                                      | Owner-approved taxonomy and nullable canonical category; model/rules/research remain suggestions.                    |
| Offers             | `offers`, `offer_versions`                                                                                     | Stable source-offer identity and append-only accepted/rejected/superseded field versions.                            |
| Publication        | `publication_batches`, `publication_items`, `published_current`, `publication_events`                          | Approved manifest, atomic publication, sole current pointer, withdrawal/correction receipts.                         |
| Review             | `review_tasks`, `review_decisions`                                                                             | Typed queues, one open task per subject/input, named actor, expected version, before/after evidence.                 |
| Reliability        | `ingest_requests`, `outbox_events`, `outbox_deliveries`                                                        | Same-key/body replay, conflict detection, leased at-least-once delivery, durable exactly-once domain effects.        |
| Cost               | `provider_calls`, `cost_ledger`, `cost_allocations`, `review_time_entries`                                     | Actual/estimated/unknown spend, retries/discarded work, allocation method, review minutes/corrections.               |
| Accounts           | `users`, `auth_identities`, `sessions`, `user_roles`, `user_settings`                                          | OIDC identity, opaque revocable sessions, server-side roles.                                                         |
| Personal/household | `households`, `household_members`, `household_plugins`, `watchlists`, `watchlist_items`, `lists`, `list_items` | Synced account state and optional modules with structural tenancy.                                                   |
| AI governance      | `prompt_versions`, `model_releases`, `pipeline_releases`                                                       | Approved exact prompt/schema/model/code/config releases; no silent environment-only model switch.                    |

### 4.3 The only current-offer rule

All public list/detail/comparison paths share one repository primitive equivalent to:

```sql
FROM published_current pc
JOIN offer_versions ov ON ov.id = pc.offer_version_id
JOIN campaign_revisions cr ON cr.id = ov.campaign_revision_id
JOIN store_sources ss ON ss.id = pc.store_source_id
WHERE pc.withdrawn_at IS NULL
  AND ov.state = 'accepted'
  AND ov.valid_during @> :as_of_local_date
  AND cr.coverage_state = 'complete'
  AND ss.public_visibility = 'public'
```

There is no latest-observation fallback. Tests cover null dates, future/expired offers, WIB/UTC boundaries, overlapping campaigns, corrections, withdrawn versions, incomplete campaigns, and an expired latest observation.

## 5. Pipeline and store controls

### 5.1 Source modes

| Mode          | Discover/extract/reprocess | Scheduled collection | Publish                                                                      |
| ------------- | -------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `disabled`    | No                         | No                   | No                                                                           |
| `manual_only` | Admin only                 | No                   | Approved batch only                                                          |
| `scheduled`   | Yes                        | Yes, while certified | Approved policy/batch only                                                   |
| `suspended`   | No new paid work           | No                   | No new publish; hiding existing data is a separate audited visibility action |

Certification and run mode are separate. Only Superindo starts `manual_only`; every other source is `disabled` and absent from manual pickers until deliberately enabled.

### 5.2 Commands and states

Replace Scrape Now's implicit `--publish` with:

- **Discover**: build a complete campaign/page manifest; no model or publication.
- **Extract**: create candidates from captured bytes under an approved release and spend confirmation.
- **Reprocess**: replay frozen bytes with a new prompt/model/parser; never alter original observation times.
- **Review**: admin disposition of coverage, extraction, identity, optional category, and publication.
- **Publish**: execute one approved batch ID + manifest hash + idempotency key. It performs no OCR, matching, or research.

```text
Run: queued → discovering → capturing → extracting → normalizing
     → identity_review → release_review → publishing → published
     ↘ failed / cancelled at a checkpoint

Campaign revision: discovered → capturing → complete
                   ↘ coverage_failed / review_required

Offer version: draft → pending_review → accepted → superseded
                              ↘ rejected

Publication: draft → blocked/awaiting_approval → approved → publishing → published
             published → withdrawn only through a compensating publication
```

Checkpoint transactionally after discovery, each evidence upload, every raw model response (including failed paid calls), each page's normalized candidates/tile accounting, every review decision, and publication commit. Novelty advances only after durable acknowledgment and is an optimization, not truth.

A failed refresh leaves the last valid published revision until expiry; it never replaces it with a partial snapshot. A wrong-data kill switch can hide it immediately.

### 5.3 Superindo gate

A campaign counts only if it is a distinct source campaign/fresh manifest and:

- every discovered in-scope page is captured and accounted;
- every printed priced tile ends accepted, human-approved rejected, or as a visible blocker;
- no known wrong accepted price/member/original/validity/evidence/identity remains;
- all new/ambiguous identities have named human decisions;
- public cards/details/evidence/expiry/region/conditions pass QA;
- complete quality, cost, latency, correction, and review-time reports exist;
- the owner signs the campaign report.

Campaign A is exhaustive. Campaign B repeats the complete loop including expiry/freshness rollover; all exceptions and new/ambiguous identities remain gated. The second signature unlocks scheduled Superindo and one next store. Material source/discovery changes require full recertification; prompt/model changes require frozen-gold regression plus a fresh complete campaign and owner approval.

## 6. Prompt/model policy

Initial candidates are the current OpenRouter routes, not preselected winners:

| Task              | Starting route                          | Policy                                                                                          |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| OCR               | `google/gemini-3.8-flash`               | Strict JSON Schema, raw response persistence, evidence/tile lineage, no silent fallback.        |
| Embeddings        | `qwen/qwen3-embedding-8b`               | Candidate ranking only; model/dimension-specific pgvector indexes.                              |
| Verifier          | `google/gemini-3.8-flash`               | Advisory. YES/NO/null/error are recorded; new/ambiguous pairs remain human-gated even when YES. |
| Category decision | `perplexity/pplx-decider-v1.2`          | Suggestion only; null is valid.                                                                 |
| Optional research | `deepseek/deepseek-v4.1-flash` with web | Admin-only suggestion with citations; cannot clear a review task.                               |

Evaluation freezes source bytes and independently labels every priced tile, no-price region, and deliberate omission. Compare whole-page extraction with improved structured prompts and, only if needed, detect-then-extract tiling. Same-model reruns measure repeatability; cross-model agreement is not accuracy.

Report tile recall, field accuracy, missing/rejected tiles, false-merge/false-split, evidence correctness, schema failures, verifier outcomes, latency, and cost per accepted offer. Critical-field/identity accuracy outranks lower cost.

Remove continuous same-model shadow as an accuracy mechanism. Keep sampled/manual independent evaluation. Keep pure deterministic validation and conditional second passes only when human-labelled results justify them.

## 7. Public, account, admin, and internal APIs

### Public, no login/entitlement

- home, retailers/regions, campaigns and campaign offers;
- product detail and offer search;
- public metadata and immutable brochure evidence.

Responses contain approved public fields only—never raw prompts, provider responses, review notes, candidate identities, or costs. Public reads are cursor-paginated and bounded.

### Account

OIDC Authorization Code + PKCE, preferably through AutQ if the early client/lifecycle spike passes; otherwise direct Google OIDC behind the same session interface. Identity uniqueness is `(issuer, subject)`, not email.

Use opaque server-side sessions with hashed tokens, `HttpOnly; Secure; SameSite=Lax` host-only cookies, revocation, and idle/absolute expiry. Roles are server-resolved and immediately invalidatable. Origin checks + CSRF protect mutations. Household authorization is independent of admin role.

### Admin

Sources/certification, runs, campaigns, review, products/aliases, publications, model/prompt registry, evaluations, costs, audit, and public-visibility kill switch. Mutations require role, expected version, idempotency, confirmation where destructive, and audit receipts.

### Internal

Loopback-only authenticated assets/runs/extractions/candidates/command events/publication execution. RumaQ owns the strict versioned contract; pipeline syncs it after the RumaQ PR. Unknown fields fail validation.

## 8. Caching, abuse, and privacy

- Public list/search shared TTL <=60 s with publication-version ETags and normalized query keys.
- Public campaign/product SSR uses short shared TTL plus event-driven purge after publication.
- TTL never crosses the next validity transition; scheduled WIB-boundary purges remove expired content.
- Historical accepted versions and public evidence may be immutable/long-lived.
- Account/admin/error responses are private, no-store.
- Publication commit and cache-invalidation outbox event share one transaction.
- Edge and origin rate limits protect reads/search/auth/mutations; trusted client-IP propagation is tested so users do not share one bucket.
- Retailer HTML/images/OCR/research are untrusted data, never instructions or executable markup.
- No third-party ad trackers, session replay, fingerprinting, precise geolocation, or advertising profiles. Analytics uses an allow-list and excludes raw queries/list notes/private content/prompts.

## 9. Product experience

### 9.1 Routes and rendering

| Route                          | Access                | Rendering / behavior                                                            |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------- |
| `/`                            | Public                | SSR verified promo home for selected region.                                    |
| `/promos`                      | Public                | CSR search/filter exploration with URL-backed state; prerenderable entry shell. |
| `/campaigns`, `/campaigns/:id` | Public                | SSR current/upcoming/ended campaigns, parsed list + original brochure.          |
| `/products/:id`                | Public when published | SSR canonical product, current offers, conditions, evidence.                    |
| `/watchlist`                   | Guest/account         | Device-local or synced watches; CSR.                                            |
| `/shopping`                    | Guest/account         | One local/synced list; CSR.                                                     |
| `/profile`                     | Guest/account         | Local settings/sign-in or account/household/module controls.                    |
| `/household/*`                 | Account               | Optional modules after the first slice; private CSR.                            |
| `/admin/*`                     | Authorized operator   | Private CSR review/run/store/publication controls.                              |
| `/privacy`, `/credits`         | Public                | Prerendered static information and attribution.                                 |

Use a TanStack Start-on-Bun proof for one campaign and one product. If it cannot run on the pinned runtime without adding another stack, use Vite prerendering plus Hono-rendered public shells rather than introducing Node solely for SSR. Do not SSR every route. Never put private data in cached SSR HTML or resurrect expired offers through the PWA cache.

### 9.2 Primary navigation and pages

Five labelled mobile destinations: **Beranda, Promo, Favorit, Belanja, Profil**. Desktop uses adaptive header/sidebar and multi-column content, not a fixed phone frame.

- **Home:** region selector, real verified count/validity/last check, search, ending soon, newly approved, watched items, and current campaigns. No aggregate savings or popularity.
- **Promo catalog:** scope line, URL-backed filters, transparent sort, accessible “Muat lebih”, no silent fallback to another date/store.
- **Campaign:** exact dates/region/coverage, verified items, original brochure with keyboard page controls, official source and rehosted evidence.
- **Product:** exact identity and all valid offers, conditions beside price, evidence action, no chart until enough same-basis history exists.
- **Watchlist:** exact-product and keyword watches, visible match examples/count, local versus synced state, no fake alert history.
- **Shopping:** selected-offer store grouping, custom unpriced items, condition-aware quantities/totals, unknown never Rp0, ended offers retained but marked for recheck.
- **Profile:** honest guest/account state, region/language, install/privacy/credits, clear-local-data, account sync/export/delete, module controls.

### 9.3 Guest-local and sign-in

Guests get region/language, product/keyword watches, and one list in a versioned local namespace. No anonymous saved-state API. Sign-in is requested only at sync/remote-alert/household boundaries.

After OIDC return, an import preview offers **Tambahkan data perangkat ini** or **Jangan impor**. Deduplicate by canonical product/normalized keyword; never overwrite account data. Material list conflicts import as a reviewed separate batch. Clear local copies only after acknowledged server success and user confirmation. Logout clears private caches while guest data remains separate; shared-device clearing is prominent.

### 9.4 Household modules

Core: public catalog/evidence, region/language, auth/profile, personal watch/list, household create/join/members/roles, shared-list authorization, notification preferences, plugin lifecycle, and admin.

Default-off optional modules: **Pantry, Receipts & history, Tasks, Calendar, Documents**. Disabled hides navigation/deep links and stops new writes/cron/AI work. Disable retains data; export/purge is separate. No marketplace/runtime installation. These modules are excluded from the first vertical slice and later enabled one at a time.

### 9.5 Admin review

Separate queues for coverage, extraction, identity, optional category, and publication. The reviewer gets zoom/pan/rotate source pages, tile/crop highlighting, official source, raw response, normalized values, parser diff, and side-by-side identity evidence.

Actions include create/approve product, attach approved identity, reject, split, request re-extraction, leave uncategorized, and approve publication. No bulk approval of model-proposed new identities. Publication preview shows additions/removals/corrections, validity, exclusions and reasons, accepted counts, and cost.

### 9.6 Notifications and analytics

Remote alerts are post-slice, account-only, per-type opt-in, deduplicated, region/condition-aware, quiet-hour aware, and revalidated on open. Guests receive no remote-alert promise. Begin later with an in-app/push daily digest, not engagement spam.

Private first-party metrics may cover funnel success without raw queries, watch/list adoption, sign-in/import, coverage, rejection reasons, freshness failures, accessibility/performance, and notification delivery. None are presented as public popularity.

## 10. Design quality and acceptance

- Bahasa Indonesia default with full English parity, including admin/errors/conditions/notifications.
- Inclusive “kamu/keluarga” copy; no assumed housewife/gendered persona.
- WCAG 2.2 AA, visible nav labels, 44×44 targets, visible focus, keyboard-complete dialogs/filters, focus containment/return, reduced motion, screen readers, 200% zoom and 400% reflow.
- QA at 320, 390, 768, 1024, and 1440 widths, landscape/safe areas, long id/en strings, slow fonts, PWA offline/update, and current mobile/desktop browsers.
- Fixtures cover empty/one/long/missing-image/null-category/no-reference/member/multi-buy/quantity-cap/upcoming/expired/stale/two-region/partial-total/offline/error/missing-cost.
- Every request state distinguishes loading, genuine empty, no filter result, offline/server/rate-limit failure, stale, expired, and withdrawn.
- Owner approves responsive screenshots and truth copy before production UI sign-off.

The prototype's five items/four-column navigation, tiny text/targets, arbitrary offer math, hidden empty-date fallback, static notification promises, and desktop phone frame are explicit non-goals.

## 11. Cost, backup, and observability

Historical evidence is not a current benchmark: eight runs cost $29.40 total ($3.675/run average), $28.95 AI, approximately $27.21 OCR. No current cap or model switch follows from those numbers.

Every campaign reports calls/attempts/tokens/retries/provider cost/missing-cost by stage/model/prompt; discarded/replayed work; paid source/proxy/Actor/web usage; review minutes/corrections; accepted and published denominators. Zero denominator => null, never zero cost. Shared infrastructure shows incremental and allocated total cost with its method labelled.

Backup target: nightly consistent encrypted PostgreSQL dump plus WAL archiving to off-box restic/R2, aiming at **RPO <=15 minutes and RTO <=4 hours**, subject to a real drill. Back up registry, decisions, publication state, and pinned evidence manifests; source refetch is not a restore plan. Run an isolated restore before launch and quarterly thereafter.

Monitor API/DB/RSS, run state/checkpoint age, page/tile accounting, review age, publication failures, provider 429/quota/cost/missing-cost, outbox/cache lag, complete-campaign freshness, backup/restore, and host pressure. Exit 0 is never presented as quality acceptance.

## 12. Legacy coexistence and rollback

1. Build the fresh v2 stack without reading or writing legacy D1/R2 application state.
2. Point **`rumaq-v1.ahaqqu.com`** to the legacy Worker; verify its auth/API/PWA independently.
3. Point **`rumaq.ahaqqu.com`** to v2 as soon as the new public shell passes release QA. Empty approved data is acceptable; demo data is not.
4. Stop legacy scheduling/writes through the controlled deployment path. Existing legacy data remains untouched until the owner chooses deletion.
5. Campaign offers appear on the new site only after their human-approved publication batch.
6. Before v2 accepts account/list writes, hostname rollback to legacy is safe. After v2 accepts writes, rollback means the previous v2 artifact/DB recovery or a maintenance page—not returning users to stale legacy state.

The two-campaign gate still controls scheduled collection and next-store enablement; it does not keep the legacy UI on the primary hostname.
