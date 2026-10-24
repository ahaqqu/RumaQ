# Phase 07 — DevOps & Deployment

> **Historic planning document (kept as history).** The deployment stack has since
> migrated from Wrangler TOML configs to `cf` CLI with `backend/cloudflare.config.ts`
> — see `docs/plan/tech-stack-tidyup.md`. Tool references below reflect the stack
> at the time of writing.

**Status:** Partial (preview deployments done — branch-specific Workers + Pages previews with auto-cleanup; environment-specific configs exist; R2 bucket automation exists; PR preview comment, Wrangler config validation, and secrets rotation docs remain)
**Priority:** P0/P1
**Source sections:** Sections 3, 7 of `docs/PROJECT_PLAN.md`
**Estimated effort:** Medium

---

## Objective

Make the deployment process repeatable, documented, and safe. Set up preview environments for pull requests, automate R2 bucket creation, separate local/dev/prod environment configs, and document secrets management. The user impact is: _the team can ship confidently and review changes on real URLs before merging_.

This phase complements Phase 05 (final deployment) and Phase 06 (security/secrets) but focuses on the developer workflow.

---

## Acceptance Criteria

1. `scripts/deploy.sh cloudflare` deploys the Worker, D1 migrations, R2 bindings, and Pages frontend in the correct order without manual steps. It is a **fast deploy script** and does not run the full CI gate (lint/typecheck/unit) — that remains the responsibility of CI.
2. `scripts/deploy/deploy-cf.js` automates R2 bucket creation and binding, and accepts the target Worker name so secrets are uploaded to the correct branch Worker.
3. Preview deployments are enabled for pull requests on Cloudflare Pages, and a GitHub Actions job comments the preview URL on PRs.
4. Environment-specific configs exist for local dev (`backend/wrangler.local.toml`), test (`backend/wrangler.test.toml`), and production (`backend/wrangler.cloudflare.toml`). Sensitive IDs (`account_id`, `database_id`) are **not** hard-coded in the committed production config; they are supplied via environment variables or `.dev.vars`.
5. `backend/.dev.vars.example` documents required local secrets, and `.env.example` documents frontend build vars like `VITE_API_BASE`.
6. Secrets management is documented step-by-step, including generation, rotation, and per-environment requirements.
7. GitHub Actions CI remains green and includes lint, typecheck, unit tests, build, and Wrangler config validation.
8. A test automation workflow can deploy to a preview environment and run integration tests against it.
9. `docs/ARCHITECTURE.md` and `README.md` are updated with the latest deployment steps and branch-preview architecture.
10. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phases 01-05 for the features being deployed.
- Existing `scripts/deploy.sh`, `scripts/deploy/deploy-cf.js`, `scripts/deploy/setup-db.js`.
- Existing GitHub Actions workflows in `.github/workflows/`.
- Cloudflare account and Wrangler CLI authentication.

---

## Scope

### 1. Unify and finalize deployment scripts

- `scripts/deploy.sh`:
  - Ensure it runs in the correct order:
    1. Install dependencies.
    2. Set up remote D1 database and apply migrations.
    3. Ensure R2 bucket exists.
    4. Upload Worker secrets (before the Worker is deployed, so a startup secrets check never fails).
    5. Deploy Worker.
    6. Build frontend with the deployed Worker URL.
    7. Deploy frontend to Pages.
  - Add `--dry-run` flag to validate configs and build Worker + frontend without touching Cloudflare.
  - Add proper error handling and exit on failure (`set -euo pipefail` already present; strengthen empty-variable checks).
  - Support both `cloudflare` target and future targets.
  - Keep it **fast**: do not run lint, typecheck, or unit tests here.

- `scripts/deploy/deploy-cf.js`:
  - Add `--name <worker-name>` option so `put-secrets` targets the correct branch Worker.
  - Keep `r2-ensure` command to create the R2 bucket if it doesn't exist.
  - Keep `pages-bindings` command but make it merge safely with existing Pages deployment configs.
  - Keep `d1-setup` command and improve it to auto-copy `database_id` into wrangler files only when environment variables are not used.
  - Add `--dry-run` flag for `r2-ensure`, `put-secrets`, and `pages-bindings` for CI validation.

- `scripts/deploy/setup-db.js`:
  - Ensure it applies migrations locally and remotely.
  - Add a `--remote` flag.
  - Document usage.

### 2. Wrangler configuration files

