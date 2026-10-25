# Phase 05 — Purchase History & Ship

**Status:** Done (PR #81 — purchase history, patterns, AI chat, and ship readiness)  
**Priority:** P0 (MVP blocker)  
**Source PR:** PR 6 — Purchase History + Ship (from `docs/PROJECT_PLAN.md`)  
**Estimated effort:** Medium (history UI + deployment polish)

---

## Objective

Let users review past purchases and spending patterns, refine run-out estimates from real history, and finalize the deployment configuration so the app goes live. The user impact is: _understand what you bought, when, and how it affects future stock_.

This is the final P0 phase. After it, the app is fully functional end-to-end and ready for release.

---

## Acceptance Criteria

1. `GET /api/purchases` returns purchase history with date/store filters and month-grouped totals.
2. The History page shows month-grouped purchases, line items, totals, and pattern detection (e.g., "you buy milk every 5 days").
3. Run-out estimates are recalibrated using the full purchase history.
4. `POST /api/ai/chat` answers Assistant messages with persona-aware, household-scoped responses, and the Assistant panel uses it instead of mocks.
5. Cloudflare Pages and Worker deployment configs are finalized and documented.
6. R2 bucket setup is documented.
7. Secrets management is documented step-by-step.
8. The plan in `docs/PROJECT_PLAN.md` is updated to mark all P0 items as `Done`.
9. End-to-end verification passes on the live URL.
10. All tests pass (`vp test`, integration, E2E smoke).
11. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phases 01-04 are merged.
- D1 schema has `purchases`, `purchase_items`, `items`, `stores`.
- Existing History page is mocked in `frontend/src/pages/History.jsx`.
- Existing deployment scripts in `scripts/deploy.sh` and `scripts/deploy/deploy-cf.js`.

---

## Scope

### Backend

1. **Purchase history endpoint** (`GET /api/purchases` in `backend/src/apps/api.ts`):
   - Query params: `store` (store_id), `from` (ISO date), `to` (ISO date), `q` (search item name), `group_by` (optional: `month`, `store`).
   - Return a list of purchases with nested items: `{ id, date, store, total, items: [...] }`.
   - Support pagination (`limit`, `cursor`) to avoid huge responses.
   - Compute month-grouped totals in SQL or in the Worker.
   - Filter by `household_id`.

2. **Purchase detail endpoint** (`GET /api/purchases/:id`):
   - Return a single purchase with full items and signed receipt URL or receipt proxy URL.
   - Verify household ownership.

3. **Run-out recalibration** (`backend/src/lib/stock.ts` extension):
   - Use the full purchase history (not just recent) to compute average daily consumption.
   - Weight recent purchases more heavily if desired (simple linear weighting).
   - Handle seasonal gaps: if no purchase in the last 90 days, fall back to default.
   - Recalibrate all stock rows when the phase is implemented, or on each purchase creation.

4. **Pattern detection helper** (`backend/src/lib/patterns.ts` or inline):
   - For a given item, compute average purchase interval and average quantity.
   - Return a summary like `{ item_id, avg_interval_days, avg_qty, last_purchase_date, pattern: 'every N days' }`.
   - Expose via `GET /api/purchases/patterns` or include in history response.

5. **AI chat endpoint** (`POST /api/ai/chat`):
   - Valibot schema: `message` (string, required) and optional `history` (short array of recent messages for context, capped).
   - Decrypt the user's AI key; return 402 if not configured. Enforce the daily `ai_usage` limit and increment per call (reuse the scan endpoint's pattern).
   - Build the system prompt server-side from the user's persona settings (port the `buildSystemPrompt` logic from `frontend/src/lib/persona.js`) plus household-scoped context: low-stock items, expiring items, and the active plan summary.
   - Use the generalized text-prompt provider layer from Phase 04; stream the response if the provider supports it, otherwise return a plain JSON reply.
   - Never include another household's data in the prompt.

