# Phase 04 — AI Shopping Plans

**Status:** Done (PR #77 — AI shopping plans generation, CRUD, check-off, and plan page; follow-ups in #108)  
**Priority:** P0 (MVP blocker)  
**Source PR:** PR 5 — AI Shopping Plans (from `docs/PROJECT_PLAN.md`)  
**Estimated effort:** Medium-High (AI prompt engineering + plan state machine)

---

## Objective

Generate an automatic per-store shopping plan from low-stock items, expiring items, and purchase history. The user can review the plan, mark items bought or skipped, and regenerate. The user impact is: _the app tells you exactly what to buy and where, before you run out_.

This phase builds on the stock and purchase data from Phases 02 and 03.

---

## Acceptance Criteria

1. `GET /api/plans?status=active` returns the current household's active plan with grouped per-store items.
2. `POST /api/plans/generate` asks the AI to build a plan from current stock, expiry, and history; returns a draft without persisting it.
3. `POST /api/plans` saves a generated plan as active, replacing any previous active plan.
4. `PATCH /api/plans/:id/items/:itemId` marks a plan item as `bought` or `skipped`; `bought` also creates a purchase record and updates stock.
5. The Plan page shows per-store trip cards, check-off toggles, regenerate, all-bought state, and key-missing state.
6. AI prompts only include data from the current household.
7. All endpoints use Valibot validation and household-scoped queries.
8. API integration tests cover plan CRUD, generate endpoint, and check-off flow.
9. Frontend tests cover the plan UI and state changes.
10. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phase 01 (Settings) for AI provider/key decryption and store/location lists.
- Phase 02 (Inventory) for stock/run-out data.
- Phase 03 (Receipt Scan) for purchase history, but the plan generator can work with manual purchases too.
- D1 schema has `plans`, `plan_items`, `items`, `stock`, `stores`, `locations`.
- Existing Plan page is mocked in `frontend/src/pages/Plan.jsx`.
- Frontend uses TanStack Query (PR #34, #76): server state lives in `frontend/src/lib/queries/` hooks with optimistic updates. `queries/plans.js` is a stub to replace, and `queries/stock.js` is the reference pattern.

---

## Scope

### Backend

1. **Plan generator helper** (`backend/src/lib/plans.ts`):
   - Build a prompt from the current household context:
     - Low-stock items: `stock` rows with `run_out_days <= 7` or `run_out_days IS NULL`.
     - Expiring soon: `stock` rows with `expiry_date` within 7 days.
     - Recent purchase history: last 30 days of `purchase_items` joined with `items` and `stores`.
     - Store list: the household's stores.
     - Current household preference: currency, persona roles (optional).
   - Ask the AI to return JSON: `{ items: [{ name, qty, unit, store_id?, price_estimate?, why }] }`.
   - Group items by store if possible; if a store is not known, leave `store_id` null.
   - Why field explains why the item is suggested (e.g., "running out in 3 days", "expires in 2 days", "not bought in 30 days").
   - Validate the AI response with Valibot.
   - Cap the plan at a reasonable number of items (e.g., 50) to keep prompts and responses small.
   - Note: the provider functions in `backend/src/lib/ai.ts` (`callOpenAI`, `callGemini`, `callAnthropic`, `callOpenCode`) are currently receipt-image specific. Generalize the provider-call layer to also accept text prompts (e.g., a shared text-completion function per provider) and reuse it here — do not duplicate four provider implementations in `plans.ts`.

2. **Generate endpoint** (`POST /api/plans/generate` in `backend/src/apps/api.ts`):
   - Decrypt the AI key from `user_settings`.
   - Gather context data with household filter.
   - Call the AI provider with the prompt.
   - Try to match returned item names to existing `items` in the household by normalized name; if not found, keep it as a new item suggestion.
   - Return `{ items: [...], generated_at }` without writing to the database.
   - Increment AI usage.
   - Enforce daily AI usage limit.

3. **Save plan endpoint** (`POST /api/plans`):
   - Valibot schema: accepts the generated draft items (from the frontend).
   - Create a new `plans` row with `status = 'active'`.
   - If another active plan exists for the household, mark it as `archived` or `completed` first (design choice; see Open Questions).
   - Insert `plan_items` rows, linking to `item_id` where matched, otherwise `item_id = NULL` with a suggested name.
   - Optionally store `price_estimate` and `why`.
   - Return the created plan with items.

4. **List plans endpoint** (`GET /api/plans`):
   - Query params: `status` (default `active`, can be `all`, `completed`, `archived`).
   - Return plans with nested `plan_items` for the household.
   - Order by `created_at DESC`.

5. **Update plan item endpoint** (`PATCH /api/plans/:id/items/:itemId`):
   - Valibot schema: `status` in `['bought', 'skipped']`.
   - Verify plan and item belong to the household.
   - Update status.
   - If status is `bought`:
     - Create a lightweight `purchases` + `purchase_items` row (date = today, `store_id` from the plan item, `price` from `price_estimate`) so purchase history, spending totals (Phase 05), and run-out learning stay consistent. Skip this when the plan item has no matched `item_id` — create the `items` row first in that case, reusing the name-matching logic from `POST /api/purchases`.
     - Update the corresponding `stock` row (increase qty by `plan_items.qty`) or create stock if missing. Recalculate `run_out_days` with `computeRunOutDays` (the new purchase row feeds the estimate).
   - If all items are `bought` or `skipped`, set the plan status to `completed`.
   - Return the updated item and plan.

6. **Plan prompt isolation**:
   - Only include store labels, item names, and history from the current household.
   - Never include IDs that could be reversed to another household.
   - Never log the prompt with household data.

### Frontend

1. **API client additions** (`frontend/src/lib/api.js`):
   - `getPlans(status = 'active')` → `GET /api/plans?status=...`
   - `generatePlan()` → `POST /api/plans/generate`
   - `savePlan(items)` → `POST /api/plans`
   - `updatePlanItem(planId, itemId, status)` → `PATCH /api/plans/${planId}/items/${itemId}`

2. **TanStack Query hooks** (`frontend/src/lib/queries/plans.js`, replacing the existing stub):
   - `usePlans(status = 'active')` — `useQuery` with key `['plans', status]`.
   - `useGeneratePlan()` and `useSavePlan()` — mutations that invalidate `['plans']` on success.
   - `useUpdatePlanItem()` — optimistic check-off following the `onMutate` / `onError` rollback / `onSettled` invalidate pattern from `queries/stock.js`; on settled also invalidate `['stock']` and `['home']` because buying items changes stock and dashboard stats.
   - Keep the exports in `queries/index.js` in sync.

3. **Plan page refactor** (`frontend/src/pages/Plan.jsx`):
   - Remove the `PLAN` mock import and the `aiKey` / `setView` props; use `usePlans('active')` for data, `useSettings()` (`has_ai_key`) for the key-missing state, and TanStack Router navigation for links.
   - Show empty state if no active plan; offer to generate.
   - Show generating state while calling `useGeneratePlan`.
   - Show review state after generation; allow saving or regenerating.
   - Show active plan as per-store cards with checkboxes for bought/skipped.
   - Check-off is optimistic via `useUpdatePlanItem`.
   - When all items are bought/skipped, show "all-bought" state and prompt to create the next plan.
   - If no AI key is configured, show key-missing state with a link to Settings.
   - Use `personaText` for lead copy and empty states.

4. **Plan store card component** (new or inline):
   - Group items by store.
   - Show item name, qty, unit, why, and price estimate.
   - Toggle between pending, bought, skipped.

5. **Home page integration** (optional in this phase):
   - Populate `next_trip` in `GET /api/home` from the active plan — the endpoint already returns `next_trip: null` as a placeholder.

---

## Out of Scope

- Trip optimization by location/time (Phase 10).
- Price memory and cheapest-store recommendations (Phase 10).
- Recurring/auto-generated plans (Phase 10).
- Plan templates or manual plan creation beyond AI generation.
- Notifications when a plan is generated (Phase 08).
- Multiple concurrent active plans.

---

## Database Changes

No schema changes are required. The existing `plans` and `plan_items` tables support this phase. Consider adding an index if listing plans becomes slow:

```sql
CREATE INDEX IF NOT EXISTS idx_plans_household_status ON plans(household_id, status);
```

If you add this index, create a new migration (`backend/migrations/0004_plan_indexes.sql`) — do not edit `0001_schema.sql`, which is already applied in production.

If you want to store the AI-generated plan metadata, the existing `total_estimate` and `status` columns are enough. Add `generated_at` if needed, but `created_at` on `plans` already serves this purpose.

---

## Testing Strategy

### Backend unit tests

1. `plan-generator.test.ts` — mock AI responses and assert:
   - Prompt only contains household-scoped data.
   - Returned items are matched to existing items by normalized name.
   - Unknown items stay as suggestions.
2. `plan-state.test.ts` — test all-bought detection and stock update on bought item.

### Backend integration tests

Add to `automation/tests/local/api/`:

1. `plans.feature` — scenarios:
   - Generate a plan returns draft items grouped by store.
   - Save a plan creates an active plan and plan items.
   - GET /api/plans returns the active plan.
   - Marking an item bought updates stock and plan status when all items are resolved.
   - Marking an item skipped does not update stock.
   - AI usage limit reached returns 429.
   - Another household cannot see or modify the plan.

### Frontend tests

1. Update `Plan.test.jsx` to mock plan API functions.
2. Test generate → save → mark bought flow.
3. Test empty state, key-missing state, and all-bought state.

### Manual verification

1. Ensure there is stock with low run_out_days or expiring items.
2. Open Plan page and generate a plan.
3. Verify the plan groups items by store.
4. Mark an item bought and verify stock increases in Inventory.
5. Mark all items bought/skipped and verify the plan is completed.
6. Verify AI usage meter increments.

---

## Deployment & Secrets

- No new secrets beyond the existing AI key and `WORKER_ENCRYPTION_KEY`.
- Plan generation may be slow (a few seconds). Consider adding a loading UI in the frontend.
- AI usage is tracked per user per day; ensure `ai_usage` rows are created correctly.

---

## Risks & Mitigations

| Risk                                           | Impact | Mitigation                                                                                           |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| AI generates poor or nonsensical plans         | High   | Use a strongly typed prompt and Valibot validation; allow user to regenerate and edit before saving. |
| Plan is too large or slow to generate          | Medium | Cap items at 50; only include low/expiring stock; limit history to 30 days.                          |
| Another household's plan is visible            | High   | Filter every query by `household_id`; add integration tests.                                         |
| Buying an item does not update stock correctly | High   | Reuse the stock update logic from Phase 02/03; add tests.                                            |
| AI usage limit not enforced                    | Medium | Increment usage and check limit before calling AI in both scan and plan endpoints.                   |
| Race condition when replacing active plan      | Low    | D1 batch is atomic for a single batch; mark old plan archived and insert new plan in one batch.      |

---

## Open Questions

1. **Should saving a new plan archive the old active plan or complete it?** Recommendation: archive it so the user can view history. If all items were bought, mark completed instead.
2. **Should bought items be auto-added to stock immediately or only on plan completion?** Resolved: immediately on each `bought` toggle, and a lightweight `purchases` + `purchase_items` row is created at the same time. Without the purchase row, run-out learning (computed from `purchase_items` history) and the Phase 05 History page would be blind to plan check-offs.
3. **Should skipped items be excluded from the next regeneration?** Not in MVP. They are just marked skipped.
4. **Should price_estimate be required from the AI?** No, make it optional. The UI shows it if present.
5. **Should the plan generator consider items with zero stock?** Yes, if they have purchase history or were in a previous plan. Otherwise, include them if they are in the item catalog and have no stock.
6. **Should we allow editing the plan before saving?** Yes, the review phase should allow editing qty, unit, and store.
7. **Should `POST /api/plans/generate` accept any input?** Not for MVP; it derives everything from context. Later, accept a target store or budget.

---

## Alternatives Considered

- **Rule-based plan generation without AI:** Rejected because the AI can infer grouping, quantities, and reasons from natural language context, which is a core product value.
- **Generating plans entirely on the client:** Rejected because the client does not have full purchase history and would expose the AI key.
- **Saving plans implicitly on generate:** Rejected because the user should review before replacing the active plan.
- **Separate plans per store:** Rejected; one plan with grouped items is simpler for the UI.

---

## Implementation Notes for a Future Session

1. Start with the plan generator helper and mock AI tests. This is the most finicky part.
2. Implement `POST /api/plans/generate` with usage tracking.
3. Implement `POST /api/plans` and `GET /api/plans`.
4. Implement `PATCH /api/plans/:id/items/:itemId` with stock updates.
5. Wire the Plan page through all states.
6. Run the full test suite and open the PR.

After this phase, the user can generate, review, and execute shopping plans driven by real stock and expiry data.
