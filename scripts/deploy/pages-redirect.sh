#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# One-time migration helper: point the legacy Cloudflare Pages
# project (rumaq.pages.dev) at the Worker origin.
# The app + API now live on a single Worker (static assets), so
# the Pages project only needs to send visitors to the new URL.
# Idempotent: re-running redeploys the same redirect site.
#
# Usage:
#   ./scripts/deploy/pages-redirect.sh
# ============================================================

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

if [[ -f $ROOT_DIR/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

WORKER_URL="${WORKER_URL:-https://api.rumaq.workers.dev}"
PAGES_PROJECT="${PAGES_PROJECT_NAME:-rumaq}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Error: CLOUDFLARE_API_TOKEN is not set (add it to .env or export it)."
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Pages _redirects: send every path to the same path on the Worker origin.
cat > "$TMP_DIR/_redirects" <<EOF
/* ${WORKER_URL}/:splat 301
EOF

cat > "$TMP_DIR/index.html" <<EOF
<!doctype html>
<meta http-equiv="refresh" content="0; url=${WORKER_URL}/">
<p>This app moved to <a href="${WORKER_URL}/">${WORKER_URL}</a>.</p>
EOF

echo "==> Deploying redirect site to Pages project '${PAGES_PROJECT}' (main)..."
cd "$ROOT_DIR"
bunx wrangler@4.152.0 pages deploy "$TMP_DIR" \
  --project-name "$PAGES_PROJECT" \
  --branch main \
  --commit-dirty=true

echo "==> Done. ${PAGES_PROJECT}.pages.dev now redirects to ${WORKER_URL}"
echo "    (The Worker serves the app + API at that origin.)"
