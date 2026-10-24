# RumaQ Tech Stack Tidy-Up — Vite+ Everywhere, wrangler → cf CLI, Dependency Refresh

> Status: **Approved direction, not yet implemented.** Written 2026-10-24.
> Self-contained: includes the full tooling audit (file:line) so a fresh session can
> implement without re-auditing. Follow the `guided-implementation` skill.
> Land these PRs **before** the haqita integration PRs
> (`docs/plan/haqita-integration.md`) so new work isn't built on the old stack.

## 0. Current state (audited 2026-10-24)

RumaQ is already ~90% on Vite+ (`vite-plus` 0.2.6, provides `vp`/`vpr`/`oxfmt`/`oxlint`):

- Root `vite.config.ts` is **vite-plus-native** (`defineConfig` from `vite-plus`):
  configures `staged`, `check` (fmt+lint), `fmt` (prettier for `*.sh`), `lint` (oxlint,
  typeAware, `no-unused-vars: error`), `test.projects` (frontend jsdom / backend node),
  coverage thresholds 50/50/50/50.
- All dev/build/preview/test/check/fmt/run lifecycle goes through `vp` (root
  `package.json` scripts, `scripts/build.sh`, `scripts/style.sh`, `scripts/test/unit.sh`,
  `scripts/docs.sh` L8, `scripts/deploy.sh` L362/L484/L488, `automation/docker/Dockerfile.api` L24,
  `Dockerfile.web` L24).

**Remaining direct-vite/vitest/wrangler surface** (the migration targets):

| Where                                                                                    | What                                                                                                                                                                                                                                                                                          | Line refs  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `frontend/vite.config.js`                                                                | `defineConfig` from `vite` (not vite-plus) + **duplicate** test/coverage blocks (root vp config already defines the projects)                                                                                                                                                                 | whole file |
| `backend/vite.config.ts`                                                                 | `defineConfig` from `vite` + `@cloudflare/vite-plugin` w/ `configPath: './wrangler.test.toml'`                                                                                                                                                                                                | whole file |
| `automation/vitest.config.integration.mjs`                                               | standalone vitest config (`defineConfig` from `vitest/config`)                                                                                                                                                                                                                                | L1         |
| `automation/docker/Dockerfile.test-runner` L42 + `automation/scripts/test-local.sh` L228 | `bun x vitest run --config …` — direct vitest, bypasses vp                                                                                                                                                                                                                                    |            |
| `scripts/github/ci.sh` L17                                                               | `bunx tsc --noEmit -p backend/tsconfig.json` — separate typecheck; `vp check` already does fmt+lint+**type-check** in one pass                                                                                                                                                                |            |
| `backend/package.json` L7/L10/L11/L13                                                    | `wrangler dev` / `wrangler deploy` / `wrangler d1 migrations apply` scripts (`dev` is legacy — root + deploy.sh already use `vp dev backend`)                                                                                                                                                 |            |
| `scripts/deploy.sh`                                                                      | wrangler: migrations apply L92/L225/L265, `require_cmd wrangler` L142, `bunx wrangler deploy` L340–344, `wrangler pages deploy` L371–374, `wrangler whoami/login` L394–396; plus `resolve_wrangler_config()` L98–115 sed-generates `wrangler.cloudflare.resolved.toml` from TOML placeholders |            |
| `scripts/deploy/setup-db.js` L37/L55/L65/L82                                             | `wrangler --version` / `d1 list` / `d1 create` / `d1 migrations apply --local`                                                                                                                                                                                                                |            |
| `scripts/github/ci.sh` L31–35                                                            | `bunx wrangler deploy --dry-run` CI validation                                                                                                                                                                                                                                                |            |
| `scripts/github/cleanup-branch.sh` L21                                                   | `bunx wrangler delete --name rumaq-api-{branch}`                                                                                                                                                                                                                                              |            |
| `.github/workflows/preview.yml` L34, `cleanup-branch.yml` L24                            | `bun add -g wrangler` (global install in CI)                                                                                                                                                                                                                                                  |            |
| 4× TOML configs (`backend/wrangler.{toml.example,local,test,cloudflare}.toml`)           | name/main/compat/bindings/vars/exports+cache; cloudflare one has `account_id`/`database_id` placeholders resolved by sed at deploy time                                                                                                                                                       |            |

**Dependency state**: bun workspaces (`bun@1.3.14` pinned in workflows + Docker bases).
Root devDeps include `vite ^8.1.5`, `vite-plus ^0.2.6`, `vitest ^4.1.10`, `wrangler ^4.114.0`
(backend), `cloudflare ^7.0.0` SDK (used by `scripts/deploy/deploy-cf.js` for d1-setup /
r2-ensure / put-secrets / pages-bindings). Known mismatch: `Dockerfile.test-runner`
Playwright base image `1.61.1` vs `@playwright/test ^1.62.0`.

**Tool facts** (verified 2026-10-24):

