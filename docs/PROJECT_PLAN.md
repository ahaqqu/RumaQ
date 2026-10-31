# RumaQ — Project Plan

This plan lists every known work item for RumaQ, its current status, and its priority. It does not include cost or time estimates.

## Legend

- **Status:**
  - `Done` — implemented and verified in this branch.
  - `Partial` — scaffold or design exists, but not fully functional end-to-end.
  - `Not started` — no code or design yet.
- **Priority:**
  - `P0` — required for MVP; blocks release.
  - `P1` — important; improves core value and trust.
  - `P2` — valuable; can ship after MVP.

---

## 1. Product foundation

| Item                              | Status | Priority | Notes                                                                            |
| --------------------------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| Product definition & design brief | Done   | P0       | `.commandcode/design/brief.md`                                                   |
| Visual design system & CSS tokens | Done   | P0       | `frontend/src/styles/tokens.css`, `base.css`, `components.css`                   |
| README for users and developers   | Done   | P0       | `README.md`                                                                      |
| Full-stack architecture document  | Done   | P0       | `docs/ARCHITECTURE.md`                                                           |
| REST API contract                 | Done   | P0       | `docs/API.md`                                                                    |
| Contribution & coding guidelines  | Done   | P2       | `CONTRIBUTING.md`, `AGENTS.md`, `docs/ONBOARDING.md`, GitHub templates (PR #260) |

## 2. Frontend (React + Vite)

| Item                                                    | Status   | Priority | Notes                                                                                                                        |
| ------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Vite + React project scaffold                           | Done     | P0       | Existing prototype                                                                                                           |
| Responsive app shell (rail + topbar + bottombar)        | Done     | P0       | `frontend/src/components/AppShell.jsx`                                                                                       |
| Home / overview dashboard                               | Done     | P0       | `frontend/src/pages/Home.jsx`                                                                                                |
| Inventory list with search and filter                   | Done     | P0       | `frontend/src/pages/Inventory.jsx`                                                                                           |
| Add stock from receipt (UI flow)                        | Done     | P0       | `frontend/src/pages/AddFromReceipt.jsx`; wired via PR #63                                                                    |
| Shopping plan UI                                        | Done     | P0       | `frontend/src/pages/Plan.jsx`; wired via PR #77                                                                              |
| Purchase history UI                                     | Done     | P0       | `frontend/src/pages/History.jsx`                                                                                             |
| Settings UI (AI key, locations, motion, currency)       | Done     | P0       | `frontend/src/pages/Settings.jsx`                                                                                            |
| Persona personalization UI                              | Done     | P0       | `frontend/src/pages/Settings.jsx` persona section                                                                            |
| Persona copy transformation                             | Done     | P0       | `frontend/src/lib/persona.js` `speak()`                                                                                      |
| Persona theme color generator                           | Done     | P0       | `frontend/src/lib/persona.js` `applyTheme()`                                                                                 |
| AI assistant chat panel                                 | Done     | P0       | `frontend/src/components/Assistant.jsx`; real chat via PR #81                                                                |
| API client module                                       | Done     | P0       | Typed client via openapi-fetch (`frontend/src/lib/api.ts` + `api-schema.d.ts` from OpenAPI codegen; contract drift fails CI) |
| Authentication UI (login / logout)                      | Done     | P0       | Login page, user avatar/name in rail, logout button                                                                          |
| Error boundaries and loading states                     | Done     | P1       | Route-level `pendingComponent`/`errorComponent` on all routes; skeletons                                                     |
| Offline / optimistic updates                            | Done     | P1       | PR #76 — query persistence + optimistic mutations                                                                            |
| Frontend refactor (Kumo + TanStack + Tailwind v4 + PWA) | Done     | P1       | PR #34 — TanStack Router + Query + Kumo UI + Tailwind v4 + PWA                                                               |
| UI redesign (Figma direction): tokens + shell + Home    | Partial  | P1       | Green palette, Inter, Lucide, new shell + Home (`docs/design/tokens.md`); remaining screens inherit tokens, receipt queue next |
| PWA manifest & service worker                           | Done     | P2       | PR #34 — installable app, offline caching                                                                                    |
| Push notifications                                      | Deferred | P2       | Decision recorded in `docs/PUSH_NOTIFICATIONS_DECISION.md`                                                                   |
| Mobile native wrappers (iOS/Android)                    | Deferred | P2       | Decision recorded in `docs/MOBILE_WRAPPERS_DECISION.md`                                                                      |

## 3. Backend (Cloudflare Workers + Hono)

| Item                                          | Status      | Priority | Notes                                                                                                                 |
| --------------------------------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| Backend project scaffold                      | Done        | P0       | `backend/` with Hono, Wrangler config example                                                                         |
| Google OAuth 2.0 login & callback             | Done        | P0       | OAuth flow with PKCE, JWT sessions, default seed on household creation                                                |
| JWT session cookie middleware                 | Done        | P0       | `backend/src/middleware.ts`; verifies cookie + loads active household                                                 |
| CORS configuration                            | Done        | P0       | Same-origin app + API; localhost dev origins + `*.pages.dev` previews allowed, unknown origins rejected (unit-tested) |
| Health check endpoint                         | Done        | P0       | `GET /api/health`                                                                                                     |
| `GET /api/me` endpoint                        | Done        | P0       | Returns current user                                                                                                  |
| `GET /api/stock` endpoint                     | Done        | P0       | Query with location/q filters, ordered by run-out + expiry                                                            |
| Stock CRUD endpoints (`PATCH /api/stock/:id`) | Done        | P0       |                                                                                                                       |
| Household endpoints                           | Not started | P0       | Create/list households, set active                                                                                    |
| Location endpoints                            | Done        | P0       | `GET/POST/DELETE /api/locations`                                                                                      |
| Store endpoints                               | Done        | P0       | `GET/POST/DELETE /api/stores`                                                                                         |
| Purchase endpoints                            | Done        | P0       | `GET/POST /api/purchases`, `GET /api/purchases/:id`, `GET /api/purchases/patterns`                                    |
| Receipt upload to R2                          | Done        | P0       | `POST /api/purchases/scan` (PR #63); private bucket + Worker proxy                                                    |
| Plan endpoints                                | Done        | P0       | `GET/POST /api/plans`, `POST /api/plans/generate`, `PATCH /api/plans/items/:id`                                       |
| Settings endpoints                            | Done        | P0       | `GET/PATCH /api/settings`                                                                                             |
| AI chat endpoint                              | Done        | P0       | `POST /api/ai/chat` (streaming deferred; see ARCHITECTURE.md §13)                                                     |
| AI usage endpoint                             | Done        | P0       | `GET /api/ai/usage`                                                                                                   |
| Input validation with Valibot                 | Done        | P0       | Add to all routes                                                                                                     |
| Centralized error handling                    | Done        | P1       | `app.onError` catches all unhandled errors; middleware returns JSON errors                                            |
| Rate limiting                                 | Done        | P1       | General per-IP limiter + AI daily limits via `ai_usage`; 429s carry `Retry-After`; KV migration deferred (§13)        |
| Request logging / observability               | Partial     | P2       | `hono/logger` in place; structured logs/analytics not done                                                            |

## 4. Database (Cloudflare D1)

| Item                            | Status      | Priority | Notes                                                                            |
| ------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------- |
| Relational schema design        | Done        | P0       | `backend/migrations/0001_schema.sql`                                             |
| Migration runner / setup script | Done        | P0       | `scripts/deploy/setup-db.js`                                                     |
| Seed default locations & stores | Done        | P0       | Kulkas, Freezer, Lemari, Rak + Indomaret, Alfamart, Pasar on household creation  |
| Run-out estimate computation    | Done        | P0       | `computeRunOutDays` in `backend/src/lib/stock.ts`; full history, weighted avg    |
| Index tuning                    | Done        | P0       | Migrations 0003–0005 (stock, plan, purchase-history indexes)                     |
| Multi-household data isolation  | Done        | P0       | Enforced in all queries; cross-household integration tests in `security.feature` |
| Backup / export strategy        | Not started | P2       | Periodic D1 export                                                               |

## 5. Authentication & security

| Item                            | Status  | Priority | Notes                                                                                                             |
| ------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| Google OAuth 2.0 integration    | Partial | P0       | Code complete and deployed; end-to-end live verification with real credentials pending (manual step)              |
| Session JWT signing             | Done    | P0       | HMAC-SHA256, 30-day expiry, `HttpOnly`/`Secure`/`SameSite=None`; rotation invalidates sessions                    |
| Secure AI key encryption        | Done    | P0       | AES-GCM with `WORKER_ENCRYPTION_KEY`                                                                              |
| R2 signed URLs for receipts     | Done    | P0       | Receipts served through `GET /api/purchases/:id/receipt` proxy; R2 signed URLs deferred (§13)                     |
| AI prompt data isolation        | Done    | P0       | All chat/plan/scan prompts filtered by `household_id` in queries; labels-only stores (`prompt-isolation.test.ts`) |
| HTTPS-only cookies              | Done    | P0       | `Secure` + `SameSite=None` on HTTPS, `Lax` locally; same-origin in production                                     |
| CORS restricted to Pages origin | Done    | P0       | Same-origin single Worker; see CORS configuration row                                                             |
| CSRF protection via OAuth state | Done    | P0       | `state` + PKCE in `backend/src/auth.ts`                                                                           |
| Row-level security review       | Done    | P1       | Household-scoped queries audited in phase 06; `security.feature` covers cross-household access                    |

## 6. AI features

| Item                              | Status      | Priority | Notes                                                                                                                                  |
| --------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| BYO AI key in settings            | Done        | P0       | UI + AES-GCM encryption; only `has_ai_key` leaves the Worker                                                                           |
| Receipt OCR → parsed items        | Done        | P0       | PR #63 — `backend/src/lib/ai.ts` + scan endpoint                                                                                       |
| Shopping plan generation          | Done        | P0       | PR #77 — plans API + Plan page wired                                                                                                   |
| Assistant chat with system prompt | Done        | P0       | EN-only persona; see ARCHITECTURE.md §13                                                                                               |
| Daily AI usage meter              | Done        | P0       | Backend counter + UsageMeter wired                                                                                                     |
| Use-it-up expiry recipe nudge     | Not started | P1       | Suggest recipes for near-expiry items                                                                                                  |
| Cheapest-store recommendation     | In progress | P1       | Groundwork done (price tables + `/api/prices`, haqita PR1 #252); recommendation itself outstanding — `docs/plan/haqita-integration.md` |
| Consumption calibration           | Partial     | P1       | Run-out recalibration extends in-place; no bulk recalibrate endpoint (see ARCHITECTURE.md §13)                                         |
| Natural-language quick add        | Not started | P1       | Parse "beli 2L susu di Indomaret"                                                                                                      |
| Trip optimization                 | Not started | P2       | Group plan by location/time                                                                                                            |
| Price memory & alerts             | Not started | P2       | Track price changes per store/product                                                                                                  |

## 7. DevOps & deployment

| Item                                | Status  | Priority | Notes                                                                                                                                                       |
| ----------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Pages deployment config  | Retired | P0       | Pages retired in #243 — single Worker serves app (static assets) + API; canonical `rumaq.ahaqqu.com` Worker Custom Domain since #272, Pages project deleted |
| Cloudflare Worker deployment config | Done    | P0       | `backend/cloudflare.config.ts` (env-driven single config)                                                                                                   |
| D1 database creation guide          | Done    | P0       | `scripts/deploy/setup-db.js` + README                                                                                                                       |
| R2 bucket creation guide            | Done    | P0       | `./scripts/deploy.sh cloudflare` creates the bucket if missing                                                                                              |
| GitHub Actions CI                   | Done    | P1       | Unit tests + build on push/PR to main                                                                                                                       |
| Test automation CI                  | Done    | P1       | Docker-based integration/E2E tests on push/PR to main                                                                                                       |
| Preview deployments for PRs         | Done    | P1       | Branch-specific Worker + Pages preview; auto-cleanup                                                                                                        |
| Secrets management documentation    | Done    | P0       | `docs/ARCHITECTURE.md` §8 env vars table; `RUN_SECRETS_CHECK` guards missing secrets                                                                        |
| Environment-specific configs        | Done    | P1       | `backend/.dev.vars` local, env-driven `cloudflare.config.ts`, `RUN_SECRETS_CHECK` startup guard                                                             |

## 8. Quality assurance

| Item                        | Status | Priority | Notes                                                                                                          |
| --------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| Frontend production build   | Done   | P0       | `vp build` passes                                                                                              |
| Worker TypeScript typecheck | Done   | P0       | `vp check --no-fmt --no-lint` passes                                                                           |
| Unit tests                  | Done   | P1       | Vitest: 16+ frontend suites, 3 backend suites with coverage thresholds                                         |
| API integration tests       | Done   | P1       | `automation/tests/local/api/` — Vitest BDD + fetch against Docker Miniflare; `vp run test:api`                 |
| End-to-end tests            | Done   | P2       | Playwright BDD: smoke + page-level features for inventory/plan/history/settings/receipt; per-scenario DB reset |
| Docker test automation      | Done   | P1       | `docker compose -f automation/docker-compose.yml` runs all tests; CI workflow                                  |
| Production smoke tests      | Done   | P1       | Scheduled GitHub Actions check `rumaq.ahaqqu.com` every 6 hours                                                |
| Accessibility audit         | Done   | P1       | axe-core scans of every main page in E2E (critical/serious must be zero); first-wave contrast/label fixes      |
| Performance budget          | Done   | P2       | Bundle gate 250 KB JS gzip (scripts/ci/bundle-budget.mjs) + Lighthouse CI budgets in ci.yml                    |

---

## P0 Implementation Plan — Pull Request Basis

This plan translates the remaining P0 work into a sequence of user-impact-focused Pull Requests. Each PR delivers a complete, testable piece of functionality and builds on the previous one. Valibot validation, centralized error handling, and multi-household isolation are established in PR 1 and extended per PR.

Dependency order:

```
PR 1 (Auth) → PR 2 (Settings) → PR 3 (Inventory)
                                   ↓
                         PR 4 (Receipt Scan → Stock)
                                   ↓
                         PR 5 (AI Shopping Plans)
                                   ↓
                         PR 6 (History + Ship)
```

### PR 1 — Authentication ✅

_User impact: sign in with Google, see profile, sign out._

- Configure real Google OAuth credentials in Cloudflare secrets; verify login/callback/logout flow end-to-end.
- Seed default locations (kulkas, freezer, lemari, rak) and stores (indomaret, alfamart, pasar) during household creation.
- Add auth UI: login button, user avatar/name from `getMe()`, logout.
- Expand API client with `getMe()`, `getHealth()`, and auth helpers.
- Establish centralized error handling + JSON error response pattern.
- Add integration tests for the OAuth flow and auth middleware.

### PR 2 — Settings & Preferences ✅

_User impact: configure AI key, locations, stores, persona, language, motion, and currency — all persisted._

- Implement `GET /api/settings` and `PATCH /api/settings` with AES-GCM encryption for the AI key.
- Implement `GET/POST/DELETE /api/locations` and `GET/POST/DELETE /api/stores`.
- Wire Settings page fully: provider/key, persona, locations, stores, language, motion, currency.
- Wire `UsageMeter` to `GET /api/ai/usage`.
- Add tests for settings CRUD, encryption round-trip, and location/store CRUD.

### PR 3 — Inventory Dashboard ✅

_User impact: see real stock on Home and Inventory, search/filter/update items._

- Implement run-out estimate computation from purchase history and stock qty.
- Implement `PATCH /api/stock/:id` for qty, location, and expiry updates.
- Wire Home page: stats, needs-attention list, next trip, quick refill.
- Wire Inventory page: search, location filter, time signals, urgency sort.
- Add tests for stock queries, run-out calculation, and PATCH validation.

### PR 4 — Receipt Scan → Stock ✅

_User impact: take a receipt photo, AI reads the items, review them, and stock updates._

- Implement `POST /api/purchases/scan`: receipt upload to R2, AI OCR, parsed item extraction.
- Implement `POST /api/purchases` for manual purchase entry.
- Wire AddFromReceipt page through the 4-phase flow (capture → scanning → review → done).
- Create/update `items`, `stock`, `purchases`, and `purchase_items` in one transaction.
- Add tests for scan endpoint, purchase creation, and R2 upload handling.
- Verify AI prompt context is scoped to the current household only.

### PR 5 — AI Shopping Plans ✅

_User impact: get an auto-generated per-store shopping plan from low stock, expiries, and history._

- Implement `GET/POST /api/plans` and `POST /api/plans/generate` (AI groups items by store).
- Implement `PATCH /api/plans/items/:id` to mark items bought or skipped.
- Wire Plan page: per-store trip cards, check-off, regenerate, all-bought state, key-missing state.
- Add tests for plan CRUD, generate endpoint, and check-off flow.
- Ensure plan generation prompt context is scoped to the current household only.

### PR 6 — Purchase History + Ship ✅

_User impact: review past purchases and spending patterns; app goes live._

- ✅ Implemented `GET /api/purchases` with date/store/month-grouping filters, text search, keyset pagination.
- ✅ Implemented `GET /api/purchases/:id` for single purchase detail.
- ✅ Implemented `GET /api/purchases/patterns` for consumption pattern detection.
- ✅ Wired History page: month-grouped table, totals, pattern cards, receipt lightbox.
- ✅ Refined run-out estimates from full purchase history (weighted avg, 90-day gap fallback).
- ✅ Implemented `POST /api/ai/chat` with household-scoped system prompt.
- ✅ Wired Assistant: real chat, usage limits, AI-proposal apply-to-plan.
- ✅ Added `RUN_SECRETS_CHECK` for production config validation.
- ✅ Added BDD feature files + step definitions for purchase history and AI chat.
- ✅ Updated deployment documentation and tech debt notes in ARCHITECTURE.md §13.

---

## Immediate next steps

The MVP is shipped: production runs as a single Worker (`rumaq.ahaqqu.com`, deployed on merge to `main`), scheduled smoke tests run every 6 hours, and all P0 phases (01–05) plus phase 06 security hardening (one manual live-OAuth check outstanding) are done. Active work and remaining items:

1. **Haqita integration** (`docs/plan/haqita-integration.md`) — PR1 #252, PR2 #255, PR3 #262 and PR4 #275 merged (freshness status endpoint, smoke staleness alert, timer go-live; backfill dropped — haqita was never live). The nightly timer is live and managed by `ahaqqu/vps` `rumaq/`, and the scraper deploys through `vps-deploy rumaq`; PR5 (frontend `/prices` + plan grounding + scraping monitor) and PR6 (cleanup) remain.
2. **Scrape Now** (`docs/plan/scrape-now.md`) — admin-triggered, store-selectable scraping: command queue in D1 + polling VPS agent + frontend `/admin/scrape` (trigger, live log, failure logs) all on `feat/scrape-now` (PR open); merge and live verification (VPS agent unit install + first real trigger) remain.
3. **Phase 09** — done: page-level E2E features, axe-core accessibility scans + first-wave fixes, bundle-size budget and Lighthouse CI (see `docs/TEST_STRATEGY.md`).
4. **Phase 08** — route loader/Query alignment, PWA manifest screenshots, cache-TTL validation (mostly-finished modernization; offline E2E now covered by phase 09 features).
5. **Phase 10** — AI feature expansion (recipes, cheapest-store rec, calibration, quick add, trip optimization, price alerts).
6. **Phase 11** — isolation unit test, backup/export strategy, migration docs, query monitoring.
7. Tech debt in `docs/ARCHITECTURE.md` §13 (KV rate-limit counters, AI streaming, R2 signed URLs, …).