6. **Deployment config finalization**:
   - Ensure `backend/wrangler.cloudflare.toml` has all bindings: `DB`, `RECEIPTS`, `KV` (if used for rate limiting later), routes, vars.
   - Ensure `frontend/.env` or build pipeline injects `VITE_API_BASE` correctly.
   - Update `scripts/deploy.sh` to run all necessary steps in order.
   - Update `scripts/deploy/deploy-cf.js` to automate R2 bucket creation and binding.

### Frontend

1. **API client additions** (`frontend/src/lib/api.js`):
   - `getPurchases({ store, from, to, q, cursor })` → `GET /api/purchases`
   - `getPurchasePatterns()` → `GET /api/purchases/patterns` (if separate endpoint is chosen)
   - `sendChatMessage(message, history)` → `POST /api/ai/chat`

2. **TanStack Query hooks**:
   - Implement the `useHistory()` stub in `frontend/src/lib/queries/history.js` with key `['purchases', filters]`, following the established queries pattern.

3. **History page refactor** (`frontend/src/pages/History.jsx`):
   - Fetch purchases on mount and on filter changes via `useHistory()`.
   - Group by month by default.
   - Show each purchase with store, date, items, total, and receipt thumbnail.
   - Show month totals and average spend per month.
   - Show pattern cards for top items (e.g., "Milk every 5 days").
   - Add filters for date range, store, and search.
   - Add loading and error states.
   - Use `personaText` for empty state and lead copy.

4. **Assistant panel wiring** (`frontend/src/components/Assistant.jsx`):
   - Replace the mocked replies with `sendChatMessage` calls.
   - Keep the quick actions ("Plan this week", etc.) as predefined prompts.
   - Handle loading/streaming state, key-missing state (402 → link to Settings), and usage-limit errors (429).
   - "Apply to plan" navigates to the Plan page via TanStack Router.

5. **Receipt thumbnail**:
   - Use the signed receipt URL or proxy endpoint.
   - Lazy load images.
   - Add a lightbox or full-size view on click.

6. **Home page integration**:
   - Show a "last purchase" or "this month spending" summary if desired.

---

## Out of Scope

- Price memory and alerts (Phase 10).
- Detailed analytics charts (Phase 10).
- Export to CSV/PDF (Phase 11).
- Household switching (Phase 06 or a separate phase).
- Push notifications (Phase 08).

---

## Database Changes

No schema changes are required. Consider adding an index to speed up date-range history queries:

```sql
CREATE INDEX IF NOT EXISTS idx_purchases_household_date_store ON purchases(household_id, date, store_id);
```

If you decide to store computed pattern data, keep it as a derived value in the Worker rather than a new table.

---

## Testing Strategy

### Backend unit tests

1. `run-out-recalibration.test.ts` — test that full history produces better estimates than sparse history.
2. `pattern-detection.test.ts` — test average interval and quantity calculations.

### Backend integration tests

Add to `automation/tests/local/api/`:

1. `purchase-history.feature` — scenarios:
   - GET /api/purchases returns purchases in date order.
   - Date filter returns only matching purchases.
   - Store filter works.
   - Search by item name works.
   - Month-grouped totals are correct.
   - Another household cannot see purchases.
2. `ai-chat.feature` — scenarios:
   - POST /api/ai/chat returns a reply using the `TEST_MODE` AI mock.
   - Missing AI key returns 402.
   - AI usage limit reached returns 429.
   - The prompt is built only from the current household's data.

### Frontend tests

1. Update `History.test.jsx` to mock `getPurchases` and assert month grouping, totals, and filters.
2. Test receipt thumbnail rendering and lightbox.

### E2E smoke tests

1. Add a live smoke test that hits `rumaq.pages.dev`, logs in, and verifies the History page loads with no errors.

### Manual verification

