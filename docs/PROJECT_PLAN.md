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

| Item                              | Status      | Priority | Notes                                                          |
| --------------------------------- | ----------- | -------- | -------------------------------------------------------------- |
| Product definition & design brief | Done        | P0       | `.commandcode/design/brief.md`                                 |
| Visual design system & CSS tokens | Done        | P0       | `frontend/src/styles/tokens.css`, `base.css`, `components.css` |
| README for users and developers   | Done        | P0       | `README.md`                                                    |
| Full-stack architecture document  | Done        | P0       | `docs/ARCHITECTURE.md`                                         |
| REST API contract                 | Done        | P0       | `docs/API.md`                                                  |
| Contribution & coding guidelines  | Not started | P2       | Add `CONTRIBUTING.md` and `AGENTS.md`                          |

## 2. Frontend (React + Vite)

| Item                                                    | Status      | Priority | Notes                                                                                                    |
| ------------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------- |
| Vite + React project scaffold                           | Done        | P0       | Existing prototype                                                                                       |
| Responsive app shell (rail + topbar + bottombar)        | Done        | P0       | `frontend/src/components/AppShell.jsx`                                                                   |
| Home / overview dashboard                               | Done        | P0       | `frontend/src/pages/Home.jsx`                                                                            |
| Inventory list with search and filter                   | Done        | P0       | `frontend/src/pages/Inventory.jsx`                                                                       |
| Add stock from receipt (UI flow)                        | Done        | P0       | `frontend/src/pages/AddFromReceipt.jsx`; currently mocked                                                |
| Shopping plan UI                                        | Done        | P0       | `frontend/src/pages/Plan.jsx`; currently mocked                                                          |
| Purchase history UI                                     | Done        | P0       | `frontend/src/pages/History.jsx`                                                                         |
| Settings UI (AI key, locations, motion, currency)       | Done        | P0       | `frontend/src/pages/Settings.jsx`                                                                        |
| Persona personalization UI                              | Done        | P0       | `frontend/src/pages/Settings.jsx` persona section                                                        |
| Persona copy transformation                             | Done        | P0       | `frontend/src/lib/persona.js` `speak()`                                                                  |
| Persona theme color generator                           | Done        | P0       | `frontend/src/lib/persona.js` `applyTheme()`                                                             |
| AI assistant chat panel                                 | Done        | P0       | `frontend/src/components/Assistant.jsx`; currently mocked                                                |
| API client module                                       | Partial     | P0       | Has `getMe`, `getStock`, `getHealth`, `login`, `logout`, `isAuthenticated`; needs full endpoint coverage |
| Authentication UI (login / logout)                      | Done        | P0       | Login page, user avatar/name in rail, logout button                                                      |
| Error boundaries and loading states                     | Partial     | P1       | Skeletons exist; need global error handling                                                              |
| Offline / optimistic updates                            | Done        | P1       | PR #76 — query persistence + optimistic mutations                                                        |
| Frontend refactor (Kumo + TanStack + Tailwind v4 + PWA) | Done        | P1       | PR #34 — TanStack Router + Query + Kumo UI + Tailwind v4 + PWA                                           |
| PWA manifest & service worker                           | Done        | P2       | PR #34 — installable app, offline caching                                                                |
| Push notifications                                      | Not started | P2       | Expiry/run-out reminders                                                                                 |
| Mobile native wrappers (iOS/Android)                    | Not started | P2       | Future phase                                                                                             |

## 3. Backend (Cloudflare Workers + Hono)

| Item                                          | Status      | Priority | Notes                                                                              |
| --------------------------------------------- | ----------- | -------- | ---------------------------------------------------------------------------------- |
| Backend project scaffold                      | Done        | P0       | `backend/` with Hono, Wrangler config example                                      |
| Google OAuth 2.0 login & callback             | Done        | P0       | OAuth flow with PKCE, JWT sessions, default seed on household creation             |
| JWT session cookie middleware                 | Done        | P0       | `backend/src/middleware.ts`; verifies cookie + loads active household              |
| CORS configuration                            | Done        | P0       | Configured for Pages origin + localhost                                            |
| Health check endpoint                         | Done        | P0       | `GET /api/health`                                                                  |
| `GET /api/me` endpoint                        | Done        | P0       | Returns current user                                                               |
| `GET /api/stock` endpoint                     | Done        | P0       | Query with location/q filters, ordered by run-out + expiry                         |
| Stock CRUD endpoints (`PATCH /api/stock/:id`) | Done        | P0       |                                                                                    |
| Household endpoints                           | Not started | P0       | Create/list households, set active                                                 |
| Location endpoints                            | Done        | P0       | `GET/POST/DELETE /api/locations`                                                   |
| Store endpoints                               | Done        | P0       | `GET/POST/DELETE /api/stores`                                                      |
| Purchase endpoints                            | Done        | P0       | `GET/POST /api/purchases`, `GET /api/purchases/:id`, `GET /api/purchases/patterns` |
| Receipt upload to R2                          | Not started | P0       | `POST /api/purchases/scan`                                                         |
| Plan endpoints                                | Done        | P0       | `GET/POST /api/plans`, `POST /api/plans/generate`, `PATCH /api/plans/items/:id`    |
| Settings endpoints                            | Done        | P0       | `GET/PATCH /api/settings`                                                          |
| AI chat endpoint                              | Done        | P0       | `POST /api/ai/chat` (streaming deferred; see ARCHITECTURE.md §13)                  |
| AI usage endpoint                             | Done        | P0       | `GET /api/ai/usage`                                                                |
| Input validation with Valibot                 | Done        | P0       | Add to all routes                                                                  |
| Centralized error handling                    | Done        | P1       | `app.onError` catches all unhandled errors; middleware returns JSON errors         |
| Rate limiting                                 | Not started | P1       | Per-user AI and API limits                                                         |
| Request logging / observability               | Not started | P2       | Structured logs, optional analytics                                                |

