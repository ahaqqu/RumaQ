# Onboarding — first-time setup

A walkthrough from clean clone to running app. For day-to-day workflow see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 1. Install prerequisites

- [Bun](https://bun.sh) — package manager and runtime (`bun --version` should match `packageManager` in `package.json`)
- Google OAuth credentials (client ID + secret) from Google Cloud Console
- Docker only if you plan to run the local automation suite

## 2. Configure local secrets

```bash
cp backend/.dev.vars.example backend/.dev.vars
```

Fill in:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth credentials; the authorized redirect URI for local dev is the Vite/Worker dev origin shown when you start dev servers.
- `WORKER_JWT_SECRET` / `WORKER_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`.
- `EMAIL_AUTH_ENABLED=true` — email/password login for local testing without a real Google app.

`backend/.dev.vars` is gitignored; never commit it and never paste its contents anywhere.

## 3. Run the app

```bash
bun install
./scripts/deploy.sh
```

The script is idempotent: it prepares config, dependencies, and the local D1 database, builds, then starts:

- Frontend: `http://localhost:5173`
- API/Worker: `http://localhost:8787` (Vite proxies `/api`)

Default seed data (locations + stores) is created with the first household on sign-up. Log in with email auth locally, or Google if configured.

## 4. Verify your setup

```bash
./scripts/test.sh unit backend    # or: unit frontend, unit scraper, unit
./scripts/style.sh --check        # format + lint + typecheck
```

## 5. Where things live

| Path                  | What                                                      |
| --------------------- | --------------------------------------------------------- |
| `frontend/src/`       | React SPA (routes, pages, queries, i18n)                  |
| `backend/src/`        | Hono Worker (apps per domain in `apps/`, logic in `lib/`) |
| `backend/migrations/` | D1 migrations, applied by deploy / setup-db               |
| `scraper/`            | Bun price-scraper workspace member (VPS systemd job)      |
| `automation/`         | Docker-based API/E2E test harness                         |
| `scripts/`            | `deploy.sh`, `test.sh`, `docs.sh`, `style.sh` entrypoints |
| `docs/plan/`          | Phase plans; `docs/PROJECT_PLAN.md` for overall status    |

## Common issues

- **Port already in use** — stop leftover dev servers (`pkill -f "vp dev"`), or the previous `./scripts/deploy.sh` run is still attached.
- **401 on every API call** — `backend/.dev.vars` missing or `WORKER_JWT_SECRET` changed (old cookies are invalid; sign in again).
- **Google login redirects fail** — the redirect URI registered in Google Cloud Console must exactly match the local origin; or use `EMAIL_AUTH_ENABLED=true`.
- **Migration errors on startup** — delete local dev state and re-run `./scripts/deploy.sh` (local D1 is disposable; never do this against production).
- **CI fails with `Permission denied` on a new script** — add it to `.gitattributes` with `mode=755`.
- **Lint/type failures** — run `./scripts/style.sh` to autofix before committing.
