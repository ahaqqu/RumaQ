# Phase 10 — AI Feature Expansion

**Status:** Not started (none of the six features have endpoints yet; price-data groundwork — migration 0007, ingest + `/api/prices` — has landed via `docs/plan/haqita-integration.md`)  
**Priority:** P1/P2  
**Source sections:** Section 6 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Medium-High (multiple AI-powered features)

---

## Objective

Extend the AI features beyond the MVP: suggest recipes for near-expiry items, recommend cheapest stores, calibrate consumption estimates, parse natural-language quick adds, optimize shopping trips, and track price changes. The user impact is: _the app becomes smarter and saves more money and time_.

This phase is post-MVP. It builds on the AI infrastructure from Phases 01, 03, and 04.

---

## Acceptance Criteria

1. **Use-it-up recipe nudge:** The assistant or a dedicated card suggests recipes for items expiring within a few days.
2. **Cheapest-store recommendation:** The plan generator or history view highlights which store has the best price for a recurring item.
3. **Consumption calibration:** The run-out estimate is calibrated when actual depletion differs from the estimate (e.g., user marks an item as finished).
4. **Natural-language quick add:** The user can type or say "beli 2L susu di Indomaret" and the system parses it into a purchase/stock entry.
5. **Trip optimization:** The shopping plan groups items by store and suggests an efficient route/order.
6. **Price memory & alerts:** Track price changes per store/product and alert the user to significant changes.
7. Each new AI feature has backend tests, frontend tests, and integration tests where applicable.
8. AI prompts remain household-isolated.
9. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phases 01-05.
- AI provider/key encryption from Phase 01.
- Stock and purchase history from Phases 02, 03, 05.
- Plan generation from Phase 04.
- `ai_usage` tracking from Phase 01.

---

## Scope

### 1. Use-it-up recipe nudge

- Backend: add `GET /api/ai/recipes` or include in `GET /api/home`.
  - Find items expiring within 3 days.
  - Build a prompt asking the AI for 1-3 simple recipes using those items.
  - Return `{ recipes: [{ title, ingredients, steps, uses: [item_id] }] }`.
- Frontend: show a "Use it up" card on Home for expiring items with recipe suggestions.
- Increment AI usage and enforce the daily limit.

### 2. Cheapest-store recommendation

- Backend: add `GET /api/stores/prices?item_id=` or include in plan generation.
  - Query `purchase_items` + `purchases` for the latest price per store for the item.
  - Return `{ stores: [{ store_id, label, latest_price, date }] }`.
- Frontend: in plan review and history, show the cheapest known store for each item.
- Extend plan generator prompt with price history context so the AI can suggest the cheapest store.

### 3. Consumption calibration

- Backend: add `POST /api/stock/:id/finish` or `PATCH /api/stock/:id` with a `finished` flag.
  - Record the actual depletion date.
  - Compare actual days to the estimated `run_out_days`.
  - Adjust a calibration factor per item (e.g., `items.consumption_factor`) and recalculate future run-out estimates.
- Frontend: add a "Finished today" button on stock items.
- This can be done without AI; it's a statistics feature.

### 4. Natural-language quick add

- Backend: add `POST /api/ai/parse` or `POST /api/stock/quick-add`.
  - Accept a free-text string like "beli 2L susu di Indomaret".
  - Parse using either an AI provider or a rule-based parser first (rule-based for common patterns, AI fallback).
  - Return parsed items and store.
  - Confirm via the existing purchase creation endpoint.
- Frontend: add a quick-add input to Home or Inventory (e.g., a chat-like bar).
- Increment AI usage if AI is used; rule-based parsing does not count.

### 5. Trip optimization

- Backend: extend the plan generator to group items by store and suggest an order.
  - Use a simple heuristic: order by store frequency, then by distance if known (not MVP).
  - Return `{ trips: [{ store_id, items: [...] }] }`.
- Frontend: show the plan as an ordered trip list with checkboxes per store.
- This overlaps with Phase 04; if not done there, implement it here.

### 6. Price memory & alerts

- Backend: add a `price_alerts` table or derive from history.
  - Track price per item per store over time.
  - Detect price changes > 10% from the average of the last 3 purchases.
  - Add `GET /api/price-alerts` endpoint.
- Frontend: show price alerts on History or Home.
- Add a setting to enable/disable price alerts.

---

## Out of Scope

