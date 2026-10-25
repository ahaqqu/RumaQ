# Phase 11 — Database Operations & Maintenance

**Status:** Partial (run-out estimates done with recalibration tests, index tuning done via migrations 0003–0005, household isolation enforced and covered by integration tests; remaining work is an isolation unit test, backup/export strategy, migration-convention docs, and query-performance monitoring)  
**Priority:** P0/P2  
**Source sections:** Section 4 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Medium

---

## Objective

Ensure the database layer is performant, isolated, and resilient. Compute run-out estimates, validate and tune indexes, enforce multi-household data isolation in every query, and establish a backup/export strategy. The user impact is: _fast, accurate, and private data even as the app grows_.

This phase has both P0 components (run-out, isolation) and P2 components (backup strategy). The P0 parts are prerequisites for Phases 02 and 03 and should be completed earlier; the P2 parts can wait.

---

## Acceptance Criteria

1. Run-out estimates are computed and stored correctly for all stock rows (P0, overlaps with Phase 02).
2. All household-scoped queries are verified to include `household_id` filters (P0, overlaps with Phase 06).
3. Indexes are validated against real query patterns and adjusted as needed (P0/P1).
4. A backup/export strategy is documented and optionally automated (P2).
5. A migration strategy is documented for future schema changes.
6. D1 query performance is measured and optimized for the common read paths.
7. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phases 01-05 for the features that generate database queries.
- D1 schema from `backend/migrations/0001_schema.sql`.
- Existing `scripts/deploy/setup-db.js`.

---

## Scope

### 1. Run-out estimate computation

This is primarily implemented in Phase 02. This phase documents and hardens it:

- Ensure the run-out helper is centralized in `backend/src/lib/stock.ts`.
- Ensure it is called on:
  - Purchase creation (Phase 03).
  - Stock PATCH (Phase 02).
  - Plan item bought (Phase 04).
  - Manual calibration (Phase 10).
- Document the formula and fallback behavior.
- Add a periodic recalculation job (optional, via Cron Trigger) to refresh stale estimates.

### 2. Index tuning

- Review all query patterns from the implemented endpoints.
- Verify existing indexes are used.
- Consider adding:
  - `CREATE INDEX IF NOT EXISTS idx_purchase_items_item_id ON purchase_items(item_id);` for run-out calculations.
  - `CREATE INDEX IF NOT EXISTS idx_purchase_items_item_created ON purchase_items(item_id, created_at);` for date-range history.
  - `CREATE INDEX IF NOT EXISTS idx_plans_household_status ON plans(household_id, status);` for active plan lookup.
  - `CREATE INDEX IF NOT EXISTS idx_purchases_household_date_store ON purchases(household_id, date, store_id);` for history filters.
- Add a migration file for new indexes; do not modify `0001_schema.sql` if it has already been applied remotely. Use `0003_indexes.sql`.

### 3. Multi-household data isolation

- Audit every SQL query in the backend.
- Ensure all queries that touch household-scoped tables filter by `household_id`.
- Check all JOINs: a joined table may need its own `household_id` filter or the join must be on a household-scoped key.
- Add tests that attempt cross-household access for every resource type (settings, stock, locations, stores, purchases, plans, receipts, AI usage).
- Document the isolation model in `docs/ARCHITECTURE.md`.

### 4. Backup / export strategy

- Document how to export D1 data:
  - `wrangler d1 export` if available.
  - Manual SQLite dump via Wrangler dashboard.
  - Periodic GitHub Actions workflow that exports D1 and stores the artifact.
- Document R2 object backup:
  - R2 has built-in durability; consider a second-bucket copy or lifecycle rules.
- Document disaster recovery: how to restore from D1 export and R2 objects.
- This is P2; implement the documentation first, then automate if needed.

### 5. Migration strategy

- Document how to add new migrations:
  - Create `backend/migrations/NNNN_description.sql`.
  - Run `wrangler d1 migrations apply rumaq --local` for local dev.
  - Run `wrangler d1 migrations apply rumaq --remote` for production.
- Document rollback policy: D1 does not support down migrations easily; plan rollbacks via compensating migrations or backups.
- Ensure `scripts/deploy/setup-db.js` can apply migrations.