1. Deploy to Cloudflare.
2. Log in on the live URL.
3. Add a purchase via receipt scan or manual entry.
4. Open History and verify the purchase appears with correct total and items.
5. Verify the month total and pattern cards make sense.
6. Run the production smoke test workflow.

---

## Deployment & Secrets

1. **Finalize `backend/wrangler.cloudflare.toml`**:
   - `[d1_databases]` binding `DB` with real `database_id`.
   - `[[r2_buckets]]` binding `RECEIPTS` with real bucket name.
   - `[vars]` for non-secrets: `PAGES_ORIGIN`, `EMAIL_AUTH_ENABLED`.
   - No secrets in toml; secrets are set via Wrangler or `deploy-cf.js`.

2. **Document secrets**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `WORKER_JWT_SECRET`
   - `WORKER_ENCRYPTION_KEY`

3. **Document one-time setup**:
   - D1 database creation.
   - Migrations apply.
   - R2 bucket creation.
   - Google OAuth credentials.
   - Wrangler secret upload.

4. **Update `README.md`** or `docs/ARCHITECTURE.md` with deployment steps.

5. **Update `docs/PROJECT_PLAN.md`**:
   - Mark all P0 items as `Done` or `Partial` where appropriate.
   - Update the Immediate next steps to point to P1 work.

---

## Risks & Mitigations

| Risk                                                          | Impact | Mitigation                                                                                                             |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Purchase history query is slow for many rows                  | Medium | Add indexes; paginate; limit default to 50 purchases.                                                                  |
| Run-out recalibration changes existing estimates dramatically | Medium | Show a "based on N purchases" label and fall back to default if N < 2.                                                 |
| Deployment config drift between local and prod                | High   | Use `wrangler.local.toml`, `wrangler.cloudflare.toml`, and `wrangler.test.toml` consistently; validate bindings in CI. |
| Live smoke test fails because of environment issues           | High   | Run smoke tests after every deployment; keep them simple (login + page load).                                          |
| R2 bucket not bound correctly                                 | High   | Automate R2 creation/binding in `deploy-cf.js`; fail deployment if binding is missing.                                 |
| Secrets missing in production                                 | High   | Add a startup check in the Worker that fails fast with a clear error if required secrets are missing.                  |

---

## Open Questions

1. **Should patterns be computed on the fly or cached?** Recommendation: compute on the fly for MVP; cache in a `stock.basis` or `items` metadata column later if slow.
2. **Should the History page allow editing or deleting purchases?** Not in MVP. Add later if users ask.
3. **Should receipts be deletable?** Not in MVP. R2 objects are retained.
4. **Should month grouping use the user's timezone or UTC?** Use UTC for simplicity; the date is already stored as ISO 8601 without timezone. Consider locale later.
5. **Should the deployment include a staging environment?** For MVP, preview deployments on PRs (Phase 07) are enough. A separate staging environment can be added later.
6. **Should the production smoke test run every 6 hours or on every deploy?** Keep the existing 6-hour schedule and add a post-deploy smoke hook if feasible.

---

## Alternatives Considered

- **Client-side history grouping:** Rejected because the backend can compute totals more efficiently and the API may be used by other clients later.
- **Separate analytics endpoints:** Rejected for MVP; keep patterns in the history response or a simple `/api/purchases/patterns` endpoint.
- **Manual run-out calibration UI:** Rejected because automatic recalibration from history is the product promise.

---

## Implementation Notes for a Future Session

1. Implement the purchase history endpoint and tests first.
2. Add pattern detection and tests.
3. Refine run-out estimates using the full history.
4. Wire the History page.
5. Implement `POST /api/ai/chat` and wire the Assistant panel.
6. Update `docs/PROJECT_PLAN.md` and run the full test suite.
7. Deploy to Cloudflare and run live smoke tests.
8. Open the final P0 PR.

After this phase, RumaQ is an end-to-end MVP: users can scan receipts, track stock, generate plans, review history, and deploy to production.