## 4. Database (Cloudflare D1)

| Item                            | Status      | Priority | Notes                                                                           |
| ------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------- |
| Relational schema design        | Done        | P0       | `backend/migrations/0001_schema.sql`                                            |
| Migration runner / setup script | Done        | P0       | `scripts/deploy/setup-db.js`                                                    |
| Seed default locations & stores | Done        | P0       | Kulkas, Freezer, Lemari, Rak + Indomaret, Alfamart, Pasar on household creation |
| Run-out estimate computation    | Done        | P0       | `computeRunOutDays` in `backend/src/lib/stock.ts`; full history, weighted avg   |
| Index tuning                    | Partial     | P0       | Basic indexes in schema; validate with query patterns                           |
| Multi-household data isolation  | Partial     | P0       | Schema ready; enforce in all queries                                            |
| Backup / export strategy        | Not started | P2       | Periodic D1 export                                                              |

## 5. Authentication & security

| Item                            | Status      | Priority | Notes                                                                                                             |
| ------------------------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| Google OAuth 2.0 integration    | Partial     | P0       | Code complete; needs secrets and live test                                                                        |
| Session JWT signing             | Partial     | P0       | `backend/src/auth.ts`; verify key rotation story                                                                  |
| Secure AI key encryption        | Done        | P0       | AES-GCM with `WORKER_ENCRYPTION_KEY`                                                                              |
| R2 signed URLs for receipts     | Partial     | P0       | Receipts served through `GET /api/purchases/:id/receipt` proxy; R2 signed URLs deferred (see ARCHITECTURE.md §13) |
| AI prompt data isolation        | Done        | P0       | All chat/plan/scan prompts filtered by `household_id` in queries                                                  |
| HTTPS-only cookies              | Partial     | P0       | Set `Secure`; verify on deployed domain                                                                           |
| CORS restricted to Pages origin | Done        | P0       | Allows Pages origin + `*.rumaq.pages.dev` preview subdomains                                                      |
| CSRF protection via OAuth state | Done        | P0       | `state` + PKCE in `backend/src/auth.ts`                                                                           |
| Row-level security review       | Not started | P1       | Ensure every query filters by household                                                                           |

## 6. AI features

| Item                              | Status      | Priority | Notes                                                                                          |
| --------------------------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| BYO AI key in settings            | Done        | P0       | UI exists; backend encryption pending                                                          |
| Receipt OCR → parsed items        | Done        | P0       | PR #63 — `backend/src/lib/ai.ts` + scan endpoint                                               |
| Shopping plan generation          | Done        | P0       | PR #77 — plans API + Plan page wired                                                           |
| Assistant chat with system prompt | Done        | P0       | EN-only persona; see ARCHITECTURE.md §13                                                       |
| Daily AI usage meter              | Done        | P0       | Backend counter + UsageMeter wired                                                             |
| Use-it-up expiry recipe nudge     | Not started | P1       | Suggest recipes for near-expiry items                                                          |
| Cheapest-store recommendation     | Not started | P1       | From price history; Haqita integration later                                                   |
| Consumption calibration           | Partial     | P1       | Run-out recalibration extends in-place; no bulk recalibrate endpoint (see ARCHITECTURE.md §13) |
| Natural-language quick add        | Not started | P1       | Parse "beli 2L susu di Indomaret"                                                              |
| Trip optimization                 | Not started | P2       | Group plan by location/time                                                                    |
| Price memory & alerts             | Not started | P2       | Track price changes per store/product                                                          |

## 7. DevOps & deployment

