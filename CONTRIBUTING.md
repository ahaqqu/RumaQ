# Contributing

Thanks for helping build RumaQ — a household shopping & inventory assistant (receipt photo → stock, run-out estimates, AI shopping plans). This guide covers how to set up, work, and submit changes. Agent-specific instructions live in [`AGENTS.md`](AGENTS.md); first-time setup walkthrough in [`docs/ONBOARDING.md`](docs/ONBOARDING.md).

## Prerequisites

- **Bun** (package manager + runtime; `packageManager` field in `package.json` pins the version)
- A **Cloudflare account** for deployment (local dev works without one using `backend/.dev.vars`)
- **Docker** only for the local automation test suite (`./scripts/test.sh automation-local`)
- Google OAuth credentials for login flows (see [`docs/SECURITY.md`](docs/SECURITY.md))

## Setup

```bash
bun install
./scripts/deploy.sh   # local dev: config, deps, db, build, then dev servers on :5173 / :8787
```

Before the first run, copy `backend/.dev.vars.example` to `backend/.dev.vars` and fill in real secrets (gitignored — never commit it).

## Development workflow

- **Branches:** `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `refactor/<topic>`.
- **Never commit or push directly to `main`** — open a PR; merges to `main` auto-deploy production after CI.
- **Commits:** conventional style, e.g. `feat(frontend): ...`, `fix(backend): ...`, `docs: ...`, `ci: ...`.
- **PRs:** use the PR template; CI (`ci.yml`) must be green before merge. The `pr-creation` skill automates branch + gate + description.
- **New shell scripts** must be added to `.gitattributes` with `mode=755` or CI fails with `Permission denied`.
- **API docs:** `docs/API.md` is generated — after changing routes, run `./scripts/docs.sh` and commit the result (CI checks the diff).

## Testing

Single entrypoint: `./scripts/test.sh` — see [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md).

| Suite              | Command                                                   |
| ------------------ | --------------------------------------------------------- |
| Unit (all)         | `./scripts/test.sh unit`                                  |
| Unit (one project) | `./scripts/test.sh unit frontend` / `backend` / `scraper` |
| Local integration  | `./scripts/test.sh automation-local`                      |
| Production smoke   | `./scripts/test.sh automation-live`                       |

Coverage thresholds are 50/50/50/50 for frontend and backend. New API endpoints need an automation scenario in `automation/tests/local/api/`; new UI flows need one in `automation/tests/local/e2e/`.

## Code style

- Format + lint + type-check in one pass: `./scripts/style.sh --check` (fix: `./scripts/style.sh`). Under the hood this is `vp check` (Oxfmt + Oxlint).
- Frontend rules: [`docs/FRONTEND_CONVENTIONS.md`](docs/FRONTEND_CONVENTIONS.md)
- Backend rules: [`docs/BACKEND_CONVENTIONS.md`](docs/BACKEND_CONVENTIONS.md)

## Architecture & plans

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full-stack architecture, request flow, auth, deployment, tech debt (§13)
- [`docs/API.md`](docs/API.md) — REST API contract (generated)
- [`docs/plan/`](docs/plan/) — phase and feature implementation plans; `docs/PROJECT_PLAN.md` tracks overall status

## Deployment

All deployments go through `./scripts/deploy.sh` (`cloudflare` mode for production; branch pushes to `main` deploy automatically via GitHub Actions). Preview Workers for PRs are deployed on demand from the Actions tab. Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the README "For cloud ops" section.

## Security

Found a vulnerability? Prefer a private GitHub security advisory over a public issue. Security posture, secret generation, and rotation notes: [`docs/SECURITY.md`](docs/SECURITY.md).

## Questions

Open a GitHub issue with the `question` label, or start a discussion. For implementation plans, comment on the tracking issue of the relevant phase in [`docs/plan/`](docs/plan/).

## License

No license file yet — the project is private. All contributions are under the repository owner's terms.
