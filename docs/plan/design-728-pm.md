# #728 — Category-edit UI on taxonomy review flags (PM design)

Status: **implemented** (PM persona design, 2026-11-19; §8's deviations were
reconciled by the manager — the revert is dual-surface, the vocabulary home is
the contract). Issue: `ahaqqu/RumaQ#728`. Builds on `design-728-architect.md` (binding): direct
`price_products.category` UPDATE (+ `category_version`, new `category_source`), append-only
`price_product_category_audit` receipt (0037 pattern), gated `canonical_index_state` bump, flag
settle `decided_source='human'` — one D1 batch. No read-path precedence layer (the
"nightly republish overwrites" premise verified false: ingest fills only `WHERE category IS NULL`).
This doc designs the product surface on top of that shape; it does not re-litigate it.

Verified anchors used throughout (all read this session):

- Row anatomy + chips: `frontend/src/pages/AdminReview.jsx` `ReviewRow` (~395–595) — assigned
  category + version chip (#626), kind chip + `rulesCategory` (#626 p2), rename action on the
  catalog (entry) side, decided-state provenance chip + per-row Undo.
- Panel precedent: `frontend/src/components/ProductRenameForm.jsx` — ONE component, two surfaces
  (explorer product detail + review row), identity read as the CAS source, error-vocabulary
  mapping, revert block with the latest-receipt-only rule.
- Picker: `frontend/src/components/CategoryPicker.jsx` — presentation-only, `onChange(slug|null)`,
  pinned "All categories" reset row, a11y-complete, ordered by whatever array the parent passes.
- Settlement precedent: `backend/src/lib/match-review.ts:942` `acknowledgePendingTaxonomy`;
  per-row undo `undoReviewDecision` (:907) re-opens the flag only (clears `decided_*`).
- Vocabulary reality: `/api/prices/meta` `categories` is `SELECT DISTINCT category` from data
  (`lib/prices.ts:211`) — NOT the sealed list. The override needs the sealed 49-bucket vocabulary
  as its validation authority (owner question below).
- Receipt precedent: `backend/migrations/0037_price_product_audit.sql` (append-only, denormalized
  `product_key`, no FKs, `reverts_audit_id` + unique partial index, version before/after).
- `price_products.product_key` is UNIQUE (0007) — one catalog row per key; `category_version`
  already exists (0030, taxonomy version string).

---

## 1. User story

> As an admin reviewing the taxonomy tab (`/admin/review` with the taxonomy reason chip), when a
> flag shows the rules head was right and the decision model wrong — or the assigned category is
> simply wrong — I can set the product's category from the sealed bucket list right there on the
> row, see what I'm overriding (assigned category + version, confidence, flag kind, rules answer),
> and after saving the flag is settled as a human decision, the catalog row carries my category
> with my name on it, and the nightly republish leaves it alone. If I change my mind, I can undo
> the flag decision per row (that never touches the category) and revert the category itself as a
> compensating, audited action.

Secondary story (same component, product surface): from the product's identity surface the admin
can see the category audit history and revert the latest override — the rename story with
`category` in place of `name`.

## 2. UX flow

### 2.1 Where the affordance lives

- Taxonomy tab rows only (`reason === 'taxonomy'`). Identity flags are match questions, not
  category questions — no picker there (scope cut §4).
- The affordance is a **"Set category" ghost button on the catalog (entry) side's action area**,
  beside the existing "Rename" button (`ReviewRow` already renders `renameOpen` there; the
  category panel gets its own sibling open-state, same #423 per-row pattern). It renders only for
  admins (`isAdmin` prop, like the rename form's alias gating).
- The bulk-ack panel (`TaxonomyAckPanel`) lead copy gains one sentence pointing at the new path
  ("Acknowledging records 'seen — the assigned category stands'; to correct it, use Set category
  on the row." — id + en). The ack stays for "the assigned category is fine, just noisy".

### 2.2 What the admin sees on the row (before opening)

Already shipped by #626/#626-part-2 and unchanged: assigned category + taxonomy version chip,
confidence %, method, flag-kind chip ("Low confidence" / "Rules disagreed"), `rulesCategory`
context text. **Additive:** when the joined `item_category_source === 'human'`, a "Human override"
marker chip beside the assigned-category chip — this is what makes a re-flagged-after-override row
legible (§6 edge cases) instead of silently looking like a fresh pipeline answer.

### 2.3 The panel (opens under the row, rename-form pattern)

One new component, `CategoryOverrideForm` — deliberately the `ProductRenameForm` pattern:

- **On open it fetches the product identity read** (`GET /api/admin/products/:productKey` with
  `enabled: panelOpen`): this is the CAS source (`expectedMetadataVersion`), the current-category
  source of truth, and the audit history for the revert block — exactly the rename form's
  "identity read is the source of truth" rule. Loading state: `aria-busy` + muted copy; identity
  404 (product row gone / re-keyed away): load-error block with Retry + Cancel (rename precedent).
- **Context header:** product name; current category + version + provenance line
  ("Assigned by pipeline · v0.4" / "Human override — set by <name> on <date> — reason: …").
  The frozen-pair note (`rename.frozenPairNote` equivalent): the pair's frozen labels are what
  the admin judged; only the canonical category moves.
- **The picker:** `CategoryPicker` reused presentation-only. The parent (not the component)
  builds the option array as **quick choices first, then the sealed vocabulary**: assigned
  category, then `rulesCategory` (if different), then the sealed 49 minus those two (deduped;
  slugs rendered as-is). Two small **additive** props with defaults preserving `ProductsView`
  behavior: hide the pinned "All categories" reset row (an override must name a slug — null is
  not a legal value) and allow the sr-only prefix / listbox aria-label to come from the
  override i18n keys instead of the `prices.categoryFilterLabel` namespace.
- **Optional reason** textarea: 200-char cap with live counter, same as rename (`REASON_MAX`
  precedent; a reason-less override is a complete receipt).
- **Save / Cancel:** Save (primary) disabled until a slug is picked and differs from the current
  category (mirrors rename's `canSubmit`, so backend `category_unchanged` stays a backstop, not a
  UI state) and while busy. Cancel resets the draft and collapses the panel via `onClose`.

### 2.4 What happens on save

One server round trip: `POST /api/admin/review/:id/category` (architect's route, body
`{ category, reason? }`). Server-side, one D1 batch: guarded product UPDATE (from-value CAS on
`category IS ?`, `metadata_version` bump) → gated receipt insert → gated index bump → flag settle
gated on the receipt (`status='approved', decided_source='human'` — the ack's exact vocabulary).
Response is the re-read row `{ item }`; the mutation then invalidates `['review']`, `['prices']`,
and the product identity key (rename's `onSuccess` invalidation set is the precedent — the
explorer, the meta filter domain and the queue all move together).

### 2.5 UI states after save (named for tests)

- **saved:** the row re-renders in the decided state — "✓ Approved" + provenance chip "Human"
  (the same `PROVENANCE_KEYS` chip the ack produces) — plus an additive "Category set to <slug>"
  hint beside it, and the "Human override" marker on the context chip row. The panel closes.
- **picker open / cancelled:** panel open with no server writes; Escape/outside-click closes the
  picker popover only (picker's own contract), Cancel collapses the panel.
- **invalid slug (`400 category_unknown`):** inline `role="alert"` block (rename-notice
  styling), the picked slug stays in the draft, admin re-picks. Reachable only via a stale page
  (taxonomy bump mid-session) or a hand-crafted request — still a pinned state.
- **stale (`409 stale_category`):** CAS lost — re-fetch the identity read, keep the picked slug,
  show "someone changed this category; review and save again" (rename's `stale_product`
  behavior: never auto-resubmit).
- **not found (`404`)**: product row gone since open — load-error block, Retry/Cancel.
- **forbidden (`403`)**: session lost / non-admin — generic forbidden copy, no retry.
- **busy / offline:** disabled Save + muted "Recording…" status line (ack panel's
  `taxonomyAckWorking` pattern); generic error state on failure.

### 2.6 The two undo actions (never conflated)

- **Flag undo** — the existing per-row Undo (`DELETE /api/admin/review/:id/decision`), unchanged.
  It re-opens the flag only (`decided_*` cleared). On a row whose category was overridden, the
  card's "Human override" chip explains why a pending flag sits on a corrected category; the undo
  confirm copy says so ("the category you set stays on the product").
- **Category revert** — a compensating receipt (`action='revert'`, old/new swapped,
  `reverts_audit_id`, one-compensation-per-set unique index): `DELETE
  /api/admin/products/:productKey/category` with `expectedMetadataVersion` (architect's route,
  rename-revert error vocabulary: `409 stale_product` / `409 stale_revert`). It never touches
  flag rows.
- **Where the revert affordance renders:** the identity read gains an additive `categoryAudit`
  array (same DTO discipline as the rename audit); `CategoryOverrideForm` renders a revert block
  whenever the latest receipt is an unreverted `'set'` matching the live category — the
  latest-receipt-only linear-history rule, and the button lives wherever the panel renders:
  the product detail surface (home base, with the audit history) and the review row panel (the
  admin fixing a mistaken override should not have to hunt for the product page). See §8
  deviation note 1 — the route and audit stay product-surface as architected; only the
  affordance is shared-component, which is exactly how the rename revert already works.
- **Reverted state:** provenance line returns to "Assigned by pipeline · v0.4" (or "No category
  assigned" — and note: a revert-to-null row is re-filled by the next publish's
  `WHERE category IS NULL` fill; that convergence is by design, not a bug).

## 3. What the backend gains for the UI (read shapes only)

All additive; the write shape is the architect's, unchanged:

- Queue read: `REVIEW_ROW_COLUMNS` gains `pp.category_source AS item_category_source`
  (architect §3) → `ReviewItem.itemCategorySource` + `REVIEW_ITEM_SCHEMA` + frontend type.
- Identity read (`GET /api/admin/products/:productKey`): product DTO gains
  `categorySource` (and exposes the existing `category`/`category_version` if not already
  present), plus the `categoryAudit` list (newest-first) so the product surface can show the
  history and the panel can derive revertability without a second read.
- Vocabulary route: `GET /api/admin/review/taxonomy/buckets` → `{ version, buckets }`
  (architect §5; home of the constants = owner question §7.1). The frontend never imports the
  contract package (verified: hand-written `src/lib/api.ts` wrappers), so the list rides this
  response; the taxonomy tab fetches it once (TanStack cache) and feeds both the picker arrays
  and the quick-choice reordering.

## 4. Scope cuts (and why)

1. **Bulk category edits** — no multi-row "set these N flags to X". An override is a per-product
   truth statement with a name on the receipt; bulk-setting invites catalog corruption at the
   exact moment the admin's attention is cheapest per row. The bulk ack already covers the
   "nothing to fix, just noise" volume; #177's ≥0.95 research pass shrinks what remains.
2. **Pipeline feedback loop** — overrides do not flow into the VPS classification cache in this
   issue (shape (b) is architecturally impossible without a pipeline write channel; the reserved
   follow-up owns it). The receipts + `ReviewExportRow` are the artifact that loop will consume.
3. **Non-admin roles** — the review surface is already admin-gated end-to-end; shoppers never
   see flags. No new role model.
4. **Set affordance outside the taxonomy tab (AdminPrices / explorer list)** — owner question
   §7.3. v1 ships review-surface only; because the component is shared and the route is
   product-addressed, the second placement is a small follow-up PR, not a redesign.
5. **Re-flag suppression** — stopping the pipeline from re-flagging an overridden product is
   pipeline-side (flags ride the classifier output, not RumaQ's stored category). Handled
   UX-side via the "Human override" chip + ack (§6).
6. **Sealed taxonomy changes, new buckets, merge/split of duplicate identities** — issue
   out-of-scope line; merge/split stays #423's "separate action" rule. The override fixes exactly
   the row the flag names.

## 5. Acceptance criteria (extends the issue checklist)

- [ ] An admin can set a category on a taxonomy-flagged item from the review surface, choosing
      from the sealed bucket list, seeing the assigned category + `rulesCategory` context.
  - [ ] The "Set category" affordance renders on taxonomy rows only, admin-only, on the catalog
        side beside Rename; the panel shows assigned category + version + provenance, confidence,
        flag kind, and `rulesCategory` before any write.
  - [ ] The picker offers the sealed vocabulary with the assigned category and `rulesCategory`
        pinned to the top as quick choices; no "All categories" reset row; picking the current
        category leaves Save disabled.
- [ ] The override survives the nightly republish (read paths prefer it per the designed
      precedence).
  - [ ] After save, `price_products.category` = the chosen slug, `category_source='human'`,
        `category_version` = the sealed version the picker was validated against,
        `metadata_version` bumped; the canonical index bump is gated on the receipt.
- [ ] Audit: who/when/from → to is queryable; the flag records a settled decision (`decided_by`
      human, like the ack path).
  - [ ] One override = one `price_product_category_audit` receipt row (`set`: actor, from, to,
        version before/after, optional reason, `review_item_id` link), append-only.
  - [ ] The flag row settles `status='approved', decided_source='human'` in the same batch as the
        product write; a flag already decided by a concurrent ack does not block the write.
  - [ ] The identity read exposes the category audit history newest-first.
- [ ] The two undo actions are independent and honestly labeled: per-row flag undo re-opens the
      flag only (copy says the category stays); category revert writes a compensating `revert`
      receipt (old/new swapped, `reverts_audit_id`), never touches flags, and is offered only for
      the latest unreverted override (second revert → `409 stale_revert`).
- [ ] A row whose product was already human-overridden shows the "Human override" marker chip
      (`item_category_source === 'human'`) — including a fresh flag raised after an override.
- [ ] Error states are pinned: `400 category_unknown` (invalid slug, draft preserved),
      `409 stale_category` (re-read, keep draft, never auto-resubmit), `404` (product gone),
      `403`, generic failure; the success state shows decided-row + "Category set to <slug>".
- [ ] No contract change required unless design proves one necessary — design selects the
      contract home for the sealed vocabulary (§7.1), so: additive contract export first (RumaQ
      PR), then `sync-contract.sh` in a pipeline PR (repo law); no pipeline behavior change.
- [ ] Frontend conventions + backend conventions followed; `./scripts/docs.sh` regenerated for
      the two new routes; tests via `./scripts/test.sh` (backend route tests incl. CAS race,
      receipt gating, revert-once; component tests for the panel states; `automation/tests/local/api/`
      scenario; E2E scenario: open panel → pick → save → flag settled → flag undo → revert on
      product surface).

## 6. Edge cases

- **Category null on one side.** Taxonomy flags are self-pairs — both sides name the same
  product, so "one side null" manifests as the assigned-category chip absent: either the row was
  never classified (`category IS NULL`) or the product row is gone. The panel still renders
  ("No category assigned" provenance line; picker starts unfiltered) — overriding a null category
  is a first-class path, not an error. Product row gone: identity read 404s, panel shows the
  load-error block; the override route also 404s.
- **Duplicate catalog identities (the architect's honest limitation: override fixes one row).**
  `product_key` is UNIQUE, but the same shelf product can exist under several keys (the
  near-duplicate identity problem the match queue exists for). The override corrects exactly the
  row the flag names; sibling rows keep the model's answer. The receipt's denormalized
  `product_key` makes "which row was fixed" queryable. Not fixed by UI hints in v1 — documented
  here as the known limitation; if usage shows sibling churn, the follow-up is a "same-name
  siblings" hint on the panel, not a bulk write.
- **Multiple pending flags for the same product (re-flag loop).** Flags recompute every run from
  the pipeline cache, so an overridden product can re-appear as a NEW pending flag next night.
  v1 settles only the flag the panel was opened from; siblings stay pending (ack or per-row).
  The "Human override" chip makes those rows self-explaining — the admin sees the correction
  already in place and acks. The success notice says so honestly ("other pending flags for this
  product, if any, remain in the queue"). Settling all pending flags for one product is
  deliberately NOT v1 (owner question §7.5).
- **#21 re-key interplay.** The override binds to `price_products.id`; the receipt denormalizes
  `product_key` and carries no FK, so it survives both re-key outcomes:
  (a) same UUID row, re-derived key — the override survives (it is bound to the row, not the
  key); old pair blobs referencing the frozen key join to nothing → assigned chip renders null
  until the product re-flags under the new key;
  (b) re-key orphans the row (new UUID for the identity) — the old override is bound to the old
  UUID; the new row starts uncategorized and the next publish fills it; the receipt still reads
  as a fact about the catalog ("admin set X on key K at T"), and the admin re-overrides on the
  new flag if needed. The architect's #21 coordination note stands: re-key mapping must carry
  override/receipt rows explicitly.
- **Undo ordering.** The two actions are independent facts; any order is coherent:
  override → flag undo → flag pending, category stays human (chip explains it); bulk-ack later
  re-settles it. override → revert → category restored (pipeline value or null — a null is
  re-filled by the next publish's `WHERE category IS NULL` fill), flag stays settled; a later
  flag undo on that row works normally. Re-override (X → Y) is allowed at any time (new receipt);
  revert compensates only the latest set (unique partial index is the storage backstop, the
  route's CAS is the primary guard — 0037's exact division of labor).
- **Concurrent ack + override.** Independent rows, one batch each; the ack never touches
  `category`, the override's flag-settle is gated and reports no change when the flag is already
  decided — the product write still lands. No interleaving produces a receipt-less settle or a
  settle-less receipt (both gated in the same batch).
- **Stale vocabulary.** A taxonomy bump between page load and submit yields `400
  category_unknown`; the UI keeps the draft and the admin re-picks from a refetched bucket list.

## 7. Owner question pack (recommendations for the morning report)

1. **Sealed-vocabulary home — contract vs local copy.** Recommendation: **contract** (agree with
   the architect): the local-copy failure mode lands on the admin's screen (a bumped bucket
   missing from the picker silently breaks the exact human path this issue builds), while the
   `sync-contract.sh` flow already exists as routine repo law; additive export, no pipeline
   behavior change. Cost: one contract PR + one pipeline sync PR, once.
2. **Override route auth — session-admin vs review-script token.** Recommendation: **session
   admin only** (`propsAuthMiddleware`, not `propsOrReviewScriptAuth`). A category override is a
   catalog WRITE whose receipt must name a human — `decided_source='human'` / `actor_user_id`
   must never be stampable by the scripted operator identity (#656's token exists for queue
   reads/evaluation).
3. **Set-affordance surface — review-surface-only vs also AdminPrices.** Recommendation:
   **review-surface-only for this issue.** Flags are the only place a correction is _prompted_;
   an unprompted picker on the explorer invites drive-by edits. Ship the shared component so the
   explorer-detail placement is a small follow-up PR if owner wants it.
4. **Pipeline feedback loop follow-up — file now or after usage data.** Recommendation: **file
   the follow-up issue now** (cheap, keeps the loop on the board, the receipt + export are its
   defined input), implement only if the re-flag loop proves noisy after a few weeks of
   overrides.
5. **Flag-settle breadth (new, surfaced by this design) — settle the opened flag only vs all
   pending flags for the same product.** Recommendation: **opened flag only in v1** (per-row
   semantics match the decision route; honest limitation documented in UI copy), revisit if the
   nightly re-flag loop makes the queue noisy in practice — the "Human override" chip is the
   mitigation that makes v1 tolerable.

## 8. Deviations from the architect (explicit, for reconciliation)

1. **Revert affordance placement.** The architect's binding text places the revert on the
   product surface (route `DELETE /api/admin/products/:productKey/category`, home with the
   rename handlers — adopted verbatim). This design additionally renders the revert affordance
   inside the shared `CategoryOverrideForm` on the review row (identity-read-driven, latest
   receipt only), mirroring how the rename revert already rides `ProductRenameForm` on both of
   its surfaces. Route, audit, and history stay product-surface; only the button is shared.
   No architecture change; flagging because the architect's sentence could be read as
   product-surface-only UI.
2. **Vocabulary home recommendation phrasing.** The architect recommends contract-home with a
   local fallback; this doc recommends contract-home outright (owner question §7.1) — same
   landing spot, firmer stance, because the admin-facing failure mode of the local copy is the
   one thing this issue cannot afford to break silently.

Everything else — write shape, CAS design, receipt schema, gated batch, undo semantics, error
vocabulary, route addressing — is adopted from the architect's verified design without change.

## 9. Verification notes (for the planner)

- Backend route tests: sealed-list accept/reject; `category_unchanged`; CAS race → 0 changes →
  no receipt, no bump, flag still pending; receipt+index-bump gating; settle on pending vs
  already-decided; revert-once + `stale_revert`; `category_source` transitions incl. revert-to-null
  re-fill; migration EXPLAIN pins per the 0037 precedent; zero AI-boundary surface (no provider
  calls — `ai-boundary.test.ts` untouched).
- Frontend component tests: panel open/saved/reverted/error states; picker quick-choice ordering
  and no-reset-row mode; identity-loading and identity-404 blocks; invalidation set on success.
- Automation: `automation/tests/local/api/` override + revert scenario; E2E: taxonomy tab → set
  → settled row → flag undo (category stays) → product-surface revert (flag stays settled).
- i18n: all new strings id + en; bulk-ack lead copy updated; no backend strings rendered
  (Household error-vocabulary precedent — map codes to keys).