- `backend/wrangler.local.toml` — local dev with Miniflare, local D1, local R2, `EMAIL_AUTH_ENABLED = 'true'`.
- `backend/wrangler.test.toml` — integration test config, uses Docker/local bindings, test secrets.
- `backend/wrangler.cloudflare.toml` — production config **with placeholders** for `account_id` and `database_id`. Real values are supplied via:
  - `CLOUDFLARE_ACCOUNT_ID` environment variable, or
  - `CLOUDFLARE_DATABASE_ID` environment variable (new), or
  - `backend/.dev.vars` for local overrides.
- `backend/wrangler.toml.example` — template with placeholders, committed to repo.
- Keep `bucket_name` in `wrangler.cloudflare.toml` because bucket names are not considered secrets, but document how to change it.
- Remove the current hard-coded `account_id` and `database_id` from `wrangler.cloudflare.toml` in the committed file.

### 3. Environment-specific configs and `.dev.vars`

- Add committed `backend/.dev.vars.example` for local development:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `WORKER_JWT_SECRET`
  - `WORKER_ENCRYPTION_KEY`
  - `PAGES_ORIGIN=http://localhost:5173`
  - `EMAIL_AUTH_ENABLED=true`
- Ensure `backend/.dev.vars` is in `.gitignore`.
- Update `.env.example` to document frontend build vars and Wrangler auth tokens.
- Update `scripts/deploy.sh` to create `backend/.dev.vars` from `.dev.vars.example` if missing, instead of a hard-coded here-doc.

### 4. Cloudflare Pages preview deployments

- Enable Pages preview branches in the Cloudflare dashboard (manual one-time step; document it).
- Add a new GitHub Actions workflow `.github/workflows/preview.yml` (or extend `ci.yml`) that, on pull requests, deploys a branch Worker and Pages preview, then comments the preview URL on the PR.
- Ensure the preview frontend points to the branch Worker URL for API calls (`VITE_API_BASE=https://rumaq-api-{branch}.rumaq.workers.dev`).
- Add a workflow step that runs smoke tests against the preview URL after deployment.
- Document the branch-preview architecture decision in `docs/ARCHITECTURE.md`: branch previews get their **own Worker and database**, not the production Worker.

### 5. GitHub Actions CI updates

- `.github/workflows/ci.yml`:
  - Keep lint, typecheck, unit tests, and frontend build.
  - Add a step to validate Wrangler configs (non-destructive `wrangler deploy --dry-run` or `wrangler versions upload --dry-run`).
- `.github/workflows/test-automation.yml`:
  - Keep Docker-based integration tests.
  - Add a job that deploys to preview and runs E2E against it (optional nightly; can be deferred).
- `.github/workflows/smoke.yml`:
  - Keep scheduled production smoke tests.
  - Add a `workflow_run` trigger after the production deploy succeeds, or after CI on `main`.
- `.github/workflows/audit.yml`:
  - Keep daily dependency audit.

### 6. Secrets management documentation

- Create or update `docs/ARCHITECTURE.md` section on secrets:
  - How to generate `WORKER_JWT_SECRET` and `WORKER_ENCRYPTION_KEY`.
  - How to set secrets via Wrangler: `wrangler secret put <name>`.
  - How to bulk upload from `.dev.vars`.
  - How to rotate secrets.
  - Which secrets are required for local vs test vs prod.
  - Warning: rotating `WORKER_ENCRYPTION_KEY` requires re-encrypting stored AI keys.

### 7. R2 bucket creation guide

- Add to `README.md` or `docs/ARCHITECTURE.md`:
  - How to create the bucket via `deploy-cf.js r2-ensure` or the dashboard.
  - How to bind the bucket in `wrangler.cloudflare.toml`.
  - How to verify the bucket is private.

---

## Out of Scope

- Multi-region deployments.
- Terraform/Pulumi infrastructure-as-code.
- Kubernetes or non-Cloudflare hosting.
- Blue/green deployments.
- Canary releases.
- Advanced observability dashboards (Phase 09 may include some).

---

## Database Changes

No schema changes. This phase is about tooling and configuration.

---

## Testing Strategy

### Script tests

1. Run `./scripts/deploy.sh cloudflare --dry-run` and validate exit code.
2. Test `deploy-cf.js` commands with `--dry-run` where supported.

### CI tests

1. Ensure CI still passes after config changes.
2. Open a test PR and verify the preview URL is generated and commented.
3. Run integration tests against the preview URL if configured.

### Manual verification

