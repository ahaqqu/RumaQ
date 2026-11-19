# #728 Design — category-edit UI on taxonomy review flags (PRODUCT ARCHITECT)

> Status: **implemented** (backend: migration 0052 + override/revert lib +
> routes; frontend: CategoryOverrideForm on the taxonomy rows, dual-surface
> revert). Owner decisions sealed 2026-11-19: contract-home vocabulary
> (`TAXONOMY_BUCKETS`/`TAXONOMY_VERSION`), session-admin-only auth,
> review-tab-only affordance, opened-flag-only settlement. Issue:
> `ahaqqu/RumaQ#728`. Pipeline consumption of the overrides is a reserved
> follow-up (the canonical index already carries them).

Date: 2026-11-19. Persona: product architect. Counterpart: PM persona doc (manager reconciles).
Method: code-verification only (no D1 queries needed — every question the code could answer, the code answered).

---

## 0. Verified ground truth (read before judging the shapes)

The issue's driving premise — "the pipeline re-assigns `category` on every run; a naive D1 edit would be silently overwritten the next night" — is **false for the current v2 contract**. Verified in code:

| Writer of `price_products.category`                      | Behavior                                                                                                                                                                                                                                                                                 | Proof                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nightly ingest (`backend/src/lib/ingest-v2.ts`)          | New keys: INSERT with the payload's proposed category. **Existing keys: the category write is `WHERE product_key = ? AND category IS NULL`** — fill-once, never overwrite. The shared-timestamps UPDATE for existing rows touches `last_seen_at`/`updated_at` only.                      | ingest-v2.ts:270–303 (INSERT for `newKeys`), 305–323 (existing rows: timestamps only), 325–340 (`if (row.category !== null) continue` + `AND category IS NULL`) |
| Replay backfill (`backend/src/lib/taxonomy-backfill.ts`) | Same NULL-fill discipline (`AND category IS NULL`), idempotent by design; its work list is `WHERE category IS NULL`.                                                                                                                                                                     | taxonomy-backfill.ts:47, 115                                                                                                                                    |
| v1 ingest (`backend/src/lib/ingest.ts`)                  | Does not touch category at all (only `runReportSchema` + `getPricesStatus` are consumed from it).                                                                                                                                                                                        | grep: zero category writes                                                                                                                                      |
| Pipeline side                                            | The category rides the payload as a **null-fill proposal** ("a backend null-fill proposal, never a canonical write" — publish/payload.ts:236); the name-hash cache's model-sourced answers are final and re-flag (not re-decide) each run; the RumaQ-side ingest enforces the null-fill. | classify.ts:245–263, payload.ts:235–248                                                                                                                         |

So **a direct, human write to `price_products.category` survives the nightly republish by construction**. The real lifetime risks are elsewhere (§3 key churn) and the real design cost of a shadow override store is read-path precedence duplication (§2).

Category read paths (all read the column directly — a direct write reaches every consumer with zero read-path changes):

1. Explorer rows + exact filter (`p.category = ?`, api.ts:4247) and the filter domain `/api/prices/meta` → `SELECT DISTINCT p.category` (prices.ts:209–220).
2. Review card's `item_category` chip — LIVE `LEFT JOIN price_products pp ON pp.product_key = r.item_product_key` (match-review.ts REVIEW_ROW_JOINS, 432–434).
3. Brochure product rows (brochures.ts:297, 331).
4. **The canonical index → pipeline**: `getCanonicalIndex` (ingest-v2.ts:575–660) serves `price_products.category`/`category_version` on every product; the pipeline caches the index ≤48 h and matches against it. A corrected category therefore **flows back to the pipeline automatically** — this matters for shape (b) (§2).
5. Contract integrity constraint: `canonicalProductSchema.category` caps at `maxLength(50)` (contract/src/index.ts:247) and `getCanonicalIndex` fails the WHOLE index (`CanonicalIndexIntegrityError` → 500) if any row violates it. Any human write must be validated to ≤50 chars — the sealed slugs (max 23) are strictly inside.

