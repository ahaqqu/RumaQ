# RumaQ — Testing Strategy

The test and check scripts print failures only. The full output is written to
`test-results/*.log` (gitignored), and CI uploads those logs when a run fails.

## Unit test

| Location                          | Runner | Environment | Coverage                |
| --------------------------------- | ------ | ----------- | ----------------------- |
| `frontend/src/**/*.test.{js,jsx}` | Vitest | jsdom       | 50/50/50/50             |
| `backend/src/**/*.test.ts`        | Vitest | Node        | 50/50/50/50 (D1 mocked) |

```
./scripts/test.sh unit
```

Scope: in CI each suite runs only when the change set can reach it — the
frontend suite runs on `frontend/` (plus dependencies, the test plumbing under
`scripts/`, and anything unknown), the backend suite on `backend/` +
`contract/`. The other workspace's sources, docs, codegen tools and Markdown
skip. Named edge: `frontend/src/plugins/registry.test.js` imports backend's
`plugins/manifests.js` (plugin parity), so `backend/src/plugins/` always runs
the frontend suite. `scripts/github/unit-test-scope.sh` decides from the
change set, the decision is covered offline by
`./scripts/test.sh unit-test-scope`, and an unavailable diff runs both suites
— a wasted minute, never a regression that merges green.

## Worker boot smoke (CI gate)

`scripts/github/worker-boot-smoke.sh` builds the backend with the Cloudflare
Vite plugin (`vp build backend`) and boots the resulting **bundle in workerd**
twice, asserting `GET /api/health` answers `{"ok":true}` each time:

1. `vp preview backend` — the plugin's own preview runtime, what dev and
   previews serve through.
2. `scripts/ci/worker-boot-harness.mjs` — the repo's pinned `miniflare` dev
   dependency, the runtime the nightly Docker/automation harness boots
   (`automation/tests/support/worker-server.mjs`).

Deploys build the same bundle through the same plugin (`cf deploy`), so the
boot check exercises the deploy artifact even though it does not run the
preview server.

It runs inside `scripts/github/ci.sh` — the gate both the PR `ci` job
(`.github/workflows/ci.yml`) and the main-push `ci` job
(`.github/workflows/deploy.yml`) run — and is local-runnable:

```
bash ./scripts/github/worker-boot-smoke.sh
```

Scope: the smoke runs when the change set can reach the bundle — any path
outside `docs/`, `.agents/`, `automation/` and Markdown. A docs-, skill- or
test-only change skips it, because `vp build backend` cannot differ for those
paths. `scripts/github/worker-smoke-scope.sh` decides from the change set, the
decision is covered offline by `./scripts/test.sh smoke-scope`, and an
unavailable diff runs the smoke — a wasted minute, never a bundle that merges
green.