| Item                                | Status      | Priority | Notes                                                                                              |
| ----------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------- |
| Cloudflare Pages deployment config  | Done        | P0       | `wrangler pages deploy` in deploy.sh (retiring Pages for Worker assets per tech-stack-tidyup plan) |
| Cloudflare Worker deployment config | Done        | P0       | `backend/cloudflare.config.ts` (env-driven single config)                                          |
| D1 database creation guide          | Done        | P0       | `scripts/deploy/setup-db.js` + README                                                              |
| R2 bucket creation guide            | Not started | P0       | Add to README or script                                                                            |
| GitHub Actions CI                   | Done        | P1       | Unit tests + build on push/PR to main                                                              |
| Test automation CI                  | Done        | P1       | Docker-based integration/E2E tests on push/PR to main                                              |
| Preview deployments for PRs         | Done        | P1       | Branch-specific Worker + Pages preview; auto-cleanup                                               |
| Secrets management documentation    | Done        | P0       | `docs/ARCHITECTURE.md` §8 env vars table; `RUN_SECRETS_CHECK` guards missing secrets               |
| Environment-specific configs        | Not started | P1       | `.dev.vars` for local, secrets for prod                                                            |

## 8. Quality assurance

| Item                        | Status      | Priority | Notes                                                                                          |
| --------------------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| Frontend production build   | Done        | P0       | `vp build` passes                                                                              |
| Worker TypeScript typecheck | Done        | P0       | `vp check --no-fmt --no-lint` passes                                                           |
| Unit tests                  | Done        | P1       | Vitest: 16+ frontend suites, 3 backend suites with coverage thresholds                         |
| API integration tests       | Done        | P1       | `automation/tests/local/api/` — Vitest BDD + fetch against Docker Miniflare; `vp run test:api` |
| End-to-end tests            | Partial     | P2       | Playwright BDD smoke test in `automation/tests/local/e2e/`; `vp run test:e2e`                  |
| Docker test automation      | Done        | P1       | `docker compose -f automation/docker-compose.yml` runs all tests; CI workflow                  |
| Production smoke tests      | Done        | P1       | Scheduled GitHub Actions check `rumaq.pages.dev` every 6 hours                                 |
| Accessibility audit         | Not started | P1       | Keyboard navigation, contrast, labels                                                          |
| Performance budget          | Not started | P2       | Bundle size, First Contentful Paint                                                            |

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

### PR 1 — Authentication

_User impact: sign in with Google, see profile, sign out._

- Configure real Google OAuth credentials in Cloudflare secrets; verify login/callback/logout flow end-to-end.
- Seed default locations (kulkas, freezer, lemari, rak) and stores (indomaret, alfamart, pasar) during household creation.
- Add auth UI: login button, user avatar/name from `getMe()`, logout.
- Expand API client with `getMe()`, `getHealth()`, and auth helpers.
- Establish centralized error handling + JSON error response pattern.
- Add integration tests for the OAuth flow and auth middleware.

### PR 2 — Settings & Preferences

_User impact: configure AI key, locations, stores, persona, language, motion, and currency — all persisted._

- Implement `GET /api/settings` and `PATCH /api/settings` with AES-GCM encryption for the AI key.
- Implement `GET/POST/DELETE /api/locations` and `GET/POST/DELETE /api/stores`.
- Wire Settings page fully: provider/key, persona, locations, stores, language, motion, currency.
- Wire `UsageMeter` to `GET /api/ai/usage`.
- Add tests for settings CRUD, encryption round-trip, and location/store CRUD.

### PR 3 — Inventory Dashboard

_User impact: see real stock on Home and Inventory, search/filter/update items._

- Implement run-out estimate computation from purchase history and stock qty.
- Implement `PATCH /api/stock/:id` for qty, location, and expiry updates.
- Wire Home page: stats, needs-attention list, next trip, quick refill.
- Wire Inventory page: search, location filter, time signals, urgency sort.
- Add tests for stock queries, run-out calculation, and PATCH validation.

### PR 4 — Receipt Scan → Stock

_User impact: take a receipt photo, AI reads the items, review them, and stock updates._

- Implement `POST /api/purchases/scan`: receipt upload to R2, AI OCR, parsed item extraction.
- Implement `POST /api/purchases` for manual purchase entry.
- Wire AddFromReceipt page through the 4-phase flow (capture → scanning → review → done).
- Create/update `items`, `stock`, `purchases`, and `purchase_items` in one transaction.
- Add tests for scan endpoint, purchase creation, and R2 upload handling.
- Verify AI prompt context is scoped to the current household only.

### PR 5 — AI Shopping Plans

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

Phase 04 (AI Shopping Plans) and Phase 05 (Purchase History & Ship) are complete. Remaining P0 items:

1. Enable email auth in production (`EMAIL_AUTH_ENABLED` binding in `backend/cloudflare.config.ts`) after verifying the login flow live.
2. Deploy to Cloudflare via `./scripts/deploy.sh cloudflare` and run end-to-end smoke verification.
3. Run automation-local and production smoke tests.
4. Address tech debt items listed in `docs/ARCHITECTURE.md` §13.
