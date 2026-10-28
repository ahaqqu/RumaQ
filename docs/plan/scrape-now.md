# Scrape Now — admin-triggered, store-selectable scraping with live logs

Status: APPROVED by owner (2026-10-28). Decisions: manual runs always **publish live**; live output = **raw log stream**; button on a **new `/admin/scrape` page**. Manager handles merge; implementation agents must NOT merge.

Status: APPROVED by owner (2026-10-28). Decisions: manual runs always **publish live**; live output = **raw log stream**; button on a **new `/admin/scrape` page**. Manager handles merge; implementation agents must NOT merge.

## Architecture (locked — do not revisit)

The scraper runs on the VPS as a systemd oneshot; the VPS has zero inbound ports and the Worker is pull-only (locked decisions in `docs/plan/haqita-integration.md` §1–2). Only plan-consistent trigger path: **command queue in D1 + polling agent on the VPS**, reusing the bearer-secret channel.

```
Admin UI ──POST /api/admin/scrape──▶ Worker (D1: scrape_commands row, pending)
VPS agent (new long-running systemd svc) ──GET /api/internal/scrape/next──▶ claims it
Agent spawns: bun dist/index.js --publish --stores=<slugs> --state-dir=...
Agent streams child stdout lines ──POST .../commands/:id/events──▶ D1: scrape_run_events
Agent posts exit ──POST .../commands/:id/finish──▶ command success/failed
Admin UI polls events every 2s while running ◀── raw log = live output AND failure log
```

Nightly path untouched; a manual run lands in `price_runs` automatically via the pipeline's existing run report (`reportRun` in `scraper/src/pipeline.ts`), so the Scraper Monitor (`/admin/prices`) keeps working.

## Codebase pointers (verified 2026-10-28)

- Contract: `contract/src/index.ts` (valibot; shared by scraper + backend; additive changes only).
- Scraper CLI: `scraper/src/main.ts` `parseArgs` (lines 24–36; only `--publish`, `--self-check`, `--state-dir`; nightly failures deliberately exit 0). Pipeline: `scraper/src/pipeline.ts` `runPipeline` + `PipelineOptions` (line ~95); store registry `scraper/src/stores/index.ts` `activePlugins(config)` = `config.stores.map(createPlugin)`; store table `scraper/src/config.ts` `loadConfig()` (slugs `superindo`, `lotte-mart`). Scraper logs ISO-prefixed lines to stdout via `createLog` in `scraper/src/util/log.ts`.
- Backend: Hono app `backend/src/apps/api.ts`. Bearer middleware `requireIngestSecret` (lines 142–154, timing-safe, 503 when unset, 401 on mismatch; internal routes exempt from rate limiter, excluded from OpenAPI). Admin pattern: `apiApp.use('/api/admin/price-runs', propsAuthMiddleware)` (line 255) + `requireAdmin` from `backend/src/lib/admin.ts` on the route (lines 2087–2105). Run-record lib: `backend/src/lib/price-runs.ts` (`recordRunReport`, `listPriceRuns`). Migrations: `backend/migrations/` (latest 0010_price_runs.sql). Types: `backend/src/types.ts` (`HAQITA_INGEST_SECRET`, `ADMIN_EMAILS`).
- Tests: backend `backend/src/__tests__/ingest.test.ts` (fake D1 `createFakeDb`, `apiApp.request(path, init, env)`), `price-runs.test.ts`, `admin.test.ts`; automation `automation/tests/local/api/features/prices.feature` + `steps/prices.steps.js` (admin auth via `signTestCookie`, harness binds `ADMIN_EMAILS='test@rumaq.dev'`). Frontend example: `frontend/src/pages/AdminPrices.test.jsx`. E2E: `automation/tests/local/e2e/AdminPrices.test.jsx`.
- Frontend: TanStack Query v5; polling example `frontend/src/lib/queries/prices.js` `usePriceRuns` (refetchInterval 60s); api client `frontend/src/lib/api.ts` (`unwrap()`/`ApiError`); nav `frontend/src/components/AppShell.jsx` NAV + admin injection (lines 52–56); page pattern `frontend/src/pages/AdminPrices.jsx` (Panel/EmptyState/SkeletonRows, status dots, expandable rows); i18n `frontend/src/i18n/locales/en.json` + `id.json` (`nav.monitor`, `monitor.*`).
- Provisioning: units in `scraper/provision/vps/systemd/` (`rumaq-scraper.service` oneshot with hardening, `EnvironmentFile=/etc/rumaq-scraper/env`, `PLAYWRIGHT_BROWSERS_PATH=/srv/rumaq-scraper/browsers`); `apply.sh` installs units (root, idempotent, currently installs 3 units); deploy `scripts/deploy/vps.sh` — stage 1 builds `bun build scraper/src/main.ts → dist/index.js` (playwright-core external), rsync to /srv/rumaq-scraper, browsers, selfcheck gate.

## 1. Contract — `contract/src/index.ts` (additive)