It is the only CI check that evaluates the real Worker bundle under the runtimes
that host it (ahaqqu/RumaQ#534). Unit tests call `app.request()` on the Hono app
in Node (no bundle evaluation, no workerd rules), and the static module-scope
scan added with the #533 fix (`backend/src/__tests__/worker-global-scope.test.ts`)
matches direct constructs only. The Docker automation stack does boot the same
bundle, but only on its nightly schedule — a module-scope `new AbortController()`
(#533) made the Worker unable to start at all and still merged green.

Booting **both** runtimes is deliberate: they ship different workerd versions
and disagree on global-scope restrictions. The plugin's newer workerd accepts
`new AbortController()` at module scope; the pinned one — the runtime #533
actually broke — rejects it. A preview-only gate would let that line pass PRs
and fail the nightly again, so the harness boot keeps the gate load-bearing for
the nightly stack.

No secrets, no D1 migrations and no Docker: `/api/health` is a static JSON
handler, and the script clears `CLOUDFLARE_ACCOUNT_ID` (and the API token)
before building, so the LOCAL environment turns the startup secrets check off.
The harness has a 60 s boot deadline and the preview a 90 s health deadline.
Keep it well under a minute once dependencies are installed — the full 150/53
automation matrix stays nightly in `test-automation.yml`.

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

## Price-freshness probe test (offline)

`scripts/test/price-freshness.sh` runs the real
`scripts/github/check-price-freshness.sh` against canned probe responses
(issue #536): the consecutive-failed-run branch must fire with **zero
observations** (a pipeline that never publishes must not read as "go-live
pending"), the staleness branch keeps its behaviour, and a missing or renamed
field fails instead of disarming the alert. A `curl` shim first in `PATH`
serves the responses — no network, no secret.

```
./scripts/test.sh freshness
```

## Local automation test

All services behind an `nginx` proxy published on an **ephemeral, loopback-only**
host port: Docker assigns a free port and the runner discovers it after `up` and
prints `http://127.0.0.1:<port>` (`RUMAQ_TEST_PORT` pins an explicit loopback
port; `RUMAQ_PROXY_PORTS` overrides the whole mapping). Inside the Compose
network the proxy stays `proxy:3000`, so test origins and the CSRF assertions
are unchanged. Worker exposes `TEST_MODE`-guarded admin endpoints. Gherkin
features + `jest-cucumber` for API, `playwright-bdd` for E2E. Run by Vitest +
Playwright inside Docker.

The images are **toolchain-only** (ahaqqu/RumaQ#356): bun 1.4.0, real Node for
the Worker build, nginx, Playwright/Chromium and the installed dependency tree —
never repo source. `backend/src`, `backend/migrations`, `contract/src`,
`automation/tests`, `frontend/src` and `frontend/public` are bind-mounted
read-only, and each service builds its artifact at container start (Worker
bundle, SPA, BDD tests) behind a content-hash cache in a per-toolchain-digest
volume. Consequences:

- a **source** edit needs no image work at all — the next run reads the mount;
- a **deps/config** edit changes the image tag (a digest of Dockerfiles,
  entrypoints, nginx config, manifests, lockfile and build configs), and Compose
  builds exactly that one missing tag; every checkout with the same lockfile
  shares it;
- a **warm, unchanged** run reuses the cache, so the artifact builds cost
  roughly a copy instead of the build;
- `node_modules` is never mounted — the image's dependency tree is the only one
  the container sees, which is what keeps "deps change ⇒ rebuild" true.

The first run on a machine (or after a Docker prune) builds the toolchain
images; the Playwright + Chromium layer dominates that cold cost, and a lockfile
change rebuilds it too. Later runs reuse them. `--build` re-runs the image build
for the current digest (Docker's layer cache is reused — it is not `--no-cache`),
`--no-build` fails fast when the tag is missing instead of silently building it,
and `RUMAQ_BUILD_CACHE=0` bypasses the artifact cache.

Each **invocation** gets its own Compose project, an ephemeral loopback port and
its own results directory (`automation/test-results/runs/<run-id>/`), so runs
from the same checkout or different worktrees never share containers, ports,
Playwright reports, Vitest JSON, artifacts or diagnostics. `--down` takes no
arguments: it sweeps this checkout's stacks by label and never touches another
checkout's. A project that also contains a foreign container is refused as a
whole — it is never `down`-ed project-wide — and pre-#356 unlabelled stacks are
found by their deterministic old project name. The same ownership check runs
before a normal `up` and again at teardown: if an explicit `COMPOSE_PROJECT_NAME`
already points at another checkout's containers (even ones created from this
compose file), the run refuses to start or tear it down and exits nonzero. `--clean` also removes this
toolchain's cache volume; that volume is shared by every checkout using the same
lockfile, so run `--clean` only when no other automation run is active (Docker
refuses to remove a volume that is in use).

`--api` starts only `api` + `proxy` (the API suite never requests the SPA), so it
skips the web build and the SPA phase of the readiness gate; the full and
`--e2e` modes start `web` too and therefore prove the published SPA bundle.

Readiness is a real gate on the published port: `/api/health` must answer 200
**and** `{"ok":true}`, `/` must answer 200 with `id="root"` (full/e2e), then the
#318 canary `POST /api/purchases` must answer 401 — with a 250 ms→2 s jittered
backoff, one 180 s budget (`RUMAQ_READY_TIMEOUT`, each probe capped at the
remaining budget), per-attempt logging, and a diagnostics bundle under
`automation/test-results/runs/<run-id>/diagnostics/` that the workflow uploads.
A diagnostics write failure is reported but never masks the original failure.

```
./scripts/test.sh automation-local
```

### Image tags and manual pruning

Image tags are content-addressed and local-only (`rumaq-test-*:<digest>`); a
lockfile/config change simply stops referencing the old tag. Nothing prunes
automatically — removing a tag can race a parallel run still using it. Prune
manually when disk matters (no run in flight):

```bash
docker image ls --filter label=rumaq.automation.toolchain
docker image prune -a --filter label=rumaq.automation.toolchain
docker volume ls --filter name=rumaq-test-cache-
rm -rf automation/test-results/runs   # per-run reports/diagnostics (gitignored)
```

`./scripts/test.sh automation-local --clean` removes only the current
toolchain's cache volume (the recovery for a corrupted cache). Because that
volume is shared across checkouts for the same lockfile, use it only when no
other automation run is active; the next run rebuilds the cache.

### E2E page-level coverage (`automation/tests/local/e2e/`)

Beyond the login/logout smoke, each main flow has a BDD feature file. Every
scenario resets and reseeds the database through the `TEST_MODE` admin
endpoints (`shared.steps.js` `Before` hook), and scenarios run with
`workers: 1` because they share one seeded backend.

| Feature                   | Covers                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.feature`           | App shell loads, email login, logout recovers to the login form                                                                                                                                                                                                                                                                                   |
| `inventory.feature`       | Stock list, search, location filter, empty state, quantity +/- with optimistic update                                                                                                                                                                                                                                                             |
| `plan.feature`            | Connect-key state, AI generate (mocked), save draft, check-off persists after reload                                                                                                                                                                                                                                                              |
| `history.feature`         | Month groups, totals, store filter, item search (whole-purchase match semantics)                                                                                                                                                                                                                                                                  |
| `settings.feature`        | Seeded locations/stores listed, add + remove location and store                                                                                                                                                                                                                                                                                   |
| `add-receipt.feature`     | Upload → mock scan → review → confirm → stock updated; unsupported type rejected                                                                                                                                                                                                                                                                  |
| `prices-explorer.feature` | Server-side sort, promo badges, freshness line, #productKey deep-link expand + scroll                                                                                                                                                                                                                                                             |
| `price-promos.feature`    | Promos segment: fixed-order cards, expand, example jump into the explorer, empty state                                                                                                                                                                                                                                                            |
| `price-brochures.feature` | Admin brochure ingestion QA (#630/#631): the retired `/prices?view=brochures` deep link redirects to `/admin/catalog?tab=brochures`, a multi-column card grid with image/fallback, store/date filters, selecting a card opens the full product table, a row expands its ingestion metadata in place (no navigation), hash precedence, empty state |
| `admin-review.feature`    | Match review queue: side-by-side pair, decide persists across reload, undo, versioned export download, monitor cross-link, forbidden state for non-admins; AI mode switch persists across reload, and Agree on a cached verdict records `ai_assist` provenance                                                                                    |
| `admin-rename.feature`    | Canonical rename (#423): versioned write, admin-catalog row refetch + reload persistence, frozen review-pair labels, cold load (#488)                                                                                                                                                                                                             |
| `duplicate-names.feature` | Duplicate-name report (#485): admin-only admin-catalog panel, collapsed until opened, one lazy fetch, group rows with product keys and observing stores                                                                                                                                                                                           |
| `accessibility.feature`   | axe-core scan (wcag2a/2aa/21a/21aa) of every main page; fails on critical/serious                                                                                                                                                                                                                                                                 |

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
  page (Home, Inventory, Plan, History, Settings, Prices, Prices promos, and
  the admin catalog) in
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

Enforced in CI (`.github/workflows/ci.yml`, on pull requests — the audit
gates are scoped to the change set, see below):

- **Bundle size** — `scripts/ci/bundle-budget.mjs` fails when the total JS in
  `frontend/dist/assets` exceeds **350 KB gzipped** (2026-10 baseline ≈ 185 KB;
  raised from 250 KB on 2026-11-11 for the #518 purchase flows + hey-api
  generated client — revisit after codegen slimming, #580).
- **Lighthouse CI** — `treosh/lighthouse-ci-action` against the built
  `frontend/dist` (desktop preset, static run; measures the public login
  page). Assertions: Performance ≥ 0.7 (error), Accessibility ≥ 0.9 (error),
  Best-Practices ≥ 0.9 (warn), SEO off. Config: `.lighthouserc.json`. PRs
  whose change set cannot reach the bundle (docs, backend, contract, codegen
  tools, most scripts) skip the audit — scoped by
  `scripts/github/lighthouse-scope.sh`, offline-tested via
  `./scripts/test.sh lighthouse-scope`, failing safe to a run.

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
- [x] Real Worker bundle boots in workerd and serves `/api/health` on every CI run whose change set can reach the bundle — `scripts/github/worker-boot-smoke.sh`, scoped by `scripts/github/worker-smoke-scope.sh`
- [x] Main user flows covered by page-level E2E — `automation/tests/local/e2e/features/`
- [x] No critical/serious axe-core violations on main pages — `accessibility.feature`
- [x] Bundle-size budget enforced in CI — `scripts/ci/bundle-budget.mjs`
- [x] Lighthouse budgets enforced in CI — `.lighthouserc.json` + `ci.yml`, scoped to change sets that can reach the bundle