The #626 recording precedent: `acknowledgePendingTaxonomy` (match-review.ts:942–969) settles a flag as `status='approved', decided_at, decided_by, decided_source='human'` via one statement; `undoReviewDecision` (907–921) clears the decision fields; the ingest upsert's DO UPDATE list never mentions status/decided_* (never-reopen invariant, lines 92–111). The admin rename path (0037, `renameProduct` in lib/canonical-products.ts:992–1100) is the canonical-write precedent: guarded UPDATE (metadata_version CAS) → gated audit receipt → gated `canonical_index_state` bump, all one `db.batch` transaction.

---

## 1. RECOMMENDED SHAPE — (a′) backend-owned canonical category write with provenance + audit receipt

An admin override **writes `price_products.category` directly** (plus `category_version`, a new `category_source` provenance column), records an append-only receipt (0037 pattern), bumps the canonical index version, and settles the flag exactly like the ack does (`decided_source='human'`). No shadow table, no read-path precedence.

This is shape (a) in the issue's taxonomy, implemented as the _simpler variant the code verification earns_: the issue framed (a) as "override store … that read paths prefer over the pipeline-assigned category" — that framing assumes the pipeline column keeps moving, which it does not. The column IS the override surface; the pipeline's assigned value is null-fill-only, so human writes stand.

### Why not a shadow override store (a as literally framed)

A separate table with "override > pipeline" precedence must be re-implemented in **every** category consumer: explorer rows, the filter domain (`DISTINCT` would need a merge of override slugs not currently assigned — otherwise a corrected-to bucket with no other products vanishes from the filter list), the review card join, brochure rows, and the canonical index build (or the pipeline never sees the correction). Five replication points, each a future drift bug ("new read path forgot the precedence join"), to preserve a pipeline-assigned value whose only consumer is the review card's context chip. The audit receipt preserves the from→to history (what the shadow store's "pipeline value" was for); the card already shows `rulesCategory` and the receipt is queryable. The shadow store buys nothing the receipt + provenance column don't, at materially higher complexity.

### Why not (b) — feedback into the pipeline's classification cache

