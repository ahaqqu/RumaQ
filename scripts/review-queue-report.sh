#!/usr/bin/env bash
# Read-only review-queue report against production (docs/REVIEW-AUTO-MODE.md).
# Requires --remote (explicit production intent) and RUMAQ_REVIEW_TOKEN in the
# environment — the api Worker's REVIEW_SCRIPT_TOKEN. The token is never
# committed, never echoed, and this script performs zero writes: the endpoint
# is a whole-queue aggregate read. --ids a,b,c switches to the per-ID
# inspection mode (#691): { items: [{ id, found, item }] } with the frozen
# pair + CURRENT entry evidence per id.
set -euo pipefail

REMOTE=""
IDS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --remote) REMOTE=1 ;;
  --ids)
    shift
    IDS="${1:-}"
    [ -n "$IDS" ] || {
      echo "--ids requires a comma-separated list of review-item ids" >&2
      exit 2
    }
    ;;
  *)
    echo "usage: scripts/review-queue-report.sh --remote [--ids a,b,c]   (RUMAQ_REVIEW_TOKEN in env)" >&2
    exit 2
    ;;
  esac
  shift
done
if [ -z "$REMOTE" ]; then
  echo "usage: scripts/review-queue-report.sh --remote [--ids a,b,c]   (RUMAQ_REVIEW_TOKEN in env)" >&2
  exit 2
fi
# No apostrophe inside the ${:?} word — bash parses quotes within parameter
# expansions, so one stray ' swallows the rest of the file (ahaqqu/RumaQ#666).
: "${RUMAQ_REVIEW_TOKEN:?export RUMAQ_REVIEW_TOKEN (the REVIEW_SCRIPT_TOKEN Worker secret) — never committed, never echoed}"
BASE="${RUMAQ_PROD_URL:-https://rumaq.ahaqqu.com}"

# Ids are lowercase hex + commas — URL-safe as-is; the server validates.
IDS_QUERY=""
if [ -n "$IDS" ]; then
  IDS_QUERY="?ids=${IDS}"
fi

curl -fsS \
  -H "Authorization: Bearer ${RUMAQ_REVIEW_TOKEN}" \
  "${BASE}/api/admin/review/queue-report${IDS_QUERY}" | jq .