- **Vite+** (`viteplus.dev`, VoidZero): unified toolchain bundling Vite/Rolldown,
  Vitest, Oxlint, Oxfmt, tsdown, Vite Task. CLI: `vp dev|build|preview|test|check|fmt|run|pack|staged|env|install|add|remove|create|migrate|upgrade|toolchain`. `vp check` =
  format + lint + **type-check** in one pass. Intended pattern: single unified config
  using vite-plus's `defineConfig`, tool config in blocks of `vite.config.ts`.
- **cf CLI** (`developers.cloudflare.com/cf/`, open beta): 2,900+ generated commands
  covering the whole Cloudflare API (vs wrangler's ~280). `cf migrate` converts a
  Wrangler project to typed **`cloudflare.config.ts`** (bindings.* / triggers.*
  helpers, programmatic environments — the launch post cites ~40% smaller configs).
  Vite is the default dev server/build for cf; Workers still on esbuild (or Rust/
  Python) delegate to wrangler internally — **not RumaQ's case** (backend builds via
  `@cloudflare/vite-plugin`). JSON output by default. `cf cli search "<task>"` for
  discovery. Wrangler is not dead: final major when beta ends + 18 months maintenance.

## 1. Work items

### PR A — Dependency refresh + Vite+ consolidation

1. `bun update --latest` across workspaces (root, frontend, backend); bump
   `vite-plus` notably. Keep `packageManager: bun@…` consistent: bump workflows'
   `bun-version` and `oven/bun:` Docker tags together. Fix the Playwright mismatch:
   either match the base image tag to `@playwright/test` or `bunx playwright install
   --with-deps chromium` in the image (prefer the latter — kills the tag-chase).
2. `frontend/vite.config.js` and `backend/vite.config.ts`: switch `defineConfig`
   import to `vite-plus` (keep the vite plugins — they work through Vite+); delete the
   duplicated `test`/`coverage` blocks in the frontend config — root vp config is the
   single source of truth for test projects.
3. Automation integration tests: replace `bun x vitest run --config …` with
   `bunx vp test --project integration` if achievable inside the Docker test-runner
   image (add an `integration` project to the root vp config); keep the standalone
   config only if vp genuinely can't target it — document why in the file.
4. Typecheck: try folding `bunx tsc --noEmit` into `vp check` (it type-checks); keep
   explicit tsc only if vp check's coverage of `backend/tsconfig.json` proves
   incomplete during implementation.
5. Remove now-unused deps discovered along the way (e.g. if `concurrently` can be
   replaced by `vp run` task graph for the root `dev` script — nice-to-have, not a
   blocker).

### PR B — wrangler → cf CLI

1. Run `cf migrate` on the backend; adopt generated **`cloudflare.config.ts`**:
   - Programmatic environments kill the sed machinery: read `CLOUDFLARE_ACCOUNT_ID` /
     `CLOUDFLARE_DATABASE_ID` from `process.env` directly in TS config; branch worker
     name `rumaq-api-${branch}` becomes a computed value.
   - Delete `resolve_wrangler_config()` (`scripts/deploy.sh` L98–115) and the four
     TOMLs (keep the resolved config under version control as the single TS file with
     env-driven locals: `local`, `test`, `cloudflare` variants expressed as
     environments/functions).
   - `backend/vite.config.ts`'s `cloudflare({ configPath })` must point at the new
     config (verify @cloudflare/vite-plugin supports cloudflare.config.ts; if not yet,
     keep a minimal generated TOML for the vite-plugin path only and note it).
2. Replace every wrangler invocation with the cf equivalent (discover exact commands
   via `cf cli search` during implementation):
   - `scripts/deploy.sh`: d1 migrations apply (local+remote), worker deploy
     (+ `--var PAGES_ORIGIN`), pages deploy, whoami/login hints; `require_cmd wrangler`
     → `require_cmd cf`.
   - `scripts/deploy/setup-db.js`: d1 list/create/version.
   - `scripts/github/ci.sh` L31: dry-run validation deploy.
   - `scripts/github/cleanup-branch.sh` L21: worker delete.
   - `backend/package.json`: delete the legacy `wrangler dev` script (root already
     uses `vp dev backend`); `deploy`/`db:migrate` → cf equivalents.
   - Workflows: `bun add -g wrangler` → pinned `cf` (prefer adding `cf` as a devDep
     and `bunx cf` for reproducibility over global installs).
3. `scripts/deploy/deploy-cf.js` (cloudflare SDK): evaluate replacing its subcommands
   with cf CLI calls (JSON output makes them shell-friendly): `d1-setup`,
   `r2-ensure`, `put-secrets` are all standard API operations cf covers. Deleting
   this bespoke SDK code is a net win; keep the `cloudflare` SDK dep only if some
   call lacks CLI parity. Drop the unused `pages-bindings` subcommand regardless.
4. Docs: update stale tool attributions — `README.md` L79–83 (says Prettier/ESLint;
   actually vp/oxfmt/oxlint), `docs/ARCHITECTURE.md` (L44–45 references a
   `vitest.config.js` that doesn't exist; L193/L256/L290/L322–323/L346 wrangler
   commands), `docs/TEST_STRATEGY.md` where needed.

### PR C — (Recommended) Single Worker + static assets: retire Cloudflare Pages

