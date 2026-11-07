# RumaQ — Testing Strategy

## Unit test

| Location                          | Runner | Environment | Coverage                |
| --------------------------------- | ------ | ----------- | ----------------------- |
| `frontend/src/**/*.test.{js,jsx}` | Vitest | jsdom       | 50/50/50/50             |
| `backend/src/**/*.test.ts`        | Vitest | Node        | 50/50/50/50 (D1 mocked) |

```
./scripts/test.sh unit
```

## Deploy guard test (offline)

`scripts/test/deploy-secrets.sh` asserts the deploy surface's secret policy
(ahaqqu/RumaQ#456): `scripts/deploy.sh` and the Deploy production workflow
manage **exactly** the four gateway secrets and never the operator-owned
`HAQITA_INGEST_SECRET`, which is set and rotated out-of-band. It reads the
files only — no network, no Cloudflare credentials — so it runs in every CI
pass via `scripts/github/ci.sh`.

```
./scripts/test.sh deploy
```

## Local automation test

All services behind `nginx` proxy on a per-run host port: the runner picks a
free port and prints it (`RUMAQ_TEST_PORT` overrides; `localhost:3000` when
compose is used directly). Worker exposes `TEST_MODE`-guarded admin endpoints.
Gherkin features + `jest-cucumber` for API, `playwright-bdd` for E2E. Run by
Vitest + Playwright inside Docker. Each checkout uses its own Compose project,
so parallel worktrees/sessions can run the suite concurrently.

```
./scripts/test.sh automation-local
```

### E2E page-level coverage (`automation/tests/local/e2e/`)

Beyond the login/logout smoke, each main flow has a BDD feature file. Every
scenario resets and reseeds the database through the `TEST_MODE` admin
endpoints (`shared.steps.js` `Before` hook), and scenarios run with
`workers: 1` because they share one seeded backend.

| Feature                   | Covers                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.feature`           | App shell loads, email login, logout recovers to the login form                                                                                                                                                                                                |
| `inventory.feature`       | Stock list, search, location filter, empty state, quantity +/- with optimistic update                                                                                                                                                                          |
| `plan.feature`            | Connect-key state, AI generate (mocked), save draft, check-off persists after reload                                                                                                                                                                           |
| `history.feature`         | Month groups, totals, store filter, item search (whole-purchase match semantics)                                                                                                                                                                               |
| `settings.feature`        | Seeded locations/stores listed, add + remove location and store                                                                                                                                                                                                |
| `add-receipt.feature`     | Upload → mock scan → review → confirm → stock updated; unsupported type rejected                                                                                                                                                                               |
| `prices-explorer.feature` | Server-side sort, promo badges, freshness line, #productKey deep-link expand + scroll                                                                                                                                                                          |
| `price-promos.feature`    | Promos segment: fixed-order cards, expand, example jump into the explorer, empty state                                                                                                                                                                         |
| `admin-review.feature`    | Match review queue: side-by-side pair, decide persists across reload, undo, versioned export download, monitor cross-link, forbidden state for non-admins; AI mode switch persists across reload, and Agree on a cached verdict records `ai_assist` provenance |
| `admin-rename.feature`    | Canonical rename (#423): versioned write, explorer row refetch + reload persistence, frozen review-pair labels, cold load (#488)                                                                                                                               |
| `duplicate-names.feature` | Duplicate-name report (#485): admin-only panel, collapsed until opened, one lazy fetch, group rows with product keys and observing stores                                                                                                                      |
| `accessibility.feature`   | axe-core scan (wcag2a/2aa/21a/21aa) of every main page; fails on critical/serious                                                                                                                                                                              |

Notes for writing new E2E scenarios:

- `TEST_MODE` mocks all AI endpoints (chat, plan generate, receipt scan, the
  vault's expiry-date read #433, and the persona copy rewrite #523 P5, which
  echoes the strings it was sent) — no real AI key is reached. A flow that needs
  a resolved provider turns AI on the way a household owner does (#523 P3):
  `configureAi()` in `automation/tests/local/api/steps/helpers.js` (API) and
  `configureAi()` in `automation/tests/local/e2e/steps/ai-setup.js` (E2E) POST a
  provider to `/api/ai/providers` and assign the capabilities through
  `/api/ai/capabilities/*`, then drop the persisted query cache — the app caches
  settings for 5 minutes in IndexedDB, and a reload inside the persister's
  throttle window would otherwise hydrate a pre-setup snapshot
  (`clearPersistedQueryCache()` in `shared.steps.js`). There is no legacy
  `PATCH /api/settings` AI write any more: those fields are rejected with 400
  and the columns are gone (migration 0042).
  The match-review evaluator (#484) is the deliberate exception: under
  `TEST_MODE` it is NOT stubbed — with no provider configured it returns the
  documented 200 `{ evaluated: 0, aiConfigured: false }` degrade, never a
  fabricated verdict. When a scenario needs a cached verdict, seed one through
  the harness-only `POST /api/__test/direct-sql` endpoint (the products-rename
  precedent) and give the household a `decision` provider so the queue reports
  `aiConfigured: true` — the scenario then exercises the assist decision
  (Agree → `ai_assist`), never a model call.

  The ten scenarios that were pending from P1 to P3 (API: chat reply, plan
  generate, receipt scan, both `ai_usage` ones; E2E: the receipt scan, the three
  plan flows and the cached verdict assist) are live again against those public
  endpoints — none were deleted.

- Assert item names in the receipt review via input values (`getByRole
  'textbox'`), not text — review rows are editable inputs.
- Scope history item assertions to `getByRole('table')` — the Patterns
  section repeats item names outside the purchase table.

## Live production automation test

Runs every 6 hours via `.github/workflows/smoke.yml`. Base URL: `rumaq.ahaqqu.com` (app + API, same origin; the Worker Custom Domain). Run by Cucumber-js (API health) and Playwright (E2E login/logout). On failure → auto-creates issue with `smoke-failure` label.

```
./scripts/test.sh automation-live
```

## Accessibility

- **axe-core** (`@axe-core/playwright`) scans the login page and every main
  page (Home, Inventory, Plan, History, Settings) in
  `automation/tests/local/e2e/features/accessibility.feature`. CI fails on
  any **critical or serious** violation (wcag2a, wcag2aa, wcag21a, wcag21aa
  tags); moderate/minor findings surface in the test report only.
- The first audit wave (2026-10) fixed: logout / bottom-nav / offline-banner
  text contrast, the `--warn` token (now ≥ 4.5:1 on all light surfaces),
  three unnamed submit buttons in Settings, and the assistant FAB accessible
  name. Known remaining item: the `--ok` token is ~3.8:1 — below AA for body
  text; no audited page currently renders ok-toned body text, so axe does not
  flag it. Revisit when a screen uses it.
- Follow-up (2026-11): the household card link's accessible name now comes from
  the card's visible text (household name + member count + hint). The previous
  `aria-label` carried only the name and the "Household members" suffix, which
  tripped axe `label-content-name-mismatch` (WCAG 2.5.3) on every page (#498).
- Manual screen-reader passes (NVDA/VoiceOver) are periodic, not automated.

## Performance budget

Enforced in CI (`.github/workflows/ci.yml`, on every PR):

- **Bundle size** — `scripts/ci/bundle-budget.mjs` fails when the total JS in
  `frontend/dist/assets` exceeds **250 KB gzipped** (2026-10 baseline ≈ 185 KB).
- **Lighthouse CI** — `treosh/lighthouse-ci-action` against the built
  `frontend/dist` (desktop preset, static run; measures the public login
  page). Assertions: Performance ≥ 0.7 (error), Accessibility ≥ 0.9 (error),
  Best-Practices ≥ 0.9 (warn), SEO off. Config: `.lighthouserc.json`.

Both gates are hard errors; relax them only with a documented reason in the
PR (e.g. a deliberate dependency addition), and prefer lazy-loading/splitting
heavy deps over raising the budget.

## Acceptance criteria

- [x] Frontend unit test coverage thresholds met (50/50/50/50) — `./scripts/test.sh unit frontend --coverage`
- [x] Backend unit test coverage thresholds met (50/50/50/50) — `./scripts/test.sh unit backend --coverage`
- [x] New API endpoint has automation test scenario — `automation/tests/local/api/`
- [x] New UI flow has automation test scenario — `automation/tests/local/e2e/`
- [x] Local automation tests pass — `./scripts/test.sh automation-local`
- [x] API docs match current routes — `./scripts/docs.sh` + `git diff --exit-code docs/API.md`
- [x] All unit tests pass — `./scripts/test.sh unit`
- [x] Code style and lint pass — `./scripts/style.sh --check`
- [x] Deploy never writes the operator-owned ingest secret — `./scripts/test.sh deploy`
- [x] Main user flows covered by page-level E2E — `automation/tests/local/e2e/features/`
- [x] No critical/serious axe-core violations on main pages — `accessibility.feature`
- [x] Bundle-size budget enforced in CI — `scripts/ci/bundle-budget.mjs`
- [x] Lighthouse budgets enforced in CI — `.lighthouserc.json` + `ci.yml`