1. Run `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_DATABASE_ID=... ./scripts/deploy.sh cloudflare` from a clean checkout and verify it deploys.
2. Verify the live URL works.
3. Open a PR and verify the preview deployment and PR comment.
4. Verify secrets are set correctly and not leaked in logs.

---

## Deployment & Secrets

- The deployment script itself must not print secrets. Use `wrangler secret put` or Cloudflare API calls that do not echo values.
- Keep `wrangler.cloudflare.toml` in version control with placeholders; keep real IDs in environment variables or local `.dev.vars`.
- Keep `.dev.vars` out of version control; keep `.dev.vars.example` committed.
- Document how to rotate `WORKER_JWT_SECRET` and `WORKER_ENCRYPTION_KEY` safely (rotating the encryption key usually requires re-encrypting data).

---

## Risks & Mitigations

| Risk                                                       | Impact | Mitigation                                                                                   |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| Deployment script fails silently or deploys out of order   | High   | `set -euo pipefail`; validate each step; add `--dry-run`; secrets before Worker deploy.      |
| Preview deployments point to the wrong Worker              | High   | Derive `VITE_API_BASE` from `WORKER_NAME`/`BRANCH_NAME`; comment URL on PR for verification. |
| Secrets are leaked in CI logs                              | High   | Use GitHub secrets and Wrangler's secret management; never echo values.                      |
| `.dev.vars` is accidentally committed                      | High   | Add to `.gitignore`; provide `.dev.vars.example`.                                            |
| Wrangler config drift causes local/test/prod inconsistency | Medium | Keep configs in version control with placeholders; validate in CI.                           |
| Preview deployments are not gated                          | Low    | Only run on non-draft PRs; require CI green before preview deploy.                           |

---

## Open Questions (answered)

1. **Should preview deployments use a separate staging Worker or the production Worker?** Decision: branch previews get their **own branch-specific Worker** and branch Pages preview. This avoids writing test data to production and matches the existing `cleanup-branch.yml` automation. Document in `docs/ARCHITECTURE.md`.
2. **Should D1 migrations run automatically in CI?** Decision: run migrations as part of `deploy.sh` but not automatically on PR preview deploys; preview Workers share the production D1 database for simplicity, and destructive migrations require a separate approval process.
3. **Should R2 bucket creation be part of `deploy.sh` or a separate setup command?** Decision: `deploy.sh` calls `deploy-cf.js r2-ensure` every deploy; it is idempotent and safe. One-time setup is not required separately.
4. **Should the CI build the frontend with a production API base even for PRs?** Decision: PR previews build against the branch Worker URL, not production.
5. **Should we use Wrangler Pages Functions or keep the SPA on Pages?** Decision: keep the SPA on Pages; the Worker is the API.

---

## Alternatives Considered

- **Use GitHub Actions for all deployments instead of `deploy.sh`:** Rejected because a local script is useful for manual deploys and debugging. Keep both.
- **Use a single `wrangler.toml` with environment overrides:** Rejected because separate files are clearer and match the current pattern (`wrangler.local.toml`, `wrangler.cloudflare.toml`, `wrangler.test.toml`).
- **Deploy Worker only after Pages build:** Rejected because the frontend build needs the deployed Worker URL to set `VITE_API_BASE`. Order: Worker first, then Pages.
- **Use Cloudflare Pages Direct Upload via API:** `wrangler pages deploy` is the current path; keep it.
- **Commit real `account_id`/`database_id` in `wrangler.cloudflare.toml`:** Rejected to avoid leaking environment-specific identifiers and to make branch/fork setups easier. Use environment variables instead.

---

## Implementation Notes

1. Audit existing `deploy.sh`, `deploy-cf.js`, and Wrangler configs.
2. Move `account_id` and `database_id` out of committed `wrangler.cloudflare.toml`; update `deploy.sh` and `deploy-cf.js` to read them from env.
3. Add `backend/.dev.vars.example` and update `scripts/deploy.sh` to copy from it.
4. Add `--name` support to `deploy-cf.js put-secrets` and `--dry-run` support where applicable.
5. Add PR preview workflow that comments the Pages preview URL.
6. Update CI to validate Wrangler configs.
7. Update `docs/ARCHITECTURE.md` and `README.md` with branch-preview architecture and secrets rotation guide.
8. Run `scripts/github/ci.sh` and a test deploy to verify.
9. Open a PR and verify the preview comment appears.

After this phase, the team has a reliable, repeatable deployment workflow with branch preview environments, env-driven configuration, and clear documentation.