- **RumaQ cannot write it.** The cache is `category-cache.json` in the VPS state dir, keyed `sha256(name)`, written only by the scraper run (categorize/cache.ts). There is no channel; inventing one (Worker→VPS write API) violates the deploy topology and the standing directive that category intelligence lives pipeline-side.
- **It is unnecessary for correctness here.** The cache answers names; the product row carries the published assignment. Since the ingest is null-fill-only, the human override on the row is never contested by the cache. A cache-mismatch (rules head still disagrees with the human) would keep RE-FLAGGING the name each run — but the flag lands on the SAME self-pair row `(item_product_key, entry_product_key)`, whose status the ingest never resets (never-reopen invariant): the acked/overridden flag stays settled. The queue does not fill back up.
- **A free partial-(b) already exists**: the corrected category rides the canonical index to the pipeline on its next fetch (≤48 h). If the pipeline ever wants the human signal (e.g. #177's research pass seeding its prior, or the matcher-feedback loop consuming overrides the way `ReviewExportRow` does for identity), the seam is the index — no new write channel, no contract change. That pipeline-side consumption is out of scope here (the issue says so explicitly).
- Per the standing directive (LLM/research calls live pipeline-side): RumaQ records the human fact; the pipeline decides what to do with it.

### Why not (c) — review-queue-state only

It leaves the catalog wrong: the explorer, brochures, and the index keep carrying the doubtful category while the queue says "seen". The flag is a signal about the row; fixing only the signal is the weakest shape and the issue already ranks it so.

---

## 2. Data model (migration 0052_category_override.sql — next free number)

```sql
-- Provenance for the category a human set. NULL = pipeline-assigned
-- (every existing row; the ingest and backfill never set it).
ALTER TABLE price_products ADD COLUMN category_source TEXT
  CHECK (category_source IN ('pipeline', 'human'));

-- Append-only receipt, the 0037 pattern (a RECEIPT, not a child of the
-- product: product_id/actor_user_id are PLAIN TEXT handles with no FK so the
-- fact survives the row and the account; product_key denormalized so the
-- receipt stays readable across a re-key).
CREATE TABLE IF NOT EXISTS price_product_category_audit (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,              -- plain handle, no FK (0032/0037 rationale)
  product_key TEXT NOT NULL,             -- frozen at mutation time (0037)
  actor_user_id TEXT NOT NULL,           -- plain handle, no FK
  action TEXT NOT NULL CHECK (action IN ('set', 'revert')),
  old_category TEXT,                     -- NULL when the row had none
  old_category_version TEXT,
  new_category TEXT NOT NULL,
  new_category_version TEXT,
  reason TEXT,                           -- optional free text (normalizeReason pattern)
  review_item_id TEXT,                   -- the flag this override settled; NULL on product-surface edits
  metadata_version_before INTEGER NOT NULL,
  metadata_version_after INTEGER NOT NULL,
  reverts_audit_id TEXT,                 -- compensation pointer; NULL on a 'set'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One compensation per set, structurally (0037's revert-once backstop).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppcat_audit_revert_once
  ON price_product_category_audit(reverts_audit_id) WHERE reverts_audit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ppcat_audit_product
  ON price_product_category_audit(product_id, created_at);
```

Notes:

- **`category_source` vs. deriving from receipts**: the only consumer this issue needs it for is the review card's provenance chip ("human-set"); a scalar column is one write site and one JOIN column vs. a correlated latest-receipt subquery on a 200-row page read. The canonical index does NOT carry it (no contract change needed for the index; the pipeline never re-proposes over non-null anyway). Revisit only if the pipeline asks.
- `category_version` moves with `category` (ingest's own invariant, ingest-v2.ts:329–330): the override stamps the sealed version its vocabulary was validated against (`TAXONOMY_VERSION`, §3).
- `metadata_version` bumps on every override write, per the "every audited write bumps the version" rule the rename/revert and ingest size-fill already follow.

### Read-path precedence

**None required — that is the point.** Override = the column. Every existing consumer (explorer, meta filter domain, review card, brochures, canonical index) shows the human value with zero changes. The ONE additive read: `REVIEW_ROW_COLUMNS` gains `pp.category_source AS item_category_source` (ReviewItem + `REVIEW_ITEM_SCHEMA` + tests, additive like the #626 fields).

---

## 3. Sharpest risk — product-key churn (the #21 collision), addressed head-on

`product_key` derives from the raw name (`makeProductKey(name, brand, unit)`); pipeline #21 (identity program, step 1 research DONE, step 2 = owner's A-vs-B decision pending) exists precisely because that key is not durable: a re-match or re-key founds a **new row** (new UUID) — new row → ingest INSERTs the pipeline-assigned category → the human override on the old row is orphaned AND the same doubtful name re-flags under the new key as a fresh pair row.

Mitigations, in order of what this design controls:

1. **Bind the override to the row, not the key.** The audit receipt carries `product_id` (the UUID PK) as the primary handle with `product_key` denormalized for readability — the exact 0037 decision ("a rename … never touches product_key/UUID"; UUID survives renames and is #21 option B's identity). Renames are already safe (0037); #21 option A re-keys that keep the row are safe for the row-bound override.
2. **Ride #21's explicit mapping.** #21's acceptance criteria already require "re-key only with an explicit mapping; backfill both the pipeline catalog and price_products". Overrides and their receipts are one more row class that mapping must carry. This is a coordination note for the manager to attach to #21 when this design lands — not code in this issue.
3. **Honest limitation, documented not engineered around**: the same physical product under two keys TODAY (4+2 duplicate keys per the #21 research) — an override fixes one row; its duplicate keeps the doubtful category and keeps its own flag. Merging is #21's explicit non-goal for v1; fixing one row is still strictly better than fixing none, and the receipt makes the partial fix visible.

A name-hash key (mirroring the pipeline cache) was considered and rejected: names are exactly what churns (#21's whole point), and RumaQ would hold a hash of a name it does not normalize — strictly worse than the row handle.

---

## 4. Flag settlement + undo semantics

**Settlement** (one `db.batch`, the decide/ack pattern):
`overrideTaxonomyCategory(db, { reviewItemId, category, actorUserId, reason, now })` in `match-review.ts` (it owns the pair blob, the row reads, `getReviewRow`; imports `indexBumpStatement` from canonical-products.js):

1. Read the review row; resolve `itemProductKey` → product (`id`, current `category`/`category_version`/`metadata_version`). 404 if the pair blob is malformed or the product row is gone.
2. Guard: requested category ≠ current category → 400 `category_unchanged` (confirming is the ack's job — the bulk action and the plain decide both already do it).
3. Batch (D1 transaction, statements see each other's writes):
   - **(1) guarded product UPDATE** — `SET category=?, category_version=?, category_source='human', metadata_version=metadata_version+1, updated_at=? WHERE id=? AND category IS ?` (NULL-safe from-value CAS; the review card does not carry `expectedMetadataVersion`, so the from-value plays the CAS role the rename gives to metadata_version — a concurrent category write 0-rows the update).
   - **(2) gated receipt INSERT** — `INSERT … SELECT … FROM price_products WHERE id=? AND category=? AND metadata_version=?` (the renameProduct gating-triple pattern: a stale request writes no receipt).
   - **(3) `indexBumpStatement(db, auditId, 'price_product_category_audit')`** — requires extending the union `'price_product_audit' | 'price_product_alias_audit'` with the third table (one line, canonical-products.ts:713–725). Exactly one index bump per committed override; the pipeline picks up the corrected category within its ≤48 h cached-index window.
   - **(4) flag settle, gated on the receipt** — `UPDATE match_review_items SET status='approved', decided_at=?, decided_by=?, decided_source='human' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM price_product_category_audit WHERE id=?)`. The settle is decided_source='human' exactly like the ack (issue acceptance: "it should record a decided_source decision like the ack does"). If the product write lost a race, the receipt is absent and the flag stays pending — intent is atomic.
   - Re-read `getReviewRow(db, id)` → return `{ item }` like decide/undo.
4. **Allowed on already-decided rows**: the card renders decided rows (`status='all'`), and fixing the catalog there is legitimate; statement (4)'s `status='pending'` guard makes the settle a no-op while the category write + receipt still commit.

**Undo — two independent, honestly-labeled actions** (consistent with, not conflated with, `undoReviewDecision`):

- _Flag undo_ (existing `DELETE /api/admin/review/:id/decision`, unchanged): re-opens the flag only. The category keeps the human value; the card's `item_category_source='human'` chip explains why a pending flag sits on a corrected category. Undoing an already-pending row stays an idempotent no-op, per current semantics.
- _Category revert_ (new, product-surface, the rename-revert precedent): `DELETE /api/admin/products/:productKey/category` with `expectedMetadataVersion` (the identity surface HAS it) → compensating receipt `action='revert'`, `reverts_audit_id` → the latest 'set' (one-per-set, unique partial index; 409 `stale_revert` on a second compensation, 409 `stale_product` on CAS miss), restores `old_category`/`old_category_version`, `category_source` recomputed (earlier unreverted 'set' exists → `'human'`, else NULL), index bump. Does NOT touch flag rows — the flag decision and the catalog state are separately auditable facts, and the receipt links them (`review_item_id`) when they came together.

---

## 5. API surface + validation + the sealed vocabulary question

**Where does RumaQ get the sealed 49-bucket list?** Verified: it has NO copy. The list lives only in the pipeline (`RumaQ-pipeline/groceries/scraper/src/categorize/taxonomy.ts`, `CRITERIA`/`BUCKETS`, sealed v0.4, hash-pinned). `/api/prices/meta` serves `SELECT DISTINCT p.category` — the _assigned_ slugs, not the sealed domain: a bucket with zero assigned products (exactly where a correction often needs to GO — e.g. `alat-tulis-kantor` was empty before v0.4 claimed paper) is missing from it. The contract references the vocabulary (`rulesCategory` comment: "the sealed 49-slug taxonomy vocabulary") but does not contain it.

**Recommendation: prove the contract change necessary and put the list in the contract.**

- Add to `contract/src/index.ts`: `export const TAXONOMY_VERSION = 'v0.4'` and `export const TAXONOMY_BUCKETS: readonly string[]` (the 49 slugs, pipeline declaration order). Both are data the contract already _describes_; repo law for shipping is established (RumaQ PR first → `./scripts/sync-contract.sh <sha>` in a pipeline PR). The pipeline keeps `BUCKETS = Object.keys(CRITERIA)` and its verbatim hash test asserts equality with the contract list — one test, one source, drift fails CI on both sides.
- Server-side validation is then strict: `pipe(string(), maxLength(50), picklist-ish membership in TAXONOMY_BUCKETS)` → 400 `category_unknown` otherwise. Strictness is not pedantry: the pipeline's own classifier treats an out-of-domain answer as a hard failure ("a guessed bucket is worse than none … must never ride the payload, the cache, or the explorer's filter domain" — classify.ts:291–303) because a stray slug pollutes `/api/prices/meta`'s DISTINCT domain permanently. A human typo path with loose validation (the backfill's `maxLength(100)` precedent) reintroduces exactly that. The 50 cap also protects `getCanonicalIndex`'s whole-index contract parse (§0.5).
- The override stamps `category_version = TAXONOMY_VERSION` — honest provenance (the answer was produced against v0.4's vocabulary), matching ingest's version-pairing invariant.
- _Fallback if the owner rejects contract churn_: a RumaQ-local `TAXONOMY_BUCKETS` constant + a test pinning count=49 and the version string. Cost: every taxonomy bump (v0.5+) needs a remembered RumaQ edit — the failure mode is silent validation rejection of a legitimate new bucket. The contract route makes the bump one coordinated PR, which is what "sealed" means.

**Routes** (all `describeRoute`-annotated, Valibot-validated, regenerate `docs/API.md`):

- `POST /api/admin/review/:id/category` — body `{ category: string, reason?: string }`; `requireAdmin` (session — deliberately NOT `propsOrReviewScriptAuth`: #656's token is a scripted-operator identity for queue reads/evaluation, and a script stamping catalog categories deserves a human's user id in `actor_user_id`; flagged as an owner question anyway). 200 `{ item }`; 400 `category_unknown` / `category_unchanged`; 404 unknown review item or product row gone; 409 `stale_category` (CAS lost — re-read and retry).
- `DELETE /api/admin/products/:productKey/category` — body `{ expectedMetadataVersion: number }`; `requireAdmin`; reuses the rename route's error vocabulary (409 `stale_product`, `stale_revert`). Lives with the rename/revert handlers (api.ts §5238 block) since it is a canonical write on the product surface.
- `GET /api/admin/review/taxonomy/buckets` — `{ version, buckets }` from the contract constants; the frontend does NOT import `@rumaq/contract` (verified: hand-written `src/lib/api.ts` wrappers), so the vocabulary rides an API response. Alternatively fold into an existing taxonomy admin response — new tiny route is cleaner.

**Frontend** (AdminReview taxonomy card):

- "Set category" affordance beside the decide/ack buttons on taxonomy cards; inline panel with quick-choice chips (assigned `itemCategory`, `rulesCategory`) and a searchable picker. **Reuse `CategoryPicker.jsx`** — it is presentation-only (reports the chosen slug), a11y-complete, and already built against this exact vocabulary; needs a small variant to hide the pinned "All categories" reset row (meaningless for a set operation) and `review.*` i18n keys (id + en) instead of `prices.*`.
- Mutation: TanStack `useSetOverrideCategory` with the file's established optimistic pattern (`patchReviewCaches`-style flip to approved + provenance stamp, snapshot/rollback, invalidate `['review']` on settle). The vocabulary query is a staleTime-forever server state hook (`review.buckets`).
- Decided rows render the affordance too (§4: override-on-decided is legal); the card's category chip shows the human-set provenance when `itemCategorySource === 'human'`.

**Tests** (conventions: route-level Vitest + Hono request helper, automation scenario):

- Backend: sealed-list acceptance/rejection; `category_unchanged`; CAS race (concurrent category change → 0 changes → no receipt, no bump, flag still pending); receipt + index-bump gating (stale request bumps nothing); settle on pending vs decided; undo idempotence; revert-once; `category_source` transitions; canonical index still parses after an override (the 50-cap guarantee).
- Frontend: picker variant, quick chips, optimistic flip + rollback, i18n (id+en).
- Automation: `automation/tests/local/api/` scenario for the override route; E2E for the card flow per the checklist.

---

## 6. Conventions compliance

- Backend checklist: migration 0052 (never edit applied ones); no new bindings/env vars (D1 only, no AI — this feature makes **zero provider calls**; the AI-boundary rule is untouched); route in the existing api app under `/api/admin/review` + `/api/admin/products` with `propsAuthMiddleware`-style path middleware consistent with the decision/ack routes; Valibot input validation; parameterized SQL; business logic in `lib/` (match-review.ts + canonical-products.ts extension); `describeRoute` + `./scripts/docs.sh`; household-scoping N/A (global price domain, like rename/review).
- Backend conventions, "extract logic into services": the override lib function is the one writer of the four-statement batch; handlers stay HTTP-only (the rename block's stated discipline).
- Frontend checklist: no new route file (AdminReview exists); API fn + query hook in `lib/api.ts`/`lib/queries/review.js`; i18n id+en; existing components/icons; optimistic snapshot/rollback + invalidate-on-settle; unit tests next to code; E2E scenario.
- Repo law: contract change ships RumaQ-first, then `sync-contract.sh` in a pipeline PR — but the pipeline PR is a one-line test assertion, not behavior change, and can land with the next natural pipeline PR if the owner prefers batching.

## 7. Alternatives rejected (summary)

| Alternative                                              | Why rejected                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a-literal) Shadow override table + read-path precedence | 5 consumer sites to duplicate precedence (incl. the DISTINCT filter domain and the index build) to protect a value nothing but the card's context chip reads; the receipt + `category_source` preserve the same information without the joins. Rejected _because_ the overwrite premise verified false — kept honest by §0's evidence. |
| (b) Write/feedback the pipeline cache                    | No channel (VPS-local file, RumaQ has no write path); unnecessary for correctness (null-fill ingest + never-reopen flags); standing directive keeps classification intelligence pipeline-side. The canonical index already carries the correction back for free; pipeline-side consumption is a separate issue if wanted.              |
| (c) Queue-state-only                                     | Leaves the catalog wrong everywhere the queue isn't.                                                                                                                                                                                                                                                                                   |
| Name-hash-keyed override store                           | Names are the churning entity (#21); RumaQ doesn't normalize names; strictly worse than the row handle.                                                                                                                                                                                                                                |
| Override writes without receipts (just UPDATE)           | Fails the issue's audit acceptance criterion and the 0037 precedent; "who/when/from→to" is the point of the feature.                                                                                                                                                                                                                   |
| Loose validation (backfill-style ≤100 chars)             | A stray slug permanently pollutes the explorer filter domain and can 500 the canonical index (>50 chars); the pipeline treats out-of-domain as a hard failure for the same reason.                                                                                                                                                     |
| Settle-then-write or write-then-settle as separate calls | Intent atomicity: the flag settle is gated on the receipt inside one batch (the decide+agreement one-batch precedent, match-review.ts:874–893).                                                                                                                                                                                        |

## 8. OPEN QUESTIONS for the owner

1. **Sealed-vocabulary home (drives a contract change):** add `TAXONOMY_BUCKETS` + `TAXONOMY_VERSION` to `@rumaq/contract` (recommended; strict server validation, single source, bump = one coordinated PR via sync-contract), or keep a RumaQ-local copy with a drift test (zero contract churn, silent-stale risk on every taxonomy bump)? The issue's "no contract change unless proven necessary" clause is invoked here — the proof is §5.
2. **Pipeline feedback loop:** ship RumaQ-local (recommended for #728) — but should a follow-up pipeline issue consume human overrides (the canonical index already carries them; options: #177's research pass treats an index category as a prior, or the matcher-feedback loop exports category overrides like `ReviewExportRow` does for identity)? If yes, file after this design lands, per the issue's scope note.
3. **#21 coordination:** when the identity model decision (A vs B) lands and re-keying happens, category overrides + `price_product_category_audit` receipts must ride #21's explicit re-key mapping. Confirm #21's acceptance criteria should name override/receipt rows explicitly (manager to attach to #21 — no issue posting from design).
4. **Scripted overrides:** category override route = session-admin only (recommended) or also the #656 review-script token (`propsOrReviewScriptAuth`)?
5. **Product-surface edit in this issue?** The revert route lands on the product identity surface (it needs `expectedMetadataVersion`); the SET affordance is review-surface-only this issue (recommended) — a set affordance on AdminPrices identity panel is a natural follow-up, not scope here.
