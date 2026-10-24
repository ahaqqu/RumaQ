#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== CI: style check ==="
bash "$ROOT_DIR/scripts/style.sh" --check

echo "=== CI: docs check ==="
bash "$ROOT_DIR/scripts/docs.sh"
git diff --exit-code docs/API.md

echo "=== CI: frontend tests ==="
"$ROOT_DIR/scripts/test.sh" unit frontend --coverage

echo "=== CI: backend tests ==="
"$ROOT_DIR/scripts/test.sh" unit backend --coverage

echo "=== CI: audit ==="
bun audit --audit-level=critical

echo "=== CI: build ==="
bash "$ROOT_DIR/scripts/build.sh"

echo "=== CI: validate Wrangler config ==="
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cd "$ROOT_DIR/backend"
  bunx wrangler deploy \
    --config wrangler.cloudflare.toml \
    --name "api-ci-validation" \
    --var PAGES_ORIGIN:"https://rumaq.pages.dev" \
    --dry-run
  cd "$ROOT_DIR"
else
  echo "  skip  CLOUDFLARE_API_TOKEN not set — Wrangler config validation skipped."
fi

echo "=== CI: passed ==="
