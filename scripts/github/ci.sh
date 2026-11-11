#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== CI: deploy secret guard (#456) ==="
# Offline: asserts the CI deploy never writes the operator-owned
# HAQITA_INGEST_SECRET and still manages exactly the four gateway secrets.
# A re-asserted stale copy silently clobbers the rotated Worker value and 401s
# every internal endpoint (ahaqqu/RumaQ#456).
"$ROOT_DIR/scripts/test.sh" deploy

echo "=== CI: price-freshness probe guard (#536) ==="
# Offline: runs the real probe script against canned responses. The
# consecutive-failed-run branch must fire with zero observations (a dead
# pipeline must not read as "go-live pending") and the staleness branch must
# keep its behaviour.
"$ROOT_DIR/scripts/test.sh" freshness

echo "=== CI: style check ==="
bash "$ROOT_DIR/scripts/style.sh" --check

echo "=== CI: docs check ==="
bash "$ROOT_DIR/scripts/docs.sh"
git diff --exit-code docs/API.md

echo "=== CI: API client codegen check ==="
# Regenerate the OpenAPI spec + typed client schema and fail on drift between
# the backend routes and the committed frontend artifacts.
bunx vp run api:codegen
git diff --exit-code frontend/openapi.json frontend/src/lib/api-client

echo "=== CI: frontend tests ==="
# Scope: a change set that cannot reach the frontend suite skips it — docs,
# the backend workspace outside the parity edge (backend/src/plugins/ feeds
# the frontend parity test), contract, codegen tools. The rule is
# offline-tested in scripts/test/unit-test-scope.sh and it fails safe: an
# unavailable change set runs the suite.
if bash "$ROOT_DIR/scripts/github/unit-test-scope.sh" frontend; then
  "$ROOT_DIR/scripts/test.sh" unit frontend --coverage
else
  echo "  skip  frontend tests for this change set"
fi

echo "=== CI: backend tests ==="
# Scope: mirrors the frontend rule — docs, the frontend workspace, codegen
# tools skip; backend, contract and anything unknown run.
if bash "$ROOT_DIR/scripts/github/unit-test-scope.sh" backend; then
  "$ROOT_DIR/scripts/test.sh" unit backend --coverage
else
  echo "  skip  backend tests for this change set"
fi

echo "=== CI: audit ==="
bun audit --audit-level=critical

echo "=== CI: build ==="
bash "$ROOT_DIR/scripts/build.sh"

echo "=== CI: bundle size budget ==="
node "$ROOT_DIR/scripts/ci/bundle-budget.mjs"

echo "=== CI: worker boot smoke (workerd) ==="
# Boots the real bundle in workerd and asserts /api/health (#534). This lives
# in ci.sh, not in ci.yml, so the main-push ci job in deploy.yml runs the same
# gate before deploy — PR checks and main CI stay one contract.
#
# Scope: a change set that cannot reach the bundle (docs, a skill, an
# automation test, Markdown) skips it. The rule is offline-tested here and in
# scripts/test/worker-smoke-scope.sh, and it fails safe: an unavailable change
# set runs the smoke.
"$ROOT_DIR/scripts/test.sh" smoke-scope
if "$ROOT_DIR/scripts/github/worker-smoke-scope.sh"; then
  bash "$ROOT_DIR/scripts/github/worker-boot-smoke.sh"
else
  echo "worker boot smoke: skipped for this change set"
fi

echo "=== CI: validate Worker config ==="
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  # Builds the Worker with backend/cloudflare.config.ts and runs cf's checks
  # without uploading (worker name/bindings are computed by the config).
  # cf deploy must run next to cloudflare.config.ts so it finds the project.
  cd "$ROOT_DIR/backend"
  node "$ROOT_DIR/node_modules/cf/bin/cf" deploy --dry-run
  cd "$ROOT_DIR"
else
  echo "  skip  CLOUDFLARE_API_TOKEN not set — Worker config validation skipped."
fi

echo "=== CI: passed ==="