The code already anticipates this: `backend/src/gateway.ts` serves `env.ASSETS` for
non-`/api/*` requests and `backend/src/types.ts` declares `ASSETS: Fetcher` — only the
deployment doesn't use it. Cloudflare's direction is Workers static assets (Pages is
in maintenance mode); cf CLI is built around it.

- Point worker assets at `frontend/dist` (SPA fallback via assets config or the
  gateway's existing fallback), drop: `wrangler/cf pages deploy`, the separate Pages
  project, `PAGES_ORIGIN` var, the CORS layer for the Pages origin, and the
  `pages-bindings` code path.
- Wins: one deploy target; **same-origin auth cookie** (removes the whole
  cross-origin `credentials: 'include'` + CORS class of issues); single URL for app +
  API; PR previews become ONE url (`rumaq-api-{branch}.rumaq.workers.dev` serves both)
  instead of worker + pages preview pair; `rumaq.ahaqqu.com` becomes a single custom
  domain on the Worker (currently pending anyway).
- Keep: PWA/service worker (same-origin fine), R2 receipt proxy, edge-cache exports.
- Migration detail: update `frontend/src/lib/api.js` to use relative `/api` paths only
  (`VITE_API_BASE` becomes unnecessary); keep a redirect from `rumaq.pages.dev` to the
  worker domain for existing users.

### PR D — Test-harness + API-client improvements

1. `automation/tests/support/worker-server.mjs` applies D1 migrations by a
   **hand-maintained list** (0001, 0003–0006 + ad-hoc `ALTER TABLE`). Make it glob
   `backend/migrations/*.sql` and apply in order — otherwise **haqita migration 0007
   silently won't exist in the Docker stack**. This is effectively a prerequisite for
   haqita PR1.
2. (Optional but recommended before haqita adds `/api/prices`): generate a typed API
   client from the hono-openapi spec (`/api/openapi.json`) — e.g. `openapi-typescript`
   - `openapi-fetch` — and retire the hand-written fetch functions in
     `frontend/src/lib/api.js`. Contract drift becomes a build-time error. Add spec
     generation to `vp run` tasks so it runs in CI.

### Deferred / noted (do not do now)

- **Rate limiting KV/DO migration** (known tech debt, per api.ts comment): current
  in-memory limiter is per-isolate. Revisit with Cloudflare's rate-limiting binding
  when GA; the haqita ingest endpoint must stay exempt either way (it's service auth,
  not user auth).
- `vp pack`, `vp env`, `vp install`: not applicable (no library packaging; bun is the
  package manager and runtime — keep it).

## 2. Risks & mitigations

| Risk                                                             | Mitigation                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cf CLI is open beta (breaking changes possible)                  | Pin cf version as devDep (not `-g`); keep the used command surface minimal; preview deploys validate before prod; wrangler remains installed-able as fallback for 18+ months |
| `@cloudflare/vite-plugin` not yet reading `cloudflare.config.ts` | Keep a minimal generated TOML for the plugin path only; file an upstream issue; rest of repo still migrates                                                                  |
| Pages retirement breaks existing URLs                            | Keep `rumaq.pages.dev` project alive with redirect; custom domain moves to the Worker                                                                                        |
| `bun update --latest` churn                                      | Land it as its own PR before the toolchain PRs; CI + automation-local must be green; audit workflow already exercises this path periodically                                 |
| Playwright browser/version drift in Docker                       | Prefer `bunx playwright install --with-deps` in the image over pinning base tags                                                                                             |

## 3. Suggested sequence

**PR A (deps + vp consolidation) → PR B (cf migration) → PR C (Worker+assets, retire
Pages) → PR D (migrations glob + typed client)** — then start the haqita plan
(`docs/plan/haqita-integration.md`), updating its §"RumaQ touch-points" for whatever
PR C changed (PAGES_ORIGIN removal, relative API paths, same-origin explorer).

## 4. Audit reference (line numbers valid as of 2026-10-24)

- Root scripts: `package.json` L11–26 · `scripts/build.sh` L6 · `scripts/style.sh`
  L14/17 · `scripts/docs.sh` L7–8 · `scripts/test/unit.sh` L11–18
- Wrangler call sites: `backend/package.json` L7/10/11/13 · `scripts/deploy.sh`
  L92/142/225/265/340–344/371–374/394–396 + resolver L98–115 ·
  `scripts/deploy/setup-db.js` L37/55/65/82 · `scripts/github/ci.sh` L31–35 ·
  `scripts/github/cleanup-branch.sh` L21 · `preview.yml` L34 · `cleanup-branch.yml` L24
- Direct vitest: `automation/docker/Dockerfile.test-runner` L42 ·
  `automation/scripts/test-local.sh` L228 · `automation/vitest.config.integration.mjs`
- Separate typecheck: `scripts/github/ci.sh` L17
- Miniflare (programmatic, unaffected by cf): `automation/tests/support/worker-server.mjs` L61
- Docs needing updates: `docs/ARCHITECTURE.md` (many), `README.md` L38–83,
  `docs/TEST_STRATEGY.md` L11–38, `docs/plan/phase-07-devops-and-deployment.md` (historic —
  leave as history, note at top), `docs/PROJECT_PLAN.md`
