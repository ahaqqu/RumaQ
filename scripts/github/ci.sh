#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== CI: deploy secret guard (#456) ==="
# Offline: asserts the CI deploy never writes the operator-owned
# HAQITA_INGEST_SECRET and still manages exactly the four gateway secrets.
# A re-asserted stale copy silently clobbers the rotated Worker value and 401s
# every internal endpoint (ahaqqu/RumaQ#456).
"$ROOT_DIR/scripts/test.sh" deploy

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
"$ROOT_DIR/scripts/test.sh" unit frontend --coverage

echo "=== CI: backend tests ==="
"$ROOT_DIR/scripts/test.sh" unit backend --coverage

echo "=== CI: audit ==="
bun audit --audit-level=critical

echo "=== CI: build ==="
bash "$ROOT_DIR/scripts/build.sh"

echo "=== CI: bundle size budget ==="
node "$ROOT_DIR/scripts/ci/bundle-budget.mjs"

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