### 6. Query performance monitoring

- Add request logging (Phase 06/07) that includes query duration for slow queries.
- Add a periodic check for long-running queries in the D1 dashboard.
- Consider adding a `/api/admin/health` or `/api/admin/db-stats` endpoint (owner-only) for diagnostics.

---

## Out of Scope

- Multi-tenant scaling beyond D1's free tier.
- Read replicas or sharding.
- Advanced database observability (basic logging only).
- Data retention policies (can be added later).
- GDPR/right-to-erasure automation (document manual process for now).

---

## Database Changes

Add a new migration `backend/migrations/0003_indexes.sql` with performance indexes as needed. Example:

```sql
-- Phase 11: performance indexes
CREATE INDEX IF NOT EXISTS idx_purchase_items_item_id ON purchase_items(item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_item_created ON purchase_items(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plans_household_status ON plans(household_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_household_date_store ON purchases(household_id, date, store_id);
CREATE INDEX IF NOT EXISTS idx_stock_household_item ON stock(household_id, item_id);
```

Do not edit `0001_schema.sql` if it has been applied to production.

---

## Testing Strategy

### Unit tests

1. `run-out.test.ts` (from Phase 02) — verify estimates.
2. `isolation.test.ts` — mock database queries and verify household filters are present.

### Integration tests

1. `isolation.feature` — cross-household access is denied for every resource type.
2. `performance.feature` — smoke tests for large stock lists and history queries (optional).

### Manual verification

1. Run `wrangler d1 insights` or query logs to identify slow queries.
2. Verify indexes are used in query plans (D1 may not expose EXPLAIN; use timing and load tests).
3. Test a restore from a D1 export in a local environment.

---

## Deployment & Secrets

- Migrations require Wrangler access; ensure CI has permission to apply migrations or require manual application for production.
- Backup workflow may need a Cloudflare API token with D1 read and R2 read permissions.

---

## Risks & Mitigations

| Risk                                        | Impact | Mitigation                                                                                 |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Missing household filter in a new query     | High   | Code review checklist; integration tests for every resource.                               |
| Index bloat slows writes                    | Low    | Only add indexes proven by query patterns; remove unused indexes.                          |
| D1 free-tier query limits exceeded          | Medium | Optimize queries; add caching (Phase 07); monitor usage.                                   |
| Backup workflow fails or is forgotten       | Medium | Automate with GitHub Actions; document manual fallback.                                    |
| Migration applied incorrectly in production | High   | Test migrations locally and in preview; apply manually in production with a rollback plan. |

---

## Open Questions

1. **Should the run-out recalculation be a Cron Trigger or event-driven?** Recommendation: event-driven on data changes; add a daily Cron Trigger for stale rows later.
2. **Should we add a `household_id` column to `users`?** No, `users` is global; household membership is in `household_members`.
3. **Should backups be daily or weekly?** Recommendation: daily for D1; R2 objects are durable but a weekly cross-bucket copy is reasonable.
4. **Should we implement soft deletes for household data?** Not for MVP; hard deletes are fine. Add soft deletes later if needed for audit or recovery.
5. **Should we partition data by household in the future?** D1 does not support partitioning; consider separate databases per household only if scaling requires it.

---

## Alternatives Considered

- **Use a separate database per household:** Rejected because it complicates operations and is unnecessary for MVP scale.
- **Store all data in KV instead of D1:** Rejected because relational queries and joins are central to the product.
- **Compute run-out entirely in SQL:** Rejected because SQLite in D1 may not support window functions or complex analytics easily; Worker-side computation is more flexible and testable.
- **Skip backups on the free tier:** Rejected because even free users need a documented recovery path; the backup workflow can run cheaply.

---

## Implementation Notes for a Future Session

1. Audit existing queries and add missing indexes via a migration.
2. Add or run isolation tests for all resources.
3. Document the backup/export process.
4. Optionally add a GitHub Actions backup workflow.
5. Run the full test suite and open a PR.

After this phase, the database layer is robust, well-isolated, and has a clear maintenance plan.
