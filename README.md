# RumaQ

Household shopping & inventory assistant. Snap a receipt — stock updates. Know what's running out, where it is, and when it expires. AI builds a per-store shopping plan.

---

## For users

- **Track stock** — photo a receipt; items, prices, and store are read automatically.
- **Home dashboard** — items nearing expiry or running out within 3 days.
- **Shopping plans** — AI groups needs by store; check off as you buy.
- **Assistant** — ask for plans, recipes, or store recommendations.
- **Persona** — set roles ("I am the king, you are the warrior") and the app's tone and colour adapt. See [`docs/features/persona.md`](docs/features/persona.md).

### Quick start

1. Sign in with Google.
2. Add an AI key in **Settings** (OpenAI / Gemini / Anthropic / OpenCode).
3. Snap a receipt via **Add from receipt**.
4. Check the home page and ask the assistant for a plan.

---

## For developers

| Layer    | Technology                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Frontend | React + Vite + TanStack Router + TanStack Query + Cloudflare Kumo UI → Cloudflare Worker static assets |
| Backend  | Cloudflare Workers + Hono                                                                              |
| Database | Cloudflare D1 (SQLite)                                                                                 |
| Files    | Cloudflare R2                                                                                          |
| Auth     | Google OAuth 2.0 + JWT                                                                                 |
| AI       | BYO key proxied through the Worker                                                                     |

### Quick start

```bash
./scripts/deploy.sh
```

Prepares config, dependencies, database, and build, then starts dev servers on `localhost:5173` / `:8787`. Idempotent from clean checkout.

> Before first run, edit `backend/.dev.vars` with real secrets (Google OAuth, JWT secret, encryption key).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture, auth flow, and free-tier limits.

## For cloud ops

### Deploy

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_DATABASE_ID=...
./scripts/deploy.sh cloudflare
```

Creates D1 database and R2 bucket if missing, then deploys a single Worker that serves both the app (static assets) and the API. Idempotent. Worker configuration lives in `backend/cloudflare.config.ts` and reads `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_DATABASE_ID` from the environment directly.

Merges to `main` deploy production automatically: `.github/workflows/deploy.yml` runs CI first, then calls the same `./scripts/deploy.sh cloudflare` — both checks visible on the commit. Docs-only merges skip the deploy automatically (`scripts/github/needs-deploy.sh`), and the workflow can be run manually from the Actions tab to redeploy. Pull requests are gated by `ci.yml`, which has no deploy job.

### Pull request previews

Previews are deployed **on demand** — run `Preview deployment` from the GitHub Actions tab and select the branch. Docs-only or trivial PRs need no preview environment.

- Single preview URL: `https://rumaq-api-{sanitized-branch}.rumaq.workers.dev` (serves both the app and the API)
- Database: dedicated staging D1 database (`rumaq-preview`), separate from production

`.github/workflows/preview.yml` deploys the branch Worker and comments the URL on the PR (when one is open for the branch). The branch-specific Worker is deleted automatically when the PR is closed. To purge all preview Workers at once, run `scripts/cleanup-preview-workers.sh`.

### Production smoke tests

A scheduled GitHub Actions workflow (`.github/workflows/smoke.yml`) verifies `rumaq.pages.dev` and `api.rumaq.workers.dev` every 6 hours — includes API health checks and a Playwright login/logout test via email form. On failure, a `smoke-failure` issue is auto-created.

---

## Scripts

| Script              | When to use                                                                  | How to use                                                                                        | What it does                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/build.sh`  | Before deployment or to verify the frontend compiles                         | `./scripts/build.sh`                                                                              | Builds the frontend (Vite)                                                                                                     |
| `scripts/deploy.sh` | Setting up local dev, deploying to Cloudflare, or dry-running a build        | `./scripts/deploy.sh` for local dev, `./scripts/deploy.sh cloudflare` for production              | Idempotent — prepares config, deps, database; starts dev servers or deploys the app + API Worker                               |
| `scripts/docs.sh`   | After adding/changing API endpoints to regenerate docs/API.md                | `./scripts/docs.sh`                                                                               | Generates REST API docs from Hono route definitions and formats with oxfmt                                                     |
| `scripts/style.sh`  | Before committing to check or fix formatting and lint                        | `./scripts/style.sh` to fix, `./scripts/style.sh --check` to verify                               | Runs `vp check` (Oxfmt + Oxlint + type-check) across the repo                                                                  |
| `scripts/test.sh`   | Running any test suite — unit, automation-local (Docker), or automation-live | `./scripts/test.sh unit`, `./scripts/test.sh unit frontend`, `./scripts/test.sh automation-local` | Dispatches to the appropriate test runner (Vitest, Playwright, Cucumber). See [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) |

## Agent skills

This project uses agent skills to keep complex workflows consistent. Invoke them with `/<skill-name>`.

| Skill                   | When to use                                                   | How to use                                             | Benefit                                                                            |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pr-creation`           | Creating or opening a pull request                            | Mention or invoke `pr-creation`                        | Ensures a green gate, proper description, and review rules before submitting       |
| `guided-implementation` | Implementing a difficult or unclear plan from a markdown file | Invoke `guided-implementation` with the plan file path | Confirms the high-level approach before coding and protects architecture decisions |
| `code-review`           | Reviewing a PR after it is created                            | Mention or invoke `code-review`                        | Sets review depth, checks philosophy and guardrails, posts itemized PR comments    |

### `/pr-creation`

Use whenever creating a PR. It creates a branch, analyzes security and performance, runs the full CI gate (`scripts/github/ci.sh`), validates docs, and writes the PR description. See [`.agents/skills/pr-creation/SKILL.md`](.agents/skills/pr-creation/SKILL.md).

### `/guided-implementation`

Use when asked to implement a plan that may be ambiguous, cross-cutting, or architectural. It reads the plan, `docs/ARCHITECTURE.md`, and `docs/TEST_STRATEGY.md`; analyzes the plan critically; proposes a step-by-step implementation; and waits for your confirmation before deviating from the plan or making architecture changes. See [`.agents/skills/guided-implementation/SKILL.md`](.agents/skills/guided-implementation/SKILL.md).

### `/code-review`

Use whenever a PR needs review. It sets the review depth — normal for docs/skill-only changes, thermos (via `thermos-with-comments` and the two thermo-nuclear passes) mandatory for anything touching code — checks the PR against `docs/ARCHITECTURE.md` goals and the `AGENTS.md`/conventions guardrails, and posts each finding as an individual line-anchored review comment. See [`.agents/skills/code-review/SKILL.md`](.agents/skills/code-review/SKILL.md).

---

## Further docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full-stack architecture
- [`docs/API.md`](docs/API.md) — REST API contract
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) — testing strategy
- [`docs/features/persona.md`](docs/features/persona.md) — persona personalisation
- [`docs/features/internationalisation.md`](docs/features/internationalisation.md) — i18n
- [`backend/migrations/0001_schema.sql`](backend/migrations/0001_schema.sql) — D1 schema
