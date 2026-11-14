#!/usr/bin/env bash
# Bulk-fill cached AI verdicts in assist mode (docs/REVIEW-AUTO-MODE.md).
# DRY-RUN by default: prints a coverage snapshot and sends nothing. --apply
# drains the pending-without-verdict backlog in batches of 10 (the API cap),
# stopping on the first auth/quota failure instead of retrying blindly. The
# script never decides: assist only caches verdicts for human review — auto
# semantics belong to the server, not to this script.
set -euo pipefail

APPLY=0
case "${1:-}" in
--remote) ;;
*)
  echo "usage: scripts/review-evaluate.sh --remote [--apply]   (RUMAQ_REVIEW_TOKEN in env)" >&2
  exit 2
  ;;
esac
[ "${2:-}" = "--apply" ] && APPLY=1
# No apostrophe inside the ${:?} word — bash parses quotes within parameter
# expansions, so one stray ' swallows the rest of the file (ahaqqu/RumaQ#666).
: "${RUMAQ_REVIEW_TOKEN:?export RUMAQ_REVIEW_TOKEN (the REVIEW_SCRIPT_TOKEN Worker secret) — never committed, never echoed}"
BASE="${RUMAQ_PROD_URL:-https://rumaq.ahaqqu.com}"

if [ "$APPLY" -ne 1 ]; then
  echo "DRY RUN — nothing sent. Re-run with --apply to fill verdicts (assist mode)."
  echo "Coverage snapshot:"
  curl -fsS -H "Authorization: Bearer ${RUMAQ_REVIEW_TOKEN}" \
    "${BASE}/api/admin/review/queue-report" |
    jq '{pending: .counts.pending, withoutVerdict: .ai.pendingWithoutVerdict, autoEligible: .ai.autoEligible}'
  exit 0
fi

total_evaluated=0
total_applied=0
batch=0
while :; do
  batch=$((batch + 1))
  if ! out=$(curl -fsS -X POST \
    -H "Authorization: Bearer ${RUMAQ_REVIEW_TOKEN}" \
    -H 'Content-Type: application/json' -d '{"limit":10}' \
    "${BASE}/api/admin/review/evaluate"); then
    echo "STOPPED: batch $batch failed (auth or quota) — earlier batches are kept; re-run with --apply to continue." >&2
    exit 1
  fi
  evaluated=$(jq -r '.evaluated' <<<"$out")
  applied=$(jq -r '.applied' <<<"$out")
  mode=$(jq -r '.mode' <<<"$out")
  total_evaluated=$((total_evaluated + evaluated))
  total_applied=$((total_applied + applied))
  echo "batch $batch (mode $mode): evaluated=$evaluated applied=$applied — totals: $total_evaluated evaluated, $total_applied applied"
  if [ "$evaluated" -eq 0 ]; then
    echo "done — no unevaluated pending items left: $total_evaluated evaluated, $total_applied applied across $batch batch(es)."
    exit 0
  fi
  if [ "$batch" -ge 100 ]; then
    echo "STOPPED: 100-batch safety cap reached — re-run with --apply to continue." >&2
    exit 1
  fi
done