- `SCRAPE_STORE_SLUGS = ['superindo', 'lotte-mart'] as const`.
- `scrapeCommandCreateSchema` (`{ stores: picklist(SCRAPE_STORE_SLUGS), minLength(1) }`).
- `scrapeEventSchema`: `{ seq: integer ≥0, ts: ISO timestamp, level: picklist(['info','error']), message: string ≤8000 }`; `scrapeEventsPostSchema`: `{ events: array(1..100) }`.
- `scrapeFinishSchema`: `{ status: picklist(['success','failed']), exitCode: picklist([0,1,2]), error: nullish(≤2000), logTruncated: nullish(boolean()) }`.
- Output/response schemas for the admin endpoints (typed OpenAPI codegen depends on them).

## 2. Scraper

- `main.ts`: `--stores=slug1,slug2` (comma list, validated against `SCRAPE_STORE_SLUGS`, unknown slug → error). Scoped runs exit with the pipeline's REAL exit code (1/2) — not the nightly soft-exit-0; the agent depends on it. Update the header comment.
- `pipeline.ts`: `PipelineOptions.stores?: string[]`; filter `activePlugins(config)` result by slug when set; empty filtered list → typed error. Status/per-store report naturally covers only scoped stores.
- New `scraper/src/agent.ts` → bundled `dist/agent.js`:
  - Poll every 15s: `GET {base}/api/internal/scrape/next` — base URL + bearer derived from existing `RUMAQ_INGEST_URL` / `RUMAQ_INGEST_SECRET` (same derivation pattern as `deriveRunsUrl` in `scraper/src/publish/runs.ts`). No new env vars required.
  - On claim: acquire `flock` (via `/usr/bin/flock -w 1800`) on `<stateDir>/run.lock`, then spawn `bun <distDir>/index.js --publish --stores=<slugs> --state-dir=<stateDir>` (env inherited). Re-validate slugs against `SCRAPE_STORE_SLUGS` before building args (defense-in-depth; slugs are `[a-z-]` so no injection surface).
  - Capture merged stdout+stderr line-by-line; each line = one event (`ts` = prefix if parseable else now, `level` = 'error' when from stderr or line matches /error|fail/i else 'info'). Ring-buffer the full log (cap 512KB / 5000 events per command; beyond that keep the TAIL and set `logTruncated`).
  - Batch-post events (flush ~2s or 25 lines) to `POST /api/internal/scrape/commands/:id/events`; seq is agent-assigned monotonic per command; retries are idempotent (worker does ON CONFLICT DO NOTHING).
  - On child exit: `POST .../finish` with status/exitCode/error (last error line or PipelineFailure message). Kill child after 60min → finish failed 'timeout'.
  - Agent never exits on error (log + continue loop); systemd `Restart=always` as backstop.
- Provisioning:
  - New `scraper/provision/vps/systemd/rumaq-scraper-agent.service`: long-running (`Restart=always`, `RestartSec=5`), same user/hardening as `rumaq-scraper.service`, `ExecStart=/usr/bin/bun /srv/rumaq-scraper/dist/agent.js`, same `EnvironmentFile` + `PLAYWRIGHT_BROWSERS_PATH`.
  - `apply.sh`: install the 4th unit; `systemctl enable --now rumaq-scraper-agent.service` (the agent is safe pre-go-live: it only acts on commands).
  - `scripts/deploy/vps.sh`: stage 1 also bundles `scraper/src/agent.ts → dist/agent.js`; after rsync, restart the agent with `sudo -n systemctl restart rumaq-scraper-agent.service` — MUST be non-fatal when the unit isn't installed yet (print a warning, continue); extend the sudoers fragment (`scraper/provision/vps/sudoers/`) with restart rights for the agent unit and update `apply.sh` sudoers installation accordingly.
  - Nightly `rumaq-scraper.service`: wrap `ExecStart` with `/usr/bin/flock -n /var/lib/rumaq-scraper/run.lock` so nightly and manual runs can never overlap (a skipped nightly soft-fails and retries tomorrow — consistent with existing philosophy).

## 3. Backend

- Migration `backend/migrations/0011_scrape_commands.sql` — CHECK the migrations dir first and use the next free number (astro branch may add one):
  - `scrape_commands(id TEXT PK, stores TEXT NOT NULL /*JSON*/, status TEXT NOT NULL DEFAULT 'pending' /*pending|running|success|failed*/, created_by TEXT NOT NULL, created_at TEXT NOT NULL, picked_up_at TEXT, finished_at TEXT, exit_code INTEGER, error TEXT)` + index on created_at DESC.
  - `scrape_run_events(command_id TEXT NOT NULL REFERENCES scrape_commands(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (command_id, seq))`.
- New `backend/src/lib/scrape.ts`:
  - `createScrapeCommand(db, {stores, createdBy})`: 409 if a pending/running command exists (one run at a time); insert with generated id; prune history to newest 50 (delete older commands + their events).
  - `claimNextScrapeCommand(db)`: lazy stale sweep first (status='running' AND picked_up_at < now−2h → status='failed', error='agent lost — no terminal report', finished_at=now); then atomically claim oldest pending via `UPDATE ... WHERE status='pending' ORDER BY created_at LIMIT 1 RETURNING` setting status='running', picked_up_at=now; return command or null.
  - `appendScrapeEvents(db, id, events)`: 404 unknown command; 409 if already terminal; `INSERT ... ON CONFLICT (command_id, seq) DO NOTHING`.
  - `finishScrapeCommand(db, id, body)`: only running→terminal (ignore repeat finishes).
  - `listScrapeCommands(db, limit=20)`, `listScrapeEvents(db, id, afterSeq=0, limit=1000)` (404 unknown command).
