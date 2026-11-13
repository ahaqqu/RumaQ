#!/usr/bin/env bash
# Read-only review-queue report against production (docs/REVIEW-AUTO-MODE.md).
# Requires --remote (explicit production intent) and RUMAQ_REVIEW_TOKEN in the
# environment — the api Worker's REVIEW_SCRIPT_TOKEN. The token is never
# committed, never echoed, and this script performs zero writes: the endpoint
# is a whole-queue aggregate read.
set -euo pipefail

case "${1:-}" in
--remote) ;;
*)
  echo "usage: scripts/review-queue-report.sh --remote   (RUMAQ_REVIEW_TOKEN in env)" >&2
  exit 2
  ;;
esac
: "${RUMAQ_REVIEW_TOKEN:?export RUMAQ_REVIEW_TOKEN (the Worker's REVIEW_SCRIPT_TOKEN) — never committed, never echoed}"
BASE="${RUMAQ_PROD_URL:-https://rumaq.ahaqqu.com}"

curl -fsS \
  -H "Authorization: Bearer ${RUMAQ_REVIEW_TOKEN}" \
  "${BASE}/api/admin/review/queue-report" | jq .
