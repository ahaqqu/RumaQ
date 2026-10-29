# RumaQ — Testing Strategy

## Unit test

| Location                          | Runner | Environment | Coverage                                                                           |
| --------------------------------- | ------ | ----------- | ---------------------------------------------------------------------------------- |
| `frontend/src/**/*.test.{js,jsx}` | Vitest | jsdom       | 50/50/50/50                                                                        |
| `backend/src/**/*.test.ts`        | Vitest | Node        | 50/50/50/50 (D1 mocked)                                                            |
| `scraper/{src,test}/**/*.test.ts` | Vitest | Node        | no threshold yet (new workspace; all IO injected, haqita fixtures ported verbatim) |

```
./scripts/test.sh unit
```

## Local automation test

All services behind `nginx` proxy at `localhost:3000`. Worker exposes `TEST_MODE`-guarded admin endpoints. Gherkin features + `jest-cucumber` for API, `playwright-bdd` for E2E. Run by Vitest + Playwright inside Docker.

```
./scripts/test.sh automation-local
```

### E2E page-level coverage (`automation/tests/local/e2e/`)

Beyond the login/logout smoke, each main flow has a BDD feature file. Every
scenario resets and reseeds the database through the `TEST_MODE` admin
endpoints (`shared.steps.js` `Before` hook), and scenarios run with
`workers: 1` because they share one seeded backend.

| Feature                   | Covers                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `smoke.feature`           | App shell loads, email login, logout recovers to the login form                        |
| `inventory.feature`       | Stock list, search, location filter, empty state, quantity +/- with optimistic update  |
| `plan.feature`            | Connect-key state, AI generate (mocked), save draft, check-off persists after reload   |
| `history.feature`         | Month groups, totals, store filter, item search (whole-purchase match semantics)       |
| `settings.feature`        | Seeded locations/stores listed, add + remove location and store                        |
| `add-receipt.feature`     | Upload → mock scan → review → confirm → stock updated; unsupported type rejected       |
| `prices-explorer.feature` | Server-side sort, promo badges, freshness line, #productKey deep-link expand + scroll  |
| `price-promos.feature`    | Promos segment: fixed-order cards, expand, example jump into the explorer, empty state |
| `admin-review.feature`    | Match review queue: side-by-side pair, decide persists across reload, undo, versioned export download, monitor cross-link, forbidden state for non-admins |
| `accessibility.feature`   | axe-core scan (wcag2a/2aa/21a/21aa) of every main page; fails on critical/serious      |

Notes for writing new E2E scenarios:

- `TEST_MODE` mocks all AI endpoints (chat, plan generate, receipt scan) — no
  real AI key is needed; set one via `PATCH /api/settings` when a flow
  requires `has_ai_key`, and drop the persisted query cache afterwards (the
  app caches settings for 5 minutes in IndexedDB).
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
- [x] Scraper unit tests pass — `./scripts/test.sh unit scraper`
- [x] New API endpoint has automation test scenario — `automation/tests/local/api/`
- [x] New UI flow has automation test scenario — `automation/tests/local/e2e/`
- [x] Local automation tests pass — `./scripts/test.sh automation-local`
- [x] API docs match current routes — `./scripts/docs.sh` + `git diff --exit-code docs/API.md`
- [x] All unit tests pass — `./scripts/test.sh unit`
- [x] Code style and lint pass — `./scripts/style.sh --check`
- [x] Main user flows covered by page-level E2E — `automation/tests/local/e2e/features/`
- [x] No critical/serious axe-core violations on main pages — `accessibility.feature`
- [x] Bundle-size budget enforced in CI — `scripts/ci/bundle-budget.mjs`
- [x] Lighthouse budgets enforced in CI — `.lighthouserc.json` + `ci.yml`