- Routes in `backend/src/apps/api.ts` (copy existing patterns exactly):
  - Admin (describeRoute-annotated, `propsAuthMiddleware` registered for each path, `requireAdmin` inline): `POST /api/admin/scrape` → 201 `{id}` (400 unknown store via valibot, 409 conflict), `GET /api/admin/scrape/stores` → `{stores: [...SCRAPE_STORE_SLUGS]}`, `GET /api/admin/scrape/commands`, `GET /api/admin/scrape/commands/:id/events?afterSeq=N`. Set `Cache-Control: private, no-cache` like the price-runs route.
  - Internal (`requireIngestSecret`, no describeRoute — excluded from OpenAPI): `GET /api/internal/scrape/next` → `{command: null}` or the claimed command; `POST /api/internal/scrape/commands/:id/events`; `POST /api/internal/scrape/commands/:id/finish`.
- Tests: `backend/src/__tests__/scrape.test.ts` (fake-DB pattern): admin 401/403, validation 400, 409 conflict, claim + stale sweep, event idempotency, finish guard, prune. Automation: `automation/tests/local/api/features/scrape.feature` + steps simulating the full agent lifecycle (admin creates → bearer claim → events → finish → admin reads feed + events).
- No new bindings/secrets.

## 4. Frontend (per docs/FRONTEND_CONVENTIONS.md)

- `frontend/src/routes/admin.scrape.jsx` + `frontend/src/pages/AdminScrape.jsx` (+ colocated test):
  - Store checkboxes from `GET /api/admin/scrape/stores`; **Scrape Now** button (disabled while mutation pending or a command is pending/running; 409 → inline message "a scrape is already running").
  - Active-run card: status chip, requested stores, elapsed; live log = monospace `<pre>` auto-scrolled, fed by incremental polling (`afterSeq`) every 2s while pending/running; stops at terminal.
  - Recent commands: expandable rows (status dot, stores, created/finished, error snippet) reusing AdminPrices Panel/EmptyState/SkeletonRows patterns; expanding fetches the full event log — that's the "full failure logs" view.
- `frontend/src/lib/api.ts`: `getScrapeStores`, `createScrape`, `getScrapeCommands`, `getScrapeEvents`.
- `frontend/src/lib/queries/scrape.js` (export from `queries/index.js`): `useScrapeStores`, `useScrapeCommands` (refetchInterval 5s while any active else 60s), `useScrapeEvents`, `useTriggerScrape` (invalidate commands on success).
- Nav entry in `AppShell.jsx` admin section (id `scrape`, `/admin/scrape`); i18n keys `nav.scrape` + `scrape.*` in BOTH `en.json` and `id.json`.
- Tests: `AdminScrape.test.jsx` following `AdminPrices.test.jsx` (vi.mock queries, i18n key assertions, fresh QueryClientProvider); e2e scenario in `automation/tests/local/e2e/`.

## 5. Docs & generated artifacts (CI-enforced)

- Copy this plan into `docs/plan/scrape-now.md` as part of the branch (status header: approved, date).
- `./scripts/docs.sh` (API.md) and `vp run api:codegen` (`frontend/src/lib/api-schema.d.ts`) — CI fails on route drift.
- Short notes in `docs/ARCHITECTURE.md` (on-demand trigger via command queue) and `docs/PROJECT_PLAN.md` status.

## 6. Execution phases (manager-orchestrated)

- **Phase A** (this agent): contract + backend + scraper + provisioning + backend/scraper/automation tests. Do NOT touch `frontend/` except nothing — leave frontend fully to Phase B. Do NOT open the PR. Push branch `feat/scrape-now` in worktree `/home/ahaqqu/Projects/RumaQ-scrape-now` (create it: `git worktree add ../RumaQ-scrape-now -b feat/scrape-now main`, then `bun install` inside). Run `./scripts/test.sh unit` for backend+scraper projects and `./scripts/test.sh automation-local` if the harness supports partial runs; report exact results.
- **Phase B** (next agent): frontend + docs regen + codegen + PR (follow pr-creation skill) on the same branch/worktree.

## 7. Verification (manager runs after merge; implementation agents skip)

- Preview: PR branches get branch Workers (`rumaq-api-{branch}`) via the on-demand "Preview deployment" workflow.
- Production: `./scripts/deploy.sh cloudflare` then `./scripts/deploy.sh vps` (non-fatal agent-unit warning expected until root apply.sh re-run). Root `scraper/provision/vps/apply.sh` + go-live timer enable = operator steps → surfaced to user, not blockers for code work.
- Verify: public SPA loads; admin page reachable; automation/e2e green; live scrape trigger (publishes real data — owner-sanctioned) once agent unit is installed.