- Haqita integration (mentioned as future in `docs/PROJECT_PLAN.md`).
- Real-time price scraping from external sources.
- Complex route optimization using maps/distance APIs.
- Voice input beyond the platform's native speech-to-text.
- Nutrition information or recipe images.

---

## Database Changes

Add tables/columns as needed:

```sql
-- Consumption calibration factor
ALTER TABLE items ADD COLUMN consumption_factor REAL DEFAULT 1.0;

-- Price history/alerts (optional, can derive from purchase_items)
CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  old_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  change_percent REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_household ON price_alerts(household_id);
```

Consider whether a separate `price_history` table is needed or if `purchase_items` is enough. For simple latest-price and average-price queries, `purchase_items` is sufficient. For more complex trends, a materialized table may be needed.

---

## Testing Strategy

### Unit tests

1. `recipe-prompt.test.ts` — verify recipe prompt only includes expiring items.
2. `price-comparison.test.ts` — verify latest price per store calculation.
3. `consumption-calibration.test.ts` — verify factor adjustment.
4. `quick-add-parser.test.ts` — test rule-based and AI fallback parsing.

### Integration tests

1. `ai-recipes.feature` — request recipes and assert they use expiring items.
2. `price-alerts.feature` — create purchases with price changes and assert alerts.
3. `quick-add.feature` — parse text and confirm purchase.
4. `consumption-calibration.feature` — mark item finished and verify run-out estimate updated.

### Frontend tests

1. Test the "Use it up" card renders recipes.
2. Test the quick-add input parses and creates items.
3. Test price alert indicators.

### Manual verification

1. Add items expiring soon and verify recipe suggestions appear.
2. Create purchases for the same item at different prices/stores and verify cheapest-store recommendation.
3. Mark an item finished and verify run-out estimates adjust.
4. Type a natural-language quick add and verify parsing.

---

## Deployment & Secrets

- No new secrets beyond existing AI key and encryption key.
- AI usage may increase with these features; ensure the daily limit is reasonable and documented.

---

## Risks & Mitigations

| Risk                                                         | Impact | Mitigation                                                                               |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| AI features increase daily usage and hit the limit quickly   | Medium | Allow rule-based fallbacks for quick-add and price comparison; cache results.            |
| Recipe suggestions are low quality                           | Medium | Keep prompts simple and limited to 1-3 recipes; allow user to regenerate.                |
| Cheapest-store recommendation is misleading with sparse data | Medium | Only show recommendation if there are at least 2 purchases at the store.                 |
| Consumption calibration over-corrects                        | Medium | Cap the calibration factor (e.g., between 0.5 and 2.0) and require multiple data points. |
| Natural-language parsing fails for non-Indonesian input      | Medium | Support both `id` and `en` patterns; use AI fallback.                                    |
| AI prompt isolation becomes harder with more features        | High   | Audit every new prompt; add tests.                                                       |

---

## Open Questions

1. **Should these features be gated behind a setting or enabled by default?** Recommendation: enable by default but allow disabling in Settings.
2. **Should recipe suggestions be from the AI provider or a curated recipe database?** Recommendation: AI provider for flexibility and language/persona matching.
3. **Should trip optimization use a map API?** Recommendation: no, use simple heuristics (store frequency, alphabetical) for MVP.
4. **Should price alerts be real-time or periodic?** Recommendation: periodic, computed when the history page is loaded or via a daily cron.
5. **Should consumption calibration be automatic or manual?** Recommendation: manual "finished today" button for now; automatic calibration later when data is richer.
6. **Should quick-add support voice input?** Recommendation: use the browser's built-in speech-to-text on the input; no custom model needed.

---

## Alternatives Considered

- **Build a custom ML model for consumption calibration:** Rejected because simple statistics are enough for MVP and do not require training data.
- **Integrate with a third-party recipe API:** Rejected because it adds another dependency and cost; the AI provider can generate recipes.
- **External price comparison service (Haqita):** Rejected as future work; the app uses the user's own purchase history first.
- **Rule-based AI feature set only:** Rejected because AI provides better language understanding and persona matching, which is a core product value.

---

## Implementation Notes for a Future Session

1. Pick one feature to start (recommendation: use-it-up recipes or quick-add because they are user-visible).
2. Implement backend endpoint and tests.
3. Implement frontend UI and tests.
4. Repeat for each feature in separate PRs to keep changes reviewable.
5. Update AI usage tracking and prompts to include new features.
6. Run the full test suite and open PRs.

After this phase, RumaQ has a richer set of AI-powered features that differentiate it from a simple inventory tracker.
